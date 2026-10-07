import "server-only";

/**
 * Planes · mover en serie (D23) y re-planificar (L7) — núcleo server-only
 * (S16a, ES2b P2.2). Las actions finas viven en `lib/plans-move.ts`.
 *
 * Consume SOLO lo publicado (C8, S07c, S11e, P2-C2): el motor
 * (`previewProgramRowsInTx`, `reclassifyOrThrowStaleInTx`, `commitPlanRowsInTx`,
 * `validatePlanRefsInTx`), el core de turnos (`applyBookingUpdateInTx` con
 * `capLocksHeld:true`), `cancelBookingsInTx` y el verificador
 * (`assertProgramInvariantsInTx`). Nada de acá emite: los `*InTx` DEVUELVEN
 * `BookingChangeRef[]` y la action llama `afterBookingsCommitted` una vez,
 * después del commit y fuera de la tx (enmienda Realtime).
 *
 * Orden de locks (C2 / tabla C4 "Este y los siguientes / re-planificar",
 * literal: paciente → cupos → sedes → Booking asc → Session):
 *   (0) `lockPlanPatient` primero, después del gate (el gate solo lee).
 *   (1) Cupos: UNA `lockCapacityMany` con el SUPERCONJUNTO de las claves que
 *       después piden el motor (profesional/servicio del plan en cada destino)
 *       y el core (profesional/servicio de CADA turno en su destino). El motor
 *       vuelve a pedir las suyas dentro de `reclassifyOrThrowStaleInTx`, pero
 *       los advisory locks son reentrantes en la misma sesión: no espera nada
 *       y no queda ningún cupo tomado DESPUÉS de una fila.
 *   (2) `lockTenantLocationsShared` una vez (el motor y el core lo re-piden
 *       compartido: reentrante).
 *   (3) Booking `FOR UPDATE` id asc de TODOS los turnos que se tocan (los de la
 *       serie / los futuros a cancelar ∪ los adoptados), en una sentencia.
 *       Después Session (write-through del core / commit del motor; en
 *       re-planificar, `FOR UPDATE` id asc de la selección ANTES de escribir
 *       el plan, P2-Z/H-a2.2) y al final TreatmentProgram.
 *
 * Desvío documentado (re-planificar con cambio de profesional/servicio/sede/
 * duración): el motor lee las refs DEL PLAN (`programEngineInTx`), así que el
 * plan se actualiza ANTES de re-clasificar, pero DESPUÉS de lockear los
 * Booking y las Session de la selección (P2-Z, H-a2.2: antes se escribía el
 * plan y las sesiones se esperaban en el commit → ciclo con Seguimiento y
 * rescheduleSession, que van Session → Program). Se escribe con el `updatedAt`
 * original (Prisma respeta un `@updatedAt` explícito) para que el `stateToken`
 * del motor siga siendo el CAS del plan; el bump va al final.
 *
 * "Replan cancela los futuros impagos antes de re-clasificar" (nota S11e): acá
 * se cancelan DESPUÉS de re-clasificar y antes del commit. Es equivalente para
 * la clasificación (el motor ya excluye el turno activo de cada sesión con
 * `excludeBookingId`) y respeta C2 (cupo antes que filas: `cancelBookingsInTx`
 * no toma cupo pero lockea Booking).
 */
import type { Actor } from "@/lib/session";
import type { DbClient } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import { auditInTx } from "@/lib/audit";
import type { Capability } from "@/lib/capabilities";
import { assertPlanManageInTx, assertPlanScheduleInTx } from "@/lib/plan-authz-internal";
import { lockPlanPatient } from "@/lib/plan-lock";
import { capacityKeysForWindow, lockCapacityMany, type CapacityLockKey } from "@/lib/booking-cap-lock";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { assertProgramInvariantsInTx } from "@/lib/plan-invariants-internal";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { planSessionOrdinals } from "@/lib/plan-display";
import { applyBookingUpdateInTx, type BookingUpdatePatch } from "@/lib/bookings-core";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { addDays, dayKeyDiff, dayKeyOf, instantAt, minutesOfDayAR } from "@/lib/availability/day";
import { expandPlanDates, planStateToken, type PlanPreview, type PlanRowResolution, type PlanScheduleV1 } from "@/lib/availability/plan";
import {
  PlanRejected,
  StalePlanPreview,
  commitPlanRowsInTx,
  legacyFrequency,
  previewProgramRowsInTx,
  reclassifyOrThrowStaleInTx,
  validatePlanRefsInTx,
  type PlanPreviewTarget,
  type PlanRefsOk,
} from "@/lib/plans-engine-internal";
import { loadProgramForEngineInTx, type ProgramEngineRow } from "@/lib/plans-load-internal";
import type { MovePlanSeriesInputParsed, ReplanPlanInputParsed } from "@/lib/plans-edit-types";

const MIN_MS = 60_000;
const DAY_MIN = 1440;

export const PLAN_MOVE_COPY = {
  program: "Plan inválido.",
  notActive: "El plan no está activo: reactivalo antes de re-planificar.",
  notMovable: "El plan está cancelado o finalizado: no se pueden mover sus turnos.",
  session: "La sesión no es de este plan.",
  notPending: (ordinal: number) => `La sesión ${ordinal} ya no está pendiente.`,
  nothingToReplan: "No hay sesiones pendientes para re-planificar desde esa sesión.",
  pastStart: "La fecha de inicio no puede ser anterior a hoy.",
  resolution: "Al mover en serie cada fila se mueve o se deja como está (no se adopta ni se marca realizada).",
  token: "Cambiaste el pedido desde la vista previa: revisá los turnos de nuevo.",
  conflict: (ordinal: number) =>
    `No se pudo mover el turno de la sesión ${ordinal}: la agenda cambió. No se movió ningún turno; probá de nuevo.`,
} as const;

/** Turno activo de una sesión para I2 (PENDING/CONFIRMED/COMPLETED). */
const ACTIVE_FOR_SESSION: ReadonlySet<string> = new Set(["PENDING", "CONFIRMED", "COMPLETED"]);
/** Lo que se mueve o se cancela: un turno activo que todavía no se atendió. */
const OPEN: ReadonlySet<string> = new Set(["PENDING", "CONFIRMED"]);

type EngineSession = ProgramEngineRow["sessions"][number];

/** Conflicto del core que el motor no vio (rollback total; no es stale de fila). */
export class MoveSeriesConflict extends Error {
  constructor(
    public readonly ordinal: number,
    public readonly outcome: string
  ) {
    super(PLAN_MOVE_COPY.conflict(ordinal));
    this.name = "MoveSeriesConflict";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Puros
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D23 "mismo desfase", en hora de PARED AR (`lib/availability/day`, que va por
 * `lib/datetime-ar.ts`): la sesión ancla pasa de `from` a `to`; cada otra
 * sesión corre los mismos días de calendario AR y los mismos minutos de pared
 * (con acarreo de día). Con el offset fijo de AR (-03, sin DST) es lo mismo
 * que sumar milisegundos, pero así no depende de esa suposición ni del TZ del
 * host (Vercel = UTC). Los segundos/ms se conservan aparte.
 */
export function shiftSameOffset(x: Date, from: Date, to: Date): Date {
  const dDays = dayKeyDiff(dayKeyOf(from), dayKeyOf(to));
  const dMin = minutesOfDayAR(to) - minutesOfDayAR(from);
  const subMinute = to.getTime() - from.getTime() - (dDays * DAY_MIN + dMin) * MIN_MS;
  let minute = minutesOfDayAR(x) + dMin;
  const carry = Math.floor(minute / DAY_MIN);
  minute -= carry * DAY_MIN;
  const day = addDays(dayKeyOf(x), dDays + carry);
  const xSub = ((x.getTime() % MIN_MS) + MIN_MS) % MIN_MS;
  return new Date(instantAt(day, minute).getTime() + xSub + subMinute);
}

/** Token compuesto: el del motor (CAS del plan + target) + el del pedido (lo que el target no ve). */
export function composeToken(engineToken: string, op: Record<string, unknown>): string {
  return `${engineToken}.${planStateToken(op)}`;
}

/** Separa el token compuesto; null si el pedido cambió desde el preview. */
export function engineTokenOf(token: string, op: Record<string, unknown>): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  return token.slice(dot + 1) === planStateToken(op) ? token.slice(0, dot) : null;
}

function orderedLive(program: ProgramEngineRow): { ordered: EngineSession[]; ordinals: Map<string, number> } {
  const ordinals = planSessionOrdinals(program.sessions.map((s) => ({ ...s, archivedAt: null })));
  const ordered = [...program.sessions].sort((a, b) => ordinals.get(a.id)! - ordinals.get(b.id)!);
  return { ordered, ordinals };
}

const activeOf = (s: EngineSession) => s.bookings.find((b) => ACTIVE_FOR_SESSION.has(b.status)) ?? null;

export type MoveSeriesRow = {
  sessionId: string;
  ordinal: number;
  bookingId: string;
  bookingUpdatedAt: Date;
  currentAt: Date;
  at: Date;
};

export type MoveSeriesPlan = {
  fromOrdinal: number;
  /** false = desfase 0: no hay nada que mover (reenvío idempotente). */
  shifts: boolean;
  /** Sesiones con turno abierto: el turno lo mueve el core. */
  rows: MoveSeriesRow[];
  /** Sesiones "sin turno": solo cambia la fecha planificada. */
  sessionsOnly: Array<{ sessionId: string; currentAt: Date; at: Date }>;
};

/**
 * La serie de "este y los siguientes" (D23): la sesión `fromSessionId` y las
 * siguientes por ordinal (fecha, desempate por `index`), vivas y no
 * realizadas. Una con turno COMPLETED (realizada por el turno) queda afuera.
 * La "fecha actual" del ancla es la de su turno abierto (= la de la sesión por
 * I3) o la planificada si está sin turno.
 */
export function planMoveSeries(program: ProgramEngineRow, fromSessionId: string, at: Date): MoveSeriesPlan {
  const { ordered, ordinals } = orderedLive(program);
  const pos = ordered.findIndex((s) => s.id === fromSessionId);
  if (pos < 0) throw new PlanRejected(PLAN_MOVE_COPY.session, "fromSessionId");
  const from = ordered[pos];
  const fromOrdinal = ordinals.get(from.id)!;
  const fromActive = activeOf(from);
  if (from.completedAt || fromActive?.status === "COMPLETED") {
    throw new PlanRejected(PLAN_MOVE_COPY.notPending(fromOrdinal), "fromSessionId");
  }
  const fromAt = fromActive ? fromActive.scheduledFor : from.scheduledFor;
  const shifts = at.getTime() !== fromAt.getTime();
  const rows: MoveSeriesRow[] = [];
  const sessionsOnly: MoveSeriesPlan["sessionsOnly"] = [];
  for (const s of ordered.slice(pos)) {
    if (s.completedAt) continue;
    const a = activeOf(s);
    if (a && !OPEN.has(a.status)) continue;
    if (a) {
      rows.push({
        sessionId: s.id,
        ordinal: ordinals.get(s.id)!,
        bookingId: a.id,
        bookingUpdatedAt: a.updatedAt,
        currentAt: a.scheduledFor,
        at: shiftSameOffset(a.scheduledFor, fromAt, at),
      });
    } else {
      sessionsOnly.push({ sessionId: s.id, currentAt: s.scheduledFor, at: shiftSameOffset(s.scheduledFor, fromAt, at) });
    }
  }
  return { fromOrdinal, shifts, rows, sessionsOnly };
}

export type ReplanSelection = {
  fromOrdinal: number;
  /** Sesiones que se re-planifican, en orden de ordinal. */
  sessions: EngineSession[];
  /** Turnos futuros impagos de esas sesiones: se cancelan en la tx. */
  cancelIds: string[];
  /** Turnos con cobro: quedan intactos con su sesión (se reprograman a mano). */
  keptWithPayment: string[];
};

/**
 * L7 "Editar desde la sesión N": las sesiones vivas no realizadas desde el
 * ordinal de `fromSessionId`. Se quedan como están (y su sesión no se
 * re-planifica): las de turno con cobro (C13 "no se tocan"), las de turno
 * pasado no atendido (no es "futuro") y las realizadas por el turno.
 */
export function selectReplanSessions(program: ProgramEngineRow, fromSessionId: string, now: Date): ReplanSelection {
  const { ordered, ordinals } = orderedLive(program);
  const pos = ordered.findIndex((s) => s.id === fromSessionId);
  if (pos < 0) throw new PlanRejected(PLAN_MOVE_COPY.session, "fromSessionId");
  const from = ordered[pos];
  const fromOrdinal = ordinals.get(from.id)!;
  if (from.completedAt || activeOf(from)?.status === "COMPLETED") {
    throw new PlanRejected(PLAN_MOVE_COPY.notPending(fromOrdinal), "fromSessionId");
  }
  const out: ReplanSelection = { fromOrdinal, sessions: [], cancelIds: [], keptWithPayment: [] };
  for (const s of ordered.slice(pos)) {
    if (s.completedAt) continue;
    const a = activeOf(s);
    if (!a) {
      out.sessions.push(s);
      continue;
    }
    if (a.status === "COMPLETED") continue;
    if (bookingHasMoney(a)) {
      out.keptWithPayment.push(a.id);
      continue;
    }
    if (a.scheduledFor.getTime() <= now.getTime()) continue;
    out.sessions.push(s);
    out.cancelIds.push(a.id);
  }
  if (out.sessions.length === 0) throw new PlanRejected(PLAN_MOVE_COPY.nothingToReplan, "fromSessionId");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comunes de tx
// ─────────────────────────────────────────────────────────────────────────────

type ProgramHead = { id: string; patientId: string };

async function programHeadInTx(tx: DbClient, tenantId: string, programId: string): Promise<ProgramHead> {
  const p = await tx.treatmentProgram.findFirst({ where: { id: programId, tenantId }, select: { id: true, patientId: true } });
  if (!p) throw new PlanRejected(PLAN_MOVE_COPY.program, "programId");
  return p;
}

async function engineProgramInTx(tx: DbClient, tenantId: string, programId: string): Promise<ProgramEngineRow> {
  const p = await loadProgramForEngineInTx(tx, tenantId, programId);
  if (!p || p.archivedAt || !p.practitionerId || !p.serviceId) throw new PlanRejected(PLAN_MOVE_COPY.program, "programId");
  return p;
}

const resolutionsByIndex = (rows: ReadonlyArray<PlanRowResolution>) => new Map(rows.map((r) => [r.index, r]));

/** Instante donde una fila termina (mismo criterio que el motor para sus locks). */
function landing(at: Date, res: PlanRowResolution | undefined): Date {
  if (res?.kind === "move" && res.at) {
    const t = new Date(res.at);
    if (!Number.isNaN(t.getTime())) return t;
  }
  return at;
}

function keysFor(tenantId: string, practitionerId: string, serviceId: string, start: Date, durationMin: number): CapacityLockKey[] {
  return capacityKeysForWindow({ tenantId, practitionerId, serviceId, start, end: new Date(start.getTime() + durationMin * MIN_MS) });
}

/** C2 (3): todas las filas Booking que se tocan, `FOR UPDATE` en orden de id, en una sentencia. */
async function lockBookingsAscInTx(tx: DbClient, tenantId: string, ids: Iterable<string>): Promise<void> {
  const sorted = Array.from(new Set(ids)).sort();
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "tenantId" = ${tenantId} AND "id" = ANY(${sorted}::text[]) ORDER BY "id" FOR UPDATE`;
}

/**
 * C2 (3): las sesiones que se tocan, `FOR UPDATE` id asc en una sentencia,
 * después de los Booking y antes del plan. `programId` ya es del tenant (el
 * plan se cargó con `{id, tenantId}`); Session no tiene tenantId.
 */
async function lockSessionsAscInTx(tx: DbClient, programId: string, ids: Iterable<string>): Promise<void> {
  const sorted = Array.from(new Set(ids)).sort();
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "programId" = ${programId} AND "id" = ANY(${sorted}::text[]) ORDER BY "id" FOR UPDATE`;
}

const adoptIdsOf = (rows: ReadonlyArray<PlanRowResolution>) =>
  rows.filter((r) => r.kind === "adopt" && r.bookingId).map((r) => r.bookingId as string);

// ─────────────────────────────────────────────────────────────────────────────
// Mover en serie (D23) · plans.schedule
// ─────────────────────────────────────────────────────────────────────────────

/** El pedido que el target del motor no ve (las sesiones "sin turno" se corren con el mismo `at`). */
const moveOp = (i: Pick<MovePlanSeriesInputParsed, "fromSessionId" | "at">) => ({
  op: "move-series",
  fromSessionId: i.fromSessionId,
  at: new Date(i.at).toISOString(),
});

const moveTarget = (plan: MoveSeriesPlan): PlanPreviewTarget => ({
  newRows: plan.rows.map((r) => ({ at: r.at.toISOString(), sessionId: r.sessionId })),
});

/**
 * Preview de "este y los siguientes" (solo lectura). Gate `plans.schedule`
 * (la Secretaria puede, PD-09). `PlanPreview` no lleva títulos (nada que
 * redactar sin `clinical.read`); las filas son solo las sesiones con turno
 * (las "sin turno" no crean nada: solo corren su fecha).
 */
export async function previewMoveSeriesInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: { programId: string; fromSessionId: string; at: string; rows: PlanRowResolution[] },
  now: Date
): Promise<PlanPreview> {
  const head = await programHeadInTx(tx, actor.tenantId, input.programId);
  await assertPlanScheduleInTx(tx, actor, caps, head.patientId);
  const program = await engineProgramInTx(tx, actor.tenantId, input.programId);
  if (program.status !== "ACTIVE" && program.status !== "PAUSED") throw new PlanRejected(PLAN_MOVE_COPY.notMovable, "programId");
  const plan = planMoveSeries(program, input.fromSessionId, new Date(input.at));
  const p = await previewProgramRowsInTx(tx, actor, {
    programId: program.id,
    target: moveTarget(plan),
    mode: "replan",
    overrides: input.rows,
    now,
  });
  return { ...p, stateToken: composeToken(p.stateToken, moveOp(input)) };
}

export type MoveSeriesCommit = {
  patientId: string;
  refs: BookingChangeRef[];
  movedBookings: number;
  movedSessions: number;
};

/**
 * Commit de "este y los siguientes" en la tx del caller. Tira
 * `StalePlanPreview` (con el preview fresco y el token compuesto),
 * `MoveSeriesConflict`, `PlanRejected` o `ForbiddenError`: todos hacen
 * rollback total (un conflicto = nada movido).
 */
export async function moveSeriesInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: MovePlanSeriesInputParsed,
  now: Date
): Promise<MoveSeriesCommit> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanScheduleInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });

  const program = await engineProgramInTx(tx, tenantId, input.programId);
  if (program.status !== "ACTIVE" && program.status !== "PAUSED") throw new PlanRejected(PLAN_MOVE_COPY.notMovable, "programId");
  const at = new Date(input.at);
  const plan = planMoveSeries(program, input.fromSessionId, at);
  // Desfase 0 = el mismo commit reenviado (o "mover" a donde ya está): no-op.
  if (!plan.shifts) return { patientId: head.patientId, refs: [], movedBookings: 0, movedSessions: 0 };

  const op = moveOp(input);
  const engineToken = engineTokenOf(input.stateToken, op);
  const target = moveTarget(plan);
  const res = resolutionsByIndex(input.rows);
  const indexOf = new Map(program.sessions.map((s) => [s.id, s.index]));
  for (const r of input.rows) {
    if (r.kind === "adopt" || r.kind === "mark-done") throw new PlanRejected(PLAN_MOVE_COPY.resolution, "rows");
  }

  // (1) cupos: superconjunto motor (refs del plan) ∪ core (refs de cada turno).
  const refs: PlanRefsOk = await validatePlanRefsInTx(tx, actor, {
    discipline: program.discipline,
    practitionerId: program.practitionerId!,
    serviceId: program.serviceId!,
    locationId: program.locationId,
    durationMin: program.durationMin,
  });
  const booked = await tx.booking.findMany({
    where: { tenantId, id: { in: plan.rows.map((r) => r.bookingId) } },
    select: { id: true, practitionerId: true, serviceId: true, durationMin: true },
  });
  const bookedById = new Map(booked.map((b) => [b.id, b]));
  const keys: CapacityLockKey[] = [];
  for (const r of plan.rows) {
    const dest = landing(r.at, res.get(indexOf.get(r.sessionId)!));
    keys.push(...keysFor(tenantId, refs.practitioner.id, refs.service.id, dest, refs.durationMin));
    const b = bookedById.get(r.bookingId);
    if (b) keys.push(...keysFor(tenantId, b.practitionerId, b.serviceId, dest, b.durationMin));
  }
  await lockCapacityMany(tx, keys);
  // (2) sedes, una vez.
  await lockTenantLocationsShared(tx, tenantId);
  // (3) filas Booking id asc.
  await lockBookingsAscInTx(tx, tenantId, plan.rows.map((r) => r.bookingId));

  // Re-clasificación (stale de fila o de borrador → rollback con preview fresco).
  let rc;
  try {
    if (engineToken === null) throw new StalePlanPreview(null, "draft");
    rc = await reclassifyOrThrowStaleInTx(tx, actor, {
      programId: program.id,
      rows: target,
      resolutions: input.rows,
      now,
      mode: "replan",
      stateToken: engineToken,
    });
  } catch (e) {
    if (e instanceof StalePlanPreview && e.preview) {
      throw new StalePlanPreview({ ...e.preview, stateToken: composeToken(e.preview.stateToken, op) }, e.reason);
    }
    throw e;
  }
  // Con las filas lockeadas, la serie tiene que ser la misma que se clasificó.
  const fresh = planMoveSeries(rc.program, input.fromSessionId, at);
  const same =
    fresh.rows.length === plan.rows.length &&
    fresh.rows.every((r, i) => r.bookingId === plan.rows[i].bookingId && +r.at === +plan.rows[i].at);
  if (!same) throw new StalePlanPreview(null, "write-conflict");

  const byIndex = new Map(rc.classifications.map((c) => [c.index, c]));
  type Step = { row: MoveSeriesRow; dest: Date; force: { allowOverbooking?: boolean; allowOutOfHours?: boolean; allowPatientOverlap?: boolean } };
  const steps: Step[] = [];
  for (const row of fresh.rows) {
    const c = byIndex.get(indexOf.get(row.sessionId)!)!;
    if (c.effectiveResolution === "none") continue; // la fila se deja donde está
    if (c.effectiveResolution === "adopt" || c.effectiveResolution === "mark-done") {
      throw new PlanRejected(PLAN_MOVE_COPY.resolution, "rows");
    }
    const r = res.get(c.index);
    steps.push({
      row,
      dest: new Date(c.at),
      force: {
        ...(r?.force?.capacity || c.overbooked ? { allowOverbooking: true } : {}),
        ...(r?.force?.outOfHours ? { allowOutOfHours: true } : {}),
        ...(r?.force?.patientOverlap ? { allowPatientOverlap: true } : {}),
      },
    });
  }
  // Orden de aplicación: hacia adelante, del último al primero; hacia atrás,
  // del primero al último. Así ningún turno cae sobre otro de la misma serie
  // que todavía no se movió (el core ve la base real, el motor ya los excluyó).
  const forward = at.getTime() > fromAtOf(plan, at);
  steps.sort((a, b) => (forward ? +b.row.currentAt - +a.row.currentAt : +a.row.currentAt - +b.row.currentAt));

  const changeRefs: BookingChangeRef[] = [];
  let movedBookings = 0;
  for (const s of steps) {
    const out = await applyBookingUpdateInTx(
      tx,
      actor,
      {
        patch: { id: s.row.bookingId, scheduledFor: s.dest } as BookingUpdatePatch,
        expectedUpdatedAt: s.row.bookingUpdatedAt.toISOString(),
        force: s.force,
      },
      { now, capLocksHeld: true }
    );
    if (out.kind !== "ok") throw new MoveSeriesConflict(s.row.ordinal, out.kind);
    changeRefs.push(...out.refs);
    if (+s.dest !== +s.row.currentAt) movedBookings++;
  }

  // Sesiones "sin turno": solo la fecha planificada (Session después de Booking).
  let movedSessions = 0;
  for (const s of fresh.sessionsOnly) {
    const r = await tx.session.updateMany({
      where: { id: s.sessionId, programId: program.id, program: { tenantId }, archivedAt: null, completedAt: null },
      data: { scheduledFor: s.at },
    });
    movedSessions += r.count;
  }

  // TreatmentProgram al final: el bump invalida los previews abiertos del plan (D3).
  await tx.treatmentProgram.updateMany({ where: { id: program.id, tenantId }, data: { updatedAt: new Date() } });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.move_series",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      fromSessionId: input.fromSessionId,
      fromOrdinal: plan.fromOrdinal,
      deltaMs: at.getTime() - fromAtOf(plan, at),
      movedBookings,
      movedSessions,
      bookingIds: steps.map((s) => s.row.bookingId),
    },
  });
  return { patientId: head.patientId, refs: changeRefs, movedBookings, movedSessions };
}

/** Instante actual del ancla (ms): el de su turno o, sin turno, el planificado. */
function fromAtOf(plan: MoveSeriesPlan, at: Date): number {
  const anchor = plan.rows.find((r) => r.ordinal === plan.fromOrdinal);
  if (anchor) return anchor.currentAt.getTime();
  const s = plan.sessionsOnly[0];
  return s ? s.currentAt.getTime() : at.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-planificar desde la sesión N (L7) · plans.manage
// ─────────────────────────────────────────────────────────────────────────────

type ReplanRefs = {
  practitionerId: string;
  serviceId: string;
  locationId: string | null;
  durationMin: number | null;
};

function mergedRefs(program: ProgramEngineRow, input: ReplanPlanInputParsed): ReplanRefs {
  return {
    practitionerId: input.practitionerId ?? program.practitionerId!,
    serviceId: input.serviceId ?? program.serviceId!,
    locationId: input.locationId === undefined ? program.locationId : input.locationId,
    durationMin: input.durationMin === undefined ? program.durationMin : input.durationMin,
  };
}

const refsChanged = (p: ProgramEngineRow, r: ReplanRefs) =>
  p.practitionerId !== r.practitionerId ||
  p.serviceId !== r.serviceId ||
  p.locationId !== r.locationId ||
  p.durationMin !== r.durationMin;

/** El pedido que el target no ve: el horario y las refs nuevas. */
const replanOp = (i: ReplanPlanInputParsed, r: ReplanRefs) => ({
  op: "replan",
  fromSessionId: i.fromSessionId,
  schedule: i.schedule,
  startDayKey: i.startDayKey,
  ...r,
});

function replanTarget(sel: ReplanSelection, input: ReplanPlanInputParsed, now: Date): PlanPreviewTarget {
  const dates = expandPlanDates({
    schedule: input.schedule as PlanScheduleV1,
    startDayKey: input.startDayKey,
    count: sel.sessions.length,
    now,
  });
  return { newRows: sel.sessions.map((s, i) => ({ at: dates[i].at.toISOString(), sessionId: s.id })) };
}

/**
 * Escribe las refs nuevas en el plan con el `updatedAt` ORIGINAL (el token del
 * motor lo incluye: así sigue siendo el CAS). Las ids ya pasaron por
 * `validatePlanRefsInTx` (I4; `TreatmentProgram.locationId` tiene FK simple).
 */
async function writeRefsKeepingStampInTx(tx: DbClient, tenantId: string, program: ProgramEngineRow, r: ReplanRefs): Promise<void> {
  await tx.treatmentProgram.updateMany({
    where: { id: program.id, tenantId },
    data: {
      practitionerId: r.practitionerId,
      serviceId: r.serviceId,
      locationId: r.locationId,
      durationMin: r.durationMin,
      updatedAt: program.updatedAt,
    },
  });
}

async function validateReplanRefsInTx(tx: DbClient, actor: Actor, program: ProgramEngineRow, r: ReplanRefs): Promise<PlanRefsOk> {
  return validatePlanRefsInTx(tx, actor, {
    discipline: program.discipline,
    practitionerId: r.practitionerId,
    serviceId: r.serviceId,
    locationId: r.locationId,
    durationMin: r.durationMin,
  });
}

function assertReplanInput(program: ProgramEngineRow, input: ReplanPlanInputParsed, now: Date): void {
  if (program.status !== "ACTIVE") throw new PlanRejected(PLAN_MOVE_COPY.notActive, "programId");
  if (input.startDayKey < dayKeyOf(now)) throw new PlanRejected(PLAN_MOVE_COPY.pastStart, "startDayKey");
}

/** Señal interna: el preview con refs nuevas se calcula y se revierte. */
class PreviewRollback extends Error {
  constructor(public readonly preview: PlanPreview) {
    super("preview-rollback");
  }
}

/**
 * Preview de "Editar desde la sesión N" (solo lectura para el que mira). Con
 * profesional/servicio/sede/duración nuevos, el motor necesita verlos en el
 * plan: se escriben dentro de la tx y se revierte (`PreviewRollback`).
 * Gate `plans.manage`.
 */
export async function previewReplanInTxOrRollback(
  run: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>,
  actor: Actor,
  capsOf: (tx: DbClient) => Promise<ReadonlySet<Capability>>,
  input: ReplanPlanInputParsed,
  now: Date
): Promise<PlanPreview> {
  try {
    return await run(async (tx) => {
      const head = await programHeadInTx(tx, actor.tenantId, input.programId);
      await assertPlanManageInTx(tx, actor, await capsOf(tx), head.patientId);
      const program = await engineProgramInTx(tx, actor.tenantId, input.programId);
      assertReplanInput(program, input, now);
      const sel = selectReplanSessions(program, input.fromSessionId, now);
      const r = mergedRefs(program, input);
      const changed = refsChanged(program, r);
      if (changed) {
        await validateReplanRefsInTx(tx, actor, program, r);
        await writeRefsKeepingStampInTx(tx, actor.tenantId, program, r);
      }
      const p = await previewProgramRowsInTx(tx, actor, {
        programId: program.id,
        target: replanTarget(sel, input, now),
        mode: "replan",
        overrides: input.rows,
        now,
      });
      const out = { ...p, stateToken: composeToken(p.stateToken, replanOp(input, r)) };
      if (changed) throw new PreviewRollback(out);
      return out;
    });
  } catch (e) {
    if (e instanceof PreviewRollback) return e.preview;
    throw e;
  }
}

export type ReplanCommit = {
  patientId: string;
  refs: BookingChangeRef[];
  cancelledBookings: number;
  keptWithPayment: number;
  createdBookings: number;
  adoptedBookings: number;
};

/**
 * Commit de L7 en la tx del caller: cancela los futuros impagos desde la
 * sesión N y recrea por el motor (`commitPlanRowsInTx` modo `replan`); los
 * turnos con cobro quedan intactos. Tira `StalePlanPreview` (token compuesto),
 * `PlanRejected` o `ForbiddenError` → rollback total.
 */
export async function replanInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: ReplanPlanInputParsed,
  now: Date
): Promise<ReplanCommit> {
  const tenantId = actor.tenantId;
  const head = await programHeadInTx(tx, tenantId, input.programId);
  await assertPlanManageInTx(tx, actor, caps, head.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });

  const program = await engineProgramInTx(tx, tenantId, input.programId);
  assertReplanInput(program, input, now);
  const sel = selectReplanSessions(program, input.fromSessionId, now);
  const r = mergedRefs(program, input);
  const op = replanOp(input, r);
  const engineToken = engineTokenOf(input.stateToken, op);
  const changed = refsChanged(program, r);
  const refs = await validateReplanRefsInTx(tx, actor, program, r);
  const target = replanTarget(sel, input, now);
  const res = resolutionsByIndex(input.rows);
  const indexOf = new Map(program.sessions.map((s) => [s.id, s.index]));

  // (1) cupos de todos los destinos con las refs NUEVAS (las del motor) → (2) sedes.
  const keys: CapacityLockKey[] = [];
  if ("newRows" in target) {
    for (const row of target.newRows) {
      const dest = landing(new Date(row.at), res.get(indexOf.get(row.sessionId!)!));
      keys.push(...keysFor(tenantId, refs.practitioner.id, refs.service.id, dest, refs.durationMin));
    }
  }
  await lockCapacityMany(tx, keys);
  await lockTenantLocationsShared(tx, tenantId);
  // (3) Booking id asc: los futuros a cancelar ∪ los que se adoptan.
  await lockBookingsAscInTx(tx, tenantId, [...sel.cancelIds, ...adoptIdsOf(input.rows)]);
  // (4) Session id asc ANTES de escribir el plan (H-a2.2, P2-Z): Seguimiento y
  // rescheduleSession lockean Session → TreatmentProgram; si acá el plan se
  // escribía primero (refs nuevas) y la sesión se esperaba después (commit del
  // motor), el ciclo daba 40P01. El commit las re-pide (reentrante) y ahí
  // verifica que sigan abiertas.
  await lockSessionsAscInTx(tx, program.id, sel.sessions.map((s) => s.id));

  if (changed) await writeRefsKeepingStampInTx(tx, tenantId, program, r);

  let rc;
  try {
    if (engineToken === null) throw new StalePlanPreview(null, "draft");
    rc = await reclassifyOrThrowStaleInTx(tx, actor, {
      programId: program.id,
      rows: target,
      resolutions: input.rows,
      now,
      mode: "replan",
      stateToken: engineToken,
    });
  } catch (e) {
    if (e instanceof StalePlanPreview && e.preview) {
      throw new StalePlanPreview({ ...e.preview, stateToken: composeToken(e.preview.stateToken, op) }, e.reason);
    }
    throw e;
  }
  // Con los turnos lockeados la selección tiene que seguir igual (un cobro o un
  // turno nuevo que entró entre la lectura y el lock → preview de nuevo).
  const fresh = selectReplanSessions(rc.program, input.fromSessionId, now);
  const sameSel =
    fresh.sessions.map((s) => s.id).join() === sel.sessions.map((s) => s.id).join() &&
    fresh.cancelIds.join() === sel.cancelIds.join();
  if (!sameSel) throw new StalePlanPreview(null, "write-conflict");

  const cancelled = await cancelBookingsInTx(tx, {
    tenantId,
    bookingIds: sel.cancelIds,
    reason: "plan.replan",
    actorId: actor.userId,
    auditAction: "booking.cancel.replan",
  });
  if (cancelled.skipped.length) throw new StalePlanPreview(null, "write-conflict");

  // El profesional de las sesiones re-planificadas sigue al del plan (como las
  // nuevas del motor). Session antes de los turnos nuevos (H-a2.4): el INSERT
  // con FK al plan/sesión va después de toda escritura de Session.
  if (program.practitionerId !== refs.practitioner.id) {
    await tx.session.updateMany({
      where: { id: { in: sel.sessions.map((s) => s.id) }, programId: program.id, program: { tenantId }, archivedAt: null },
      data: { practitionerId: refs.practitioner.id },
    });
  }

  // I3 de las sesiones existentes (fecha nueva, con o sin turno) lo escribe el
  // motor: compara contra `currentAt` (P2-Z; antes había un workaround acá).
  const written = await commitPlanRowsInTx(tx, actor, {
    program: {
      id: program.id,
      patientId: program.patientId,
      practitionerId: refs.practitioner.id,
      serviceId: refs.service.id,
      locationId: refs.locationId,
      durationMin: refs.durationMin,
    },
    rows: rc,
    mode: "replan",
    now,
  });

  // TreatmentProgram al final: el horario nuevo y el bump (CAS de D3 para los previews abiertos).
  await tx.treatmentProgram.updateMany({
    where: { id: program.id, tenantId },
    data: {
      schedule: input.schedule as unknown as Prisma.InputJsonValue,
      frequency: legacyFrequency(input.schedule as PlanScheduleV1),
      updatedAt: new Date(),
    },
  });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.replan",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      fromSessionId: input.fromSessionId,
      fromOrdinal: sel.fromOrdinal,
      sessions: sel.sessions.length,
      cancelledBookings: cancelled.cancelled.length,
      keptWithPayment: sel.keptWithPayment.length,
      bookingsCreated: written.createdBookings,
      bookingsAdopted: written.adoptedBookings,
      generationId: written.generationId,
      refsChanged: changed,
      practitionerId: refs.practitioner.id,
      serviceId: refs.service.id,
    },
  });
  const cancelRefs: BookingChangeRef[] = cancelled.cancelled.map((b) => ({
    bookingId: b.id,
    practitionerId: b.practitionerId,
    scheduledFor: b.scheduledFor,
    prev: null,
    kind: "booking",
  }));
  return {
    patientId: head.patientId,
    refs: [...cancelRefs, ...written.refs],
    cancelledBookings: cancelled.cancelled.length,
    keptWithPayment: sel.keptWithPayment.length,
    createdBookings: written.createdBookings,
    adoptedBookings: written.adoptedBookings,
  };
}
