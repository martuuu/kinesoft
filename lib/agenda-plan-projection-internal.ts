import "server-only";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";
import type { AgendaPlanFields } from "@/lib/bookings-types";
import type { Discipline } from "@/lib/plans-constants";
import type { ProgramStatus } from "@prisma/client";
import { modulesFor } from "@/lib/tenant-modules";
import { bulkPatientAccess } from "@/lib/visibility";
import { planTitleFor } from "@/lib/plan-authz-internal";
import { activeLinkedPlanDisciplines, planSessionOrdinals } from "@/lib/plan-display";

/**
 * Proyección C9 de la agenda (Planes; S12p, ES2b P2.1). La firma la congeló
 * P2-C1 y **S12** la cablea en `listAgendaBookings` (proyección LIVIANA; la
 * completa `listBookingsInRange` no la usa):
 *
 *   loadAgendaPlanProjection(tx, actor, rows: {id, patientId, serviceId, programId, sessionId}[], caps)
 *     → Map<bookingId, C9Fields>
 *
 * Queries PLANAS y batcheadas (C9): una por concepto para todo el rango, nunca
 * una por turno. La agenda de la Secretaria trae ~1.300 turnos por semana
 * (perf B4.6): un N+1 acá serían miles de statements por render. Peor caso
 * 4 + las 3-4 de `bulkPatientAccess`, independiente de la cantidad de filas:
 *   1. `Service` (disciplina) de los servicios del rango;
 *   2. `TreatmentProgram` de los planes de las filas + los ACTIVE vinculados
 *      de los pacientes del rango (un solo `findMany` con `OR`);
 *   3. `Session` vivas de esos planes (ordinal M13 y `totalLive`);
 *   4. `Booking.pricedByPlan` de las filas de plan, salvo que las filas lo
 *      traigan (`listAgendaBookings` lo trae desde ES4 P4.Z);
 *   5. acceso al paciente, SOLO si el actor tiene `clinical.read` (si no, el
 *      título es null igual y no hace falta preguntar), salvo que el caller
 *      pase el mapa que ya calculó (`listAgendaBookings`, ES4 P4.Z).
 * Se corren en serie a propósito: en una tx interactiva de Prisma comparten
 * la conexión y un `Promise.all` no ganaría nada.
 *
 * Reglas (C9 + §5 + C13b):
 *   - `tenantId` a mano en cada query: en prod la conexión es BYPASSRLS y una
 *     fila con un `programId`/`serviceId` de otro consultorio no puede traer
 *     nada (se proyecta neutro). `Session` no tiene `tenantId`: va por
 *     `program: { tenantId }`.
 *   - Sin el módulo `planes` (vertical General) todo neutro y sin consultar:
 *     la disciplina del servicio también es de Planes (enmienda S13).
 *   - `plan.title` solo con `clinical.read` + acceso full (`planTitleFor`):
 *     ASSISTANT, BILLING y el PRACTITIONER básico reciben null, pero ven
 *     disciplina y contador (V1-D18: "los ve todo el que ve el turno").
 *   - Ordinal M13 = por fecha entre las sesiones NO archivadas
 *     (`planSessionOrdinals`); `totalLive` = cantidad de vivas, no la caché
 *     `totalSessions` (en un legacy difieren y el chip diría "3/8" con 3 filas).
 *     Si la sesión del turno está archivada (no tiene ordinal) → `plan: null`:
 *     no se inventa un número.
 *   - `patientActiveLinkedPlanDisciplines` con R-LEGACY (`linkedProgramWhere`)
 *     y `activeLinkedPlanDisciplines`, en orden de alta del plan.
 *   - La autorización de la OS NUNCA sale acá (E2): ni se selecciona.
 */

/** Lo mínimo de cada turno que necesita la proyección (C8). */
export type AgendaPlanProjectionRow = {
  id: string;
  patientId: string | null;
  serviceId: string;
  programId: string | null;
  sessionId: string | null;
  /**
   * Opcional (aditivo, integrador P2.1): la disciplina del servicio si el
   * caller ya la leyó en su propia query (p. ej. `listAgendaBookings` la trae
   * en el `select` de `service`). Si TODAS las filas la traen, la proyección no
   * consulta `Service`: ahorra una sentencia en `/agenda` (techo de B4.6).
   * El caller garantiza que el servicio es del tenant (lo leyó por la relación
   * del turno ya filtrado por `tenantId`).
   */
  serviceDiscipline?: Discipline | null;
  /**
   * Opcional (ES4 P4.Z, perf S26s #1): `Booking.pricedByPlan` si el caller ya lo leyó en su `select` (escalar, misma
   * sentencia). Si TODAS las filas lo traen, la proyección no consulta `Booking` de nuevo (era 1 sentencia más por
   * render de `/agenda` con turnos de plan). Mismo filtro que la query: solo cuenta si el plan es del tenant.
   */
  pricedByPlan?: boolean;
};

/** = los campos C9 de `AgendaBookingRow` (`lib/bookings-types.ts`). */
export type C9Fields = AgendaPlanFields;

function neutral(r: AgendaPlanProjectionRow): C9Fields {
  return {
    programId: r.programId,
    sessionId: r.sessionId,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: null,
    patientActiveLinkedPlanDisciplines: [],
  };
}

const uniq = (xs: Iterable<string | null>): string[] => [...new Set([...xs].filter((x): x is string => !!x))];

export async function loadAgendaPlanProjection(
  tx: DbClient,
  actor: Actor,
  rows: ReadonlyArray<AgendaPlanProjectionRow>,
  caps: ReadonlySet<Capability>,
  /**
   * Opcional (ES4 P4.Z, perf S26s #1): el `bulkPatientAccess` que el caller ya calculó para los pacientes de las
   * filas (un superconjunto de los que piden título; el nivel por paciente es el mismo). Sin esto, la proyección lo
   * recalculaba (3 sentencias más por render de `/agenda` con turnos de plan).
   */
  preloadedAccess?: ReadonlyMap<string, PatientAccessLevel>
): Promise<Map<string, C9Fields>> {
  const out = new Map<string, C9Fields>();
  if (rows.length === 0) return out;
  if (!modulesFor(actor.entitlements).has("planes")) {
    for (const r of rows) out.set(r.id, neutral(r));
    return out;
  }
  const tenantId = actor.tenantId;

  const serviceIds = uniq(rows.map((r) => r.serviceId));
  const patientIds = uniq(rows.map((r) => r.patientId));
  const programIds = uniq(rows.map((r) => r.programId));
  const planRowIds = rows.filter((r) => r.programId && r.sessionId).map((r) => r.id);

  // 1. Disciplina del servicio: si el caller ya la trajo en cada fila (agenda),
  // no se consulta; si no, una query plana filtrada por tenant.
  const preloaded = rows.every((r) => r.serviceDiscipline !== undefined);
  const services = preloaded
    ? rows.map((r) => ({ id: r.serviceId, discipline: r.serviceDiscipline ?? null }))
    : await tx.service.findMany({
        where: { tenantId, id: { in: serviceIds } },
        select: { id: true, discipline: true },
      });
  const serviceDiscipline = new Map<string, Discipline | null>(services.map((s) => [s.id, s.discipline]));

  // 2+3. Planes y sesiones vivas, en UNA sentencia (ES4 P4.Z, perf S26s #1).
  //   - Planes: los de las filas (chip, cualquier estado) + los ACTIVE, vivos y vinculados de los pacientes del rango
  //     (V2). Es el SQL de `{ tenantId, OR: [{ id: in }, { patientId: in, ...liveProgramWhere, status: ACTIVE,
  //     ...linkedProgramWhere }] }`: `linkedProgramWhere` = `schedule IS NOT NULL` (DbNull) o algún Booking con ese
  //     `programId`.
  //   - Sesiones vivas (`liveSessionWhere` = `archivedAt IS NULL`) SOLO de los planes de las filas → ordinal M13 y
  //     total vivo. Van agregadas como JSON en la fila del plan.
  // Por qué SQL a mano: con dos `findMany` (planes, después sesiones) una semana CON turnos de plan costaba una
  // sentencia más que la misma semana sin planes, y el techo de `/agenda` es +5 % (≈ 0 sentencias sobre ~12;
  // tests/perf/plans.perf.test.ts). Un `select` anidado de Prisma también es otra sentencia (sin relationJoins).
  // `tenantId` a mano (BYPASSRLS en prod); `Session` no lo tiene y va por el plan, que ya está filtrado.
  type RawProgram = {
    id: string;
    patientId: string;
    status: ProgramStatus;
    archivedAt: Date | null;
    discipline: Discipline | null;
    title: string;
    sessions: { id: string; index: number; scheduledForMs: number }[] | null;
  };
  const rawPrograms =
    programIds.length > 0 || patientIds.length > 0
      ? await tx.$queryRaw<RawProgram[]>`
          SELECT p.id, p."patientId", p.status::text AS status, p."archivedAt", p.discipline::text AS discipline,
            p.title,
            CASE WHEN p.id = ANY(${programIds}::text[]) THEN COALESCE((
              SELECT json_agg(json_build_object(
                'id', s.id, 'index', s.index,
                'scheduledForMs', floor(extract(epoch FROM s."scheduledFor") * 1000)))
              FROM "Session" s
              WHERE s."programId" = p.id AND s."archivedAt" IS NULL
            ), '[]'::json) END AS sessions
          FROM "TreatmentProgram" p
          WHERE p."tenantId" = ${tenantId}
            AND (
              p.id = ANY(${programIds}::text[])
              OR (
                p."patientId" = ANY(${patientIds}::text[])
                AND p."archivedAt" IS NULL
                AND p.status = 'ACTIVE'
                AND (p.schedule IS NOT NULL OR EXISTS (SELECT 1 FROM "Booking" b WHERE b."programId" = p.id))
              )
            )
          -- "En orden de aparición" de activeLinkedPlanDisciplines = orden de alta.
          ORDER BY p."createdAt" ASC, p.id ASC`
      : [];
  const programs = rawPrograms.map(({ sessions: _sessions, ...p }) => p);
  const programById = new Map(programs.map((p) => [p.id, p]));

  // Todo plan que volvió es VINCULADO: o entró por la rama `linkedProgramWhere`,
  // o entró por id porque un turno real del rango lo referencia (= tiene un
  // turno con `programId`, R-LEGACY). Por eso `hasLinkedBooking: true`; el
  // filtro ACTIVE/no archivado lo hace `activeLinkedPlanDisciplines`.
  const programsByPatient = new Map<string, typeof programs>();
  for (const p of programs) {
    const list = programsByPatient.get(p.patientId) ?? [];
    list.push(p);
    programsByPatient.set(p.patientId, list);
  }
  const linkedDisciplinesByPatient = new Map(
    [...programsByPatient].map(([patientId, list]) => [
      patientId,
      activeLinkedPlanDisciplines(list.map((p) => ({ ...p, hasSchedule: false, hasLinkedBooking: true }))),
    ])
  );

  // 3. Ordinal M13 y total vivo de los planes de las filas (las sesiones ya vinieron con el plan).
  const chipProgramIds = programIds.filter((id) => programById.has(id));
  const ordinalByProgram = new Map<string, { ordinals: Map<string, number>; totalLive: number }>();
  for (const p of rawPrograms) {
    if (p.sessions === null) continue; // plan que entró solo por paciente: no es chip de ninguna fila
    const list = p.sessions.map((x) => ({ id: x.id, index: x.index, scheduledFor: new Date(x.scheduledForMs), archivedAt: null }));
    // Mismo criterio que antes: un plan sin sesiones vivas no tiene entrada (no hay ordinal que mostrar).
    if (list.length === 0) continue;
    ordinalByProgram.set(p.id, { ordinals: planSessionOrdinals(list), totalLive: list.length });
  }

  // 4. `pricedByPlan` de los turnos de plan (solo los `true`).
  // Si el caller ya lo trajo en cada fila (agenda), sin query: mismo conjunto que la query (filas de plan con `true`).
  const pricedPreloaded = rows.every((r) => r.pricedByPlan !== undefined);
  const pricedRows = pricedPreloaded
    ? rows.filter((r) => r.programId && r.sessionId && r.pricedByPlan === true).map((r) => ({ id: r.id }))
    : planRowIds.length > 0 && chipProgramIds.length > 0
      ? await tx.booking.findMany({
          where: { tenantId, id: { in: planRowIds }, pricedByPlan: true },
          select: { id: true },
        })
      : [];
  const pricedIds = new Set(pricedRows.map((b) => b.id));

  // 5. Acceso al paciente para el título: solo si el actor podría verlo. Con el mapa del caller, sin queries.
  let access: ReadonlyMap<string, PatientAccessLevel> = new Map<string, PatientAccessLevel>();
  if (caps.has("clinical.read") && ordinalByProgram.size > 0) {
    const titlePatients = uniq(
      rows.filter((r) => r.programId && ordinalByProgram.has(r.programId)).map((r) => r.patientId)
    );
    if (titlePatients.length > 0) {
      access = preloadedAccess ?? (await bulkPatientAccess(actor, titlePatients, tx));
    }
  }

  for (const r of rows) {
    const f = neutral(r);
    f.serviceDiscipline = serviceDiscipline.get(r.serviceId) ?? null;
    if (r.patientId) f.patientActiveLinkedPlanDisciplines = linkedDisciplinesByPatient.get(r.patientId) ?? [];
    const program = r.programId ? programById.get(r.programId) : undefined;
    const ord = r.programId ? ordinalByProgram.get(r.programId) : undefined;
    const ordinal = r.sessionId ? ord?.ordinals.get(r.sessionId) : undefined;
    // `pricedByPlan` solo si el plan es del tenant (fila forjada → false). Con
    // la sesión archivada no hay chip, pero el flag de precio sigue siendo real.
    if (program) f.pricedByPlan = pricedIds.has(r.id);
    if (program && ord && ordinal !== undefined) {
      f.plan = {
        discipline: program.discipline,
        ordinal,
        totalLive: ord.totalLive,
        title: planTitleFor(caps, (r.patientId && access.get(r.patientId)) || "none", program.title),
      };
    }
    out.set(r.id, f);
  }
  return out;
}
