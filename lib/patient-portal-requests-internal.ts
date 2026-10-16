/**
 * ES4 S24r · helpers de los pedidos de cambio del portal, lado consultorio (brief ES4 §3.6).
 *
 * Todo corre en la tx del caller (`runWithRls` de `lib/patient-portal-requests.ts`): el CAS del pedido, los writes
 * de la ficha, el contacto, la cobertura y el audit commitean juntos o no commitea ninguno. En prod la conexión tiene
 * BYPASSRLS, así que cada where lleva `tenantId` a mano (o va por una ficha ya validada contra el tenant en esta tx).
 *
 * La cobertura NO reusa `setPatientCoverage` (`lib/patients.ts`, de S32 en esta ola y además una action con su propia
 * tx y su propio gate `full`, que la Secretaria no pasa): acá se replica el camino «Otra / texto libre» de esa action,
 * que es el único que puede llegar desde el portal (el paciente escribe el nombre de la OS; nunca elige un id). Ver el
 * handoff del reporte de S24r para unificar las dos en un `applyPatientCoverageInTx` compartido.
 */
import "server-only";
import { Prisma } from "@prisma/client";
import { resolveInsurerName } from "@/lib/insurers-internal";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import { bookingHasPaymentWhere } from "@/lib/plan-predicates";
import {
  changedFieldNames,
  PortalPendingChanges,
  type PortalPendingChangeField,
  type PortalPendingChangesT,
} from "@/lib/portal-pending-changes";

type Tx = Prisma.TransactionClient;

/** Fila del banner del perfil. Valores administrativos (teléfono, email, contacto, OS), nunca clínicos (PD-13, §6). */
export type PortalRequestRow = {
  id: string;
  /** ISO. El cliente lo devuelve como `expectedUpdatedAt` (CAS). */
  updatedAt: string;
  createdAt: string;
  fields: PortalPendingChangeField[];
  /** null = la fila guardada ya no pasa la allowlist de P4-C: solo se puede rechazar. */
  changes: PortalPendingChangesT | null;
  current: {
    phone: string | null;
    email: string | null;
    emergencyContact: { name: string; relation: string | null; phone: string } | null;
    coverage: { insurerName: string; planName: string | null; memberId: string | null } | null;
  };
  /** false = el email del pedido no se va a aplicar (ficha sin cuenta vinculada, o vinculada a otra cuenta). */
  emailApplies: boolean;
  /** El pedido cambia la obra social (el copago de los turnos impagos cambia con ella). */
  osChanges: boolean;
};

/** Pedido ya parseado: `null` si `changes` no pasa `PortalPendingChanges` (fila vieja o tocada a mano). */
export function parseStoredChanges(raw: unknown): PortalPendingChangesT | null {
  const r = PortalPendingChanges.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * «El email se aplica solo si la cuenta está vinculada» (PLANES §12, S24r). El email es la llave del portal (invitación,
 * auto-vínculo por email): si la ficha ya no está vinculada, o lo está a OTRA cuenta que la que pidió el cambio, aplicar
 * el email dejaría que una cuenta ajena redirija el acceso de la ficha. `requestedByUserId` null (pedido sin autor
 * registrado) → alcanza con que la ficha esté vinculada.
 */
export function emailApplies(patientUserId: string | null, requestedByUserId: string | null): boolean {
  if (patientUserId == null) return false;
  return requestedByUserId == null || requestedByUserId === patientUserId;
}

// ─── Cobertura ───────────────────────────────────────────────────────────────

type CurrentCoverage = {
  id: string;
  insurer: string;
  insurerId: string | null;
  planName: string | null;
  payerPlanId: string | null;
  memberId: string | null;
  copagoCents: number | null;
  insurerRef: { isParticular: boolean } | null;
};

function readCoverage(tx: Tx, patientId: string): Promise<CurrentCoverage | null> {
  // Misma fila «activa» que lee el resolver de copago y `setPatientCoverage` (id desc).
  return tx.coverage.findFirst({
    where: { patientId },
    orderBy: { id: "desc" },
    select: {
      id: true,
      insurer: true,
      insurerId: true,
      planName: true,
      payerPlanId: true,
      memberId: true,
      copagoCents: true,
      insurerRef: { select: { isParticular: true } },
    },
  });
}

type ResolvedCoverage = { name: string; insurerId: string | null; isParticular: boolean };

async function resolveRequestedInsurer(tx: Tx, tenantId: string, insurerName: string): Promise<ResolvedCoverage> {
  const r = await resolveInsurerName(tenantId, insurerName, tx);
  if (!r.insurerId) return { name: r.name, insurerId: null, isParticular: false };
  const ins = await tx.insurer.findFirst({
    where: { id: r.insurerId, tenantId },
    select: { isParticular: true },
  });
  return { name: r.name, insurerId: r.insurerId, isParticular: ins?.isParticular === true };
}

/** Misma regla que `setPatientCoverage` (lib/patients.ts): Particular = sin fila o fila al Insurer `isParticular`. */
function sameObraSocial(existing: CurrentCoverage | null, next: ResolvedCoverage): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  const newIsParticular = !next.name || next.isParticular;
  const oldIsParticular = !existing || existing.insurerRef?.isParticular === true;
  if (newIsParticular || oldIsParticular) return newIsParticular && oldIsParticular;
  if (existing!.insurerId && next.insurerId) return existing!.insurerId === next.insurerId;
  return norm(existing!.insurer) === norm(next.name);
}

/** ¿El pedido cambia la obra social? (sin escribir). */
export async function coverageChangesOsInTx(
  tx: Tx,
  tenantId: string,
  patientId: string,
  coverage: PortalPendingChangesT["coverage"]
): Promise<boolean> {
  if (!coverage) return false;
  const [existing, next] = await Promise.all([
    readCoverage(tx, patientId),
    resolveRequestedInsurer(tx, tenantId, coverage.insurerName),
  ]);
  return !sameObraSocial(existing, next);
}

/**
 * ES4-Z (M2): impacto del pedido sobre la cobertura, para la confirmación del consultorio. `ownCopagoCents` = el
 * copago propio cargado en la cobertura actual que se BORRA al aprobar (misma regla que `copagoReset` en
 * `applyPortalCoverageInTx`): solo si cambia la OS y había uno cargado. Sin escribir.
 */
export async function coverageImpactInTx(
  tx: Tx,
  tenantId: string,
  patientId: string,
  coverage: PortalPendingChangesT["coverage"]
): Promise<{ osChanges: boolean; ownCopagoCents: number | null }> {
  if (!coverage) return { osChanges: false, ownCopagoCents: null };
  const [existing, next] = await Promise.all([
    readCoverage(tx, patientId),
    resolveRequestedInsurer(tx, tenantId, coverage.insurerName),
  ]);
  const osChanges = !sameObraSocial(existing, next);
  return { osChanges, ownCopagoCents: osChanges ? existing?.copagoCents ?? null : null };
}

/**
 * Turnos del paciente cuyo copago sale de la cobertura y todavía no se cobraron: son los que cambian de monto si cambia
 * la OS. `Booking.copagoCents` null = «se calcula de la cobertura al leer» (schema); con override del turno o estampado
 * por el plan, el monto no se mueve. Impago = criterio canónico `bookingHasPaymentWhere` (C5, P6). Pasados y futuros:
 * un turno atendido e impago también se cobra con el copago nuevo.
 */
export function countUnpaidCopagoBookingsInTx(tx: Tx, tenantId: string, patientId: string): Promise<number> {
  return tx.booking.count({
    where: {
      tenantId,
      patientId,
      copagoCents: null,
      pricedByPlan: false,
      status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
      NOT: bookingHasPaymentWhere,
    },
  });
}

/**
 * Aplica la cobertura pedida (camino «Otra / texto libre» de `setPatientCoverage`). Single-active: las filas legacy
 * extra se borran. Con cambio de OS el copago propio y la vigencia se borran (eran de la OS anterior: es lo que hace
 * el drawer de Editar al confirmar «Cambiar y borrar el copago»), y el plan del catálogo se desvincula. Con la misma OS
 * se conservan copago y vigencia; el plan del catálogo se conserva solo si el nombre del plan no cambió.
 */
export async function applyPortalCoverageInTx(
  tx: Tx,
  tenantId: string,
  patientId: string,
  coverage: NonNullable<PortalPendingChangesT["coverage"]>
): Promise<{ osChanged: boolean; copagoReset: boolean }> {
  const existing = await readCoverage(tx, patientId);
  const next = await resolveRequestedInsurer(tx, tenantId, coverage.insurerName);
  const sameOs = sameObraSocial(existing, next);
  const copagoReset = !sameOs && existing?.copagoCents != null;
  const planName = coverage.planName?.trim() || null;
  const memberId = coverage.memberId?.trim() || null;

  if (existing) await tx.coverage.deleteMany({ where: { patientId, id: { not: existing.id } } });

  if (next.isParticular) {
    // Pasa a Particular: sin fila (el copago propio era de la OS anterior). Si ya era Particular, no hay nada que
    // cambiar (Particular no lleva plan ni afiliado).
    if (existing && !sameOs) await tx.coverage.deleteMany({ where: { patientId } });
    return { osChanged: !sameOs, copagoReset };
  }

  if (existing) {
    const samePlan = (existing.planName ?? "").trim().toLowerCase() === (planName ?? "").toLowerCase();
    await tx.coverage.update({
      where: { id: existing.id },
      data: {
        insurer: next.name,
        insurerId: next.insurerId,
        planName,
        payerPlanId: sameOs && samePlan ? existing.payerPlanId : null,
        memberId,
        copagoCents: sameOs ? existing.copagoCents : null,
        ...(sameOs ? {} : { validUntil: null }),
      },
    });
  } else {
    await tx.coverage.create({
      data: { patientId, insurer: next.name, insurerId: next.insurerId, planName, memberId },
    });
  }
  return { osChanged: !sameOs, copagoReset };
}

// ─── Contacto de emergencia ─────────────────────────────────────────────────

/**
 * Reemplaza el contacto de emergencia ÚNICO de la ficha (el portal y el turnero manejan uno solo; fichas viejas pueden
 * tener varios). `null` = borrarlo. `EmergencyContact` no tiene `tenantId`: el where va por la ficha del tenant (el
 * caller ya validó `{id, tenantId}` en esta tx; el filtro por relación lo repite por si un caller futuro no lo hace).
 */
export async function applyEmergencyContactInTx(
  tx: Tx,
  ref: { tenantId: string; patientId: string },
  contact: { name: string; relation?: string | null; phone: string } | null
): Promise<void> {
  await tx.emergencyContact.deleteMany({ where: { patientId: ref.patientId, patient: { tenantId: ref.tenantId } } });
  if (contact) {
    await tx.emergencyContact.create({
      data: {
        patientId: ref.patientId,
        name: contact.name.trim(),
        relation: contact.relation?.trim() || null,
        phone: contact.phone.trim(),
      },
    });
  }
}

// ─── Aplicar el pedido ───────────────────────────────────────────────────────

export class PortalRequestInvalid extends Error {}

/** Mismo criterio que `PatientUpdate` (lib/validation.ts): teléfono 6..30, email trim + minúsculas. */
function patientPhone(v: string | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t.length < 6 || t.length > 30) throw new PortalRequestInvalid("El teléfono del pedido no es válido.");
  return t;
}

export type AppliedPortalRequest = {
  fields: PortalPendingChangeField[];
  applied: PortalPendingChangeField[];
  skipped: PortalPendingChangeField[];
  osChanged: boolean;
  copagoReset: boolean;
  unpaidCopagoBookings: number;
};

/**
 * Aplica un pedido ya validado sobre la ficha `{patientId, tenantId}`. Un P2002 de email/teléfono sale como excepción
 * (Postgres aborta la tx: el caller la deja revertir entera, CAS del pedido incluido) y lo traduce `portalRequestUniqueError`.
 */
export async function applyPortalRequestInTx(
  tx: Tx,
  ref: { tenantId: string; patientId: string },
  changes: PortalPendingChangesT,
  opts: { emailApplies: boolean }
): Promise<AppliedPortalRequest> {
  const fields = changedFieldNames(changes);
  const applied: PortalPendingChangeField[] = [];
  const skipped: PortalPendingChangeField[] = [];

  const data: { phone?: string | null; email?: string | null } = {};
  if (changes.phone !== undefined) {
    data.phone = patientPhone(changes.phone);
    applied.push("phone");
  }
  if (changes.email !== undefined) {
    if (opts.emailApplies) {
      data.email = changes.email == null ? null : changes.email.trim().toLowerCase();
      applied.push("email");
    } else {
      skipped.push("email");
    }
  }
  if (Object.keys(data).length > 0) {
    // Choque con otra ficha: se busca ANTES del write para nombrar el campo. Medido contra el Docker local: el P2002 de
    // `updateMany` llega con `meta.target = null` (Prisma 5), así que desde la excepción no se sabe si fue el email o
    // el teléfono. El teléfono, igual que el único `(tenantId, phone)`. El email, SIN distinguir mayúsculas (ES4-Z B1):
    // el único `(tenantId, email)` distingue, pero `Ana@x` y `ana@x` en dos fichas dejan el auto-vínculo del portal en
    // `ambiguous` para las dos; filtro escapado + `sameEmail` (IAM-0a). Si igual pasa una carrera entre el check y el
    // write, el P2002 revierte la tx y `portalRequestUniqueError` responde.
    if (data.email || data.phone) {
      const clashes = await tx.patient.findMany({
        where: {
          tenantId: ref.tenantId,
          id: { not: ref.patientId },
          OR: [
            ...(data.email ? [{ email: emailEqualsFilter(data.email) }] : []),
            ...(data.phone ? [{ phone: data.phone }] : []),
          ],
        },
        select: { email: true, phone: true },
        take: 5,
      });
      if (data.email && clashes.some((c) => sameEmail(c.email, data.email))) {
        throw new PortalRequestInvalid(UNIQUE_COPY.email);
      }
      if (data.phone && clashes.some((c) => c.phone === data.phone)) throw new PortalRequestInvalid(UNIQUE_COPY.phone);
    }
    const res = await tx.patient.updateMany({ where: { id: ref.patientId, tenantId: ref.tenantId }, data });
    if (res.count !== 1) throw new PortalRequestInvalid("Paciente no encontrado.");
  }

  if (changes.emergencyContact !== undefined) {
    await applyEmergencyContactInTx(tx, ref, changes.emergencyContact);
    applied.push("emergencyContact");
  }

  let osChanged = false;
  let copagoReset = false;
  let unpaidCopagoBookings = 0;
  if (changes.coverage) {
    // El conteo va ANTES del write (es el mismo número que vio el confirm: los turnos que pasan a cobrar otra OS).
    const cov = changes.coverage;
    if (await coverageChangesOsInTx(tx, ref.tenantId, ref.patientId, cov)) {
      unpaidCopagoBookings = await countUnpaidCopagoBookingsInTx(tx, ref.tenantId, ref.patientId);
    }
    ({ osChanged, copagoReset } = await applyPortalCoverageInTx(tx, ref.tenantId, ref.patientId, cov));
    applied.push("coverage");
  }

  // Orden fijo de P4-C (el de `changedFieldNames`), para que el audit sea comparable entre pedidos.
  const order = (xs: PortalPendingChangeField[]) => fields.filter((f) => xs.includes(f));
  return { fields, applied: order(applied), skipped: order(skipped), osChanged, copagoReset, unpaidCopagoBookings };
}

const UNIQUE_COPY = {
  email: "Ese email ya está en otra ficha del consultorio.",
  phone: "Ese teléfono ya está en otra ficha del consultorio.",
  any: "Ese email o teléfono ya está en otra ficha del consultorio.",
} as const;

/**
 * P2002 de los únicos `(tenantId, email)` / `(tenantId, phone)` de Patient (la carrera que el pre-check de
 * `applyPortalRequestInTx` no ve) → copy para el consultorio. `meta.target` suele venir null desde `updateMany`: en ese
 * caso el copy nombra los dos campos.
 */
export function portalRequestUniqueError(e: unknown): string | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return null;
  const raw = e.meta?.target;
  const target = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
  if (target.some((t) => t.includes("email"))) return UNIQUE_COPY.email;
  if (target.some((t) => t.includes("phone"))) return UNIQUE_COPY.phone;
  return UNIQUE_COPY.any;
}
