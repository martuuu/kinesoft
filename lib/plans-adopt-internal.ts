import "server-only";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import type { DbClient } from "@/lib/rls";
import { ForbiddenError, type Actor } from "@/lib/session";
import type { Capability } from "@/lib/capabilities";
import { assertModule } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { lockPlanPatient } from "@/lib/plan-lock";
import { assertPlanManageInTx, assertPlanScheduleInTx, PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import { adoptableBookingWhere, bookingHasPaymentWhere, sessionWithoutActiveBookingWhere } from "@/lib/plan-predicates";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { disciplineLabel } from "@/lib/plan-display";
import { assertProgramInvariantsInTx, ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { casProgramUpdateInTx, PlanLifecycleStale, sameInstant } from "@/lib/plans-lifecycle-internal";
import { PLAN_LIFECYCLE_COPY } from "@/lib/plans-lifecycle-state";
import { loadProgramForEngineInTx, type ProgramEngineRow } from "@/lib/plans-load-internal";
import {
  commitPlanRowsInTx,
  PlanRejected,
  previewProgramRowsInTx,
  reclassifyOrThrowStaleInTx,
  StalePlanPreview,
  type CommitPlanRowsResult,
  type PlanPreviewTarget,
  type ReclassifiedPlan,
} from "@/lib/plans-engine-internal";
import type { PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import type { PlanFail, PlanStaleFail } from "@/lib/plans-edit-types";

/**
 * Planes · adopción y generar turnos (S25a, ES2b P2.2) — primitivas de tx,
 * server-only. Las consume `lib/plans-adopt.ts` (actions finas).
 *
 *   - **Generar** turnos para las sesiones pendientes ("sin turno", C4):
 *     `previewProgramRowsInTx` + `reclassifyOrThrowStaleInTx` +
 *     `commitPlanRowsInTx` modo `generate`, con target `{sessionIds}`. El cobro
 *     previo (C5 · PD-08: turno nuevo en $0) lo aplica el motor solo.
 *   - **Vincular** un turno suelto a una sesión y **adoptar una serie**: por el
 *     MISMO motor (fila = el instante del turno, resolución `adopt` con su
 *     `updatedAt`). Así la adopción usa el único escritor de `pricedByPlan=true`
 *     (I8), el CAS con `adoptableBookingWhere` + `count === 1` y la regla de
 *     estampado que nunca pisa un copago cobrado o manual (C5 rama b).
 *   - **Sacar del plan**: CAS de desestampado sobre el turno (C4).
 *
 * Gates (E1, §5 "Motor"; solo se CONSUMEN los de `plan-authz-internal`):
 *   - vincular, adoptar y sacar = `assertPlanManageInTx` (full + `clinical.read`);
 *   - generar = `assertPlanScheduleInTx` (la Secretaria agenda una sesión
 *     pendiente). Si el commit trae una resolución `adopt` o `mark-done` (que
 *     son de gestión: estampan plata ajena o cierran una sesión), además
 *     `assertPlanManageInTx`; el preview de quien no gestiona no las ofrece.
 * Todas arrancan con `assertModule('planes')` ANTES de buscar el plan o el
 * turno: un consultorio General recibe el error del módulo, no "no encontrado".
 *
 * Orden de locks (C2, literal): (0) `lockPlanPatient` PRIMERO → (1) cupos y
 * (2) sedes (adentro de `reclassifyOrThrowStaleInTx`) → (3) Booking `FOR
 * UPDATE` id asc (adoptados, en el motor; el turno a sacar, acá) → Session →
 * TreatmentProgram con el CAS de `updatedAt` AL FINAL. El plan se lee una vez
 * sin lock solo para saber el paciente (no cambia nunca) y se RE-LEE bajo el
 * lock: lo que se decide y se escribe es esa lectura.
 *
 * Realtime (enmienda, literal): "todo write-path que crea, mueve, cambia
 * estado/cobro, cancela o borra un `Booking` llama `afterBookingsCommitted`
 * una vez después del commit; los `*InTx` devuelven refs y nunca emiten
 * adentro." Acá los `*InTx` devuelven `refs`; `afterAdoptCommit` emite.
 *
 * Verificador (`assertProgramInvariantsInTx`) al final de cada tx que toca un
 * plan, antes del audit.
 */

// ─── Copy ────────────────────────────────────────────────────────────────────

export const PLAN_ADOPT_COPY = {
  programNotFound: "Plan no encontrado.",
  archived: "El plan está archivado: restauralo para editarlo.",
  notOpen: "El plan está cancelado o completado: reactivalo para sumarle turnos.",
  notActive: "El plan no está activo: reactivalo para agendar sus sesiones.",
  legacy: "El plan no tiene profesional o servicio: completá sus datos antes de sumarle turnos.",
  bookingNotFound: "Turno no encontrado.",
  otherPatient: "Ese turno es de otro paciente.",
  otherPlan: "Ese turno ya es de un plan.",
  inactive: "Un turno cancelado o ausente no se puede sumar al plan.",
  publicUnpaid: "Es una reserva online sin pagar: se puede sumar al plan cuando se pague o se confirme.",
  bookingChanged: "El turno cambió mientras lo vinculabas. Recargá y probá de nuevo.",
  discipline: (booking: Parameters<typeof disciplineLabel>[0], plan: Parameters<typeof disciplineLabel>[0]) =>
    `Ese turno es de ${disciplineLabel(booking)}: no se puede sumar a un plan de ${disciplineLabel(plan)}.`,
  sessionNotFound: "Sesión no encontrada.",
  sessionBusy: (n: number) => `La sesión ${n} ya tiene un turno.`,
  sessionDone: (n: number) => `La sesión ${n} ya está realizada: solo se le puede vincular un turno atendido.`,
  noPending: "No hay sesiones sin turno para agendar.",
  packageFull:
    "El plan es un paquete y no le quedan sesiones sin turno: agregá sesiones desde el plan antes de sumar más turnos.",
  notInPlan: "Ese turno no es de un plan.",
  removeWithMoney: "Tiene un cobro registrado: no se puede sacar del plan.",
  removeCompleted: 'Es un turno atendido: no se puede sacar del plan. Si fue un error, deshacé "Atendido" primero.',
  inconsistent: "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.",
} as const;

// ─── Errores que fuerzan rollback ─────────────────────────────────────────────

/**
 * El turno o el plan cambió (CAS perdido, ya es de otro plan, se canceló, es
 * una reserva pública impaga). Se TIRA para que la tx se revierta entera:
 * adoptar una serie es todo o nada (P2-C2: "→ stale entero, ninguno se
 * adopta"). La action lo devuelve como `{ kind:'stale', error }`.
 */
export class PlanAdoptStale extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanAdoptStale";
  }
}

const ACTIVE_FOR_SESSION = (status: string) => status !== "CANCELLED" && status !== "NO_SHOW";

/**
 * Rechazos esperables → resultado (en prod Next enmascara el mensaje de un
 * throw); lo demás (la base) se propaga. Un P2002 (el índice de "un turno
 * activo por sesión" o el del paciente-instante ganó una carrera con un camino
 * que no toma el lock del paciente, p. ej. reactivar un turno en el core) dejó
 * la tx abortada: es un stale.
 */
export function adoptRejection(e: unknown): PlanFail | PlanStaleFail | null {
  if (e instanceof PlanAdoptStale) return { ok: false, kind: "stale", error: e.message };
  if (e instanceof PlanLifecycleStale) return { ok: false, kind: "stale", error: PLAN_LIFECYCLE_COPY.stale };
  if (e instanceof StalePlanPreview) return { ok: false, kind: "stale", error: PLAN_ADOPT_COPY.bookingChanged };
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return { ok: false, kind: "stale", error: PLAN_ADOPT_COPY.bookingChanged };
  }
  if (e instanceof PlanRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  // El verificador ya reportó el diff a Sentry; al usuario, un error que no sea un 500.
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: PLAN_ADOPT_COPY.inconsistent };
  return null;
}

// ─── Lectura del plan ────────────────────────────────────────────────────────

/** Paciente del plan, sin lock (para tomar `lockPlanPatient`; no cambia nunca). */
async function programPatientInTx(tx: DbClient, tenantId: string, programId: string): Promise<string> {
  const p = await tx.treatmentProgram.findFirst({ where: { id: programId, tenantId }, select: { patientId: true } });
  if (!p) throw new PlanRejected(PLAN_ADOPT_COPY.programNotFound, "programId");
  return p.patientId;
}

/** El plan completo (sesiones vivas con TODOS sus turnos); en los commits se llama bajo `lockPlanPatient`. */
async function loadLiveProgramInTx(tx: DbClient, tenantId: string, programId: string): Promise<ProgramEngineRow> {
  const program = await loadProgramForEngineInTx(tx, tenantId, programId);
  if (!program) throw new PlanRejected(PLAN_ADOPT_COPY.programNotFound, "programId");
  if (program.archivedAt) throw new PlanRejected(PLAN_ADOPT_COPY.archived, "programId");
  return program;
}

/** Vincular/adoptar: ACTIVE o PAUSED (misma regla que reactivar un turno de plan en el core), con refs. */
function assertOpenForAdoption(program: ProgramEngineRow): void {
  if (program.status !== "ACTIVE" && program.status !== "PAUSED") throw new PlanRejected(PLAN_ADOPT_COPY.notOpen, "programId");
  if (!program.practitionerId || !program.serviceId) throw new PlanRejected(PLAN_ADOPT_COPY.legacy, "programId");
}

const hasActiveBooking = (s: ProgramEngineRow["sessions"][number]) => s.bookings.some((b) => ACTIVE_FOR_SESSION(b.status));

// ─── Generar turnos (plans.schedule) ─────────────────────────────────────────

export type GenerateInput = {
  programId: string;
  sessionIds?: string[];
  rows: ReadonlyArray<PlanRowResolution>;
};

/** Resoluciones que son de gestión (`plans.manage`): estampan plata de un turno ajeno o cierran una sesión. */
const MANAGE_ONLY: ReadonlySet<PlanRowResolution["kind"]> = new Set(["adopt", "mark-done"]);

/**
 * Sesiones a agendar, en orden de `index` (el target entra al `stateToken`:
 * preview y commit tienen que armar el mismo). Sin ids = todas las
 * pendientes del predicado canónico (`sessionWithoutActiveBookingWhere`); con
 * ids, cada una tiene que ser pendiente (rechazo con el número de sesión).
 */
async function generateTargetInTx(tx: DbClient, tenantId: string, programId: string, sessionIds?: ReadonlyArray<string>): Promise<string[]> {
  const pending = await tx.session.findMany({
    where: {
      AND: [
        { programId, program: { tenantId } },
        sessionWithoutActiveBookingWhere,
        ...(sessionIds ? [{ id: { in: [...sessionIds] } }] : []),
      ],
    },
    select: { id: true, index: true },
    orderBy: { index: "asc" },
  });
  if (sessionIds && pending.length !== sessionIds.length) {
    const ok = new Set(pending.map((s) => s.id));
    const missing = sessionIds.filter((id) => !ok.has(id));
    const rows = await tx.session.findMany({
      where: { id: { in: missing }, programId, program: { tenantId }, archivedAt: null },
      select: { index: true, completedAt: true },
      orderBy: { index: "asc" },
    });
    const first = rows[0];
    if (!first) throw new PlanRejected(PLAN_ADOPT_COPY.sessionNotFound, "sessionIds");
    throw new PlanRejected(
      first.completedAt ? `La sesión ${first.index} ya está realizada.` : PLAN_ADOPT_COPY.sessionBusy(first.index),
      "sessionIds"
    );
  }
  if (pending.length === 0) throw new PlanRejected(PLAN_ADOPT_COPY.noPending, "sessionIds");
  return pending.map((s) => s.id);
}

/** ¿El actor además GESTIONA el plan? (sin tirar: decide qué resoluciones ofrece el preview). */
async function canManageInTx(tx: DbClient, actor: Actor, caps: ReadonlySet<Capability>, patientId: string): Promise<boolean> {
  try {
    await assertPlanManageInTx(tx, actor, caps, patientId);
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e;
  }
}

/**
 * Preview para quien solo agenda (Secretaria): sin `adopt` ni `mark-done`
 * entre las opciones; si una de esas era la de defecto, queda "sin turno". Las
 * cuotas y `priorPaid` quedan ("Ya pagada en el turno del dd/mm" es
 * administrativo). `PlanPreview` no lleva títulos del plan ni de la sesión,
 * así que no hay nada clínico que redactar.
 */
export function scheduleOnlyPreview(p: PlanPreview): PlanPreview {
  return {
    ...p,
    rows: p.rows.map((r) => ({
      ...r,
      allowedResolutions: r.allowedResolutions.filter((k) => !MANAGE_ONLY.has(k)),
      defaultResolution: MANAGE_ONLY.has(r.defaultResolution) ? "none" : r.defaultResolution,
    })),
  };
}

/** Preview de "Agendar sesiones pendientes" (solo lectura, sin locks). */
export async function previewGenerateInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: GenerateInput,
  now: Date
): Promise<PlanPreview> {
  assertModule(actor, "planes");
  const patientId = await programPatientInTx(tx, actor.tenantId, input.programId);
  await assertPlanScheduleInTx(tx, actor, caps, patientId);
  const manage = await canManageInTx(tx, actor, caps, patientId);
  if (!manage && input.rows.some((r) => MANAGE_ONLY.has(r.kind))) throw new ForbiddenError(PLAN_FORBIDDEN_COPY.manage);
  const program = await loadLiveProgramInTx(tx, actor.tenantId, input.programId);
  if (program.status !== "ACTIVE") throw new PlanRejected(PLAN_ADOPT_COPY.notActive, "programId");
  const sessionIds = await generateTargetInTx(tx, actor.tenantId, program.id, input.sessionIds);
  const preview = await previewProgramRowsInTx(tx, actor, {
    programId: program.id,
    target: { sessionIds },
    mode: "generate",
    overrides: input.rows,
    now,
  });
  return manage ? preview : scheduleOnlyPreview(preview);
}

export type AdoptTxOut = { patientId: string; refs: BookingChangeRef[] };

/**
 * Commit de "Agendar sesiones pendientes" en la tx del caller. `stateToken` del
 * preview = CAS del plan (incluye su `updatedAt`, D3). Tira `StalePlanPreview`
 * (la action devuelve el preview fresco), `PlanRejected`, `ForbiddenError` o
 * `PlanLifecycleStale` (el plan cambió por un camino sin lock entre la
 * re-clasificación y el CAS final).
 */
export async function generateInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: GenerateInput & { stateToken: string },
  now: Date
): Promise<AdoptTxOut & { createdBookings: number; adoptedBookings: number }> {
  assertModule(actor, "planes");
  const tenantId = actor.tenantId;
  const patientId = await programPatientInTx(tx, tenantId, input.programId);
  await lockPlanPatient(tx, { tenantId, patientId });
  await assertPlanScheduleInTx(tx, actor, caps, patientId);
  if (input.rows.some((r) => MANAGE_ONLY.has(r.kind))) await assertPlanManageInTx(tx, actor, caps, patientId);

  const program = await loadLiveProgramInTx(tx, tenantId, input.programId);
  if (program.status !== "ACTIVE") throw new PlanRejected(PLAN_ADOPT_COPY.notActive, "programId");
  const sessionIds = await generateTargetInTx(tx, tenantId, program.id, input.sessionIds);
  const rc = await reclassifyOrThrowStaleInTx(tx, actor, {
    programId: program.id,
    rows: { sessionIds },
    resolutions: input.rows,
    now,
    mode: "generate",
    stateToken: input.stateToken,
  });
  const written = await commitPlanRowsInTx(tx, actor, { program: commitProgramOf(rc), rows: rc, mode: "generate", now });
  const markedDone = rc.classifications.filter((c) => c.effectiveResolution === "mark-done").length;
  if (written.createdBookings + written.adoptedBookings + markedDone === 0) {
    // Todas "sin turno": no se escribió nada → ni CAS ni audit (un reenvío no ensucia el log).
    return { patientId, refs: [], createdBookings: 0, adoptedBookings: 0 };
  }
  // CAS al final (C2 (3)) contra el `updatedAt` que leyó la re-clasificación
  // bajo el lock: invalida los previews abiertos de este plan (su token lo incluye).
  await casProgramUpdateInTx(tx, tenantId, rc.program, { updatedAt: new Date() });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.generate",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      sessions: sessionIds.length,
      targeted: input.sessionIds ? "explicit" : "all-pending",
      bookingsCreated: written.createdBookings,
      bookingsAdopted: written.adoptedBookings,
      markedDone,
      generationId: written.generationId,
    },
  });
  return { patientId, refs: written.refs, createdBookings: written.createdBookings, adoptedBookings: written.adoptedBookings };
}

function commitProgramOf(rc: ReclassifiedPlan) {
  return {
    id: rc.program.id,
    patientId: rc.program.patientId,
    practitionerId: rc.refs.practitioner.id,
    serviceId: rc.refs.service.id,
    locationId: rc.refs.locationId,
    durationMin: rc.refs.durationMin,
  };
}

// ─── Vincular / adoptar (plans.manage) ───────────────────────────────────────

type AdoptCandidate = { id: string; scheduledFor: Date; status: string; expectedUpdatedAt: string };

/**
 * Turnos a adoptar, validados contra el plan (sin lock: los mensajes). El lock
 * `FOR UPDATE` y la re-validación autoritativa (adoptable + `updatedAt`) son
 * del motor: la re-clasificación bajo lock y el CAS con `adoptableBookingWhere`.
 *
 * Qué es rechazo y qué es stale: un turno inexistente, ajeno (otro tenant: no
 * se distingue de inexistente, sin oráculo de ids), de otro paciente o de otra
 * disciplina es un rechazo (no va a cambiar); uno que ya es de un plan, se
 * canceló, es una reserva pública impaga o cambió su `updatedAt` es un stale
 * (la UI recarga la lista de turnos sueltos).
 */
async function adoptCandidatesInTx(
  tx: DbClient,
  tenantId: string,
  program: ProgramEngineRow,
  items: ReadonlyArray<{ bookingId: string; expectedUpdatedAt: string }>
): Promise<Map<string, AdoptCandidate>> {
  const ids = items.map((i) => i.bookingId);
  const [rows, adoptable] = await Promise.all([
    tx.booking.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        patientId: true,
        programId: true,
        sessionId: true,
        status: true,
        scheduledFor: true,
        updatedAt: true,
        service: { select: { discipline: true } },
      },
    }),
    tx.booking.findMany({
      where: { AND: [adoptableBookingWhere({ tenantId, patientId: program.patientId }), { id: { in: ids } }] },
      select: { id: true },
    }),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ok = new Set(adoptable.map((r) => r.id));
  const out = new Map<string, AdoptCandidate>();
  for (const item of items) {
    const b = byId.get(item.bookingId);
    if (!b) throw new PlanRejected(PLAN_ADOPT_COPY.bookingNotFound, "bookingId");
    if (b.patientId !== program.patientId) throw new PlanRejected(PLAN_ADOPT_COPY.otherPatient, "bookingId");
    const d = b.service?.discipline ?? null;
    if (program.discipline && d && d !== program.discipline) {
      throw new PlanRejected(PLAN_ADOPT_COPY.discipline(d, program.discipline), "bookingId");
    }
    if (b.programId || b.sessionId) throw new PlanAdoptStale(PLAN_ADOPT_COPY.otherPlan);
    if (!ACTIVE_FOR_SESSION(b.status)) throw new PlanAdoptStale(PLAN_ADOPT_COPY.inactive);
    if (!ok.has(b.id)) throw new PlanAdoptStale(PLAN_ADOPT_COPY.publicUnpaid);
    if (!sameInstant(item.expectedUpdatedAt, b.updatedAt)) throw new PlanAdoptStale(PLAN_ADOPT_COPY.bookingChanged);
    out.set(b.id, { id: b.id, scheduledFor: b.scheduledFor, status: b.status, expectedUpdatedAt: item.expectedUpdatedAt });
  }
  return out;
}

/** Una sesión EXISTENTE puede recibir el turno: viva, sin turno activo; realizada solo con un turno atendido. */
function assertSessionTakes(session: ProgramEngineRow["sessions"][number] | undefined, booking: AdoptCandidate): void {
  if (!session) throw new PlanRejected(PLAN_ADOPT_COPY.sessionNotFound, "sessionId");
  if (hasActiveBooking(session)) throw new PlanRejected(PLAN_ADOPT_COPY.sessionBusy(session.index), "sessionId");
  if (session.completedAt && booking.status !== "COMPLETED") {
    throw new PlanRejected(PLAN_ADOPT_COPY.sessionDone(session.index), "sessionId");
  }
}

type Assignment = {
  booking: AdoptCandidate;
  /** Sesión existente; ausente = sesión nueva al final del plan. */
  sessionId?: string;
  index: number;
  /** Cuota de la sesión nueva (las existentes conservan la suya). */
  priceCents?: number | null;
};

/**
 * Adopción por el motor: una fila por turno, en el instante del turno, con
 * resolución `adopt` (+ su `updatedAt`). La re-clasificación lockea los turnos
 * `FOR UPDATE` (id asc) y verifica que sigan adoptables y sin cambios; el
 * commit hace el CAS por fila (`count === 1`), estampa la cuota solo si el
 * turno está libre de plata (nunca re-estampa lo cobrado ni un copago manual),
 * aplica el cobro previo ($0) y deja realizada la sesión de un turno atendido.
 *
 * El commit va en modo `replan` aunque haya sesiones nuevas: el modo `add`
 * del motor escribe `totalSessions` en el plan, y eso pisaría el CAS final
 * del caller (C2: el `updatedAt` del plan se compara AL FINAL). El caller
 * escribe la caché en ese mismo CAS.
 */
async function adoptByEngineInTx(
  tx: DbClient,
  actor: Actor,
  program: ProgramEngineRow,
  assignments: ReadonlyArray<Assignment>,
  now: Date
): Promise<{ rc: ReclassifiedPlan; written: CommitPlanRowsResult }> {
  const target: PlanPreviewTarget = {
    newRows: assignments.map((a) =>
      a.sessionId
        ? { at: a.booking.scheduledFor, sessionId: a.sessionId, index: a.index }
        : { at: a.booking.scheduledFor, index: a.index, priceCents: a.priceCents ?? null }
    ),
  };
  const resolutions: PlanRowResolution[] = assignments.map((a) => ({
    index: a.index,
    kind: "adopt",
    bookingId: a.booking.id,
    expectedUpdatedAt: a.booking.expectedUpdatedAt,
  }));
  const rc = await reclassifyOrThrowStaleInTx(tx, actor, {
    programId: program.id,
    rows: target,
    resolutions,
    now,
    mode: assignments.some((a) => !a.sessionId) ? "add" : "replan",
  });
  // I3 (la sesión EXISTENTE toma la fecha de su turno) lo escribe el motor,
  // antes del CAS del turno y bajo el `FOR UPDATE` de la sesión: compara
  // contra la fecha actual de la sesión (`currentAt`, P2-Z; antes había un
  // workaround acá que escribía Session DESPUÉS de Booking, H-a2.4).
  const written = await commitPlanRowsInTx(tx, actor, { program: commitProgramOf(rc), rows: rc, mode: "replan", now });
  return { rc, written };
}

export type LinkInput = {
  programId: string;
  sessionId: string;
  bookingId: string;
  expectedBookingUpdatedAt: string;
  expectedUpdatedAt: string;
};

/** Vincular un turno suelto a una sesión pendiente (la sesión toma la fecha del turno, I3). */
export async function linkBookingInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: LinkInput,
  now: Date
): Promise<AdoptTxOut & { updatedAt: Date; sessionId: string }> {
  assertModule(actor, "planes");
  const tenantId = actor.tenantId;
  const patientId = await programPatientInTx(tx, tenantId, input.programId);
  await lockPlanPatient(tx, { tenantId, patientId });
  await assertPlanManageInTx(tx, actor, caps, patientId);
  const program = await loadLiveProgramInTx(tx, tenantId, input.programId);
  assertOpenForAdoption(program);
  if (!sameInstant(input.expectedUpdatedAt, program.updatedAt)) throw new PlanAdoptStale(PLAN_LIFECYCLE_COPY.stale);

  const candidates = await adoptCandidatesInTx(tx, tenantId, program, [
    { bookingId: input.bookingId, expectedUpdatedAt: input.expectedBookingUpdatedAt },
  ]);
  const booking = candidates.get(input.bookingId)!;
  const session = program.sessions.find((s) => s.id === input.sessionId);
  assertSessionTakes(session, booking);

  const { written } = await adoptByEngineInTx(tx, actor, program, [{ booking, sessionId: session!.id, index: session!.index }], now);
  const updatedAt = await casProgramUpdateInTx(tx, tenantId, program, { updatedAt: new Date() });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.link_booking",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: { bookingId: booking.id, sessionId: session!.id, index: session!.index, bookingStatus: booking.status },
  });
  return { patientId, refs: written.refs, updatedAt, sessionId: session!.id };
}

export type AdoptSeriesInput = {
  programId: string;
  expectedUpdatedAt: string;
  bookings: ReadonlyArray<{ bookingId: string; expectedUpdatedAt: string; sessionId?: string }>;
};

/**
 * Asignación de una serie (P2-C2: "ausente = la action asigna (pendientes
 * por fecha, o sesiones nuevas)"): primero los turnos con `sessionId`
 * explícito; los demás, por fecha (y id), a las sesiones pendientes no
 * realizadas en orden de `index`; los que sobran, a sesiones NUEVAS al final
 * con la cuota del plan. Un PACKAGE no crece por acá (el reparto del total es
 * de "agregar sesiones", S16b, con su pregunta "¿mantenemos el total?").
 */
export function assignSeries(
  program: Pick<ProgramEngineRow, "sessions" | "pricingMode" | "pricePerSessionCents">,
  items: ReadonlyArray<{ booking: AdoptCandidate; sessionId?: string }>
): Assignment[] {
  const byId = new Map(program.sessions.map((s) => [s.id, s]));
  const out: Assignment[] = [];
  const taken = new Set<string>();
  for (const it of items) {
    if (!it.sessionId) continue;
    const s = byId.get(it.sessionId);
    assertSessionTakes(s, it.booking);
    taken.add(s!.id);
    out.push({ booking: it.booking, sessionId: s!.id, index: s!.index });
  }
  const free = program.sessions
    .filter((s) => !taken.has(s.id) && !s.completedAt && !hasActiveBooking(s))
    .sort((a, b) => a.index - b.index);
  const rest = items
    .filter((it) => !it.sessionId)
    .map((it) => it.booking)
    .sort((a, b) => +a.scheduledFor - +b.scheduledFor || (a.id < b.id ? -1 : 1));
  let nextIndex = program.sessions.reduce((m, s) => Math.max(m, s.index), 0);
  for (const booking of rest) {
    const s = free.shift();
    if (s) {
      out.push({ booking, sessionId: s.id, index: s.index });
      continue;
    }
    if (program.pricingMode === "PACKAGE") throw new PlanRejected(PLAN_ADOPT_COPY.packageFull, "bookings");
    out.push({
      booking,
      index: ++nextIndex,
      priceCents: program.pricingMode === "PER_SESSION" ? program.pricePerSessionCents : null,
    });
  }
  return out;
}

/** Adoptar una serie de turnos sueltos, todo o nada. */
export async function adoptSeriesInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: AdoptSeriesInput,
  now: Date
): Promise<AdoptTxOut & { updatedAt: Date; adopted: Array<{ bookingId: string; sessionId: string }>; totalSessions: number }> {
  assertModule(actor, "planes");
  const tenantId = actor.tenantId;
  const patientId = await programPatientInTx(tx, tenantId, input.programId);
  await lockPlanPatient(tx, { tenantId, patientId });
  await assertPlanManageInTx(tx, actor, caps, patientId);
  const program = await loadLiveProgramInTx(tx, tenantId, input.programId);
  assertOpenForAdoption(program);
  if (!sameInstant(input.expectedUpdatedAt, program.updatedAt)) throw new PlanAdoptStale(PLAN_LIFECYCLE_COPY.stale);

  const candidates = await adoptCandidatesInTx(tx, tenantId, program, input.bookings);
  const assignments = assignSeries(
    program,
    input.bookings.map((b) => ({ booking: candidates.get(b.bookingId)!, sessionId: b.sessionId }))
  );
  const { written } = await adoptByEngineInTx(tx, actor, program, assignments, now);

  const added = assignments.filter((a) => !a.sessionId).length;
  const totalSessions = program.sessions.length + added;
  // Caché `totalSessions` (I5) en el MISMO CAS final del plan.
  const updatedAt = await casProgramUpdateInTx(tx, tenantId, program, {
    updatedAt: new Date(),
    ...(added ? { totalSessions } : {}),
  });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  const adopted = assignments
    .map((a) => ({ bookingId: a.booking.id, sessionId: a.sessionId ?? written.sessionIds.get(a.index)! }))
    .sort((a, b) => (a.bookingId < b.bookingId ? -1 : 1));
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.adopt_series",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: { bookings: assignments.length, sessionsAdded: added, totalSessions, bookingIds: adopted.map((a) => a.bookingId) },
  });
  return { patientId, refs: written.refs, updatedAt, adopted, totalSessions };
}

// ─── Sacar del plan (plans.manage) ───────────────────────────────────────────

export type RemoveInput = { bookingId: string; expectedUpdatedAt: string };

/**
 * Sacar un turno del plan (C4, literal: "Con cobro: rechazo. Si no:
 * `programId`/`sessionId` null, `pricedByPlan=false` y `copagoCents=null`
 * (CAS)"; orden paciente → Booking → Session). La sesión queda "sin turno" con
 * su cuota y su fecha.
 *
 * Decisiones donde el contrato no llega:
 *   - `copagoCents` se limpia solo si lo estampó el plan (`pricedByPlan`). Un
 *     copago puesto a mano en un turno adoptado sin estampar no es del plan, y
 *     borrarlo perdería un dato que el plan nunca escribió.
 *   - Un turno COMPLETED no se saca: su sesión quedó realizada por él, y
 *     sacarlo dejaría una sesión realizada (devengada) con un turno suelto
 *     impago fuera del saldo. Se deshace "Atendido" primero.
 */
export async function removeBookingFromPlanInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  input: RemoveInput
): Promise<AdoptTxOut & { bookingUpdatedAt: Date; sessionId: string }> {
  assertModule(actor, "planes");
  const tenantId = actor.tenantId;
  const head = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId }, select: { patientId: true, programId: true } });
  if (!head) throw new PlanRejected(PLAN_ADOPT_COPY.bookingNotFound, "bookingId");
  if (!head.programId || !head.patientId) throw new PlanRejected(PLAN_ADOPT_COPY.notInPlan, "bookingId");
  await lockPlanPatient(tx, { tenantId, patientId: head.patientId });
  await assertPlanManageInTx(tx, actor, caps, head.patientId);

  // C2 (3): el turno `FOR UPDATE` antes de decidir; lo que se escribe es esta lectura.
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "tenantId" = ${tenantId} AND "id" = ${input.bookingId} FOR UPDATE`;
  const b = await tx.booking.findFirst({
    where: { id: input.bookingId, tenantId },
    select: {
      id: true,
      programId: true,
      sessionId: true,
      status: true,
      paymentStatus: true,
      insurerPaidAt: true,
      payment: { select: { status: true } },
      pricedByPlan: true,
      updatedAt: true,
      practitionerId: true,
      scheduledFor: true,
      roomId: true,
    },
  });
  if (!b || !b.programId || !b.sessionId) throw new PlanAdoptStale(PLAN_ADOPT_COPY.bookingChanged);
  if (!sameInstant(input.expectedUpdatedAt, b.updatedAt)) throw new PlanAdoptStale(PLAN_ADOPT_COPY.bookingChanged);
  // PD-08 / P6: con plata no se saca (mismo criterio que cancelar: `bookingHasMoney`).
  if (bookingHasMoney(b)) throw new PlanRejected(PLAN_ADOPT_COPY.removeWithMoney, "bookingId");
  if (b.status === "COMPLETED") throw new PlanRejected(PLAN_ADOPT_COPY.removeCompleted, "bookingId");

  // CAS de desestampado: el where repite lo decidido (vínculo, updatedAt, sin
  // plata con el predicado canónico) para que un webhook de MP que marcó el
  // pago entre la lectura y el write no quede pisado.
  const res = await tx.booking.updateMany({
    where: {
      AND: [
        { id: b.id, tenantId, programId: b.programId, sessionId: b.sessionId, updatedAt: b.updatedAt, status: { not: "COMPLETED" } },
        { NOT: bookingHasPaymentWhere },
      ],
    },
    data: { programId: null, sessionId: null, pricedByPlan: false, ...(b.pricedByPlan ? { copagoCents: null } : {}) },
  });
  if (res.count !== 1) throw new PlanAdoptStale(PLAN_ADOPT_COPY.bookingChanged);

  // TreatmentProgram al final: bump del `updatedAt` (los previews y CAS abiertos
  // del plan contaban con este turno) + verificador.
  await tx.treatmentProgram.updateMany({ where: { id: b.programId, tenantId }, data: { updatedAt: new Date() } });
  await assertProgramInvariantsInTx(tx, { tenantId, programId: b.programId });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "booking.plan_remove",
    entity: "Booking",
    entityId: b.id,
    payload: { programId: b.programId, sessionId: b.sessionId, status: b.status, unstamped: b.pricedByPlan },
  });
  const after = await tx.booking.findFirst({ where: { id: b.id, tenantId }, select: { updatedAt: true } });
  return {
    patientId: head.patientId,
    // FX1a (SV08-gap): con la sala (leída bajo el lock de arriba); sin ella la
    // vista «Por sala» no repintaba el chip de plan del turno que se sacó.
    refs: [{ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, prev: null, kind: "booking" }],
    bookingUpdatedAt: after!.updatedAt,
    sessionId: b.sessionId,
  };
}

// ─── Post-commit ─────────────────────────────────────────────────────────────

/**
 * Post-commit, UNA vez y fuera de la tx (enmienda Realtime): agenda +
 * dashboard (`afterBookingsCommitted`, que nunca tira) y el perfil del
 * paciente (detalle del plan, Seguimiento).
 */
export async function afterAdoptCommit(tenantId: string, out: AdoptTxOut): Promise<void> {
  await afterBookingsCommitted(tenantId, out.refs);
  revalidatePath(`/pacientes/${out.patientId}`);
  revalidatePath("/seguimiento");
}
