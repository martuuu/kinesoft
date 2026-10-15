"use server";

/**
 * Lecturas de Planes (S14, ES2b P2.0) — server actions finas.
 *
 * Camino de cada una (AGENTS §4): `getActor()` → módulo `planes` → zod →
 * capabilities del rol → `runWithRls` con `where: { tenantId }` a mano (en
 * prod la conexión es BYPASSRLS: el filtro explícito es la única barrera) →
 * acceso al paciente DENTRO de la tx → proyección por nivel
 * (`lib/plans-read-internal.ts`).
 *
 * Módulo (enmienda EV0, regla de `lib/authz.ts`): sin `planes`, las LISTAS
 * devuelven vacío (se llaman desde pantallas comunes —ficha del paciente,
 * agenda— y no tienen que romper un consultorio General) y las lecturas de
 * DETALLE (`getPlanDetail`, `getPlanHistory`) devuelven el copy del módulo.
 *
 * Errores como resultado (`PlanReadResult`), no como throw: en prod Next
 * oculta el mensaje de un throw y la UI no distingue "sin permiso" de "se
 * cayó la base". Un error inesperado (la base) sí se propaga.
 *
 * Este archivo exporta SOLO funciones async; tipos, zod y copy viven en
 * `lib/plans-read-types.ts`.
 */
import { displayMemberName } from "@/lib/display-name";
import type { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor, ForbiddenError, type Actor } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import type { Capability } from "@/lib/capabilities";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { patientAccessFor, bulkPatientAccess } from "@/lib/visibility";
import { assertPlanScheduleInTx, canSeePlanAuthorization, planTitleFor } from "@/lib/plan-authz-internal";
import {
  linkedProgramWhere,
  liveProgramWhere,
  sessionWithoutActiveBookingWhere,
} from "@/lib/plan-predicates";
import { dbDateToDayKey } from "@/lib/availability/day";
import {
  balanceOf,
  canReadAnyPlan,
  historyDetail,
  loadPlansInTx,
  planReadLevel,
  projectHeader,
  projectPlan,
  projectPlanDetail,
  schedulableSessionsOf,
} from "@/lib/plans-read-internal";
import {
  ListPlansInput,
  PatientIdInput,
  PatientPlansInput,
  PlanIdInput,
  PLAN_HISTORY_MAX,
  PLAN_LIST_MAX,
  PLAN_READ_COPY,
  type ListPlansInputT,
  type PatientIdInputT,
  type PatientPlanBalances,
  type PatientPlansInputT,
  type PlanDetailDTO,
  type PlanDTO,
  type PlanHistory,
  type PlanIdInputT,
  type PlanListResult,
  type PlanReadResult,
  type SchedulablePlanSession,
} from "@/lib/plans-read-types";

const forbidden = { ok: false as const, error: PLAN_READ_COPY.forbidden };
const notFound = { ok: false as const, error: PLAN_READ_COPY.notFound };
const invalid = { ok: false as const, error: PLAN_READ_COPY.invalid };
const noModule = { ok: false as const, error: MODULE_DENIED_COPY.planes };

function hasPlanes(actor: Actor): boolean {
  return modulesFor(actor.entitlements).has("planes");
}

async function capsOf(actor: Actor): Promise<ReadonlySet<Capability>> {
  return memberCapabilitiesForActor(actor);
}

/**
 * Planes del tenant para `/planes/[disciplina]` (S21) y su filtro "Sesiones sin
 * turno". Por defecto ACTIVE y PAUSED, sin archivados. Cada fila sale con el
 * nivel del actor sobre SU paciente (`bulkPatientAccess`, una query); las de
 * pacientes que el actor no puede leer no salen. Nunca lleva la autorización
 * de la OS (E2).
 *
 * Tope `PLAN_LIST_MAX` + `truncated` en vez de paginar: el filtro por nivel es
 * por fila (después de la query) y un cursor sobre filas filtradas mentiría;
 * con planes ACTIVE/PAUSED de un consultorio el tope sobra.
 */
export async function listPlans(raw: ListPlansInputT = {}): Promise<PlanReadResult<PlanListResult>> {
  const actor = await getActor();
  if (!hasPlanes(actor)) return { ok: true, data: { rows: [], truncated: false } };
  const parsed = ListPlansInput.safeParse(raw ?? {});
  if (!parsed.success) return invalid;
  const input = parsed.data;
  const caps = await capsOf(actor);
  if (!canReadAnyPlan(caps)) return forbidden;

  const now = new Date();
  const where: Prisma.TreatmentProgramWhereInput = {
    AND: [
      { status: { in: input.statuses ?? ["ACTIVE", "PAUSED"] } },
      input.includeArchived ? {} : liveProgramWhere,
      input.discipline ? { discipline: input.discipline } : {},
      input.practitionerId ? { practitionerId: input.practitionerId } : {},
      input.onlyWithSinTurno
        ? { AND: [linkedProgramWhere, { sessions: { some: sessionWithoutActiveBookingWhere } }] }
        : {},
    ],
  };

  return runWithRls(actor.tenantId, async (tx) => {
    const plans = await loadPlansInTx(tx, actor.tenantId, where, { take: PLAN_LIST_MAX + 1 });
    const truncated = plans.length > PLAN_LIST_MAX;
    const page = plans.slice(0, PLAN_LIST_MAX);
    const access = await bulkPatientAccess(actor, [...new Set(page.map((p) => p.patientId))], tx);
    const rows: PlanListResult["rows"] = [];
    for (const p of page) {
      const acc = access.get(p.patientId) ?? "none";
      const level = planReadLevel(caps, acc);
      if (!level) continue;
      const { _sessions: _omit, ...header } = projectHeader(p, { caps, access: acc, level, now });
      void _omit;
      if (input.onlyWithSinTurno && header.sinTurno === 0) continue;
      rows.push({ ...header, patientName: `${p.patient.firstName} ${p.patient.lastName}` });
    }
    return { ok: true as const, data: { rows, truncated } };
  });
}

/**
 * Detalle completo de un plan (editor, PlanCard expandida). Solo nivel `full`
 * (acceso full + `clinical.read`): la Secretaria y Facturación → Forbidden
 * (lo administrativo lo leen por `getPatientPlans`). Plan de otro tenant o
 * inexistente → "no encontrado" (sin distinguir: no es un oráculo de ids).
 */
export async function getPlanDetail(raw: PlanIdInputT): Promise<PlanReadResult<PlanDetailDTO>> {
  const actor = await getActor();
  if (!hasPlanes(actor)) return noModule;
  const parsed = PlanIdInput.safeParse(raw);
  if (!parsed.success) return invalid;
  const caps = await capsOf(actor);

  return runWithRls(actor.tenantId, async (tx) => {
    const [p] = await loadPlansInTx(tx, actor.tenantId, { id: parsed.data.programId });
    if (!p) return notFound;
    const access = await patientAccessFor(actor, p.patientId, tx);
    if (planReadLevel(caps, access) !== "full") return forbidden;
    return { ok: true as const, data: projectPlanDetail(p, { caps, access, level: "full", now: new Date() }) };
  });
}

/**
 * Planes de un paciente (Tab Planes de la ficha). `full` → DTO completo;
 * `admin` (Secretaria, Facturación) → proyección administrativa. Sin
 * archivados salvo `includeArchived` (restaurar es de OWNER/ADMIN, la UI lo pide).
 * La autorización de la OS sale solo con `canSeePlanAuthorization`.
 */
export async function getPatientPlans(raw: PatientPlansInputT): Promise<PlanReadResult<PlanDTO[]>> {
  const actor = await getActor();
  if (!hasPlanes(actor)) return { ok: true, data: [] };
  const parsed = PatientPlansInput.safeParse(raw);
  if (!parsed.success) return invalid;
  const { patientId, includeArchived } = parsed.data;
  const caps = await capsOf(actor);

  return runWithRls(actor.tenantId, async (tx) => {
    const access = await patientAccessFor(actor, patientId, tx);
    const level = planReadLevel(caps, access);
    if (!level) return forbidden;
    const plans = await loadPlansInTx(tx, actor.tenantId, {
      AND: [{ patientId }, includeArchived ? {} : liveProgramWhere],
    });
    const now = new Date();
    return { ok: true as const, data: plans.map((p) => projectPlan(p, { caps, access, level, now })) };
  });
}

/**
 * Saldo P7 de cada plan del paciente, agregado en el server. Incluye los
 * archivados: un plan cerrado puede seguir debiendo (o teniendo a favor)
 * plata. Totales = Σ por plan de pendiente/a favor ya recortados (un plan a
 * favor no compensa la deuda de otro: son cuentas distintas).
 */
export async function getPatientPlanBalances(raw: PatientIdInputT): Promise<PlanReadResult<PatientPlanBalances>> {
  const actor = await getActor();
  const empty: PatientPlanBalances = {
    plans: [],
    totals: { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 },
  };
  if (!hasPlanes(actor)) return { ok: true, data: empty };
  const parsed = PatientIdInput.safeParse(raw);
  if (!parsed.success) return invalid;
  const { patientId } = parsed.data;
  const caps = await capsOf(actor);

  return runWithRls(actor.tenantId, async (tx) => {
    const access = await patientAccessFor(actor, patientId, tx);
    const level = planReadLevel(caps, access);
    if (!level) return forbidden;
    const plans = await loadPlansInTx(tx, actor.tenantId, { patientId });
    const out = empty;
    for (const p of plans) {
      const balance = balanceOf(p);
      const title = planTitleFor(caps, access, p.title);
      out.plans.push({ programId: p.id, discipline: p.discipline, status: p.status, title, balance });
      out.totals.pendingCents += balance.pendingCents;
      out.totals.creditCents += balance.creditCents;
      out.totals.collectedCents += balance.collectedCents;
      out.totals.inProcessCents += balance.inProcessCents;
    }
    return { ok: true as const, data: out };
  });
}

/**
 * Historial de un plan: eventos de audit del plan, de sus sesiones (vivas y
 * archivadas) y de sus autorizaciones, con el payload por allowlist
 * (`historyDetail`) y el nombre del actor; más el historial de órdenes de la
 * OS (las filas con `supersededAt`), solo para quien puede ver la autorización.
 * Solo nivel `full`: es la bitácora clínica del tratamiento.
 */
export async function getPlanHistory(raw: PlanIdInputT): Promise<PlanReadResult<PlanHistory>> {
  const actor = await getActor();
  if (!hasPlanes(actor)) return noModule;
  const parsed = PlanIdInput.safeParse(raw);
  if (!parsed.success) return invalid;
  const caps = await capsOf(actor);
  const tenantId = actor.tenantId;

  return runWithRls(tenantId, async (tx) => {
    const program = await tx.treatmentProgram.findFirst({
      where: { id: parsed.data.programId, tenantId },
      select: {
        id: true,
        patientId: true,
        sessions: { select: { id: true } },
        authorizations: {
          select: {
            id: true,
            code: true,
            authorizedSessions: true,
            startsOn: true,
            expiresOn: true,
            createdAt: true,
            supersededAt: true,
          },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        },
      },
    });
    if (!program) return notFound;
    const access = await patientAccessFor(actor, program.patientId, tx);
    if (planReadLevel(caps, access) !== "full") return forbidden;

    const events = await tx.auditEvent.findMany({
      where: {
        tenantId,
        OR: [
          { entity: "TreatmentProgram", entityId: program.id },
          { entity: "Session", entityId: { in: program.sessions.map((s) => s.id) } },
          { entity: "ProgramAuthorization", entityId: { in: program.authorizations.map((a) => a.id) } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PLAN_HISTORY_MAX,
      select: { id: true, createdAt: true, action: true, entity: true, entityId: true, actorId: true, payload: true },
    });
    // Nombre del actor: por el Practitioner DEL TENANT (no por UserProfile
    // suelto), así un actorId ajeno no resuelve a un nombre de otro consultorio.
    const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
    const pros = actorIds.length
      ? await tx.practitioner.findMany({
          where: { tenantId, userId: { in: actorIds } },
          select: { userId: true, user: { select: { fullName: true, email: true } } },
        })
      : [];
    const names = new Map(pros.map((p) => [p.userId, displayMemberName(p.user.fullName)]));

    const history: PlanHistory = {
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        actorId: e.actorId,
        actorName: e.actorId ? names.get(e.actorId) ?? null : null,
        detail: historyDetail(e.payload),
      })),
    };
    if (canSeePlanAuthorization(caps, access)) {
      history.authorizations = program.authorizations.map((a) => ({
        id: a.id,
        code: a.code,
        authorizedSessions: a.authorizedSessions,
        startsOn: dbDateToDayKey(a.startsOn),
        expiresOn: dbDateToDayKey(a.expiresOn),
        createdAt: a.createdAt,
        supersededAt: a.supersededAt,
      }));
    }
    return { ok: true as const, data: history };
  });
}

/**
 * Sesiones agendables de un paciente (E1): las vivas sin cerrar de sus planes
 * ACTIVE, no archivados y vinculados (R-LEGACY: un legacy no se agenda hasta
 * "Completar datos"). Gate `assertPlanScheduleInTx` (`plans.schedule` + (full
 * o `agenda.operateAll`)). ALLOWLIST literal: `{sessionId, ordinal,
 * totalLive, discipline, serviceId, practitionerId, locationId, sinTurno}` —
 * sin títulos, notas, ejercicios, precios ni autorización. Sin `planes` →
 * `[]` (el modal de agenda es común a las dos verticales).
 */
export async function listSchedulablePlanSessions(
  raw: PatientIdInputT
): Promise<PlanReadResult<SchedulablePlanSession[]>> {
  const actor = await getActor();
  if (!hasPlanes(actor)) return { ok: true, data: [] };
  const parsed = PatientIdInput.safeParse(raw);
  if (!parsed.success) return invalid;
  const { patientId } = parsed.data;
  const caps = await capsOf(actor);

  try {
    return await runWithRls(actor.tenantId, async (tx) => {
      await assertPlanScheduleInTx(tx, actor, caps, patientId);
      const plans = await loadPlansInTx(tx, actor.tenantId, {
        AND: [{ patientId, status: "ACTIVE" }, liveProgramWhere, linkedProgramWhere],
      });
      return { ok: true as const, data: plans.flatMap(schedulableSessionsOf) };
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
}
