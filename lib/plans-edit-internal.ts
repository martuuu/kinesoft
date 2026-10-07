import "server-only";

/**
 * Planes · cantidad, precio y autorización de la OS, dentro de la tx (S16b,
 * ES2b P2.2; PLANES.md §2.4, C2, C4 "Archivar sesión", C5, E2).
 *
 * Las actions finas (`lib/plans-edit.ts`) solo hacen `getActor` → zod →
 * `runWithRls` → esto, y traducen los errores a resultados. Acá vive el orden
 * de cada escritura, que es lo que importa (C2):
 *
 *   gate (`plan-authz-internal`) → `lockPlanPatient` (0) → [motor: cupos (1) →
 *   sedes (2)] → Booking `FOR UPDATE` id asc → Session → TreatmentProgram (3)
 *   → relectura bajo lock → decisión pura (`lib/plan-pricing.ts`) → escrituras
 *   por CAS → verificador (I5/I6) → `auditInTx`.
 *
 * Gates: cantidad, precio y restaurar = `plans.manage` (full + clinical.read;
 * restaurar además OWNER/ADMIN, §2.4). Renovar la autorización =
 * `plans.authorize` (la Secretaria puede, E2/PD-16).
 *
 * Realtime (enmienda): nada de acá emite. Cada `*InTx` DEVUELVE los
 * `BookingChangeRef` de los turnos que creó, canceló o re-estampó, y la action
 * llama `afterBookingsCommitted` una vez después del commit.
 *
 * El motor (`plans-engine-internal`, `plans-load-internal`) se consume tal
 * cual (C8 congelado): `addPlanSessions` = `newRows` SIN `sessionId` con
 * `priceCents` y `mode:'add'` (el motor escribe la caché `totalSessions`).
 */
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/session";
import { ForbiddenError } from "@/lib/session";
import type { DbClient } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { assertPlanAuthorizeInTx, assertPlanManageInTx } from "@/lib/plan-authz-internal";
import { lockPlanPatient } from "@/lib/plan-lock";
import { assertProgramInvariantsInTx } from "@/lib/plan-invariants-internal";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { formatARS } from "@/lib/format";
import { planSessionOrdinals } from "@/lib/plan-display";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import { PlanScheduleV1Schema } from "@/lib/plans-schemas";
import { canRestoreProgram, PLAN_LIFECYCLE_COPY } from "@/lib/plans-lifecycle-state";
import { addDays, dayKeyOf, dayKeyToDbDate, instantAt, minutesOfDayAR } from "@/lib/availability/day";
import { expandPlanDates, type PlanPreview, type PlanRowResolution } from "@/lib/availability/plan";
import {
  bookingHasMoney,
  repricePlan as repricePlanPure,
  repriceLockReason,
  type PlanPricing,
  type RepriceStamp,
} from "@/lib/plan-pricing";
import {
  lockProgramRowsInTx,
  packageKeepTotalWithNewRows,
  pricingColumns,
  programPricingOf,
  repriceRowsOf,
  sessionChangesOf,
  writeRepriceInTx,
  type SessionPriceChange,
} from "@/lib/plan-pricing-internal";
import { loadProgramForEngineInTx, type ProgramEngineRow } from "@/lib/plans-load-internal";
import {
  commitPlanRowsInTx,
  PlanRejected,
  PLAN_ENGINE_COPY,
  previewProgramRowsInTx,
  reclassifyOrThrowStaleInTx,
  StalePlanPreview,
  type PlanPreviewTarget,
} from "@/lib/plans-engine-internal";
import type {
  AddPlanSessionsInputParsed,
  PackageCountPricing,
  PlanPricingValue,
  RenewAuthorizationInputParsed,
  RepricePlanInputParsed,
  RepricePlanPreview,
} from "@/lib/plans-edit-types";
import type { z } from "zod";
import type { ArchivePlanSessionsSchema, RestorePlanSessionSchema, AddPlanSessionsPreviewSchema } from "@/lib/plans-edit-types";

// ─── Errores y copy ──────────────────────────────────────────────────────────

/** CAS perdido (expectedUpdatedAt / expectedCurrentId viejo, o una fila cambió). Rollback. */
export class PlanEditStale extends Error {
  constructor(detail = "stale") {
    super(detail);
    this.name = "PlanEditStale";
  }
}

/** Falta una confirmación explícita (reabrir un COMPLETED). */
export class PlanEditNeedsConfirmation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanEditNeedsConfirmation";
  }
}

export const PLAN_EDIT_COPY = {
  archived: "El plan está archivado.",
  cancelled: PLAN_LIFECYCLE_COPY.terminal,
  noSchedule: "Este plan no tiene horario: agregá una sesión a medida o re-planificalo.",
  noDates: "No encontramos fechas libres en el horario del plan para agregar esas sesiones.",
  tooMany: `Un plan puede tener hasta ${PLAN_MAX_SESSIONS} sesiones.`,
  packageChoice: (total: number) => `¿Mantenemos el total (${formatARS(total)}) o el precio por sesión?`,
  session: "Sesión inválida.",
  sessionCompleted: (n: number) => `La sesión ${n} ya está realizada: no se puede archivar.`,
  sessionWithPayment: (n: number) => `La sesión ${n} tiene un cobro registrado: no se puede archivar.`,
  notEnoughArchivable: (n: number) =>
    `Solo se ${n === 1 ? "puede archivar 1 sesión" : `pueden archivar ${n} sesiones`}: las demás están realizadas o tienen un cobro.`,
  sameCount: (n: number) => `El plan ya tiene ${n} ${n === 1 ? "sesión" : "sesiones"}.`,
  moreThanLive: "Para sumar sesiones usá «Agregar sesiones».",
  keepOne: "El plan tiene que quedar con al menos una sesión.",
  notArchivedSession: "La sesión no está archivada.",
  indexTaken: (n: number) => `Ya hay una sesión ${n} viva`,
  restoreForbidden: "Solo el dueño o un administrador pueden restaurar una sesión.",
} as const;

// ─── Comunes ─────────────────────────────────────────────────────────────────

/** Rol y capabilities leídos en la tx (sin una segunda conexión del pool). */
export async function roleAndCapsInTx(
  tx: DbClient,
  actor: Actor
): Promise<{ role: Prisma.MembershipGetPayload<{ select: { role: true } }>["role"] | null; caps: ReadonlySet<Capability> }> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  return { role: m?.role ?? null, caps: capabilitiesFor(m?.role) };
}

/**
 * Cabecera del plan para gatear: `where {id, tenantId}` a mano (prod =
 * BYPASSRLS). Ajeno o inexistente → mismo rechazo (sin oráculo de ids).
 */
async function programHeadInTx(tx: DbClient, tenantId: string, programId: string) {
  const p = await tx.treatmentProgram.findFirst({
    where: { id: programId, tenantId },
    select: { id: true, patientId: true, archivedAt: true },
  });
  if (!p) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  return p;
}

/** Relectura bajo lock + CAS del `updatedAt` del plan (C2 (3): al final del orden de filas). */
async function lockedProgramInTx(
  tx: DbClient,
  tenantId: string,
  programId: string,
  expectedUpdatedAt: string | null
): Promise<ProgramEngineRow> {
  await lockProgramRowsInTx(tx, { tenantId, programId });
  const program = await loadProgramForEngineInTx(tx, tenantId, programId);
  if (!program) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  if (program.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.archived, "programId");
  if (expectedUpdatedAt !== null && +program.updatedAt !== +new Date(expectedUpdatedAt)) throw new PlanEditStale();
  return program;
}

/** Escritura final del plan con el CAS repetido (cinturón: el lock ya está tomado). */
async function writeProgramInTx(
  tx: DbClient,
  tenantId: string,
  program: Pick<ProgramEngineRow, "id" | "updatedAt">,
  data: Prisma.TreatmentProgramUpdateManyMutationInput
): Promise<Date> {
  const res = await tx.treatmentProgram.updateMany({ where: { id: program.id, tenantId, updatedAt: program.updatedAt }, data });
  if (res.count !== 1) throw new PlanEditStale("program");
  const after = await tx.treatmentProgram.findFirst({ where: { id: program.id, tenantId }, select: { updatedAt: true } });
  return after!.updatedAt;
}

const ACTIVE_BOOKING = new Set(["PENDING", "CONFIRMED", "COMPLETED"]);
type EngineSession = ProgramEngineRow["sessions"][number];
const activeOf = (s: EngineSession) => s.bookings.find((b) => ACTIVE_BOOKING.has(b.status)) ?? null;
const pricingJson = (p: PlanPricing) => pricingColumns(p);

// ─── Reprecio (C5, dos ramas + desestampado) ─────────────────────────────────

export type RepriceInTxResult = {
  updatedAt: string;
  stampedBookings: number;
  sessionsChanged: number;
  refs: BookingChangeRef[];
  patientId: string;
};

/** Preview del reprecio (solo lectura): mismo cálculo puro que el commit, sin locks. */
export async function previewRepriceInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: RepricePlanInputParsed,
  now: Date
): Promise<RepricePlanPreview> {
  const head = await programHeadInTx(tx, actor.tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  const program = await loadProgramForEngineInTx(tx, actor.tenantId, input.programId);
  if (!program) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  if (program.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.archived, "programId");
  const rows = repriceRowsOf(program);
  const current = programPricingOf(program) as PlanPricingValue;
  const next = input.pricing as PlanPricingValue;
  const locks = rows.map((s) => repriceLockReason(s, now));
  // "M quedan como están (cobrados o pasados)": turnos activos de las filas bloqueadas.
  const bookingsKept = program.sessions.filter((s, i) => locks[i] !== null && activeOf(s) !== null).length;
  const r = repricePlanPure({ pricing: input.pricing, sessions: rows, now });
  if (!r.ok) {
    const lockedCents = rows.reduce((a, s, i) => a + (locks[i] ? (s.priceCents ?? 0) : 0), 0);
    return { current, next, bookingsToStamp: 0, bookingsKept, sessionsChanged: 0, lockedCents, error: r.error };
  }
  return {
    current,
    next,
    bookingsToStamp: r.stamps.length,
    bookingsKept,
    sessionsChanged: r.sessions.filter((s) => s.changed).length,
    lockedCents: r.lockedCents,
  };
}

/**
 * Reprecio C5: gate manage → `lockPlanPatient` → Booking/Session/Program
 * `FOR UPDATE` → relectura → `repricePlan` puro → CAS por fila (cuotas y
 * turnos, conteo conjunto) → plan (CAS `updatedAt`) → verificador → audit con
 * antes/después. Solo futuros impagos; lo bloqueado conserva su monto.
 */
export async function repricePlanInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: RepricePlanInputParsed,
  now: Date
): Promise<RepriceInTxResult> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });
  const program = await lockedProgramInTx(tx, tenantId, input.programId, input.expectedUpdatedAt);

  const rows = repriceRowsOf(program);
  const r = repricePlanPure({ pricing: input.pricing, sessions: rows, now });
  if (!r.ok) throw new PlanRejected(r.error, "pricing");
  const sessions = sessionChangesOf(rows, r);
  const written = await writeRepriceInTx(tx, { tenantId, programId: program.id, sessions, stamps: r.stamps, now });
  const before = pricingJson(programPricingOf(program));
  const after = pricingColumns(input.pricing);
  const updatedAt = await writeProgramInTx(tx, tenantId, program, after);

  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.reprice",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      before,
      after,
      sessionsChanged: sessions.length,
      stampedBookingIds: written.stampedBookingIds,
      branches: countBranches(r.stamps),
    },
  });
  return {
    updatedAt: updatedAt.toISOString(),
    stampedBookings: written.stampedBookingIds.length,
    sessionsChanged: sessions.length,
    refs: written.refs,
    patientId: head.patientId,
  };
}

function countBranches(stamps: readonly RepriceStamp[]): Record<RepriceStamp["branch"], number> {
  const out = { restamp: 0, first: 0, unstamp: 0 };
  for (const s of stamps) out[s.branch]++;
  return out;
}

// ─── Agregar sesiones (motor, mode 'add') ────────────────────────────────────

type AddInput = z.output<typeof AddPlanSessionsPreviewSchema> | AddPlanSessionsInputParsed;

/** Lo que el motor recibe + lo que S16b escribe aparte (paquete). */
type AddBuild = {
  target: Extract<PlanPreviewTarget, { newRows: unknown }>;
  /** Resoluciones que pone el server (una "a medida" sin fecha = sin turno). */
  forced: PlanRowResolution[];
  /** PACKAGE "mantener el total": cuotas de las existentes que cambian + re-estampados. */
  existingChanges: SessionPriceChange[];
  existingStamps: RepriceStamp[];
  /** Precio del plan después (null = no cambia). */
  pricingAfter: PlanPricing | undefined;
};

/** Primer `index` libre: sobre TODAS las sesiones (también archivadas), para que `restoreSession` no choque (M13). */
async function programExtrasInTx(tx: DbClient, tenantId: string, programId: string) {
  const p = await tx.treatmentProgram.findFirst({
    where: { id: programId, tenantId },
    select: { startDate: true, sessions: { select: { index: true }, orderBy: { index: "desc" }, take: 1 } },
  });
  if (!p) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  return { startDate: p.startDate, maxIndex: p.sessions[0]?.index ?? 0 };
}

/**
 * Fechas de N sesiones al final, siguiendo el horario del plan: se expande
 * desde el INICIO del plan (así un "cada 2 semanas" conserva su fase) y se
 * toman las posteriores a la última sesión viva y a `now`. Si el horario
 * original no alcanza (sesiones corridas más allá de 60 ocurrencias), se
 * sigue desde el día siguiente a la última.
 */
function appendDates(
  schedule: z.output<typeof PlanScheduleV1Schema>,
  startDate: Date,
  floor: Date,
  count: number,
  now: Date
): Date[] {
  const after = (d: Date) => d.getTime() > floor.getTime();
  const fromStart = expandPlanDates({ schedule, startDayKey: dayKeyOf(startDate), count: PLAN_MAX_SESSIONS, now })
    .map((r) => r.at)
    .filter(after);
  if (fromStart.length >= count) return fromStart.slice(0, count);
  const more = expandPlanDates({ schedule, startDayKey: addDays(dayKeyOf(floor), 1), count, now })
    .map((r) => r.at)
    .filter(after);
  const seen = new Set<number>();
  return [...fromStart, ...more]
    .filter((d) => (seen.has(+d) ? false : (seen.add(+d), true)))
    .sort((a, b) => +a - +b)
    .slice(0, count);
}

/**
 * Arma las filas nuevas y su plata (D5: la cuota la decide el plan, nunca el
 * cliente). Determinística dado el plan y `now`: el preview y el commit la
 * recalculan y el `stateToken` (que incluye el target con las cuotas y el
 * `updatedAt` del plan) ata uno con otro.
 */
function buildAdd(
  program: ProgramEngineRow,
  extras: { startDate: Date; maxIndex: number },
  input: AddInput,
  now: Date
): AddBuild {
  const live = program.sessions;
  const count = input.kind === "append" ? (input.count ?? 0) : 1;
  if (live.length + count > PLAN_MAX_SESSIONS) throw new PlanRejected(PLAN_EDIT_COPY.tooMany, "count");
  const lastAt = live.reduce((a, s) => Math.max(a, s.scheduledFor.getTime()), 0);
  const floor = new Date(Math.max(lastAt, now.getTime()));
  const sched = PlanScheduleV1Schema.safeParse(program.schedule);
  const schedule = sched.success ? sched.data : null;

  let dates: Date[];
  const forced: PlanRowResolution[] = [];
  if (input.kind === "append") {
    if (!schedule) throw new PlanRejected(PLAN_EDIT_COPY.noSchedule, "kind");
    dates = appendDates(schedule, extras.startDate, floor, count, now);
    if (dates.length < count) throw new PlanRejected(PLAN_EDIT_COPY.noDates, "count");
  } else if (input.at) {
    dates = [new Date(input.at)];
  } else {
    // "A medida" sin fecha: queda sin turno (resolución `none` forzada). Su
    // fecha planificada es el próximo hueco del horario o, sin horario, el día
    // AR de `floor` + 7 a la hora de pared de la última sesión viva (00:00 si
    // no hay), para que ordene al final en Seguimiento.
    //
    // P3.Z (F1): antes era `floor + 7 días` crudo. Con todas las sesiones en
    // el pasado `floor` es `now` (con milisegundos): el preview y el commit
    // corren con `now` distintos → otra fecha → otro `stateToken` → stale
    // SIEMPRE, también en el reintento del editor. Anclado al día AR es
    // determinístico dentro del día (cruzar la medianoche AR entre preview y
    // commit da un stale legítimo, una vez). Con la última sesión en el futuro
    // da lo mismo que antes (su día + 7 a su hora).
    const next = schedule ? appendDates(schedule, extras.startDate, floor, 1, now)[0] : undefined;
    dates = [next ?? instantAt(addDays(dayKeyOf(floor), 7), lastAt > 0 ? minutesOfDayAR(new Date(lastAt)) : 0)];
    forced.push({ index: extras.maxIndex + 1, kind: "none" });
  }
  const newRows = dates.map((at, i) => ({ index: extras.maxIndex + 1 + i, at }));

  const pricing = programPricingOf(program);
  let prices: Array<number | null>;
  let pricingAfter: PlanPricing | undefined;
  let existingChanges: SessionPriceChange[] = [];
  let existingStamps: RepriceStamp[] = [];
  if (!pricing) prices = newRows.map(() => null);
  else if (pricing.mode === "PER_SESSION") prices = newRows.map(() => pricing.pricePerSessionCents);
  else {
    const choice: PackageCountPricing | undefined = input.packagePricing;
    if (!choice) throw new PlanRejected(PLAN_EDIT_COPY.packageChoice(pricing.totalPriceCents), "packagePricing");
    if (choice === "keep-per-session") {
      // "El precio por sesión" = la cuota de la última sesión viva (por fecha;
      // en un reparto P4 es la base, sin el peso de resto). Sin sesiones, el
      // promedio.
      const ord = [...live].sort((a, b) => +a.scheduledFor - +b.scheduledFor || a.index - b.index);
      const unit = ord.at(-1)?.priceCents ?? (live.length ? Math.floor(pricing.totalPriceCents / live.length) : 0);
      prices = newRows.map(() => unit);
      pricingAfter = { mode: "PACKAGE", totalPriceCents: pricing.totalPriceCents + unit * newRows.length };
    } else {
      const rows = repriceRowsOf(program);
      const r = packageKeepTotalWithNewRows({ totalCents: pricing.totalPriceCents, sessions: rows, newRows, now });
      if (!r.ok) throw new PlanRejected(r.error, "packagePricing");
      prices = newRows.map((n) => r.newPrices.get(n.index) ?? 0);
      existingChanges = sessionChangesOf(rows, r.existing);
      existingStamps = r.existing.stamps;
    }
  }
  const title = input.kind === "custom" ? (input.title ?? null) : null;
  return {
    target: {
      newRows: newRows.map((n, i) => ({ at: n.at.toISOString(), index: n.index, priceCents: prices[i], title })),
    },
    forced,
    existingChanges,
    existingStamps,
    pricingAfter,
  };
}

/** Resoluciones del cliente + las forzadas por el server (pisan por `index`). */
function mergeResolutions(client: ReadonlyArray<PlanRowResolution>, forced: ReadonlyArray<PlanRowResolution>): PlanRowResolution[] {
  const m = new Map(client.map((r) => [r.index, r]));
  for (const f of forced) m.set(f.index, f);
  return Array.from(m.values());
}

function assertAddableStatus(status: ProgramEngineRow["status"]): void {
  if (status === "CANCELLED") throw new PlanRejected(PLAN_EDIT_COPY.cancelled, "programId");
}

/** Preview de "agregar sesiones" (solo lectura). Gate `plans.manage`. */
export async function previewAddSessionsInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: AddInput,
  now: Date
): Promise<PlanPreview> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  const program = await loadProgramForEngineInTx(tx, tenantId, input.programId);
  if (!program) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  if (program.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.archived, "programId");
  assertAddableStatus(program.status);
  const build = buildAdd(program, await programExtrasInTx(tx, tenantId, program.id), input, now);
  return previewProgramRowsInTx(tx, actor, {
    programId: program.id,
    target: build.target,
    mode: "add",
    overrides: mergeResolutions(input.rows, build.forced),
    now,
  });
}

export type AddSessionsInTxResult = {
  sessionIds: string[];
  createdBookings: number;
  totalSessions: number;
  reopened: boolean;
  refs: BookingChangeRef[];
  patientId: string;
};

/**
 * Commit de "agregar sesiones" (C2 completo): gate → `lockPlanPatient` →
 * `reclassifyOrThrowStaleInTx` (cupos → sedes → adoptados → stale) →
 * Booking/Session/Program `FOR UPDATE` → relectura: el plan y la plata tienen
 * que ser los del preview (si no, `StalePlanPreview(null)` y la action
 * re-previsualiza) → `commitPlanRowsInTx` modo `add` (sesiones, turnos, caché
 * `totalSessions`) → redistribución del paquete (CAS) → plan (precio, reabrir)
 * → verificador → audit.
 */
export async function addSessionsInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: AddPlanSessionsInputParsed,
  now: Date
): Promise<AddSessionsInTxResult> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });

  const before = await loadProgramForEngineInTx(tx, tenantId, input.programId);
  if (!before) throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  if (before.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.archived, "programId");
  assertAddableStatus(before.status);
  const reopen = before.status === "COMPLETED";
  if (reopen && input.confirmReopen !== true) throw new PlanEditNeedsConfirmation(PLAN_LIFECYCLE_COPY.confirmReopen);

  const extras = await programExtrasInTx(tx, tenantId, before.id);
  const build = buildAdd(before, extras, input, now);
  const resolutions = mergeResolutions(input.rows, build.forced);
  const cp = await reclassifyOrThrowStaleInTx(tx, actor, {
    programId: before.id,
    rows: build.target,
    resolutions,
    now,
    mode: "add",
    stateToken: input.stateToken,
  });

  // C2 (3) + relectura: lo que se escribe es lo que se previsualizó.
  const locked = await lockedProgramInTx(tx, tenantId, before.id, null);
  if (+locked.updatedAt !== +cp.program.updatedAt) throw new StalePlanPreview(null, "write-conflict");
  const again = buildAdd(locked, extras, input, now);
  if (
    JSON.stringify(again.target) !== JSON.stringify(build.target) ||
    JSON.stringify(again.existingChanges) !== JSON.stringify(build.existingChanges) ||
    JSON.stringify(again.existingStamps) !== JSON.stringify(build.existingStamps)
  ) {
    throw new StalePlanPreview(null, "write-conflict");
  }

  const written = await commitPlanRowsInTx(tx, actor, {
    program: {
      id: locked.id,
      patientId: locked.patientId,
      practitionerId: cp.ctx.practitionerId,
      serviceId: cp.ctx.serviceId,
      locationId: cp.ctx.locationId,
      durationMin: cp.ctx.durationMin,
    },
    rows: cp,
    mode: "add",
    now,
  });
  const repriced = await writeRepriceInTx(tx, {
    tenantId,
    programId: locked.id,
    sessions: again.existingChanges,
    stamps: again.existingStamps,
    now,
  });
  const programData: Prisma.TreatmentProgramUpdateManyMutationInput = {
    ...(again.pricingAfter !== undefined ? pricingColumns(again.pricingAfter) : {}),
    ...(reopen ? { status: "ACTIVE" as const } : {}),
  };
  if (Object.keys(programData).length) {
    await tx.treatmentProgram.updateMany({ where: { id: locked.id, tenantId }, data: programData });
  }

  const newIndexes = build.target.newRows.map((r) => r.index as number);
  const sessionIds = newIndexes.map((i) => written.sessionIds.get(i)!).filter(Boolean);
  const totalSessions = locked.sessions.length + sessionIds.length;
  await assertProgramInvariantsInTx(tx, { tenantId, programId: locked.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.sessions.add",
    entity: "TreatmentProgram",
    entityId: locked.id,
    payload: {
      kind: input.kind,
      sessionIds,
      createdBookings: written.createdBookings,
      adoptedBookings: written.adoptedBookings,
      generationId: written.generationId,
      totalSessions: { before: locked.sessions.length, after: totalSessions },
      packagePricing: input.packagePricing ?? null,
      pricing: again.pricingAfter !== undefined ? { before: pricingJson(programPricingOf(locked)), after: pricingColumns(again.pricingAfter) } : null,
      restampedBookingIds: repriced.stampedBookingIds,
      reopened: reopen,
    },
  });
  return {
    sessionIds,
    createdBookings: written.createdBookings,
    totalSessions,
    reopened: reopen,
    refs: [...written.refs, ...repriced.refs],
    patientId: head.patientId,
  };
}

// ─── Archivar sesiones / reducir la cantidad (§2.4, C4) ──────────────────────

type ArchiveInput = z.output<typeof ArchivePlanSessionsSchema>;

export type ArchiveSessionsInTxResult = {
  updatedAt: string;
  archivedSessionIds: string[];
  cancelledBookings: number;
  totalSessions: number;
  refs: BookingChangeRef[];
  patientId: string;
};

/** ¿Por qué no se puede archivar? (§2.4: realizada, turno COMPLETED o con cobro, incluido un previo cobrado). */
function archiveBlock(s: EngineSession): "completed" | "money" | null {
  if (s.completedAt != null || s.bookings.some((b) => b.status === "COMPLETED")) return "completed";
  if (s.bookings.some((b) => bookingHasMoney(b))) return "money";
  return null;
}

/**
 * Archivar sesiones (explícitas) o reducir a `totalSessions` (se archivan las
 * ÚLTIMAS por fecha que se pueden archivar: "las últimas sin cobro"). Una
 * sesión explícita realizada o con cobro → rechazo. El turno activo impago de
 * cada archivada se cancela en la tx (`cancelBookingsInTx`). PACKAGE pregunta:
 * mantener el total (se reparte lo archivado entre las libres que quedan) o el
 * precio por sesión (el total baja lo que valían las archivadas).
 */
export async function archiveSessionsInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: ArchiveInput,
  now: Date
): Promise<ArchiveSessionsInTxResult> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });
  const program = await lockedProgramInTx(tx, tenantId, input.programId, input.expectedUpdatedAt);

  const live = program.sessions;
  const ordinals = planSessionOrdinals(live.map((s) => ({ ...s, archivedAt: null })));
  const nOf = (s: EngineSession) => ordinals.get(s.id) ?? s.index;
  let targets: EngineSession[];
  if (input.sessionIds) {
    const byId = new Map(live.map((s) => [s.id, s]));
    targets = input.sessionIds.map((id) => {
      const s = byId.get(id);
      if (!s) throw new PlanRejected(PLAN_EDIT_COPY.session, "sessionIds");
      const why = archiveBlock(s);
      if (why === "completed") throw new PlanRejected(PLAN_EDIT_COPY.sessionCompleted(nOf(s)), "sessionIds");
      if (why === "money") throw new PlanRejected(PLAN_EDIT_COPY.sessionWithPayment(nOf(s)), "sessionIds");
      return s;
    });
  } else {
    const total = input.totalSessions!;
    if (total === live.length) throw new PlanRejected(PLAN_EDIT_COPY.sameCount(total), "totalSessions");
    if (total > live.length) throw new PlanRejected(PLAN_EDIT_COPY.moreThanLive, "totalSessions");
    const k = live.length - total;
    const archivable = live
      .filter((s) => archiveBlock(s) === null)
      .sort((a, b) => +b.scheduledFor - +a.scheduledFor || b.index - a.index);
    if (archivable.length < k) throw new PlanRejected(PLAN_EDIT_COPY.notEnoughArchivable(archivable.length), "totalSessions");
    targets = archivable.slice(0, k);
  }
  if (targets.length >= live.length) throw new PlanRejected(PLAN_EDIT_COPY.keepOne, "sessionIds");
  const archivedIds = new Set(targets.map((s) => s.id));
  const remaining = live.filter((s) => !archivedIds.has(s.id));

  // Plata del paquete (decidida ANTES de escribir: un rechazo no deja nada).
  const pricing = programPricingOf(program);
  let pricingAfter: PlanPricing | undefined;
  let changes: SessionPriceChange[] = [];
  let stamps: RepriceStamp[] = [];
  if (pricing?.mode === "PACKAGE") {
    if (!input.packagePricing) throw new PlanRejected(PLAN_EDIT_COPY.packageChoice(pricing.totalPriceCents), "packagePricing");
    if (input.packagePricing === "keep-per-session") {
      const gone = targets.reduce((a, s) => a + (s.priceCents ?? 0), 0);
      pricingAfter = { mode: "PACKAGE", totalPriceCents: pricing.totalPriceCents - gone };
    } else {
      const rows = repriceRowsOf({ sessions: remaining });
      const r = repricePlanPure({ pricing, sessions: rows, now });
      if (!r.ok) throw new PlanRejected(r.error, "packagePricing");
      changes = sessionChangesOf(rows, r);
      stamps = r.stamps;
    }
  }

  // Turnos activos impagos de las archivadas: se cancelan (ya están lockeados).
  const toCancel = targets.flatMap((s) => {
    const b = activeOf(s);
    return b ? [b.id] : [];
  });
  const cancelled = await cancelBookingsInTx(tx, {
    tenantId,
    bookingIds: toCancel,
    reason: "Sesión del plan archivada",
    actorId: actor.userId,
    auditAction: "booking.cancel.plan-session-archive",
  });
  if (cancelled.cancelled.length !== toCancel.length) throw new PlanEditStale("cancel");

  const res = await tx.session.updateMany({
    where: { id: { in: Array.from(archivedIds) }, programId: program.id, program: { tenantId }, archivedAt: null, completedAt: null },
    data: { archivedAt: now },
  });
  if (res.count !== archivedIds.size) throw new PlanEditStale("sessions");
  const repriced = await writeRepriceInTx(tx, { tenantId, programId: program.id, sessions: changes, stamps, now });
  const updatedAt = await writeProgramInTx(tx, tenantId, program, {
    totalSessions: remaining.length,
    ...(pricingAfter !== undefined ? pricingColumns(pricingAfter) : {}),
  });

  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.sessions.archive",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      sessionIds: Array.from(archivedIds),
      cancelledBookingIds: cancelled.cancelled.map((c) => c.id),
      totalSessions: { before: live.length, after: remaining.length },
      packagePricing: input.packagePricing ?? null,
      pricing: pricingAfter !== undefined ? { before: pricingJson(pricing), after: pricingColumns(pricingAfter) } : null,
      restampedBookingIds: repriced.stampedBookingIds,
    },
  });
  const refs: BookingChangeRef[] = [
    ...cancelled.cancelled.map((c) => ({ bookingId: c.id, practitionerId: c.practitionerId, scheduledFor: c.scheduledFor, prev: null, kind: "booking" as const })),
    ...repriced.refs,
  ];
  return {
    updatedAt: updatedAt.toISOString(),
    archivedSessionIds: Array.from(archivedIds),
    cancelledBookings: cancelled.cancelled.length,
    totalSessions: remaining.length,
    refs,
    patientId: head.patientId,
  };
}

// ─── Restaurar una sesión (§2.4, M13) ────────────────────────────────────────

type RestoreInput = z.output<typeof RestorePlanSessionSchema>;

/**
 * `restoreSession` (OWNER/ADMIN + `plans.manage`): la sesión vuelve viva SIN
 * turno (el suyo se canceló al archivarla) y con su `index` (nunca se
 * renumera: si otra viva lo tomó → "Ya hay una sesión N viva"). Cuota:
 * PER_SESSION = la vigente del plan; sin precio = null; PACKAGE = conserva la
 * suya y el total sube lo mismo ("precio por sesión": no hay a quién
 * preguntarle y redistribuir tocaría turnos de otras sesiones).
 */
export async function restoreSessionInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  role: Parameters<typeof canRestoreProgram>[0],
  input: RestoreInput
): Promise<{ updatedAt: string; totalSessions: number; patientId: string }> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  if (!canRestoreProgram(role)) throw new ForbiddenError(PLAN_EDIT_COPY.restoreForbidden);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });
  const program = await lockedProgramInTx(tx, tenantId, input.programId, input.expectedUpdatedAt);

  const s = await tx.session.findFirst({
    where: { id: input.sessionId, programId: program.id, program: { tenantId } },
    select: { id: true, index: true, archivedAt: true, priceCents: true },
  });
  if (!s) throw new PlanRejected(PLAN_EDIT_COPY.session, "sessionId");
  if (!s.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.notArchivedSession, "sessionId");
  if (program.sessions.some((x) => x.index === s.index)) throw new PlanRejected(PLAN_EDIT_COPY.indexTaken(s.index), "sessionId");
  if (program.sessions.length + 1 > PLAN_MAX_SESSIONS) throw new PlanRejected(PLAN_EDIT_COPY.tooMany, "sessionId");

  const pricing = programPricingOf(program);
  const priceCents = !pricing ? null : pricing.mode === "PER_SESSION" ? pricing.pricePerSessionCents : (s.priceCents ?? 0);
  const res = await tx.session.updateMany({
    where: { id: s.id, programId: program.id, program: { tenantId }, archivedAt: { not: null } },
    data: { archivedAt: null, priceCents },
  });
  if (res.count !== 1) throw new PlanEditStale("session");
  const totalSessions = program.sessions.length + 1;
  const updatedAt = await writeProgramInTx(tx, tenantId, program, {
    totalSessions,
    ...(pricing?.mode === "PACKAGE" ? { totalPriceCents: pricing.totalPriceCents + (priceCents ?? 0) } : {}),
  });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.session.restore",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: { sessionId: s.id, index: s.index, totalSessions },
  });
  return { updatedAt: updatedAt.toISOString(), totalSessions, patientId: head.patientId };
}

// ─── Renovar la autorización de la OS (E2) ───────────────────────────────────

/**
 * E2 (literal): en una tx con `lockPlanPatient`, CAS sobre la vigente
 * (`expectedCurrentId`), `UPDATE … SET "supersededAt" = now() WHERE
 * "programId" = $1 AND "supersededAt" IS NULL` + `INSERT` de la nueva,
 * `auditInTx` solo con ids. Gate `plans.authorize` (la Secretaria puede).
 * Dos renovaciones concurrentes: el lock las serializa y la segunda ve otra
 * vigente → stale. El único parcial `ProgramAuthorization_programId_current_key`
 * es la red si algo se saltea el lock.
 */
export async function renewAuthorizationInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: RenewAuthorizationInputParsed,
  now: Date
): Promise<{ authorizationId: string; supersededId: string | null; patientId: string }> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanAuthorizeInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });
  if (head.archivedAt) throw new PlanRejected(PLAN_EDIT_COPY.archived, "programId");

  const current = await tx.programAuthorization.findFirst({
    where: { programId: head.id, tenantId, supersededAt: null },
    select: { id: true },
  });
  if ((current?.id ?? null) !== input.expectedCurrentId) throw new PlanEditStale("authorization");
  if (current) {
    const res = await tx.programAuthorization.updateMany({
      where: { programId: head.id, tenantId, supersededAt: null },
      data: { supersededAt: now },
    });
    if (res.count !== 1) throw new PlanEditStale("authorization");
  }
  const created = await tx.programAuthorization.create({
    data: {
      tenantId,
      programId: head.id,
      code: input.code ?? null,
      authorizedSessions: input.authorizedSessions ?? null,
      startsOn: dayKeyToDbDate(input.startsOnDayKey),
      expiresOn: input.expiresOnDayKey ? dayKeyToDbDate(input.expiresOnDayKey) : null,
      createdById: actor.userId,
    },
    select: { id: true },
  });
  // Solo ids: el código y las fechas de la orden no van al audit (§2.6).
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.authorization.renew",
    entity: "TreatmentProgram",
    entityId: head.id,
    payload: { authorizationId: created.id, supersededId: current?.id ?? null },
  });
  return { authorizationId: created.id, supersededId: current?.id ?? null, patientId: head.patientId };
}
