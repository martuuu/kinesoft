"use server";

/**
 * Seguimiento domain — session-level workflow.
 *
 * `listOpenSessions` returns the Seguimiento landing by buckets (vencidas,
 * hoy, próximas, realizadas 14 días). `getSessionDetail` returns one session
 * with its program, patient and exercise checklist. The rest are the
 * session-level mutations (exercise checklist, meta, close, reschedule).
 *
 * A2a-S03 (acceso básico = solo ver, §12.0): TODO lo de este archivo exige
 * acceso `full` al paciente. Un PRACTITIONER sin asignación ni share ve el
 * turno en la agenda, pero no la sesión clínica ni la puede tocar. El gate
 * corre dentro de la misma `runWithRls` que la escritura (helper
 * `sessionForWrite`), así no hay ventana entre chequeo y escritura.
 *
 * Planes P0 · S02s: el cierre vive en `lib/sessions-internal.ts`
 * (`completeSessionInTx`, C8) para que la agenda lo reuse desde P2; los
 * schemas zod en `lib/sessions-schemas.ts`; el alta de sesión a medida
 * serializa por paciente y programa; los ejercicios asignables excluyen los
 * archivados; el bulk no toca sesiones realizadas; reprogramar rechaza planes
 * CANCELLED/COMPLETED.
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { audit, auditInTx } from "@/lib/audit";
import { notify } from "@/lib/notifications-internal";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { lockPlanPatient } from "@/lib/plan-lock";
import { bulkPatientAccess, patientAccessFor, visibilityForActor } from "@/lib/visibility";
import { dayKeyOf, dayWindow } from "@/lib/availability/day";
import { completeSessionInTx } from "@/lib/sessions-internal";
import {
  AddCustomSessionInput,
  BulkAddSessionExercisesInput,
  RescheduleSessionInput,
} from "@/lib/sessions-schemas";
import {
  SessionExerciseUpdate,
  SessionMeta,
  SessionMetaUpdate,
  type ActionResult,
  type SessionMetaInput,
  type SessionMetaUpdateInput,
} from "@/lib/validation";
import { NotificationKind, type SessionExerciseStatus } from "@prisma/client";

import {
  OPEN_SESSIONS_BUCKET_LIMIT,
  type CompleteSessionResult,
  type OpenSessionBucket,
  type OpenSessionBuckets,
  type OpenSessionRow,
  type RescheduleSessionResult,
} from "@/lib/sessions-types";

const NO_ACCESS = "No tenés acceso completo a este paciente.";
const DAY_MS = 86_400_000;

/**
 * Día AR [start, end) de un instante. Delegado al motor (`lib/availability/day`,
 * C11): antes era una copia local de la misma cuenta y dos implementaciones del
 * "día AR" pueden divergir (la paridad del motor la fija su unit test).
 */
function arDayBounds(d: Date): { start: Date; end: Date; key: string } {
  const key = dayKeyOf(d);
  return { ...dayWindow(key), key };
}

/**
 * Rechazo de negocio dentro de una `runWithRls`: tirarlo hace rollback de la
 * tx y `denied()` lo convierte en `{ ok: false, error }`. Cualquier otro error
 * sigue propagando.
 */
class Denied extends Error {}

async function denied<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof Denied) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Carga la sesión (tenant-scoped) y exige acceso `full` al paciente, en el
 * `tx` del caller. Tira `Denied` si no existe o no hay acceso.
 */
async function sessionForWrite(tx: DbClient, actor: Actor, sessionId: string) {
  const s = await tx.session.findFirst({
    where: { id: sessionId, program: { tenantId: actor.tenantId } },
    select: {
      id: true,
      index: true,
      completedAt: true,
      scheduledFor: true,
      practitionerId: true,
      paInPre: true,
      paInPost: true,
      program: {
        select: {
          id: true,
          patientId: true,
          status: true,
          patient: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!s) throw new Denied("Sesión no encontrada.");
  if ((await patientAccessFor(actor, s.program.patientId, tx)) !== "full") throw new Denied(NO_ACCESS);
  return s;
}

/** Same gate, entrando por un SessionExercise. */
async function sessionExerciseForWrite(tx: DbClient, actor: Actor, sessionExerciseId: string) {
  const sx = await tx.sessionExercise.findFirst({
    where: { id: sessionExerciseId, session: { program: { tenantId: actor.tenantId } } },
    select: {
      id: true,
      order: true,
      sessionId: true,
      session: { select: { program: { select: { patientId: true } } } },
    },
  });
  if (!sx) throw new Denied("Ejercicio no encontrado.");
  if ((await patientAccessFor(actor, sx.session.program.patientId, tx)) !== "full") throw new Denied(NO_ACCESS);
  return sx;
}

// ──────────────────────────────────────────────────────────────────────
// Landing
// ──────────────────────────────────────────────────────────────────────

const openSessionInclude = {
  program: { select: { patientId: true, title: true, totalSessions: true, patient: { select: { firstName: true, lastName: true } } } },
  exercises: { select: { status: true } },
} satisfies Prisma.SessionInclude;

type OpenSessionDbRow = Prisma.SessionGetPayload<{ include: typeof openSessionInclude }>;

function toOpenSessionRow(s: OpenSessionDbRow): OpenSessionRow {
  return {
    id: s.id,
    index: s.index,
    scheduledFor: s.scheduledFor,
    completedAt: s.completedAt,
    patientId: s.program.patientId,
    patientName: `${s.program.patient.firstName} ${s.program.patient.lastName}`,
    programTitle: s.program.title,
    totalSessions: s.program.totalSessions,
    exerciseCount: s.exercises.length,
    doneCount: s.exercises.filter((e) => e.status === "DONE").length,
  };
}

/**
 * Landing de Seguimiento (A2a-S03 ítem 5). Cambios vs. la versión anterior:
 *   - el día es el día AR (`lib/datetime-ar.ts`); antes `setHours(0)` del host
 *     (UTC en Vercel) corría el corte 3 h;
 *   - una query por bucket con su propio tope: el `take: 80` global ordenado
 *     por `completedAt asc` dejaba afuera pendientes cuando había muchas
 *     realizadas, y las vencidas sin cerrar no aparecían en ningún lado;
 *   - buckets abiertos (vencidas/hoy/próximas) solo de planes ACTIVE: un plan
 *     CANCELLED o PAUSED no tiene que pedir que cierres sus sesiones.
 *     "Realizadas" incluye COMPLETED (si no, la sesión que autocompleta el plan
 *     desaparecería de la lista en el mismo click);
 *   - solo pacientes con acceso `full`: se filtra en SQL (para que tope y
 *     conteo sean reales) y se re-verifica con `bulkPatientAccess`, que es la
 *     fuente de verdad del modelo de acceso.
 */
export async function listOpenSessions(now: Date = new Date()): Promise<OpenSessionBuckets> {
  const actor = await getActor();
  const today = arDayBounds(now);
  const recentSince = new Date(today.start.getTime() - 14 * DAY_MS);
  const take = OPEN_SESSIONS_BUCKET_LIMIT;

  return runWithRls(actor.tenantId, async (tx) => {
    const vis = await visibilityForActor(actor, tx);
    const patientAccessWhere: Prisma.PatientWhereInput = vis.seesAll
      ? {}
      : {
          OR: [
            { assignedPractitionerId: actor.practitionerId },
            { shares: { some: { practitionerId: actor.practitionerId } } },
          ],
        };
    const programWhere = (statuses: ("ACTIVE" | "COMPLETED" | "PAUSED")[]): Prisma.TreatmentProgramWhereInput => ({
      tenantId: actor.tenantId,
      status: { in: statuses },
      patient: patientAccessWhere,
    });

    const bucket = async (
      where: Prisma.SessionWhereInput,
      orderBy: Prisma.SessionOrderByWithRelationInput
    ): Promise<{ rows: OpenSessionDbRow[]; total: number }> => {
      const rows = await tx.session.findMany({ where, orderBy, include: openSessionInclude, take });
      // Solo contamos cuando el tope cortó: el caso común es 1 query.
      const total = rows.length < take ? rows.length : await tx.session.count({ where });
      return { rows, total };
    };

    const open = programWhere(["ACTIVE"]);
    const overdue = await bucket(
      { program: open, completedAt: null, scheduledFor: { lt: today.start } },
      // Las más recientes primero: son las que todavía se pueden cerrar con memoria fresca.
      { scheduledFor: "desc" }
    );
    const todayB = await bucket(
      { program: open, completedAt: null, scheduledFor: { gte: today.start, lt: today.end } },
      { scheduledFor: "asc" }
    );
    const upcoming = await bucket(
      { program: open, completedAt: null, scheduledFor: { gte: today.end } },
      { scheduledFor: "asc" }
    );
    const recent = await bucket(
      { program: programWhere(["ACTIVE", "COMPLETED", "PAUSED"]), completedAt: { gte: recentSince } },
      { completedAt: "desc" }
    );

    const all = [overdue, todayB, upcoming, recent].flatMap((b) => b.rows);
    const access = await bulkPatientAccess(
      actor,
      [...new Set(all.map((s) => s.program.patientId))],
      tx
    );
    const finalize = (b: { rows: OpenSessionDbRow[]; total: number }): OpenSessionBucket => {
      const rows = b.rows.filter((s) => access.get(s.program.patientId) === "full");
      return { rows: rows.map(toOpenSessionRow), total: b.total - (b.rows.length - rows.length) };
    };

    return {
      overdue: finalize(overdue),
      today: finalize(todayB),
      upcoming: finalize(upcoming),
      recent: finalize(recent),
    };
  });
}

/**
 * Detalle de una sesión. `null` si no existe en el tenant **o** si el actor
 * no tiene acceso `full` al paciente (la página responde 404 en ambos casos:
 * no se filtra que la sesión existe).
 */
export async function getSessionDetail(id: string) {
  const actor = await getActor();
  return runWithRls(actor.tenantId, async (tx) => {
    const s = await tx.session.findFirst({
      where: { id, program: { tenantId: actor.tenantId } },
      include: {
        program: {
          include: {
            patient: true,
            case: {
              include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } },
            },
            sessions: {
              orderBy: { index: "asc" },
              select: {
                id: true,
                index: true,
                completedAt: true,
                paInPre: true,
                paInPost: true,
              },
            },
          },
        },
        exercises: {
          orderBy: { order: "asc" },
          include: { exercise: true },
        },
      },
    });
    if (!s) return null;
    if ((await patientAccessFor(actor, s.program.patientId, tx)) !== "full") return null;
    return s;
  });
}

export async function updateSessionExercise(input: {
  sessionExerciseId: string;
  status?: SessionExerciseStatus;
  sets?: number;
  reps?: number;
  notes?: string;
}): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = SessionExerciseUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { sessionExerciseId, ...data } = parsed.data;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionExerciseForWrite(tx, actor, sessionExerciseId);
    await tx.sessionExercise.update({ where: { id: sessionExerciseId }, data });
    return g;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.update",
    entity: "SessionExercise",
    entityId: sessionExerciseId,
    payload: data as Record<string, unknown>,
  });

  revalidatePath(`/seguimiento/${r.sessionId}`);
  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Reprogramar UNA sesión del plan (A2a-S03 ítem 4).
 *
 * Mueve solo la sesión. Antes buscaba un turno del mismo paciente y
 * profesional a ±2 h del horario original y lo movía también: con dos turnos
 * cercanos (o uno que no tenía nada que ver con el plan) movía el equivocado,
 * sin optimistic lock ni chequeo de capacidad, y el copy de la UI prometía
 * "el turno asociado se mueve automáticamente". Sesión y turno no tienen FK
 * entre sí: la heurística no tiene arreglo sin modelar el vínculo (Bloque B).
 *
 * Ahora solo informa: si el paciente tiene un turno (no cancelado) ese mismo
 * día AR, lo devuelve para que la UI linkee a la agenda y el kine lo mueva a
 * mano con todos los guards de `updateBooking`.
 *
 * S02s: entrada con zod (`RescheduleSessionInput`: ISO con hora y offset; un
 * "2027-03-10" pelado lo leía el host como 00:00 UTC = 21:00 AR del día
 * anterior) y rechazo si el plan está CANCELLED o COMPLETED: mover una sesión
 * de un plan terminado la hacía reaparecer como pendiente en el perfil sin que
 * nada la pudiera cerrar (Seguimiento solo lista planes ACTIVE).
 */
export async function rescheduleSession(input: {
  sessionId: string;
  scheduledFor: string; // ISO
  practitionerId?: string;
}): Promise<ActionResult<RescheduleSessionResult>> {
  const actor = await getActor();
  const parsed = RescheduleSessionInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return { ok: false, error: fieldErrors.scheduledFor ? "Fecha inválida." : "Datos inválidos.", fieldErrors };
  }
  const newDate = new Date(parsed.data.scheduledFor);
  input = parsed.data;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionForWrite(tx, actor, input.sessionId);

    // Chequeos bajo lock (hallazgo A5, cierre de ES1). Antes se miraban
    // `completedAt` y el estado del plan sobre la lectura de `sessionForWrite`
    // (snapshot) y después se escribía por id: un cierre o una cancelación del
    // plan que commiteaba en el medio quedaba pisado (sesión realizada con la
    // fecha movida). Ahora: Session FOR UPDATE → TreatmentProgram FOR UPDATE
    // (orden C2 (3)), y se decide sobre lo que devuelven esas lecturas, que
    // en READ COMMITTED son la última versión commiteada.
    const locked = await tx.$queryRaw<{ completedAt: Date | null; scheduledFor: Date }[]>`
      SELECT s."completedAt", s."scheduledFor"
      FROM "Session" s
      JOIN "TreatmentProgram" tp ON tp.id = s."programId"
      WHERE s.id = ${input.sessionId} AND tp."tenantId" = ${actor.tenantId}
      FOR UPDATE OF s`;
    const programRow = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM "TreatmentProgram"
      WHERE id = ${g.program.id} AND "tenantId" = ${actor.tenantId}
      FOR UPDATE`;
    if (!locked[0] || !programRow[0]) throw new Denied("Sesión no encontrada.");
    const session = { ...g, completedAt: locked[0].completedAt, scheduledFor: locked[0].scheduledFor };
    const programStatus = programRow[0].status;
    if (programStatus === "CANCELLED") {
      throw new Denied("El plan está cancelado: no se pueden reprogramar sus sesiones.");
    }
    if (programStatus === "COMPLETED") {
      throw new Denied("El plan está completado: no se pueden reprogramar sus sesiones.");
    }
    if (session.completedAt) throw new Denied("La sesión ya fue realizada: no se puede reprogramar.");

    const targetPractitioner = input.practitionerId ?? session.practitionerId;
    if (targetPractitioner !== session.practitionerId) {
      const ownedPrac = await tx.practitioner.findFirst({
        where: { id: targetPractitioner, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!ownedPrac) throw new Denied("Profesional fuera del tenant.");
    }

    await tx.session.update({
      where: { id: input.sessionId },
      data: { scheduledFor: newDate, practitionerId: targetPractitioner },
    });

    const day = arDayBounds(newDate);
    const booking = await tx.booking.findFirst({
      where: {
        tenantId: actor.tenantId,
        patientId: session.program.patientId,
        scheduledFor: { gte: day.start, lt: day.end },
        status: { not: "CANCELLED" },
      },
      orderBy: { scheduledFor: "asc" },
      select: { id: true, scheduledFor: true },
    });

    return {
      session,
      targetPractitioner,
      bookingOnDay: booking ? { ...booking, dateKey: day.key } : null,
    } as const;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.reschedule",
    entity: "Session",
    entityId: input.sessionId,
    payload: {
      from: r.session.scheduledFor.toISOString(),
      to: newDate.toISOString(),
      practitionerId: r.targetPractitioner,
      bookingOnDay: r.bookingOnDay?.id ?? null,
    },
  });

  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${input.sessionId}`);
  return { ok: true, data: { bookingOnDay: r.bookingOnDay } };
}

/**
 * Guarda notas / EVA pre-post / RPE sin cerrar la sesión. `null` vacía el
 * campo (antes `""` viajaba como `undefined` y las notas no se podían borrar).
 */
export async function updateSessionMeta(input: SessionMetaUpdateInput): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = SessionMetaUpdate.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "EVA y RPE tienen que ser enteros entre 0 y 10.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { sessionId, ...meta } = parsed.data;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionForWrite(tx, actor, sessionId);
    await tx.session.update({ where: { id: sessionId }, data: meta });
    return g;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.meta.update",
    entity: "Session",
    entityId: sessionId,
    // Los puntajes sí; el texto de las notas es HC y no se copia al audit.
    payload: {
      fields: Object.keys(meta).filter((k) => meta[k as keyof typeof meta] !== undefined),
      paInPre: meta.paInPre,
      paInPost: meta.paInPost,
      rpe: meta.rpe,
    },
  });
  revalidatePath(`/seguimiento/${sessionId}`);
  revalidatePath(`/pacientes/${r.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Cierre de sesión desde Seguimiento (H3, A2a-S03 ítem 1).
 *
 * Bug que lo motivó: "Cerrar sesión" solo mandaba el id; las notas y EVA
 * tipeadas en el panel sin apretar "Guardar anotaciones" se perdían, y la
 * EvaScore se armaba con el `paInPost` viejo leído antes. Además eran 4
 * transacciones sueltas (una caída a mitad dejaba la sesión cerrada sin
 * ejercicios marcados ni EVA) y un doble click duplicaba EvaScore y
 * notificación.
 *
 * Ahora:
 *   - `meta` (notas, EVA pre/post, RPE) llega validada con zod y se guarda en
 *     el mismo UPDATE que cierra;
 *   - todo va en UNA `runWithRls`: gate `full`, cierre, ejercicios PENDING →
 *     DONE, EvaScore y autocompletado del plan;
 *   - idempotente: el cierre es un `updateMany … WHERE completedAt IS NULL`.
 *     Si otro request ya la cerró (doble click, dos pestañas), `count = 0` y
 *     se devuelve ok sin efectos (ni meta, ni EVA, ni notificación). Con dos
 *     tx concurrentes, Postgres re-evalúa el WHERE de la segunda después del
 *     commit de la primera (READ COMMITTED), así que solo una "gana";
 *   - el plan se autocompleta por CONTEO de sesiones completadas vs.
 *     `totalSessions`, no por `index == total`: cerrar la última sesión antes
 *     que una intermedia completaba el plan con sesiones pendientes, y cerrar
 *     la última de un plan con una sesión a medida agregada no lo completaba.
 *
 * La notificación va después del commit con `notify()` (fire-and-forget por
 * contrato: una falla del aviso no puede deshacer un cierre clínico), y solo
 * la emite el request que ganó el cierre.
 *
 * S02s: el claim, la meta, los ejercicios, la EVA y el audit `session.complete`
 * los hace `completeSessionInTx({source:'seguimiento'})` (C8), dentro de esta
 * misma tx. El autocompletado del plan se CONSERVA acá hasta P2 (D22 lo cambia
 * por "sugerir el alta"); su cambio de estado se audita como `program.status`
 * en la misma tx (antes viajaba como `programCompleted` en el payload del
 * cierre, fuera de la tx).
 */
export async function completeSessionFromSeguimiento(
  sessionId: string,
  meta?: SessionMetaInput
): Promise<ActionResult<CompleteSessionResult>> {
  const actor = await getActor();
  const parsed = SessionMeta.safeParse(meta ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "EVA y RPE tienen que ser enteros entre 0 y 10.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const m = parsed.data;
  const now = new Date();

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const s = await sessionForWrite(tx, actor, sessionId);

    const { claimed } = await completeSessionInTx(tx, {
      tenantId: actor.tenantId,
      sessionId,
      actorId: actor.userId ?? null,
      source: "seguimiento",
      meta: m,
      now,
    });
    if (!claimed) {
      return { s, alreadyCompleted: true, programCompleted: false, remaining: null, total: null } as const;
    }

    // Lock del programa ANTES de contar (hallazgo A4, cierre de ES1). Sin él,
    // dos cierres concurrentes de las dos últimas sesiones contaban cada uno
    // sin ver el cierre (todavía sin commitear) del otro: los dos veían una
    // pendiente y el plan quedaba ACTIVE con todas realizadas. Con el FOR
    // UPDATE el segundo espera el commit del primero y su `count` (sentencia
    // nueva en READ COMMITTED) ya lo ve. Orden C2 (3): la Session ya está
    // lockeada por el claim → recién ahora TreatmentProgram.
    await tx.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${s.program.id} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    const done = await tx.session.count({ where: { programId: s.program.id, completedAt: { not: null } } });
    const program = await tx.treatmentProgram.findUniqueOrThrow({
      where: { id: s.program.id },
      select: { totalSessions: true },
    });
    const remaining = Math.max(0, program.totalSessions - done);
    let programCompleted = false;
    if (remaining === 0) {
      // Un plan CANCELLED no se "revive" como COMPLETED.
      const u = await tx.treatmentProgram.updateMany({
        where: { id: s.program.id, tenantId: actor.tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
        data: { status: "COMPLETED" },
      });
      programCompleted = u.count > 0;
      if (programCompleted) {
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId ?? undefined,
          action: "program.status",
          entity: "TreatmentProgram",
          entityId: s.program.id,
          payload: { from: s.program.status, to: "COMPLETED", auto: true, sessionId },
        });
      }
    }
    return { s, alreadyCompleted: false, programCompleted, remaining, total: program.totalSessions } as const;
  }));
  if (!res.ok) return res;
  const r = res.value;

  const patientId = r.s.program.patientId;
  if (!r.alreadyCompleted) {
    // Señal de alta próxima: al quedar 1 pendiente y al completar el plan.
    const patientName = `${r.s.program.patient.firstName} ${r.s.program.patient.lastName}`;
    if (actor.userId && (r.remaining === 1 || r.programCompleted)) {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.PROGRAM_NEARING_DISCHARGE,
        title: r.programCompleted ? `Plan completado · ${patientName}` : `Última sesión próxima · ${patientName}`,
        body: r.programCompleted
          ? `Programá el alta o la continuidad.`
          : `Sesión ${r.total} de ${r.total} pendiente.`,
        link: `/pacientes/${patientId}`,
      });
    }
  }

  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${sessionId}`);
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath(`/dashboard`);
  return {
    ok: true,
    data: { alreadyCompleted: r.alreadyCompleted, programCompleted: r.programCompleted },
  };
}

/**
 * Reorder the exercises of a session in one shot. Re-assigns `order`
 * sequentially based on the supplied id array. Uses a transaction so an
 * interrupted update doesn't leave the session with duplicate orders.
 *
 * Workaround for the @@unique([sessionId, order]) constraint: bump
 * everything to negative orders first, then rewrite to the target order.
 */
export async function reorderSessionExercises(input: {
  sessionId: string;
  orderedIds: string[];
}): Promise<ActionResult> {
  const actor = await getActor();
  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionForWrite(tx, actor, input.sessionId);
    const exercises = await tx.sessionExercise.findMany({
      where: { sessionId: input.sessionId },
      select: { id: true },
    });
    const known = new Set(exercises.map((e) => e.id));
    const valid = input.orderedIds.filter((id) => known.has(id));
    if (valid.length !== exercises.length || new Set(valid).size !== valid.length) {
      throw new Denied("Lista incompleta.");
    }
    for (const [i, e] of exercises.entries()) {
      await tx.sessionExercise.update({ where: { id: e.id }, data: { order: -(i + 1) } });
    }
    for (const [i, id] of valid.entries()) {
      await tx.sessionExercise.update({ where: { id }, data: { order: i + 1 } });
    }
    return g;
  }));
  if (!res.ok) return res;
  const r = res.value;
  revalidatePath(`/seguimiento/${input.sessionId}`);
  return { ok: true, data: undefined };
}

export async function addSessionExercise(input: {
  sessionId: string;
  exerciseId: string;
  sets?: number;
  reps?: number;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  // Gate by plan — a FREE tenant can't sneak a PRO-only exercise by
  // POSTing its id directly.
  const gate = await gatingForActor();

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionForWrite(tx, actor, input.sessionId);
    // Asignable = visible en el plan SaaS Y no archivado (antes solo
    // `gate.visibility`: un archivado seguía entrando por id).
    const ex = await tx.exercise.findFirst({
      where: { AND: [{ id: input.exerciseId }, assignableExerciseWhere(gate)] },
      select: { id: true, defaultSets: true, defaultReps: true },
    });
    if (!ex) throw new Denied("Ejercicio no disponible en este plan.");

    const lastOrder = await tx.sessionExercise.aggregate({
      where: { sessionId: input.sessionId },
      _max: { order: true },
    });
    const row = await tx.sessionExercise.create({
      data: {
        sessionId: input.sessionId,
        exerciseId: ex.id,
        order: (lastOrder._max.order ?? 0) + 1,
        // Exercise defaults are now optional (time-based / read-only items) →
        // fall back to 3×12 when the source has none, since SessionExercise
        // requires sets/reps.
        sets: input.sets ?? ex.defaultSets ?? 3,
        reps: input.reps ?? ex.defaultReps ?? 12,
        notes: input.notes,
      },
    });
    return { session: g, rowId: row.id } as const;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.create",
    entity: "SessionExercise",
    entityId: r.rowId,
  });
  revalidatePath(`/seguimiento/${input.sessionId}`);
  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  return { ok: true, data: { id: r.rowId } };
}

export async function removeSessionExercise(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const g = await sessionExerciseForWrite(tx, actor, id);
    await tx.sessionExercise.delete({ where: { id } });
    return g;
  }));
  if (!res.ok) return res;
  const r = res.value;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.delete",
    entity: "SessionExercise",
    entityId: id,
  });
  revalidatePath(`/seguimiento/${r.sessionId}`);
  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Append a custom session to an existing program with a free-form name.
 * Date defaults to "next slot in the cadence" if not provided.
 *
 * S02s · carrera: el index nuevo es `max(index) + 1` leído en la tx. Dos altas
 * concurrentes (doble click, dos pestañas) leían el mismo máximo y creaban dos
 * sesiones con el mismo index (no hay UNIQUE (programId, index) hasta M1; el
 * dedupe de lo que ya hay en prod es S02x). Ahora, antes de leer:
 *   1. `lockPlanPatient` (C2 (0): agregar sesiones cambia la estructura del
 *      plan y este lock va siempre primero);
 *   2. `SELECT … FOR UPDATE` de la fila del programa (C2 (3): TreatmentProgram
 *      es la última fila del orden; acá no hay Booking ni Session que lockear).
 * La segunda alta espera y lee el máximo ya incrementado.
 */
export async function addCustomSession(input: {
  programId: string;
  title?: string;
  scheduledFor?: string; // ISO
}): Promise<ActionResult<{ sessionId: string }>> {
  const actor = await getActor();
  const parsed = AddCustomSessionInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return { ok: false, error: fieldErrors.scheduledFor ? "Fecha inválida." : "Datos inválidos.", fieldErrors };
  }
  const { programId, title } = parsed.data;
  const explicit = parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : null;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const owner = await tx.treatmentProgram.findFirst({
      where: { id: programId, tenantId: actor.tenantId },
      select: { id: true, patientId: true },
    });
    if (!owner) throw new Denied("Plan no encontrado.");
    if ((await patientAccessFor(actor, owner.patientId, tx)) !== "full") {
      throw new Denied(NO_ACCESS);
    }

    await lockPlanPatient(tx, { tenantId: actor.tenantId, patientId: owner.patientId });
    await tx.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${owner.id} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;

    // Releído DESPUÉS de los locks: es lo que hace que la segunda alta vea la primera.
    const program = await tx.treatmentProgram.findFirstOrThrow({
      where: { id: owner.id, tenantId: actor.tenantId },
      select: {
        id: true,
        patientId: true,
        frequency: true,
        startDate: true,
        sessions: { orderBy: { index: "desc" }, take: 1, select: { index: true, scheduledFor: true } },
      },
    });

    const lastIndex = program.sessions[0]?.index ?? 0;
    const lastSched = program.sessions[0]?.scheduledFor ?? program.startDate;
    const cadenceDays = Math.max(1, Math.floor(7 / program.frequency));
    // Suma en ms (AR sin DST), no `setDate` del host.
    const scheduledFor = explicit ?? new Date(lastSched.getTime() + cadenceDays * DAY_MS);

    const sess = await tx.session.create({
      data: {
        programId: program.id,
        practitionerId: actor.practitionerId,
        index: lastIndex + 1,
        scheduledFor,
        notes: title,
      },
    });
    await tx.treatmentProgram.update({
      where: { id: program.id },
      data: { totalSessions: { increment: 1 } },
    });
    return { sessionId: sess.id, patientId: program.patientId } as const;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.create",
    entity: "Session",
    entityId: r.sessionId,
  });
  revalidatePath(`/pacientes/${r.patientId}`);
  revalidatePath(`/seguimiento`);
  return { ok: true, data: { sessionId: r.sessionId } };
}

/**
 * Swap one exercise in a session for another, keeping the order slot
 * and inheriting series/reps from the replacement's defaults (unless
 * the caller overrides). The old SessionExercise row is removed.
 */
export async function substituteSessionExercise(input: {
  sessionExerciseId: string;
  newExerciseId: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const gate = await gatingForActor();

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const sx = await sessionExerciseForWrite(tx, actor, input.sessionExerciseId);
    const replacement = await tx.exercise.findFirst({
      where: { AND: [{ id: input.newExerciseId }, assignableExerciseWhere(gate)] },
      select: { id: true, defaultSets: true, defaultReps: true },
    });
    if (!replacement) throw new Denied("Ejercicio destino no disponible.");

    // Two-step: bump the old row to a negative order to bypass the unique
    // constraint, then create the new one in the same slot.
    await tx.sessionExercise.update({ where: { id: sx.id }, data: { order: -sx.order } });
    await tx.sessionExercise.create({
      data: {
        sessionId: sx.sessionId,
        exerciseId: replacement.id,
        order: sx.order,
        sets: replacement.defaultSets ?? 3,
        reps: replacement.defaultReps ?? 12,
      },
    });
    await tx.sessionExercise.delete({ where: { id: sx.id } });
    return sx;
  }));
  if (!res.ok) return res;
  const r = res.value;

  revalidatePath(`/seguimiento/${r.sessionId}`);
  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  return { ok: true, data: { id: input.newExerciseId } };
}


// ──────────────────────────────────────────────────────────────────────
// Bulk-assign — Sprint 16 (D.1)
// ──────────────────────────────────────────────────────────────────────

/**
 * Programs the actor can pick when bulk-assigning exercises from the
 * Biblioteca. We list every ACTIVE / PAUSED program in the tenant the
 * actor has access to (owner or shared); the picker UI filters by
 * patient as the user types.
 */
export async function listAssignablePrograms(): Promise<
  {
    id: string;
    title: string;
    patientId: string;
    patientName: string;
    totalSessions: number;
    completedSessions: number;
    status: "ACTIVE" | "PAUSED";
  }[]
> {
  const actor = await getActor();
  const rows = await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: {
      tenantId: actor.tenantId,
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    select: {
      id: true,
      title: true,
      status: true,
      totalSessions: true,
      patient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          assignedPractitionerId: true,
        },
      },
      _count: {
        select: { sessions: { where: { completedAt: { not: null } } } },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  }));

  // Visibility gate: we don't want to leak that other-owner patients
  // exist via the program picker. Filter using the same access model.
  const access = await bulkPatientAccess(
    actor,
    rows.map((r) => r.patient.id)
  );
  return rows
    .filter((r) => access.get(r.patient.id) === "full")
    .map((r) => ({
      id: r.id,
      title: r.title,
      patientId: r.patient.id,
      patientName: `${r.patient.firstName} ${r.patient.lastName}`,
      totalSessions: r.totalSessions,
      completedSessions: r._count.sessions,
      status: r.status as "ACTIVE" | "PAUSED",
    }));
}

/**
 * Append exercises to a contiguous range of sessions in a program. The
 * `range` decides which sessions receive them:
 *
 *   - `"all"`        → every session
 *   - `{ fromIndex }` → from session N to the end
 *   - `{ phases: [...] }` → only sessions whose phase matches (uses
 *     each session's `index` modulo program length to bucket into
 *     ACTIVATION / STABILITY / LOAD / PROGRESSION — same convention as
 *     `assignDiagnosisAndCreateProgram`)
 *
 * For each target session, every chosen exercise is appended at the end
 * (max order + 1). Default sets/reps come from the Exercise row.
 * Returns the number of (session, exercise) pairs created.
 *
 * Plan-gating is enforced: a FREE tenant cannot bulk-assign exercises
 * outside its visibility window.
 *
 * S02s:
 *   - solo sesiones NO realizadas: agregarle ejercicios PENDING a una sesión
 *     cerrada reescribía su registro clínico ("hizo 5 ejercicios" pasaba a
 *     tener 7, dos sin hacer);
 *   - ejercicios asignables (`assignableExerciseWhere`: sin archivados);
 *   - una sola `runWithRls` con el gate `full` adentro: antes eran cinco tx
 *     sueltas con el chequeo de acceso afuera (ventana entre chequeo y write);
 *   - entrada con zod (`BulkAddSessionExercisesInput`).
 */
export async function bulkAddSessionExercises(input: {
  programId: string;
  exerciseIds: string[];
  range: { kind: "all" } | { kind: "fromIndex"; fromIndex: number };
}): Promise<ActionResult<{ created: number; skipped: number }>> {
  const actor = await getActor();
  const parsed = BulkAddSessionExercisesInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return { ok: false, error: fieldErrors.exerciseIds?.[0] ?? "Datos inválidos.", fieldErrors };
  }
  const { programId, exerciseIds, range } = parsed.data;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const program = await tx.treatmentProgram.findFirst({
      where: { id: programId, tenantId: actor.tenantId },
      select: { id: true, patientId: true },
    });
    if (!program) throw new Denied("Plan no encontrado.");
    // Visibility check on the patient — same gate as everywhere else.
    if ((await patientAccessFor(actor, program.patientId, tx)) !== "full") {
      throw new Denied("No tenés acceso a este paciente.");
    }

    // Plan-gate the exercise selection: drop any id the actor can't assign.
    const gate = await gatingForActor(tx);
    const allowed = await tx.exercise.findMany({
      where: { AND: [{ id: { in: exerciseIds } }, assignableExerciseWhere(gate)] },
      select: { id: true, defaultSets: true, defaultReps: true },
    });
    if (allowed.length === 0) throw new Denied("Ningún ejercicio disponible en tu plan.");

    const sessions = await tx.session.findMany({
      where: {
        programId: program.id,
        completedAt: null,
        ...(range.kind === "fromIndex" ? { index: { gte: range.fromIndex } } : {}),
      },
      select: { id: true, index: true },
      orderBy: { index: "asc" },
    });
    if (sessions.length === 0) throw new Denied("Ninguna sesión pendiente coincide con el rango.");

    // Pre-compute the max(order) per session so we can append correctly.
    const orderRows = await tx.sessionExercise.groupBy({
      by: ["sessionId"],
      where: { sessionId: { in: sessions.map((s) => s.id) } },
      _max: { order: true },
    });
    const maxOrderBySession = new Map(orderRows.map((r) => [r.sessionId, r._max.order ?? 0]));

    // Each session gets the full exercise list appended; the running counter
    // is per-session.
    const toCreate: { sessionId: string; exerciseId: string; order: number; sets: number; reps: number }[] = [];
    for (const s of sessions) {
      let nextOrder = (maxOrderBySession.get(s.id) ?? 0) + 1;
      for (const ex of allowed) {
        toCreate.push({
          sessionId: s.id,
          exerciseId: ex.id,
          order: nextOrder++,
          sets: ex.defaultSets ?? 3,
          reps: ex.defaultReps ?? 12,
        });
      }
    }
    await tx.sessionExercise.createMany({ data: toCreate, skipDuplicates: true });
    const skipped = (exerciseIds.length - allowed.length) * sessions.length;
    return { program, sessions: sessions.length, exercises: allowed.length, created: toCreate.length, skipped } as const;
  }));
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.bulkCreate",
    entity: "TreatmentProgram",
    entityId: r.program.id,
    payload: {
      sessions: r.sessions,
      exercises: r.exercises,
      created: r.created,
      skipped: r.skipped,
    },
  });

  revalidatePath(`/pacientes/${r.program.patientId}`);
  return { ok: true, data: { created: r.created, skipped: r.skipped } };
}
