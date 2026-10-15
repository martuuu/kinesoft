import "server-only";
import { Prisma, type Role } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { revalidatePath } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, type Actor } from "@/lib/session";
import { capabilitiesForMembership, MEMBER_ACCESS_SELECT, type Capability } from "@/lib/capabilities";
import { isClinicalMember } from "@/lib/roles";
import { auditInTx } from "@/lib/audit";
import { lockPlanPatient, planPatientLockKey, withTxConflictRetry } from "@/lib/plan-lock";
import { assertPlanManageInTx } from "@/lib/plan-authz-internal";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { assertProgramInvariantsInTx, ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import {
  PLAN_LIFECYCLE_COPY,
  canRestoreProgram,
  decideProgramArchive,
  decideProgramTransition,
  patientArchivePlanTarget,
  programTransition,
  type FutureBookingsAction,
  type PatientArchivePlansAction,
  type ProgramStatusValue,
  type ProgramTransitionRule,
} from "@/lib/plans-lifecycle-state";
import type {
  ArchivePlanResult,
  ChangePlanStatusResult,
  PlanBookingsOutcome,
  PlanFail,
  PlanNeedsConfirmationFail,
  PlanStaleFail,
  PlanStatusChangePreview,
  RestorePlanResult,
  UpdatePlanDetailsResult,
} from "@/lib/plans-edit-types";
import type { z } from "zod";
import type { PlanStatusChangePreviewSchema } from "@/lib/plans-edit-types";

type PlanStatusChangePreviewInputParsed = z.output<typeof PlanStatusChangePreviewSchema>;

/**
 * Ciclo de vida del plan (S15, ES2b · P2.2) — primitivas de tx, server-only.
 * Las consumen `lib/plans-lifecycle.ts` (actions nuevas), los exports legacy
 * de `lib/programs.ts` (que delegan hasta que ES3/S27a los retire) y L9 en
 * `lib/patients.ts` (archivar un paciente pausa sus planes).
 *
 * La TABLA de transiciones es pura (`lib/plans-lifecycle-state.ts`); acá vive
 * lo que necesita datos: qué turnos son futuros, cancelarlos, la
 * re-validación de refs al reactivar, el CAS y el audit.
 *
 * Orden de locks (C2, literal): (0) `lockPlanPatient` PRIMERO → (2)
 * `lockTenantLocationsShared` (solo al reactivar) → (3) filas Booking (`FOR
 * UPDATE` id asc, adentro de `cancelBookingsInTx`) → TreatmentProgram, con el
 * CAS de `updatedAt` AL FINAL. Ninguna de estas funciones toma lock de cupo:
 * cancelar libera cupo, no lo ocupa (C2: "`cancelBookingsInTx` no toma cupo").
 *
 * Plata (PD-08 / P6): un turno con cobro registrado NUNCA se cancela ni se
 * saca del plan acá: `cancelBookingsInTx` lo saltea (`has-payment`) con el
 * mismo criterio que `bookingHasMoney`, y se reporta en `withPayment` ("2
 * tienen un cobro registrado y no se tocan", C13).
 *
 * Realtime (enmienda): estas funciones DEVUELVEN `refs` y nunca emiten; el
 * caller llama `afterBookingsCommitted` una vez, después del commit.
 *
 * Nada de acá gatea: el caller ya corrió `assertPlanManageInTx` (o, en L9, el
 * gate `full` de archivar el paciente).
 */

// ─── Errores que fuerzan rollback ─────────────────────────────────────────────

/**
 * CAS perdido: alguien cambió el plan entre que la UI lo mostró y este write
 * (o entre la lectura y el UPDATE). Se TIRA (no se devuelve) porque para
 * entonces la tx pudo haber cancelado turnos: devolver haría COMMIT de una
 * cancelación sin el cambio de estado que la justificaba.
 */
export class PlanLifecycleStale extends Error {
  constructor() {
    super(PLAN_LIFECYCLE_COPY.stale);
    this.name = "PlanLifecycleStale";
  }
}

/** Rechazo de datos con copy accionable (reactivar con sede archivada, responsable que ya no es miembro). */
export class PlanLifecycleRejected extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "PlanLifecycleRejected";
  }
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

export type LifecycleProgramRow = {
  id: string;
  patientId: string;
  status: ProgramStatusValue;
  archivedAt: Date | null;
  updatedAt: Date;
  practitionerId: string | null;
  locationId: string | null;
};

const PROGRAM_SELECT = {
  id: true,
  patientId: true,
  status: true,
  archivedAt: true,
  updatedAt: true,
  practitionerId: true,
  locationId: true,
} satisfies Prisma.TreatmentProgramSelect;

/** El plan con `tenantId` a mano (prod = BYPASSRLS: es la única barrera). null = no existe o es ajeno. */
export async function loadLifecycleProgramInTx(
  tx: DbClient,
  tenantId: string,
  programId: string
): Promise<LifecycleProgramRow | null> {
  return tx.treatmentProgram.findFirst({ where: { id: programId, tenantId }, select: PROGRAM_SELECT });
}

/** Rol + capabilities del actor leídos en la tx (una query; el rol hace falta para restaurar). */
export async function actorRoleAndCapsInTx(
  tx: DbClient,
  actor: Actor
): Promise<{ role: Role | null; caps: ReadonlySet<Capability> }> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    // PL-1 (H-PL1): la fila del MIEMBRO (rol + si atiende + delegaciones), no solo el rol.
    select: MEMBER_ACCESS_SELECT,
  });
  return { role: m?.role ?? null, caps: capabilitiesForMembership(m) };
}

/** `expectedUpdatedAt` (ISO de la UI) contra la fila: igualdad al ms. */
export function sameInstant(expectedIso: string, actual: Date): boolean {
  return Date.parse(expectedIso) === actual.getTime();
}

// ─── Turnos futuros (D7) ─────────────────────────────────────────────────────

export type FutureProgramBooking = { id: string; hasMoney: boolean };

/**
 * Turnos FUTUROS ACTIVOS del plan (D7: "¿Qué hacemos con los 6 turnos que
 * quedan?"): `programId` = el plan, PENDING/CONFIRMED, `scheduledFor > now`.
 * Los pasados impagos no son "los que quedan": son de Seguimiento/Recepción
 * (Ausente o Atendido), no del ciclo de vida del plan.
 */
export async function loadFutureProgramBookingsInTx(
  tx: DbClient,
  o: { tenantId: string; programId: string; now: Date }
): Promise<FutureProgramBooking[]> {
  const rows = await tx.booking.findMany({
    where: {
      tenantId: o.tenantId,
      programId: o.programId,
      status: { in: ["PENDING", "CONFIRMED"] },
      scheduledFor: { gt: o.now },
    },
    select: { id: true, paymentStatus: true, insurerPaidAt: true, payment: { select: { status: true } } },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({ id: r.id, hasMoney: bookingHasMoney(r) }));
}

export function countFutureBookings(rows: ReadonlyArray<FutureProgramBooking>): { unpaid: number; withPayment: number } {
  const withPayment = rows.filter((r) => r.hasMoney).length;
  return { unpaid: rows.length - withPayment, withPayment };
}

/**
 * D7 adentro de la tx: `cancel` cancela los futuros impagos con
 * `cancelBookingsInTx` (lockea Booking `FOR UPDATE` id asc, re-chequea el cobro
 * bajo lock y audita cada uno en la misma tx); `keep` no toca nada. Los que
 * tienen cobro quedan siempre ("no se tocan").
 *
 * `withPayment` sale de lo que `cancelBookingsInTx` vio BAJO LOCK (no de la
 * lectura previa): si un webhook de MP marcó el pago entre las dos, el turno
 * queda y se cuenta como con cobro.
 */
export async function applyFutureBookingsInTx(
  tx: DbClient,
  actor: Actor,
  o: { programId: string; action: FutureBookingsAction; now: Date; reason: string }
): Promise<{ outcome: PlanBookingsOutcome; refs: BookingChangeRef[] }> {
  const future = await loadFutureProgramBookingsInTx(tx, { tenantId: actor.tenantId, programId: o.programId, now: o.now });
  const counts = countFutureBookings(future);
  if (o.action === "keep" || future.length === 0) {
    return { outcome: { cancelled: 0, kept: counts.unpaid, withPayment: counts.withPayment }, refs: [] };
  }
  const res = await cancelBookingsInTx(tx, {
    tenantId: actor.tenantId,
    bookingIds: future.filter((b) => !b.hasMoney).map((b) => b.id),
    reason: o.reason,
    actorId: actor.userId ?? null,
    auditAction: "booking.cancel.plan",
  });
  const lateMoney = res.skipped.filter((s) => s.reason === "has-payment").length;
  // `not-active`/`not-found`: otro camino lo canceló o atendió entre la
  // lectura y el lock; ya no es "un turno que queda", no se cuenta.
  return {
    outcome: { cancelled: res.cancelled.length, kept: 0, withPayment: counts.withPayment + lateMoney },
    // FX1a (SV08-gap): la sala viaja en el ref. Sin ella, la vista «Por sala» y
    // la Sala de Espera no se enteraban de que el plan canceló el turno.
    refs: res.cancelled.map((b) => ({
      bookingId: b.id,
      practitionerId: b.practitionerId,
      scheduledFor: b.scheduledFor,
      roomId: b.roomId,
    })),
  };
}

// ─── Reactivar (S13g, literal) ───────────────────────────────────────────────

export const PLAN_REACTIVATE_COPY = {
  location: "La sede del plan está archivada. Re-planificá el plan en otra sede para reactivarlo.",
  practitioner:
    "El profesional responsable ya no gestiona planes en el consultorio. Re-planificá el plan con otro responsable para reactivarlo.",
} as const;

/**
 * S13g (literal): "al reactivar un plan PAUSED → ACTIVE, validar que la sede
 * siga activa y que el responsable siga siendo miembro con `plans.manage`; si
 * no, rechazo accionable". Vale también para COMPLETED → ACTIVE (la tabla
 * marca `revalidatesRefs` en las dos).
 *
 * Sede: `lockTenantLocationsShared` ANTES de validar con `{id, tenantId,
 * active}` (C2 (2)): validar sin el lock deja abierta la carrera con un
 * `archiveLocation` concurrente, que toma el exclusivo. `locationId` null =
 * la sede principal (no hay nada que archivar).
 *
 * Responsable: misma regla que `validatePlanRefsInTx` (miembro ACEPTADO cuyo
 * rol tiene `plans.manage`; no Secretaria ni Facturación). Un legacy sin
 * responsable (`practitionerId` null, R-LEGACY) no tiene a quién re-validar.
 */
export async function revalidateRefsForReactivationInTx(
  tx: DbClient,
  tenantId: string,
  program: Pick<LifecycleProgramRow, "practitionerId" | "locationId">
): Promise<void> {
  if (program.locationId) {
    await lockTenantLocationsShared(tx, tenantId);
    const loc = await tx.location.findFirst({ where: { id: program.locationId, tenantId, active: true }, select: { id: true } });
    if (!loc) throw new PlanLifecycleRejected(PLAN_REACTIVATE_COPY.location, "locationId");
  }
  if (program.practitionerId) {
    const prac = await tx.practitioner.findFirst({
      where: { id: program.practitionerId, tenantId },
      select: {
        user: {
          select: { memberships: { where: { tenantId }, select: { role: true, clinical: true, acceptedAt: true, disabledAt: true } } },
        },
      },
    });
    const m = prac?.user.memberships[0];
    // IAM-4b: un responsable suspendido tampoco (igual que validatePlanRefsInTx). PL-1 (H-PL1): «gestiona planes»
    // = el miembro ATIENDE (`isClinicalMember`), no el rol: un Titular sin agenda no puede ser responsable.
    if (!m || m.acceptedAt == null || m.disabledAt != null || !isClinicalMember(m)) {
      throw new PlanLifecycleRejected(PLAN_REACTIVATE_COPY.practitioner, "practitionerId");
    }
  }
}

// ─── Transición ──────────────────────────────────────────────────────────────

export type ProgramTransitionTxResult = {
  updatedAt: Date;
  bookings: PlanBookingsOutcome | null;
  refs: BookingChangeRef[];
};

/**
 * Aplica una transición YA DECIDIDA por la tabla (`decideProgramTransition` /
 * `decideProgramArchive` / `patientArchivePlanTarget`) sobre un plan leído
 * bajo `lockPlanPatient`. En orden C2: refs (sede compartida) → turnos
 * (Booking) → plan con CAS sobre el `updatedAt` leído → verificador → audit.
 *
 * `archive: true` = además marca `archivedAt` en el MISMO UPDATE (archivar un
 * plan abierto con `cancelOpen`: la transición D7 y el archivado son una sola
 * escritura, nunca un plan archivado ACTIVE, que es I7).
 *
 * Tira `PlanLifecycleStale` si el CAS no matchea y `PlanLifecycleRejected` si
 * la re-validación falla: los dos hacen rollback de los turnos ya cancelados.
 */
export async function applyProgramTransitionInTx(
  tx: DbClient,
  actor: Actor,
  o: {
    program: LifecycleProgramRow;
    to: ProgramStatusValue;
    rule: Pick<ProgramTransitionRule, "revalidatesRefs">;
    futureBookings: FutureBookingsAction | null;
    now: Date;
    /** Motivo del audit de cada turno cancelado (sin PHI). */
    reason: string;
    archive?: boolean;
    /** Extra del audit `program.status` (p. ej. `{ source: 'patient.archive' }`). */
    auditExtra?: Record<string, string | number | boolean>;
  }
): Promise<ProgramTransitionTxResult> {
  const { program } = o;
  if (o.rule.revalidatesRefs) await revalidateRefsForReactivationInTx(tx, actor.tenantId, program);

  let bookings: PlanBookingsOutcome | null = null;
  let refs: BookingChangeRef[] = [];
  if (o.futureBookings) {
    const r = await applyFutureBookingsInTx(tx, actor, {
      programId: program.id,
      action: o.futureBookings,
      now: o.now,
      reason: o.reason,
    });
    bookings = r.outcome;
    refs = r.refs;
  }

  const updatedAt = await casProgramUpdateInTx(tx, actor.tenantId, program, {
    status: o.to,
    ...(o.archive ? { archivedAt: o.now } : {}),
  });
  await assertProgramInvariantsInTx(tx, { tenantId: actor.tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.status",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      from: program.status,
      to: o.to,
      ...(o.futureBookings ? { futureBookings: o.futureBookings } : {}),
      ...(bookings ? { cancelled: bookings.cancelled, kept: bookings.kept, withPayment: bookings.withPayment } : {}),
      ...(o.auditExtra ?? {}),
    },
  });
  return { updatedAt, bookings, refs };
}

/**
 * CAS del plan AL FINAL (C2 (3)): `updateMany` con el `updatedAt` leído; 0
 * filas = otro write se metió → `PlanLifecycleStale` (rollback). Devuelve el
 * `updatedAt` nuevo para encadenar el próximo CAS de la UI sin recargar.
 */
export async function casProgramUpdateInTx(
  tx: DbClient,
  tenantId: string,
  program: Pick<LifecycleProgramRow, "id" | "updatedAt">,
  data: Prisma.TreatmentProgramUpdateManyMutationInput
): Promise<Date> {
  const res = await tx.treatmentProgram.updateMany({
    where: { id: program.id, tenantId, updatedAt: program.updatedAt },
    data,
  });
  if (res.count !== 1) throw new PlanLifecycleStale();
  const row = await tx.treatmentProgram.findFirst({ where: { id: program.id, tenantId }, select: { updatedAt: true } });
  return row!.updatedAt;
}

// ─── L9 · archivar un paciente ───────────────────────────────────────────────

/**
 * `lockPlanPatient` de VARIOS pacientes en UNA sentencia, con las claves
 * ordenadas en JS (mismo patrón que `lockCapacityMany`, C2 (1)): dos
 * `bulkArchivePatients` con pacientes en común toman los locks en el mismo
 * orden y no se cruzan. Va primero en la tx (C2 (0)).
 */
export async function lockPlanPatientsInTx(tx: DbClient, tenantId: string, patientIds: ReadonlyArray<string>): Promise<void> {
  const keys = Array.from(new Set(patientIds))
    .map((patientId) => planPatientLockKey({ tenantId, patientId }))
    .sort();
  if (keys.length === 0) return;
  await tx.$queryRaw`
    SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0)))::int AS n
    FROM (SELECT k FROM unnest(${keys}::text[]) WITH ORDINALITY u(k, o) ORDER BY o) s`;
}

export type PatientArchivePlansResult = {
  /** Planes que pasaron a PAUSED. */
  paused: number;
  /** Planes que pasaron a CANCELLED. */
  cancelled: number;
  bookings: PlanBookingsOutcome;
  refs: BookingChangeRef[];
};

/**
 * L9 (PD-10): al archivar pacientes, sus planes VIVOS pasan por la MISMA
 * transición que `changePlanStatus` (CAS + verificador + audit), nunca por un
 * `updateMany` ciego. `pause` (default) = ACTIVE → PAUSED **sin cancelar
 * turnos** (literal de S15); `cancel` = ACTIVE/PAUSED → CANCELLED con los
 * futuros impagos cancelados.
 *
 * Sin gate de módulo ni `plans.manage` a propósito: es la consecuencia de
 * archivar al paciente (gate `full` del caller), no una edición del plan. Un
 * consultorio que perdió el módulo `planes` igual no puede quedar con un
 * paciente archivado y un plan ACTIVE (precheck (6) de §16). Misma decisión
 * que S12 con la sincronía turno↔sesión.
 *
 * Locks: candidatos (lectura sin lock) → `lockPlanPatientsInTx` de esos
 * pacientes → re-lectura bajo lock (lo que se escribe es lo releído).
 */
export async function applyPatientArchivePlansInTx(
  tx: DbClient,
  actor: Actor,
  o: { patientIds: ReadonlyArray<string>; action: PatientArchivePlansAction; now: Date }
): Promise<PatientArchivePlansResult> {
  const out: PatientArchivePlansResult = {
    paused: 0,
    cancelled: 0,
    bookings: { cancelled: 0, kept: 0, withPayment: 0 },
    refs: [],
  };
  const statuses: ProgramStatusValue[] = o.action === "pause" ? ["ACTIVE"] : ["ACTIVE", "PAUSED"];
  const where = (patientIds: string[]): Prisma.TreatmentProgramWhereInput => ({
    tenantId: actor.tenantId,
    patientId: { in: patientIds },
    archivedAt: null,
    status: { in: statuses },
  });
  const candidates = await tx.treatmentProgram.findMany({ where: where([...o.patientIds]), select: { patientId: true } });
  if (candidates.length === 0) return out;
  const patientIds = Array.from(new Set(candidates.map((c) => c.patientId)));
  await lockPlanPatientsInTx(tx, actor.tenantId, patientIds);

  const programs = await tx.treatmentProgram.findMany({ where: where(patientIds), select: PROGRAM_SELECT, orderBy: { id: "asc" } });
  for (const program of programs) {
    const target = patientArchivePlanTarget(program.status, o.action);
    if (!target) continue;
    const r = await applyProgramTransitionInTx(tx, actor, {
      program,
      to: target.to,
      rule: { revalidatesRefs: false },
      futureBookings: target.futureBookings,
      now: o.now,
      reason: "patient.archive",
      auditExtra: { source: "patient.archive" },
    });
    if (target.to === "PAUSED") out.paused += 1;
    else out.cancelled += 1;
    if (r.bookings) {
      out.bookings.cancelled += r.bookings.cancelled;
      out.bookings.kept += r.bookings.kept;
      out.bookings.withPayment += r.bookings.withPayment;
    }
    out.refs.push(...r.refs);
  }
  return out;
}

// ─── Flujos completos (una tx) — los comparten las actions y los legacy ──────

/**
 * Lo que devuelve un flujo: el resultado para el cliente + lo que el caller
 * hace DESPUÉS del commit (`afterLifecycleCommit`). Los flujos viven acá (y no
 * en `plans-lifecycle.ts`) porque los exports legacy de `lib/programs.ts`
 * delegan en ellos sin `expectedUpdatedAt` (el Tab Plan de hoy no lo manda;
 * ES3 los retira) y un `"use server"` no puede exportar helpers sync ni tipos.
 */
export type LifecycleFlow<R> = { result: R; commit: { patientId: string; refs: BookingChangeRef[] } | null };

type FlowFail = PlanFail | PlanStaleFail | PlanNeedsConfirmationFail;

/** `null` = sin CAS (solo los exports legacy, que no conocen el `updatedAt`). */
type ExpectedUpdatedAt = string | null;

const NOT_FOUND = "Plan no encontrado.";
const ARCHIVED = "El plan está archivado: restauralo para editarlo.";
const INCONSISTENT = "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.";

const staleFail = (): PlanStaleFail => ({ ok: false, kind: "stale", error: PLAN_LIFECYCLE_COPY.stale });

/** Rechazos esperables → resultado (Next enmascara el mensaje de un throw en prod); lo demás se propaga. */
function lifecycleRejection(e: unknown): FlowFail | null {
  if (e instanceof PlanLifecycleStale) return staleFail();
  if (e instanceof PlanLifecycleRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  // El verificador ya reportó el diff a Sentry; al usuario, un error que no sea un 500.
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: INCONSISTENT };
  return null;
}

type FlowCtx = { program: LifecycleProgramRow; role: Role | null; caps: ReadonlySet<Capability> };

/**
 * Esqueleto común: `runWithRls` con UN reintento ante P2034/40P01 (C2) →
 * capabilities → plan del tenant → `lockPlanPatient` PRIMERO (si la operación
 * es estructural, C2 (0)) → gate `plans.manage` → re-lectura bajo el lock →
 * `body`. Un `body` que devuelve un fail antes de escribir hace COMMIT de
 * nada; uno que ya escribió TIRA (Stale/Rejected) y la tx se revierte entera.
 */
async function runLifecycleFlow<R>(
  actor: Actor,
  programId: string,
  o: { structural: boolean },
  body: (tx: DbClient, ctx: FlowCtx) => Promise<LifecycleFlow<R | FlowFail>>
): Promise<LifecycleFlow<R | FlowFail>> {
  try {
    return await withTxConflictRetry(() =>
      runWithRls(actor.tenantId, async (tx) => {
        const { role, caps } = await actorRoleAndCapsInTx(tx, actor);
        const first = await loadLifecycleProgramInTx(tx, actor.tenantId, programId);
        if (!first) return { result: { ok: false as const, error: NOT_FOUND }, commit: null };
        if (o.structural) await lockPlanPatient(tx, { tenantId: actor.tenantId, patientId: first.patientId });
        await assertPlanManageInTx(tx, actor, caps, first.patientId);
        // Bajo el lock: lo que se decide y se escribe es esta lectura.
        const program = o.structural ? await loadLifecycleProgramInTx(tx, actor.tenantId, programId) : first;
        if (!program) return { result: { ok: false as const, error: NOT_FOUND }, commit: null };
        return body(tx, { program, role, caps });
      })
    );
  } catch (e) {
    const r = lifecycleRejection(e);
    if (r) return { result: r, commit: null };
    throw e;
  }
}

function bookingsNotice(b: PlanBookingsOutcome | null): string | undefined {
  if (!b || b.withPayment === 0) return undefined;
  return b.withPayment === 1
    ? "1 turno tiene un cobro registrado y quedó en la agenda."
    : `${b.withPayment} turnos tienen un cobro registrado y quedaron en la agenda.`;
}

/** D7: preview del diálogo (solo lectura, sin lock). */
export async function previewProgramStatusChangeFlow(
  actor: Actor,
  input: PlanStatusChangePreviewInputParsed,
  now: Date
): Promise<{ ok: true; preview: PlanStatusChangePreview } | PlanFail> {
  const flow = await runLifecycleFlow<{ ok: true; preview: PlanStatusChangePreview }>(
    actor,
    input.programId,
    { structural: false },
    async (tx, { program }) => {
      const rule = programTransition(program.status, input.to);
      const future = await loadFutureProgramBookingsInTx(tx, { tenantId: actor.tenantId, programId: program.id, now });
      return {
        result: {
          ok: true,
          preview: {
            from: program.status,
            to: input.to,
            allowed: rule != null && program.archivedAt == null,
            asksFutureBookings: rule?.asksFutureBookings ?? false,
            requiresConfirmation: rule?.requiresConfirmation ?? false,
            futureBookings: countFutureBookings(future),
            expectedUpdatedAt: program.updatedAt.toISOString(),
          },
        },
        commit: null,
      };
    }
  );
  return flow.result as { ok: true; preview: PlanStatusChangePreview } | PlanFail;
}

/**
 * Cambio de estado (D7). Orden de chequeos: archivado → mismo estado (no-op
 * idempotente: un doble click no falla ni audita dos veces, aunque traiga el
 * `updatedAt` viejo) → CAS → tabla → escribir.
 */
export async function changeProgramStatusFlow(
  actor: Actor,
  input: {
    programId: string;
    expectedUpdatedAt: ExpectedUpdatedAt;
    to: ProgramStatusValue;
    futureBookings?: FutureBookingsAction;
    confirm?: boolean;
  },
  now: Date
): Promise<LifecycleFlow<ChangePlanStatusResult>> {
  return runLifecycleFlow<ChangePlanStatusResult>(actor, input.programId, { structural: true }, async (tx, { program }) => {
    if (program.archivedAt) return { result: { ok: false, error: ARCHIVED }, commit: null };
    if (program.status === input.to) {
      return {
        result: {
          ok: true,
          data: { status: program.status, updatedAt: program.updatedAt.toISOString(), bookings: null, noop: true },
        },
        commit: null,
      };
    }
    if (input.expectedUpdatedAt && !sameInstant(input.expectedUpdatedAt, program.updatedAt)) {
      return { result: staleFail(), commit: null };
    }
    const d = decideProgramTransition(program.status, input.to, { futureBookings: input.futureBookings, confirm: input.confirm });
    if (!d.ok) {
      return {
        result: d.code === "needs-confirmation" ? { ok: false, kind: "needs-confirmation", error: d.error } : { ok: false, error: d.error },
        commit: null,
      };
    }
    if (d.noop) {
      // Inalcanzable (mismo estado se resolvió arriba); el tipo lo exige.
      return { result: { ok: true, data: { status: program.status, updatedAt: program.updatedAt.toISOString(), bookings: null, noop: true } }, commit: null };
    }
    const r = await applyProgramTransitionInTx(tx, actor, {
      program,
      to: input.to,
      rule: d.rule,
      futureBookings: d.futureBookings,
      now,
      reason: `program.${input.to.toLowerCase()}`,
    });
    const notice = bookingsNotice(r.bookings);
    return {
      result: {
        ok: true,
        data: { status: input.to, updatedAt: r.updatedAt.toISOString(), bookings: r.bookings, noop: false },
        ...(notice ? { notice } : {}),
      },
      commit: { patientId: program.patientId, refs: r.refs },
    };
  });
}

/**
 * Título y notas (PD-10), con CAS. No es estructural (C2: no toma
 * `lockPlanPatient`) ni toca turnos: no emite nada a la agenda más que el
 * revalidate del perfil.
 */
export async function updateProgramDetailsFlow(
  actor: Actor,
  input: { programId: string; expectedUpdatedAt: ExpectedUpdatedAt; title?: string; notes?: string | null }
): Promise<LifecycleFlow<UpdatePlanDetailsResult>> {
  return runLifecycleFlow<UpdatePlanDetailsResult>(actor, input.programId, { structural: false }, async (tx, { program }) => {
    if (program.archivedAt) return { result: { ok: false, error: ARCHIVED }, commit: null };
    if (input.expectedUpdatedAt && !sameInstant(input.expectedUpdatedAt, program.updatedAt)) {
      return { result: staleFail(), commit: null };
    }
    const current = await tx.treatmentProgram.findFirst({
      where: { id: program.id, tenantId: actor.tenantId },
      select: { title: true, notes: true },
    });
    const data: { title?: string; notes?: string | null } = {};
    if (input.title !== undefined && input.title !== current?.title) data.title = input.title;
    if (input.notes !== undefined && input.notes !== current?.notes) data.notes = input.notes;
    const fields = Object.keys(data);
    if (fields.length === 0) {
      return { result: { ok: true, data: { updatedAt: program.updatedAt.toISOString(), changed: false } }, commit: null };
    }
    const updatedAt = await casProgramUpdateInTx(tx, actor.tenantId, program, data);
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.update",
      entity: "TreatmentProgram",
      entityId: program.id,
      // Solo nombres de campo, nunca valores (AuditParams: sin PHI).
      payload: { fields },
    });
    return {
      result: { ok: true, data: { updatedAt: updatedAt.toISOString(), changed: true } },
      commit: { patientId: program.patientId, refs: [] },
    };
  });
}

/**
 * Archivar (§2.4): directo si está CANCELLED/COMPLETED; ACTIVE/PAUSED solo con
 * `cancelOpen` = la transición D7 a CANCELLED y el `archivedAt` en el MISMO
 * UPDATE (nunca queda un plan archivado abierto, I7). Reemplaza al
 * `deleteProgram` en duro: con turnos o autorizaciones vinculados el DELETE
 * daba P2003 (RESTRICT de M1) → 500.
 */
export async function archiveProgramFlow(
  actor: Actor,
  input: { programId: string; expectedUpdatedAt: ExpectedUpdatedAt; cancelOpen?: boolean; futureBookings?: FutureBookingsAction },
  now: Date
): Promise<LifecycleFlow<ArchivePlanResult>> {
  return runLifecycleFlow<ArchivePlanResult>(actor, input.programId, { structural: true }, async (tx, { program }) => {
    const d = decideProgramArchive(program.status, {
      archived: program.archivedAt != null,
      cancelOpen: input.cancelOpen,
      futureBookings: input.futureBookings,
    });
    if (!d.ok) return { result: { ok: false, error: d.error }, commit: null };
    if (input.expectedUpdatedAt && !sameInstant(input.expectedUpdatedAt, program.updatedAt)) {
      return { result: staleFail(), commit: null };
    }
    let updatedAt: Date;
    let bookings: PlanBookingsOutcome | null = null;
    let refs: BookingChangeRef[] = [];
    let status: ProgramStatusValue = program.status;
    if (d.cancelFirst) {
      const r = await applyProgramTransitionInTx(tx, actor, {
        program,
        to: "CANCELLED",
        rule: { revalidatesRefs: false },
        futureBookings: d.cancelFirst.futureBookings,
        now,
        reason: "program.archive",
        archive: true,
      });
      updatedAt = r.updatedAt;
      bookings = r.bookings;
      refs = r.refs;
      status = "CANCELLED";
    } else {
      updatedAt = await casProgramUpdateInTx(tx, actor.tenantId, program, { archivedAt: now });
      await assertProgramInvariantsInTx(tx, { tenantId: actor.tenantId, programId: program.id });
    }
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.archive",
      entity: "TreatmentProgram",
      entityId: program.id,
      payload: { status, cancelledFirst: d.cancelFirst != null },
    });
    const notice = bookingsNotice(bookings);
    return {
      result: { ok: true, data: { updatedAt: updatedAt.toISOString(), status, bookings }, ...(notice ? { notice } : {}) },
      commit: { patientId: program.patientId, refs },
    };
  });
}

/**
 * Restaurar (PD-10: OWNER/ADMIN): limpia `archivedAt` y el plan "vuelve al
 * estado que tenía" (§2.4) — que por I7 es CANCELLED o COMPLETED; reactivarlo
 * es otro paso, con su re-validación.
 */
export async function restoreProgramFlow(
  actor: Actor,
  input: { programId: string; expectedUpdatedAt: string }
): Promise<LifecycleFlow<RestorePlanResult>> {
  return runLifecycleFlow<RestorePlanResult>(actor, input.programId, { structural: true }, async (tx, { program, role }) => {
    if (!canRestoreProgram(role)) return { result: { ok: false, error: PLAN_LIFECYCLE_COPY.restoreForbidden }, commit: null };
    if (!program.archivedAt) return { result: { ok: false, error: PLAN_LIFECYCLE_COPY.notArchived }, commit: null };
    if (!sameInstant(input.expectedUpdatedAt, program.updatedAt)) return { result: staleFail(), commit: null };
    const updatedAt = await casProgramUpdateInTx(tx, actor.tenantId, program, { archivedAt: null });
    await assertProgramInvariantsInTx(tx, { tenantId: actor.tenantId, programId: program.id });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.restore",
      entity: "TreatmentProgram",
      entityId: program.id,
      payload: { status: program.status },
    });
    return {
      result: { ok: true, data: { updatedAt: updatedAt.toISOString(), status: program.status } },
      commit: { patientId: program.patientId, refs: [] },
    };
  });
}

/**
 * Post-commit, UNA vez y fuera de la tx (enmienda Realtime): agenda +
 * dashboard (`afterBookingsCommitted`, también con `refs` vacío: el estado del
 * plan cambia el chip y "Fuera de plan" de la agenda) y el perfil.
 */
export async function afterLifecycleCommit(tenantId: string, commit: { patientId: string; refs: BookingChangeRef[] }): Promise<void> {
  await afterBookingsCommitted(tenantId, commit.refs);
  revalidatePath(`/pacientes/${commit.patientId}`);
  revalidatePath("/seguimiento");
}
