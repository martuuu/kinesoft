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
 *
 * Planes P2 · S12b (sincronía lado sesión, PLANES.md C4):
 *   - módulo `sesiones` (EV0): cada export lo exige. Lecturas vacías (`null`,
 *     `[]`, buckets vacíos) y escrituras `{ok:false}` con el copy del módulo:
 *     la UI de un consultorio General esconde Seguimiento, pero una action se
 *     puede llamar por RPC igual;
 *   - cerrar en Seguimiento lockea primero el turno activo vinculado y lo pasa
 *     a COMPLETED en la misma tx (Booking → Session → TreatmentProgram, C2 (3));
 *     si la sesión ya estaba realizada (por "Atendido"), lo tipeado se carga
 *     como evolución en vez de perderse;
 *   - D22 / PQ-09: ya no autocompleta el plan; sugiere el alta;
 *   - `rescheduleSession` con turno activo mueve el turno por el core de la
 *     agenda (L5) y la sesión le sigue (I3); nunca cambia el profesional;
 *   - buckets "Sin turno" (R-LEGACY), "Realizadas sin evolución" y la
 *     sugerencia de alta; "Sesión n de N" por ordinal entre las vivas (M13);
 *   - archivados (plan o sesión) fuera de todo listado y del bulk;
 *   - toda escritura de turno emite `afterBookingsCommitted` una vez, después
 *     del commit; el verificador de invariantes corre al final de la tx donde
 *     se cierra o se mueve una sesión.
 */
import { revalidatePath } from "next/cache";
import { Prisma, type SessionExerciseStatus } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { audit, auditInTx } from "@/lib/audit";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { bulkPatientAccess, patientAccessFor, visibilityForActor } from "@/lib/visibility";
import { dayKeyOf, dayWindow } from "@/lib/availability/day";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { planSessionOrdinals } from "@/lib/plan-display";
import {
  linkedProgramWhere,
  liveProgramWhere,
  liveSessionWhere,
  sessionWithoutActiveBookingWhere,
} from "@/lib/plan-predicates";
import {
  actorCapsInTx,
  applyBookingUpdateInTx,
  notifyPlanNearingDischarge,
  resolveBookingUpdateUniqueViolation,
  type PlanDischarge,
} from "@/lib/bookings-core";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { assertProgramInvariantsInTx, ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import {
  BAD_LOCATION_ERROR,
  BAD_ROOM_ERROR,
  ROOM_BLOCKED_ERROR,
  ROOM_BUSY_ERROR,
  BASIC_ACCESS_ERROR,
  BLOCKED_ERROR,
  OUT_OF_HOURS_ERROR,
  PATIENT_OVERLAP_ERROR,
  PLAN_SESSION_NOT_PENDING_ERROR,
  PLAN_SESSION_TAKEN_ERROR,
  PRACTITIONER_CONFLICT_ERROR,
  STALE_ERROR,
  UPDATE_SAME_INSTANT_ERROR,
} from "@/lib/bookings-constants";
import { completeSessionInTx, recordSessionEvolutionInTx } from "@/lib/sessions-internal";
import { assertPlanScheduleInTx } from "@/lib/plan-authz-internal";
import {
  BulkAddSessionExercisesInput,
  LoadSessionEvolutionInput,
  RescheduleSessionInput,
} from "@/lib/sessions-schemas";
import {
  BookingUpdate,
  SessionExerciseUpdate,
  SessionMeta,
  SessionMetaUpdate,
  type ActionResult,
  type SessionMetaInput,
  type SessionMetaUpdateInput,
} from "@/lib/validation";

import {
  OPEN_SESSIONS_BUCKET_LIMIT,
  type CompleteSessionResult,
  type DischargeSuggestionRow,
  type OpenSessionBucket,
  type OpenSessionBuckets,
  type OpenSessionRow,
  type RescheduleSessionResult,
} from "@/lib/sessions-types";

const NO_ACCESS = "No tenés acceso completo a este paciente.";
const DAY_MS = 86_400_000;
const ARCHIVED_SESSION = "La sesión está archivada.";
/** H-a1: apareció un turno activo de la sesión mientras se cerraba (rollback total). */
const SESSION_CHANGED_WHILE_CLOSING = "La sesión cambió mientras la cerrabas: reintentá.";
/**
 * El verificador (`assertProgramInvariantsInTx`) ya mandó el diff a Sentry y
 * la tx hizo rollback: es un bug nuestro, no un error del usuario. Sin esto,
 * la action tiraba y Next mostraba un 500 genérico.
 */
const INVARIANT_ERROR = "No pudimos guardar el cambio porque el plan quedaría inconsistente. Ya nos llegó el aviso.";

/**
 * Módulo `sesiones` (EV0, enmienda S12b): sin él, `{ok:false}` con el copy del
 * módulo. No tira `ForbiddenError` (como `requireModule`) porque estas actions
 * devuelven `ActionResult` y en prod Next enmascara el mensaje de un throw.
 */
function sessionsModuleOff(actor: Actor): { ok: false; error: string } | null {
  return modulesFor(actor.entitlements).has("sesiones") ? null : { ok: false, error: MODULE_DENIED_COPY.sesiones };
}

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
    if (e instanceof ProgramInvariantViolation) return { ok: false, error: INVARIANT_ERROR };
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
      archivedAt: true,
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

/** Fila del hidratado del landing (una sentencia: sesión + plan + paciente + ordinal + ejercicios). */
type OpenSessionHydrated = {
  id: string;
  programId: string;
  title: string | null;
  index: number;
  scheduledFor: Date;
  completedAt: Date | null;
  patientId: string;
  programTitle: string;
  totalSessions: number;
  firstName: string;
  lastName: string;
  ordinal: number | null;
  totalLive: number | null;
  exerciseCount: number;
  doneCount: number;
};

function toOpenSessionRow(s: OpenSessionHydrated): OpenSessionRow {
  return {
    id: s.id,
    index: s.index,
    scheduledFor: s.scheduledFor,
    completedAt: s.completedAt,
    patientId: s.patientId,
    patientName: `${s.firstName} ${s.lastName}`,
    programTitle: s.programTitle,
    totalSessions: s.totalSessions,
    exerciseCount: s.exerciseCount,
    doneCount: s.doneCount,
    programId: s.programId,
    title: s.title,
    // M13: "Sesión n de N" por ordinal entre las vivas (no `index`/`totalSessions`).
    ...(s.ordinal != null ? { ordinal: s.ordinal } : {}),
    ...(s.totalLive != null ? { totalLive: s.totalLive } : {}),
  };
}

const EMPTY_BUCKET: OpenSessionBucket = { rows: [], total: 0 };

/**
 * Landing de Seguimiento (A2a-S03 ítem 5). Cambios vs. la versión anterior:
 *   - el día es el día AR (`lib/datetime-ar.ts`); antes `setHours(0)` del host
 *     (UTC en Vercel) corría el corte 3 h;
 *   - una query por bucket con su propio tope: el `take: 80` global ordenado
 *     por `completedAt asc` dejaba afuera pendientes cuando había muchas
 *     realizadas, y las vencidas sin cerrar no aparecían en ningún lado;
 *   - buckets abiertos (vencidas/hoy/próximas) solo de planes ACTIVE: un plan
 *     CANCELLED o PAUSED no tiene que pedir que cierres sus sesiones.
 *     "Realizadas" incluye COMPLETED;
 *   - solo pacientes con acceso `full`: se filtra en SQL (para que tope y
 *     conteo sean reales) y se re-verifica con `bulkPatientAccess`, que es la
 *     fuente de verdad del modelo de acceso.
 *
 * S12b:
 *   - sin el módulo `sesiones`, buckets vacíos sin consultar;
 *   - planes y sesiones archivados fuera de todos los buckets;
 *   - buckets nuevos: "Sin turno" (C4, predicado único; solo planes ACTIVE
 *     VINCULADOS — R-LEGACY: un alta vieja no tiene turnos que faltar),
 *     "Realizadas sin evolución" (mismo criterio que "untouched", últimos 14
 *     días como "Realizadas") y la sugerencia de alta (D22). Son lentes, no
 *     particiones: una sesión "sin turno" de mañana también está en "Próximas";
 *   - cada bucket trae SOLO ids (una sentencia escalar) y todas las filas se
 *     hidratan juntas en UNA sentencia con el ordinal por ventana. Antes cada
 *     bucket hacía 4 sentencias (sesión, plan, paciente, ejercicios: Prisma 5
 *     sin `relationJoins` emite una por relación) y sumar dos buckets más con
 *     ese patrón llevaba el landing de 28 a ~40 sentencias.
 */
export async function listOpenSessions(now: Date = new Date()): Promise<OpenSessionBuckets> {
  const actor = await getActor();
  if (sessionsModuleOff(actor)) {
    return {
      overdue: EMPTY_BUCKET,
      today: EMPTY_BUCKET,
      upcoming: EMPTY_BUCKET,
      recent: EMPTY_BUCKET,
      sinTurno: EMPTY_BUCKET,
      realizadasSinEvolucion: EMPTY_BUCKET,
      suggestDischarge: { rows: [], total: 0 },
    };
  }
  const today = arDayBounds(now);
  const recentSince = new Date(today.start.getTime() - 14 * DAY_MS);
  const take = OPEN_SESSIONS_BUCKET_LIMIT;
  const tenantId = actor.tenantId;

  return runWithRls(tenantId, async (tx) => {
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
      tenantId,
      ...liveProgramWhere,
      status: { in: statuses },
      patient: patientAccessWhere,
    });

    const bucket = async (
      where: Prisma.SessionWhereInput,
      orderBy: Prisma.SessionOrderByWithRelationInput
    ): Promise<{ ids: string[]; total: number }> => {
      const full: Prisma.SessionWhereInput = { AND: [liveSessionWhere, where] };
      const rows = await tx.session.findMany({ where: full, orderBy: [orderBy, { id: "asc" }], select: { id: true }, take });
      // Solo contamos cuando el tope cortó: el caso común es 1 query.
      const total = rows.length < take ? rows.length : await tx.session.count({ where: full });
      return { ids: rows.map((r) => r.id), total };
    };

    const open = programWhere(["ACTIVE"]);
    const closedAny = programWhere(["ACTIVE", "COMPLETED", "PAUSED"]);
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
    const recent = await bucket({ program: closedAny, completedAt: { gte: recentSince } }, { completedAt: "desc" });
    const sinTurno = await bucket(
      { ...sessionWithoutActiveBookingWhere, program: { AND: [open, linkedProgramWhere] } },
      { scheduledFor: "asc" }
    );
    // "Untouched" (C4), espejo de `lockSessionEvolutionStateInTx`. SQL crudo a
    // propósito: el `none` de Prisma sobre `exercises`/`evaScores` compila a
    // `NOT IN (SELECT … FROM "SessionExercise" …)` sobre TODA la tabla, y bajo
    // RLS (`kinesoft_app`) la policy de SessionExercise (EXISTS por fila) se
    // evalúa para cada fila: medido ~600 ms con el fixture de volumen (24k
    // ejercicios) contra ~4 ms como owner. Con `NOT EXISTS` correlacionado la
    // policy corre solo sobre los ejercicios de las candidatas, por índice.
    // `count(*) OVER ()` da el total antes del LIMIT en la misma sentencia.
    const accessSql = vis.seesAll
      ? Prisma.sql`TRUE`
      : Prisma.sql`(pa."assignedPractitionerId" = ${actor.practitionerId} OR EXISTS (
          SELECT 1 FROM "PatientShare" sh WHERE sh."patientId" = pa.id AND sh."practitionerId" = ${actor.practitionerId}))`;
    const sinEvRows = await tx.$queryRaw<{ id: string; total: number }[]>`
      SELECT s.id, count(*) OVER ()::int AS total
      FROM "Session" s
      JOIN "TreatmentProgram" tp ON tp.id = s."programId"
      JOIN "Patient" pa ON pa.id = tp."patientId"
      WHERE tp."tenantId" = ${tenantId} AND tp."archivedAt" IS NULL
        AND tp.status IN ('ACTIVE', 'COMPLETED', 'PAUSED') AND ${accessSql}
        AND s."archivedAt" IS NULL AND s."completedAt" >= ${recentSince}
        AND s.notes IS NULL AND s.rpe IS NULL AND s."paInPre" IS NULL AND s."paInPost" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "EvaScore" e WHERE e."sessionId" = s.id)
        AND NOT EXISTS (SELECT 1 FROM "SessionExercise" x WHERE x."sessionId" = s.id AND x.status <> 'PENDING')
      ORDER BY s."completedAt" DESC, s.id ASC
      LIMIT ${take}`;
    const sinEvolucion = { ids: sinEvRows.map((r) => r.id), total: sinEvRows[0]?.total ?? 0 };

    // D22: planes ACTIVE con al menos una sesión viva y ninguna viva pendiente.
    const dischargeWhere: Prisma.TreatmentProgramWhereInput = {
      ...open,
      sessions: { some: liveSessionWhere, none: { archivedAt: null, completedAt: null } },
    };
    const dischargePrograms = await tx.treatmentProgram.findMany({
      where: dischargeWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: { id: true, patientId: true, title: true, discipline: true, totalSessions: true },
      take,
    });
    const dischargeTotal =
      dischargePrograms.length < take ? dischargePrograms.length : await tx.treatmentProgram.count({ where: dischargeWhere });
    const dischargeIds = dischargePrograms.map((p) => p.id);
    const dischargeAgg = dischargeIds.length
      ? await tx.$queryRaw<
          { id: string; firstName: string; lastName: string; lastCompletedAt: Date; totalLive: number; linked: boolean }[]
        >`
          SELECT tp.id, p."firstName", p."lastName", max(s."completedAt") AS "lastCompletedAt",
            count(s.id)::int AS "totalLive",
            (tp.schedule IS NOT NULL OR EXISTS (
              SELECT 1 FROM "Booking" b WHERE b."programId" = tp.id AND b."tenantId" = ${tenantId})) AS linked
          FROM "TreatmentProgram" tp
          JOIN "Patient" p ON p.id = tp."patientId" AND p."tenantId" = ${tenantId}
          JOIN "Session" s ON s."programId" = tp.id AND s."archivedAt" IS NULL
          WHERE tp.id = ANY(${dischargeIds}) AND tp."tenantId" = ${tenantId}
          GROUP BY tp.id, p."firstName", p."lastName"`
      : [];
    const aggById = new Map(dischargeAgg.map((a) => [a.id, a]));

    // Hidratado único de todas las filas de sesión.
    const allIds = [...new Set([overdue, todayB, upcoming, recent, sinTurno, sinEvolucion].flatMap((b) => b.ids))];
    const hydrated = allIds.length
      ? await tx.$queryRaw<OpenSessionHydrated[]>`
          WITH progs AS (
            SELECT DISTINCT s."programId" FROM "Session" s WHERE s.id = ANY(${allIds})
          ), live AS (
            SELECT s.id,
              row_number() OVER (PARTITION BY s."programId" ORDER BY s."scheduledFor", s.index)::int AS ordinal,
              count(*) OVER (PARTITION BY s."programId")::int AS "totalLive"
            FROM "Session" s
            WHERE s."programId" IN (SELECT "programId" FROM progs) AND s."archivedAt" IS NULL
          ), ex AS (
            -- Un solo barrido por índice (no dos subconsultas por fila: bajo RLS
            -- cada fila de SessionExercise paga su policy).
            SELECT x."sessionId", count(*)::int AS n, (count(*) FILTER (WHERE x.status = 'DONE'))::int AS done
            FROM "SessionExercise" x WHERE x."sessionId" = ANY(${allIds}) GROUP BY x."sessionId"
          )
          SELECT s.id, s."programId", s.title, s.index, s."scheduledFor", s."completedAt", tp."patientId", tp.title AS "programTitle",
            tp."totalSessions", p."firstName", p."lastName", l.ordinal, l."totalLive",
            COALESCE(ex.n, 0) AS "exerciseCount", COALESCE(ex.done, 0) AS "doneCount"
          FROM "Session" s
          JOIN "TreatmentProgram" tp ON tp.id = s."programId" AND tp."tenantId" = ${tenantId}
          JOIN "Patient" p ON p.id = tp."patientId" AND p."tenantId" = ${tenantId}
          LEFT JOIN live l ON l.id = s.id
          LEFT JOIN ex ON ex."sessionId" = s.id
          WHERE s.id = ANY(${allIds})`
      : [];
    const byId = new Map(hydrated.map((h) => [h.id, h]));

    const access = await bulkPatientAccess(
      actor,
      [...new Set([...hydrated.map((h) => h.patientId), ...dischargePrograms.map((p) => p.patientId)])],
      tx
    );
    const finalize = (b: { ids: string[]; total: number }): OpenSessionBucket => {
      const rows = b.ids
        .map((id) => byId.get(id))
        .filter((h): h is OpenSessionHydrated => !!h && access.get(h.patientId) === "full");
      return { rows: rows.map(toOpenSessionRow), total: b.total - (b.ids.length - rows.length) };
    };

    const dischargeRows: DischargeSuggestionRow[] = [];
    for (const p of dischargePrograms) {
      const a = aggById.get(p.id);
      if (!a || access.get(p.patientId) !== "full") continue;
      // R-LEGACY: un alta vieja dice "8 sesiones" con 3 filas cargadas; ahí
      // manda el contador (lo que hacía el autocompletado de antes), no las filas.
      if (!a.linked && a.totalLive < p.totalSessions) continue;
      dischargeRows.push({
        programId: p.id,
        patientId: p.patientId,
        patientName: `${a.firstName} ${a.lastName}`,
        programTitle: p.title,
        discipline: p.discipline,
        totalLive: a.totalLive,
        lastCompletedAt: a.lastCompletedAt,
      });
    }

    return {
      overdue: finalize(overdue),
      today: finalize(todayB),
      upcoming: finalize(upcoming),
      recent: finalize(recent),
      sinTurno: finalize(sinTurno),
      realizadasSinEvolucion: finalize(sinEvolucion),
      suggestDischarge: {
        rows: dischargeRows,
        total: dischargeTotal - (dischargePrograms.length - dischargeRows.length),
      },
    };
  });
}

/**
 * Detalle de una sesión. `null` si no existe en el tenant **o** si el actor
 * no tiene acceso `full` al paciente (la página responde 404 en ambos casos:
 * no se filtra que la sesión existe), o sin el módulo `sesiones`.
 *
 * S12b: `program.sessions` solo trae las vivas (una archivada está oculta) y
 * el resultado suma `ordinal`/`totalLive` (M13: "Sesión n de N" por fecha
 * entre las vivas; `null` si la sesión pedida está archivada).
 */
export async function getSessionDetail(id: string) {
  const actor = await getActor();
  if (sessionsModuleOff(actor)) return null;
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
              where: liveSessionWhere,
              orderBy: { index: "asc" },
              select: {
                id: true,
                index: true,
                // S20: el nombre de la sesión a medida en la lista del plan.
                title: true,
                scheduledFor: true,
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
    const ordinals = planSessionOrdinals(s.program.sessions.map((x) => ({ ...x, archivedAt: null })));
    return { ...s, ordinal: ordinals.get(s.id) ?? null, totalLive: s.program.sessions.length };
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
  const off = sessionsModuleOff(actor);
  if (off) return off;
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

/** Turno activo de una sesión (I2: a lo sumo uno), para decidir el camino. */
type ActiveSessionBooking = {
  id: string;
  status: string;
  practitionerId: string;
  scheduledFor: Date;
  updatedAt: Date;
  /** FX1a (SV08-gap): sala del turno para el ref realtime (la vista «Por sala»). */
  roomId: string | null;
};

/** Traduce un rechazo del core de turnos a copy (mismo copy que `updateBooking`). */
function bookingOutcomeError(o: Exclude<Awaited<ReturnType<typeof applyBookingUpdateInTx>>, { kind: "ok" }>): string {
  switch (o.kind) {
    case "notfound":
      return "Turno no encontrado.";
    case "basic":
      return BASIC_ACCESS_ERROR;
    case "stale":
      return STALE_ERROR;
    case "patient-slot":
      return UPDATE_SAME_INSTANT_ERROR;
    case "patient-overlap":
      return PATIENT_OVERLAP_ERROR;
    case "bad-location":
      return BAD_LOCATION_ERROR;
    case "bad-room":
      return BAD_ROOM_ERROR;
    case "room-busy":
      return o.blocked ? ROOM_BLOCKED_ERROR(o.roomName, o.blocked.reason) : ROOM_BUSY_ERROR(o.roomName);
    case "blocked":
      return BLOCKED_ERROR(o.reason);
    case "out-of-hours":
      return OUT_OF_HOURS_ERROR;
    case "conflict":
      return PRACTITIONER_CONFLICT_ERROR;
    case "plan-session-not-pending":
      return PLAN_SESSION_NOT_PENDING_ERROR(o.ordinal);
    default:
      // foreign-patient / clinical-relink / plan-paid-cancel / plan-patient-change:
      // un patch de solo `scheduledFor` no los puede producir.
      return "No se pudo mover el turno de la sesión.";
  }
}

/**
 * Reprogramar UNA sesión del plan (A2a-S03 ítem 4; S12b, L5 de C4).
 *
 * Historia: antes de P2 sesión y turno no tenían FK; se movía solo la sesión
 * y se informaba el turno del paciente de ese día para moverlo a mano (la
 * heurística ±2 h movía el turno equivocado). Desde M1 el vínculo existe:
 *   - **con turno activo** (`sessionId`, `status ∉ {CANCELLED, NO_SHOW}`): se
 *     mueve el TURNO por el core de la agenda (`applyBookingUpdateInTx`: gate
 *     de la Secretaria, franjas, bloqueos, cupo, superposición, lock
 *     optimista) y el core arrastra la sesión (write-through I3). Orden C2:
 *     cupo → sedes → Booking → Session (lo toma el core) → TreatmentProgram
 *     (acá, después). Un rechazo forzable vuelve como error; `force` lo pasa;
 *   - **sin turno**: se mueve solo la fecha planificada de la sesión
 *     (Session → TreatmentProgram FOR UPDATE, cierre de ES1) y se informa el
 *     turno suelto del paciente ese día, como antes.
 * Nunca cambia el profesional: si llega otro `practitionerId`, rechazo (el
 * profesional de un turno se cambia desde la agenda). Plan CANCELLED/COMPLETED
 * o sesión realizada/archivada → rechazo, re-chequeado bajo lock.
 *
 * Post-commit: `afterBookingsCommitted` una vez si se movió un turno. Al final
 * de la tx, el verificador de invariantes del plan.
 */
export async function rescheduleSession(input: {
  sessionId: string;
  scheduledFor: string; // ISO
  practitionerId?: string;
  force?: { allowOverbooking?: boolean; allowPatientOverlap?: boolean; allowOutOfHours?: boolean; allowBlocked?: boolean; allowRoomConflict?: boolean };
}): Promise<ActionResult<RescheduleSessionResult>> {
  const actor = await getActor();
  const off = sessionsModuleOff(actor);
  if (off) return off;
  const parsed = RescheduleSessionInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return { ok: false, error: fieldErrors.scheduledFor ? "Fecha inválida." : "Datos inválidos.", fieldErrors };
  }
  const newDate = new Date(parsed.data.scheduledFor);
  const { sessionId } = parsed.data;
  const now = new Date();

  // H-a4: id del turno que se intentó mover, para resolver un P2002 afuera
  // de la tx (la tx abortada ya no admite queries).
  let triedBookingId: string | null = null;
  const res = await denied(() => withTxConflictRetry(() => runWithRls(actor.tenantId, async (tx) => {
    triedBookingId = null;
    const g = await sessionForWrite(tx, actor, sessionId);
    // P3.Z.0 (S27a → S27b): la regla de "quién agenda/mueve sesiones de un
    // plan" es UNA (`assertPlanScheduleInTx`: módulo `planes` + `plans.schedule`
    // + full u `agenda.operateAll`), no una copia local. `sessionForWrite` se
    // queda delante: Seguimiento es superficie clínica y exige full (A2a-S03),
    // más estricto que la regla de agenda (la Secretaria mueve el TURNO desde
    // la agenda, no la sesión desde acá). El módulo `sesiones` sigue arriba.
    try {
      await assertPlanScheduleInTx(tx, actor, await actorCapsInTx(tx, actor), g.program.patientId);
    } catch (e) {
      // `denied()` solo traduce `Denied`; un ForbiddenError saldría como 500.
      if (e instanceof ForbiddenError) throw new Denied(e.message);
      throw e;
    }
    if (g.archivedAt) throw new Denied(ARCHIVED_SESSION);
    if (parsed.data.practitionerId && parsed.data.practitionerId !== g.practitionerId) {
      throw new Denied("Reprogramar no cambia el profesional: cambialo desde la agenda.");
    }

    // Lectura SIN lock para elegir el camino: con turno, el primer lock tiene
    // que ser el de cupo (lo toma el core), no la fila del turno ni la sesión.
    const active = await tx.booking.findFirst({
      where: { tenantId: actor.tenantId, sessionId, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      select: { id: true, status: true, practitionerId: true, scheduledFor: true, updatedAt: true },
    });

    let refs: BookingChangeRef[] = [];
    let movedBookingId: string | null = null;
    if (active) {
      // Falla rápido con el snapshot (sin tocar el cupo); se re-chequea abajo bajo lock.
      if (g.completedAt) throw new Denied("La sesión ya fue realizada: no se puede reprogramar.");
      if (g.program.status === "CANCELLED" || g.program.status === "COMPLETED") {
        throw new Denied(
          g.program.status === "CANCELLED"
            ? "El plan está cancelado: no se pueden reprogramar sus sesiones."
            : "El plan está completado: no se pueden reprogramar sus sesiones."
        );
      }
      triedBookingId = active.id;
      const outcome = await applyBookingUpdateInTx(
        tx,
        actor,
        {
          patch: BookingUpdate.parse({ id: active.id, scheduledFor: newDate.toISOString() }),
          expectedUpdatedAt: active.updatedAt.toISOString(),
          force: parsed.data.force ?? {},
        },
        { now }
      );
      if (outcome.kind !== "ok") throw new Denied(bookingOutcomeError(outcome));
      refs = outcome.refs;
      movedBookingId = active.id;
    }

    // Chequeos bajo lock (hallazgo A5, cierre de ES1): Session FOR UPDATE →
    // TreatmentProgram FOR UPDATE (orden C2 (3)); en READ COMMITTED devuelven
    // la última versión commiteada. Con turno, la fila de Session ya la tiene
    // esta tx (write-through del core) y un rechazo acá deshace el turno movido.
    const locked = await tx.$queryRaw<{ completedAt: Date | null; scheduledFor: Date }[]>`
      SELECT s."completedAt", s."scheduledFor"
      FROM "Session" s
      JOIN "TreatmentProgram" tp ON tp.id = s."programId"
      WHERE s.id = ${sessionId} AND tp."tenantId" = ${actor.tenantId}
      FOR UPDATE OF s`;
    // H-a2: `FOR NO KEY UPDATE` sobre el plan (mismo porqué que en el cierre:
    // no chocar con el FOR KEY SHARE de las FKs de replan/vincular/adoptar).
    const programRow = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM "TreatmentProgram"
      WHERE id = ${g.program.id} AND "tenantId" = ${actor.tenantId}
      FOR NO KEY UPDATE`;
    if (!locked[0] || !programRow[0]) throw new Denied("Sesión no encontrada.");
    const programStatus = programRow[0].status;
    if (programStatus === "CANCELLED") {
      throw new Denied("El plan está cancelado: no se pueden reprogramar sus sesiones.");
    }
    if (programStatus === "COMPLETED") {
      throw new Denied("El plan está completado: no se pueden reprogramar sus sesiones.");
    }
    if (locked[0].completedAt) throw new Denied("La sesión ya fue realizada: no se puede reprogramar.");

    let bookingOnDay: RescheduleSessionResult["bookingOnDay"] = null;
    if (!active) {
      // Un turno de la sesión que apareció entre la lectura y el lock dejaría
      // la sesión movida y el turno no (I3): se pide reintentar.
      const appeared = await tx.booking.count({
        where: { tenantId: actor.tenantId, sessionId, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      });
      if (appeared > 0) throw new Denied("La sesión cambió mientras la reprogramabas. Reintentá.");
      await tx.session.update({ where: { id: sessionId }, data: { scheduledFor: newDate } });

      const day = arDayBounds(newDate);
      const booking = await tx.booking.findFirst({
        where: {
          tenantId: actor.tenantId,
          patientId: g.program.patientId,
          scheduledFor: { gte: day.start, lt: day.end },
          status: { not: "CANCELLED" },
        },
        orderBy: { scheduledFor: "asc" },
        select: { id: true, scheduledFor: true },
      });
      bookingOnDay = booking ? { ...booking, dateKey: day.key } : null;
    }

    await assertProgramInvariantsInTx(tx, { tenantId: actor.tenantId, programId: g.program.id });
    return { session: { ...g, scheduledFor: locked[0].scheduledFor }, from: g.scheduledFor, bookingOnDay, refs, movedBookingId } as const;
  }))).catch(async (e) => {
    // H-a4 (revisión ES2b): mover el turno a un instante que el MISMO paciente
    // ocupa en una tx concurrente (no visible para el chequeo del core) pisa
    // el único parcial paciente+instante y Postgres tira P2002 al commit del
    // otro. El core no lo atrapa (un P2002 aborta la tx, C8); antes salía como
    // 500. Mismo tratamiento que `updateBooking`: se decide por los datos en
    // una tx nueva.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && triedBookingId) {
      const u = await resolveBookingUpdateUniqueViolation(actor.tenantId, triedBookingId);
      return {
        ok: false as const,
        error: u.kind === "plan-session-taken" ? PLAN_SESSION_TAKEN_ERROR(u.ordinal) : UPDATE_SAME_INSTANT_ERROR,
      };
    }
    throw e;
  });
  if (!res.ok) return res;
  const r = res.value;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.reschedule",
    entity: "Session",
    entityId: sessionId,
    payload: {
      from: r.from.toISOString(),
      to: newDate.toISOString(),
      practitionerId: r.session.practitionerId,
      bookingMoved: r.movedBookingId,
      bookingOnDay: r.bookingOnDay?.id ?? null,
    },
  });
  if (r.movedBookingId) {
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "booking.update",
      entity: "Booking",
      entityId: r.movedBookingId,
      payload: { scheduledFor: newDate.toISOString(), source: "session.reschedule", sessionId },
    });
    revalidatePath("/agenda");
    await afterBookingsCommitted(actor.tenantId, r.refs);
  }

  revalidatePath(`/pacientes/${r.session.program.patientId}`);
  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${sessionId}`);
  // Con turno: el turno se movió con la sesión, no hay "turno que quedó" que avisar.
  return { ok: true, data: { bookingOnDay: r.bookingOnDay } };
}

/**
 * Guarda notas / EVA pre-post / RPE sin cerrar la sesión. `null` vacía el
 * campo (antes `""` viajaba como `undefined` y las notas no se podían borrar).
 */
export async function updateSessionMeta(input: SessionMetaUpdateInput): Promise<ActionResult> {
  const actor = await getActor();
  const off = sessionsModuleOff(actor);
  if (off) return off;
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
 * Sesiones vivas pendientes de un plan, con el TreatmentProgram ya lockeado
 * por el caller (C2 (3): va último). R-LEGACY: en un alta vieja (sin
 * `schedule` ni turnos) `totalSessions` puede decir 8 con 3 filas; ahí cuenta
 * el contador, como el autocompletado de antes. En un vinculado manda I5
 * (vivas).
 */
async function programPendingInTx(
  tx: DbClient,
  tenantId: string,
  programId: string
): Promise<{ pending: number; totalLive: number; status: string } | null> {
  const rows = await tx.$queryRaw<
    { live: number; done: number; totalSessions: number; status: string; linked: boolean }[]
  >`
    SELECT count(s.id)::int AS live, count(s."completedAt")::int AS done, tp."totalSessions", tp.status::text AS status,
      (tp.schedule IS NOT NULL OR EXISTS (
        SELECT 1 FROM "Booking" b WHERE b."programId" = tp.id AND b."tenantId" = ${tenantId})) AS linked
    FROM "TreatmentProgram" tp
    LEFT JOIN "Session" s ON s."programId" = tp.id AND s."archivedAt" IS NULL
    WHERE tp.id = ${programId} AND tp."tenantId" = ${tenantId}
    GROUP BY tp.id`;
  const r = rows[0];
  if (!r) return null;
  if (r.linked) return { pending: r.live - r.done, totalLive: r.live, status: r.status };
  const total = Math.max(r.live, r.totalSessions);
  return { pending: Math.max(r.live - r.done, r.totalSessions - r.done), totalLive: total, status: r.status };
}

/**
 * Cierre de sesión desde Seguimiento (H3, A2a-S03 ítem 1).
 *
 * Bug que lo motivó: "Cerrar sesión" solo mandaba el id; las notas y EVA
 * tipeadas en el panel sin apretar "Guardar anotaciones" se perdían, y la
 * EvaScore se armaba con el `paInPost` viejo leído antes. Además eran 4
 * transacciones sueltas y un doble click duplicaba EvaScore y notificación.
 *
 * Todo en UNA `runWithRls`, idempotente (el claim es un `updateMany … WHERE
 * completedAt IS NULL`: con dos tx concurrentes solo una gana).
 *
 * S12b (C4 "Escrituras de sesión que propagan al turno", C2 (3)):
 *   1. el turno ACTIVO vinculado se lockea primero (`FOR UPDATE`): mismo orden
 *      que "Atendido" en Recepción y que el drawer (Booking → Session), así un
 *      "Atendido" y un "Cerrar" simultáneos se encolan en vez de trabarse;
 *   2. claim de la sesión (`completeSessionInTx`, `source:'seguimiento'`);
 *   3. si el turno estaba PENDING/CONFIRMED → CAS a COMPLETED en la misma tx
 *      (sin esto la agenda seguía mostrando "por atender" una sesión cerrada,
 *      y el turno quedaba para cobrar/marcar ausente);
 *   4. si la sesión YA estaba realizada (la cerró "Atendido", que escribe solo
 *      `completedAt`), lo tipeado se carga como evolución si todavía no tiene
 *      (`recordSessionEvolutionInTx`): antes se descartaba en silencio — el
 *      mismo bug de H3 por otro camino;
 *   5. TreatmentProgram `FOR UPDATE` → conteo de vivas pendientes. D22/PQ-09:
 *      ya NO autocompleta el plan (`programCompleted` siempre false); si no
 *      quedan pendientes, `suggestDischarge` y la UI pregunta "¿Le das el
 *      alta?". El lock sigue: sin él, dos cierres concurrentes de las dos
 *      últimas veían una pendiente cada uno y nadie sugería el alta;
 *   6. verificador de invariantes del plan al final de la tx.
 * Post-commit: `afterBookingsCommitted` si cambió el turno, y el aviso
 * PROGRAM_NEARING_DISCHARGE (al responsable del plan, D17) si quedan ≤ 1.
 */
export async function completeSessionFromSeguimiento(
  sessionId: string,
  meta?: SessionMetaInput
): Promise<ActionResult<CompleteSessionResult>> {
  const actor = await getActor();
  const off = sessionsModuleOff(actor);
  if (off) return off;
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
  const tenantId = actor.tenantId;

  const res = await denied(() => withTxConflictRetry(() => runWithRls(tenantId, async (tx) => {
    const s = await sessionForWrite(tx, actor, sessionId);
    if (s.archivedAt) throw new Denied(ARCHIVED_SESSION);

    // (1) C2 (3): el turno activo vinculado, primero. El WHERE se re-evalúa
    // después de esperar el lock: si otro lo canceló, ya no viene.
    const booked = await tx.$queryRaw<ActiveSessionBooking[]>`
      SELECT id, status::text AS status, "practitionerId", "scheduledFor", "updatedAt", "roomId"
      FROM "Booking"
      WHERE "tenantId" = ${tenantId} AND "sessionId" = ${sessionId} AND status NOT IN ('CANCELLED', 'NO_SHOW')
      ORDER BY id
      FOR UPDATE`;

    // (2)
    const { claimed } = await completeSessionInTx(tx, {
      tenantId,
      sessionId,
      actorId: actor.userId ?? null,
      source: "seguimiento",
      meta: m,
      now,
    });
    if (!claimed) {
      // (4) "Cargar evolución" implícito: ya realizada (por la agenda) y sin evolución.
      await recordSessionEvolutionInTx(tx, { tenantId, sessionId, actorId: actor.userId ?? null, meta: m, now });
      return { s, alreadyCompleted: true, refs: [] as BookingChangeRef[], discharge: null, suggest: false } as const;
    }

    // (2b) H-a1 (revisión ES2b): `booked` se leyó ANTES del claim. Si vino
    // vacío, un "generar turnos" / vincular / adoptar / replan concurrente
    // pudo colgar un turno activo de esta sesión entre esa lectura y el claim
    // (insertar un Booking con `sessionId` toma FOR KEY SHARE sobre la sesión,
    // que NO choca con el lock del claim). Sin esta relectura la sesión quedaba
    // "realizada" con un turno CONFIRMED futuro por cobrar / marcar ausente.
    // Bajo el lock de la sesión (el claim) se re-cuenta; si apareció uno,
    // rollback total y que el kine reintente (la segunda vuelta lo encuentra
    // en (1) y lo completa). El caso inverso (el motor crea el turno DESPUÉS de
    // este claim) lo cierra el motor re-chequeando `completedAt IS NULL` con
    // `FOR UPDATE` de la sesión antes de crear/adoptar (fixer del motor, P2.Z).
    if (booked.length === 0) {
      const appeared = await tx.booking.count({
        where: { tenantId, sessionId, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      });
      if (appeared > 0) throw new Denied(SESSION_CHANGED_WHILE_CLOSING);
    }

    // (3) CAS del turno: filtro escalar (el WHERE se re-evalúa bajo el lock de fila).
    const refs: BookingChangeRef[] = [];
    const b = booked[0];
    if (b && (b.status === "PENDING" || b.status === "CONFIRMED")) {
      const u = await tx.booking.updateMany({
        where: { id: b.id, tenantId, status: { in: ["PENDING", "CONFIRMED"] } },
        data: { status: "COMPLETED" },
      });
      if (u.count === 1) {
        // FX1a (SV08-gap): con la sala, leída en (1) bajo `FOR UPDATE` (el CAS no la cambia).
        refs.push({ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, prev: null, kind: "booking" });
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId ?? undefined,
          action: "booking.update",
          entity: "Booking",
          entityId: b.id,
          payload: { status: "COMPLETED", from: b.status, source: "seguimiento", sessionId },
        });
      }
    }

    // (5) H-a2: `FOR NO KEY UPDATE`, no `FOR UPDATE`. Sigue serializando dos
    // cierres del mismo plan (NO KEY UPDATE choca consigo mismo, que es lo que
    // necesita el conteo de pendientes), pero ya no choca con el FOR KEY SHARE
    // que toman las FKs (`Booking.programId`, `Session.programId`) de un
    // replan / vincular / adoptar que insertan o mueven filas del plan: con
    // FOR UPDATE esos caminos (plan antes que sesión) cerraban un ciclo con
    // este (sesión antes que plan) → 40P01. Lo que quede de ciclo (un UPDATE
    // real del plan del otro lado) lo cubre `withTxConflictRetry`.
    await tx.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${s.program.id} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`;
    const left = await programPendingInTx(tx, tenantId, s.program.id);
    const suggest = !!left && left.pending === 0 && (left.status === "ACTIVE" || left.status === "PAUSED");
    const discharge: PlanDischarge | null =
      left && left.pending <= 1 && left.status !== "CANCELLED"
        ? { programId: s.program.id, pending: left.pending, totalLive: left.totalLive }
        : null;

    // (6)
    await assertProgramInvariantsInTx(tx, { tenantId, programId: s.program.id });
    return { s, alreadyCompleted: false, refs, discharge, suggest } as const;
  })));
  if (!res.ok) return res;
  const r = res.value;

  const patientId = r.s.program.patientId;
  if (r.refs.length > 0) {
    revalidatePath("/agenda");
    await afterBookingsCommitted(tenantId, r.refs);
  }
  // Solo el request que ganó el cierre avisa (el doble click no duplica).
  if (r.discharge) await notifyPlanNearingDischarge(tenantId, r.discharge, actor.userId ?? null);

  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${sessionId}`);
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath(`/dashboard`);
  return {
    ok: true,
    data: { alreadyCompleted: r.alreadyCompleted, programCompleted: false, suggestDischarge: r.suggest },
  };
}

/**
 * "Cargar evolución" sobre una sesión realizada (S12b; Seguimiento: tag "Sin
 * evolución" → "Cargar evolución"). Una sesión que cerró la agenda
 * ("Atendido") tiene solo `completedAt`; esto le carga meta, ejercicios
 * PENDING → DONE y EVA post (con `sessionId`). No toca el turno (ya está
 * COMPLETED) ni el plan.
 *
 * `loaded:false` = ya tenía evolución (no pisa: se edita con "Guardar
 * anotaciones") o no llegó nada que cargar; también hace idempotente el doble
 * click. Sobre una sesión abierta, rechazo: eso es "Cerrar sesión".
 */
export async function loadSessionEvolution(
  sessionId: string,
  meta: SessionMetaInput
): Promise<ActionResult<{ loaded: boolean }>> {
  const actor = await getActor();
  const off = sessionsModuleOff(actor);
  if (off) return off;
  const id = LoadSessionEvolutionInput.safeParse({ sessionId });
  const parsed = SessionMeta.safeParse(meta ?? {});
  if (!id.success || !parsed.success) {
    return {
      ok: false,
      error: "EVA y RPE tienen que ser enteros entre 0 y 10.",
      fieldErrors: parsed.success ? undefined : parsed.error.flatten().fieldErrors,
    };
  }
  const now = new Date();

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    const s = await sessionForWrite(tx, actor, sessionId);
    if (s.archivedAt) throw new Denied(ARCHIVED_SESSION);
    const ev = await recordSessionEvolutionInTx(tx, {
      tenantId: actor.tenantId,
      sessionId,
      actorId: actor.userId ?? null,
      meta: parsed.data,
      now,
    });
    if (ev.reason === "not-completed") throw new Denied("La sesión todavía no se realizó: cerrala desde Seguimiento.");
    if (ev.reason === "not-found") throw new Denied("Sesión no encontrada.");
    return { s, loaded: ev.recorded } as const;
  }));
  if (!res.ok) return res;

  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${sessionId}`);
  revalidatePath(`/pacientes/${res.value.s.program.patientId}`);
  return { ok: true, data: { loaded: res.value.loaded } };
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
  const off = sessionsModuleOff(actor);
  if (off) return off;
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
  const off = sessionsModuleOff(actor);
  if (off) return off;
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
  const off = sessionsModuleOff(actor);
  if (off) return off;
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

// P3.Z.0 (S27b): se retiró el alta vieja de sesión a medida. "Agregar sesión a medida" va
// solo por el motor (`addPlanSessions` / `previewAddPlanSessions` con
// `kind:'custom'`, `lib/plans-edit.ts`): gate `plans.manage`, lock del
// paciente, cuota del plan, verificador y audit en la tx. La carrera de dos
// altas concurrentes (S02s) y los casos de plata (P2.Z H-a3/B-M1) se
// re-afirmaron sobre esa puerta en `tests/integration/sessions.test.ts` y
// `tests/integration/plans-sync-sessions.test.ts` antes de borrarla. Un plan
// R-LEGACY (sin responsable o sin servicio) ya no acepta sesiones a medida:
// el motor lo rechaza con copy (`PLAN_ENGINE_COPY.program`).

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
  const off = sessionsModuleOff(actor);
  if (off) return off;
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
 *
 * S12b: sin el módulo `sesiones`, `[]`; planes archivados fuera
 * (`liveProgramWhere`): un plan archivado está oculto en todos lados.
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
  if (sessionsModuleOff(actor)) return [];
  const rows = await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: {
      tenantId: actor.tenantId,
      ...liveProgramWhere,
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
        // S12b: realizadas VIVAS (una archivada no cuenta para "n de N").
        select: { sessions: { where: { ...liveSessionWhere, completedAt: { not: null } } } },
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
 * (Un rango `{ phases }` figuraba acá pero nunca existió en el schema; se
 * borró de la doc en P3.Z.0. `{ fromOrdinal }` por "Sesión n de N" entre las
 * vivas quedó para C1: necesita el schema de `lib/sessions-schemas.ts`.)
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
  const off = sessionsModuleOff(actor);
  if (off) return off;
  const parsed = BulkAddSessionExercisesInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return { ok: false, error: fieldErrors.exerciseIds?.[0] ?? "Datos inválidos.", fieldErrors };
  }
  const { programId, exerciseIds, range } = parsed.data;

  const res = await denied(() => runWithRls(actor.tenantId, async (tx) => {
    // S12b: un plan archivado no recibe ejercicios (está oculto).
    const program = await tx.treatmentProgram.findFirst({
      where: { id: programId, tenantId: actor.tenantId, ...liveProgramWhere },
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
        ...liveSessionWhere,
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
