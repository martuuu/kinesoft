import "server-only";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";
import type { AgendaPlanFields } from "@/lib/bookings-types";
import type { Discipline } from "@/lib/plans-constants";
import { modulesFor } from "@/lib/tenant-modules";
import { bulkPatientAccess } from "@/lib/visibility";
import { planTitleFor } from "@/lib/plan-authz-internal";
import { linkedProgramWhere, liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
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
 *   4. `Booking.pricedByPlan` de las filas de plan (la fila de entrada no lo
 *      trae y la firma está congelada);
 *   5. acceso al paciente, SOLO si el actor tiene `clinical.read` (si no, el
 *      título es null igual y no hace falta preguntar).
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
  caps: ReadonlySet<Capability>
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

  // 2. Planes: los de las filas (chip, cualquier estado) + los ACTIVE, vivos y
  // vinculados de los pacientes del rango (V2). Un solo `findMany`.
  const programOr = [];
  if (programIds.length > 0) programOr.push({ id: { in: programIds } });
  if (patientIds.length > 0) {
    programOr.push({
      AND: [{ patientId: { in: patientIds } }, liveProgramWhere, { status: "ACTIVE" as const }, linkedProgramWhere],
    });
  }
  const programs =
    programOr.length > 0
      ? await tx.treatmentProgram.findMany({
          where: { tenantId, OR: programOr },
          select: { id: true, patientId: true, status: true, archivedAt: true, discipline: true, title: true },
          // "En orden de aparición" de `activeLinkedPlanDisciplines` = orden de alta.
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [];
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

  // 3. Sesiones vivas de los planes de las filas → ordinal M13 y total vivo.
  const chipProgramIds = programIds.filter((id) => programById.has(id));
  const sessions =
    chipProgramIds.length > 0
      ? await tx.session.findMany({
          where: { AND: [{ programId: { in: chipProgramIds }, program: { tenantId } }, liveSessionWhere] },
          select: { id: true, programId: true, index: true, scheduledFor: true, archivedAt: true },
        })
      : [];
  const sessionsByProgram = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = sessionsByProgram.get(s.programId) ?? [];
    list.push(s);
    sessionsByProgram.set(s.programId, list);
  }
  const ordinalByProgram = new Map(
    [...sessionsByProgram].map(([programId, list]) => [programId, { ordinals: planSessionOrdinals(list), totalLive: list.length }])
  );

  // 4. `pricedByPlan` de los turnos de plan (solo los `true`).
  const pricedRows =
    planRowIds.length > 0 && chipProgramIds.length > 0
      ? await tx.booking.findMany({
          where: { tenantId, id: { in: planRowIds }, pricedByPlan: true },
          select: { id: true },
        })
      : [];
  const pricedIds = new Set(pricedRows.map((b) => b.id));

  // 5. Acceso al paciente para el título: solo si el actor podría verlo.
  let access = new Map<string, PatientAccessLevel>();
  if (caps.has("clinical.read") && ordinalByProgram.size > 0) {
    const titlePatients = uniq(
      rows.filter((r) => r.programId && ordinalByProgram.has(r.programId)).map((r) => r.patientId)
    );
    if (titlePatients.length > 0) access = await bulkPatientAccess(actor, titlePatients, tx);
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
