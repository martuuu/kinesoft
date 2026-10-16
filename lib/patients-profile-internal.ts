/**
 * PF2-b (C-PF8) · Lectores del perfil del paciente que corren DENTRO de una tx que abre otro.
 *
 * Por qué existe: `/pacientes/[id]` abría ~12 transacciones (una por lector de `lib/patients.ts`, más el acceso de
 * cada uno y el copago Particular de cada `resolvePatientBilling`). Con un pool chico todo se serializaba y una lectura
 * lenta tiraba P2028 al resto (AUDIT `runwithrls-interactive-tx-per-read`). El loader de la página
 * (`lib/patient-profile-loader.ts`) resuelve el actor y el acceso UNA vez y llama a estas variantes con su `tx`.
 *
 * Contrato:
 *  - Mismo resultado que el lector público de `lib/patients.ts` con el mismo nombre: esos delegan acá (abren su
 *    `runWithRls` y pasan el `tx`), así que la regla vive en un solo lugar.
 *  - `access` lo resuelve el que llama con `patientAccessFor(actor, patientId, tx?)`; acá no se vuelve a pedir.
 *  - `where: { tenantId }` a mano en cada sentencia sobre una tabla con `tenantId` (en prod la conexión es BYPASSRLS).
 *    `Coverage` y `EvaScore` no tienen la columna: se filtran por `patientId`, que el acceso ya validó contra el tenant
 *    (`patientAccessFor` devuelve "none" para un paciente de otro consultorio y nadie llega acá con "none").
 *  - `server-only` y no en el archivo `"use server"`: una export de ahí es un endpoint RPC, y estas funciones reciben
 *    el actor y el nivel de acceso como argumentos (un cliente podría falsificarlos).
 */
import "server-only";
import { displayMemberName } from "@/lib/display-name";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { AccessLevel } from "@/lib/visibility";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import type { PatientAdminCore, PatientBookingFull, PatientCoreWithAccess } from "@/lib/patients-types";

/**
 * P0-S07sp (E1, PD-13): ¿el actor ve la lista de turnos y el estado de cobro
 * del paciente? `full` y `admin` (Secretaria/Facturación: turnos y cobro son
 * datos administrativos). `basic` sigue sin verlos. Forma positiva: un nivel
 * nuevo no habilita nada por omisión.
 */
export function seesBookings(access: AccessLevel): boolean {
  return access === "full" || access === "admin";
}

/**
 * Resolve a patient's active obra social → { name, copagoCents }. Used to
 * stamp the billing line on each booking row. "Particular" + null copago
 * when there's no coverage (the caller falls back to the service price).
 */
export type PatientBilling = {
  obraSocial: string;
  coverageOverride: number | null; // per-patient copago override
  hasCoverage: boolean;
  insurerCopago: number | null;
  particularCopago: number | null;
  // What the obra social reimburses the kine per session (Insurer.fixedFeeCents).
  // 0 for Particular / uninsured / free-form coverage (no OS pays).
  insurerFixedFeeCents: number;
  /** The coverage row points at the tenant's Particular Insurer (per-patient override holder). */
  isParticular: boolean;
};

export async function resolvePatientBillingInTx(
  tx: DbClient,
  patientId: string,
  tenantId: string
): Promise<PatientBilling> {
  const coverage = await tx.coverage.findFirst({
    where: { patientId },
    include: { insurerRef: true },
    orderBy: { id: "desc" }, // deterministic: latest coverage = active
  });
  if (!coverage) {
    // No obra social → Particular. Use the tenant's configured Particular
    // copago exactly as set (incl. 0). `null` only when there's no
    // Particular row, in which case callers fall back to the service price.
    const particularCopago = await getParticularCopagoCents(tenantId, tx);
    return {
      obraSocial: "Particular",
      coverageOverride: null,
      hasCoverage: false,
      insurerCopago: null,
      particularCopago,
      insurerFixedFeeCents: 0,
      isParticular: true,
    };
  }
  return {
    obraSocial: coverage.insurerRef?.name ?? coverage.insurer ?? "Particular",
    coverageOverride: coverage.copagoCents,
    hasCoverage: true,
    insurerCopago: coverage.insurerRef ? coverage.insurerRef.copagoCents : null,
    particularCopago: null,
    insurerFixedFeeCents: coverage.insurerRef?.fixedFeeCents ?? 0,
    isParticular: coverage.insurerRef?.isParticular === true,
  };
}

/**
 * Redacta title/description/notes de un turno del paciente según
 * `bookingFieldAccess` (la misma regla que la agenda y el ICS: con paciente,
 * los tres campos solo con `clinical.read` + full). Para `admin` quedan en
 * null: el campo viaja (forma estable para la UI) pero sin contenido.
 */
export async function bookingTextRedactor(actor: Actor, access: AccessLevel) {
  const caps = await memberCapabilitiesForActor(actor);
  const fa = bookingFieldAccess({ clinical: caps.has("clinical.read"), access, hasPatient: true });
  return <T extends { title: string | null; description: string | null; notes: string | null }>(b: T): T => ({
    ...b,
    title: fa.title === "rw" ? b.title : null,
    description: fa.description === "rw" ? b.description : null,
    notes: fa.notes === "rw" ? b.notes : null,
  });
}

/**
 * Cuerpo de `getPatientCore` (ver su doc en lib/patients.ts): tres proyecciones por `access`. "none" → null sin tocar
 * la base. Las dos lecturas de cada rama corren en serie en el `tx` (una conexión); antes eran dos tx en paralelo.
 */
export async function patientCoreInTx(
  tx: DbClient,
  actor: Actor,
  id: string,
  access: AccessLevel
): Promise<PatientCoreWithAccess | null> {
  if (access === "none") return null;

  if (access === "admin") {
    // P0-S07sp (E1, PD-13): proyección `admin` con `select` explícito, así la
    // HC (notes, diagnosisTitle/Note, userId del portal, montos de cobertura)
    // ni siquiera sale de la DB. Antes `admin` caía en la rama básica (falla
    // cerrado) y la Secretaria no veía contacto ni cobertura para operar.
    const patient = await tx.patient.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        documentId: true,
        email: true,
        phone: true,
        dateOfBirth: true,
        // Misma regla que la rama full: la cobertura vigente es la más
        // reciente (cuid ordenable por tiempo). Sin copago ni vigencia.
        coverages: {
          orderBy: { id: "desc" },
          take: 1,
          select: { insurer: true, planName: true, memberId: true, insurerRef: { select: { name: true } } },
        },
        emergency: { orderBy: { id: "asc" }, select: { name: true, relation: true, phone: true } },
        assignedPractitioner: { select: { user: { select: { fullName: true, email: true } } } },
      },
    });
    if (!patient) return null;
    const nextBooking = await tx.booking.findFirst({
      where: {
        tenantId: actor.tenantId,
        patientId: id,
        scheduledFor: { gte: new Date() },
        status: { notIn: ["CANCELLED"] },
      },
      orderBy: { scheduledFor: "asc" },
      select: { scheduledFor: true },
    });
    const cov = patient.coverages[0];
    const assignedUser = patient.assignedPractitioner?.user;
    // Literal campo por campo (no spread): el tipo congelado es el contrato
    // con el perfil (S07v) y un campo nuevo en el `select` no tiene que
    // filtrarse solo.
    const core: PatientAdminCore = {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      documentId: patient.documentId,
      email: patient.email,
      phone: patient.phone,
      dateOfBirth: patient.dateOfBirth,
      coverage: cov
        ? { insurer: cov.insurerRef?.name ?? cov.insurer, planName: cov.planName, memberId: cov.memberId }
        : null,
      emergency: patient.emergency.map((e) => ({ name: e.name, relation: e.relation, phone: e.phone })),
      assignedPractitionerName: assignedUser ? displayMemberName(assignedUser.fullName) : null,
      nextBookingAt: nextBooking?.scheduledFor ?? null,
      access: "admin",
    };
    return core;
  }

  // `basic` (y cualquier nivel futuro no contemplado: falla cerrado).
  if (access !== "full") {
    // Minimal projection — name + DNI + next upcoming booking only.
    const patient = await tx.patient.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, firstName: true, lastName: true, documentId: true },
    });
    if (!patient) return null;
    // PF2-b: `tenantId` a mano (antes faltaba en esta sentencia; el paciente ya era del tenant, así que el resultado
    // no cambia, pero en prod la conexión es BYPASSRLS y el filtro explícito es la regla).
    const nextBooking = await tx.booking.findFirst({
      where: {
        tenantId: actor.tenantId,
        patientId: id,
        scheduledFor: { gte: new Date() },
        status: { notIn: ["CANCELLED"] },
      },
      orderBy: { scheduledFor: "asc" },
      select: { scheduledFor: true },
    });
    return {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      documentId: patient.documentId,
      nextBookingAt: nextBooking?.scheduledFor ?? null,
      access: "basic" as const,
    };
  }

  const patient = await tx.patient.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: {
      // Deterministic order so `coverages[0]` is always the latest/active
      // one (the app keeps a single active coverage; ordering is defence
      // in depth in case 2+ rows ever exist). cuid `id` is time-sortable.
      // `insurerRef.isParticular` (ES3, P3.Z): la PlanCard muestra "Obra
      // social: Sin autorización vigente" solo a quien tiene OS de verdad;
      // un Particular (o un nombre libre sin catálogo) no tiene orden.
      coverages: { orderBy: { id: "desc" }, include: { insurerRef: { select: { isParticular: true } } } },
      emergency: true,
    },
  });
  return patient ? { ...patient, access: "full" as const } : null;
}

/** Cuerpo de `getPatientBillableCount`: turnos que no están UNPAID. `admin` también (estado de cobro, PD-13). */
export async function patientBillableCountInTx(
  tx: DbClient,
  actor: Actor,
  patientId: string,
  access: AccessLevel
): Promise<number> {
  if (!seesBookings(access)) return 0;
  return tx.booking.count({
    where: {
      tenantId: actor.tenantId,
      patientId,
      paymentStatus: { not: "UNPAID" },
    },
  });
}

/** Cuerpo de `getPatientBookingsSummary` (últimos `take` turnos con la línea de cobro). */
export async function patientBookingsSummaryInTx(
  tx: DbClient,
  actor: Actor,
  patientId: string,
  access: AccessLevel,
  take = 5
) {
  if (!seesBookings(access)) return [];
  const rows = await tx.booking.findMany({
    where: { patientId, tenantId: actor.tenantId },
    orderBy: { scheduledFor: "desc" },
    take,
    select: {
      id: true,
      scheduledFor: true,
      durationMin: true,
      status: true,
      paymentStatus: true,
      notes: true,
      title: true,
      description: true,
      copagoCents: true,
      service: { select: { name: true, priceCents: true } },
    },
  });
  const billing = await resolvePatientBillingInTx(tx, patientId, actor.tenantId);
  const redact = await bookingTextRedactor(actor, access);
  return rows.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...redact(b),
    serviceName: service.name,
    obraSocial: billing.obraSocial,
    copagoCents: resolveBookingCopagoCents({
      bookingOverride: bookingCopago,
      coverageOverride: billing.coverageOverride,
      hasCoverage: billing.hasCoverage,
      insurerCopago: billing.insurerCopago,
      particularCopago: billing.particularCopago,
      servicePriceCents: service.priceCents,
    }),
  }));
}

/** Cuerpo de `getPatientBookingsAll` (página con cursor; ver su doc en lib/patients.ts). */
export async function patientBookingsAllInTx(
  tx: DbClient,
  actor: Actor,
  patientId: string,
  access: AccessLevel,
  take = 100,
  cursor?: string
): Promise<{ rows: PatientBookingFull[]; hasMore: boolean; nextCursor: string | null }> {
  const size = Math.min(Math.max(Math.trunc(take) || 100, 1), 200);
  if (!seesBookings(access)) return { rows: [], hasMore: false, nextCursor: null };
  const found = await tx.booking.findMany({
    where: { patientId, tenantId: actor.tenantId },
    orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
    take: size + 1, // +1 = sonda de "hay más"
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { service: { select: { name: true, priceCents: true } } },
  });
  const billing = await resolvePatientBillingInTx(tx, patientId, actor.tenantId);
  const redact = await bookingTextRedactor(actor, access);
  const hasMore = found.length > size;
  const page = hasMore ? found.slice(0, size) : found;
  const rows: PatientBookingFull[] = page.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...redact(b),
    serviceName: service.name,
    obraSocial: billing.obraSocial,
    // What the patient pays (copago) and what the OS reimburses (osAmount),
    // kept separate for the Facturación tab. `insurerPaidAt` rides along in
    // `...b` (booking scalar) so the UI knows if the OS already paid.
    copagoCents: resolveBookingCopagoCents({
      bookingOverride: bookingCopago,
      coverageOverride: billing.coverageOverride,
      hasCoverage: billing.hasCoverage,
      insurerCopago: billing.insurerCopago,
      particularCopago: billing.particularCopago,
      servicePriceCents: service.priceCents,
    }),
    osAmountCents: billing.insurerFixedFeeCents,
  }));
  return { rows, hasMore, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/** Cuerpo de `getPatientEvaScores`: módulo `evaluaciones` (enmienda EV0) + acceso `full`; si no, vacío. */
export async function patientEvaScoresInTx(tx: DbClient, actor: Actor, patientId: string, access: AccessLevel) {
  if (!modulesFor(actor.entitlements).has("evaluaciones")) return [];
  if (access !== "full") return [];
  return tx.evaScore.findMany({
    where: { patientId },
    orderBy: { takenAt: "asc" },
  });
}
