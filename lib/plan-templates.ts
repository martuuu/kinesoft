"use server";

/**
 * Plantillas de plan ("mis planes") — S17t (ES3 P3.1).
 *
 * Una plantilla es un BORRADOR del editor de planes: disciplina, servicio,
 * duración, horario (C6), cantidad de sesiones, precio, notas y ejercicios.
 * Aplicarla no crea nada: `getTemplatePrefill` devuelve el borrador y el
 * editor abre prellenado; el alta va por el motor (`previewPlan` →
 * `createPlan` con `templateId`), que es el único que crea planes, sesiones y
 * turnos con locks, cupos e idempotencia. P3.Z.0 (S27b) retiró la puerta
 * vieja ("aplicar" creaba plan + N sesiones a mano, sin turnos ni locks); sus
 * gates se re-afirmaron sobre `createPlan` con `templateId` en
 * `tests/integration/plan-templates-authz.test.ts` antes de borrarla.
 *
 * Gates (enmienda EV0/SV de PLANES §11, literal): "plantillas solo por
 * `gatingForActor(tx).canBuildTemplates` / `has('plantillas')`". Las
 * escrituras y el prefill leen `canBuildTemplates` DENTRO de la tx que
 * escribe/lee (un cambio de plan SaaS concurrente se ve en la misma foto); el
 * listado devuelve `[]` sin el módulo (P2-Z · B-L2, convención de VERTICALES:
 * escrituras rechazan, lecturas vacías).
 *
 * Roles: crear, editar, archivar y prellenar exigen `plans.manage` (PD-09: la
 * Secretaria agenda, no arma planes). Editar, archivar y borrar: solo el
 * autor o un OWNER/ADMIN (P0-S02t). El rol se lee en la misma tx.
 *
 * Tenant: todo `where` lleva `tenantId` a mano (en prod la conexión tiene
 * BYPASSRLS) y los ids de servicio y ejercicios se validan contra el tenant
 * con `validatePlanRefsInTx` (C8): las FK saltean RLS.
 */
import { revalidatePath } from "next/cache";
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor, isTenantAdminRole } from "@/lib/capabilities";
import { auditInTx } from "@/lib/audit";
import { assignableExerciseWhere, gatingForActor, type ExerciseCapabilities } from "@/lib/plan-gating";
import { PLAN_MAX_SESSIONS, type Discipline } from "@/lib/plans-constants";
import {
  PLAN_ENGINE_COPY,
  PlanRejected,
  legacyFrequency,
  validatePlanRefsInTx,
} from "@/lib/plans-engine-internal";
import { PlanEditorPrefillSchema, type PlanEditorPrefill } from "@/lib/plans-deeplink";
import type { PlanPricingInput, PlanScheduleV1 } from "@/lib/plans-types";
import type { ActionResult } from "@/lib/validation";

import {
  PlanTemplateCreateSchema,
  PlanTemplateUpdateSchema,
  type PlanTemplateCreateInput,
  type PlanTemplateDetail,
  type PlanTemplatePrefill,
  type PlanTemplateRow,
  type PlanTemplateUpdateInput,
} from "@/lib/plan-templates-types";

type Tx = Prisma.TransactionClient;
type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const COPY = {
  upgrade: "Mejorá tu plan para usar plantillas.",
  role: "Tu rol no puede armar plantillas de plan.",
  notFound: "Plantilla no encontrada.",
  notAuthor: "Solo quien creó la plantilla o un administrador puede cambiarla.",
  notAuthorDelete: "Solo quien creó la plantilla o un administrador puede borrarla.",
  archived: "La plantilla está archivada. Restaurala para usarla.",
  stale: "Otra persona cambió la plantilla mientras la editabas. Cerrá y volvé a abrirla.",
} as const;

/** Dosis por defecto cuando el ejercicio no trae series/reps (como el picker de sesión). */
const DEFAULT_SETS = 3;
const DEFAULT_REPS = 12;

function fail(error: string, field?: string): Fail {
  return { ok: false, error, ...(field ? { fieldErrors: { [field]: [error] } } : {}) };
}

/** `PlanRejected` / `ForbiddenError` → `{ ok:false }`; el resto sigue de largo (500 real). */
function rejection(e: unknown): Fail | null {
  if (e instanceof PlanRejected) return fail(e.message, e.field);
  if (e instanceof ForbiddenError) return fail(e.message);
  return null;
}

function zodFail(error: z.ZodError): Fail {
  const fieldErrors: Record<string, string[]> = {};
  for (const i of error.issues) {
    const k = i.path.length ? String(i.path[0]) : "_";
    (fieldErrors[k] ??= []).push(i.message);
  }
  return { ok: false, error: error.issues[0]?.message ?? "Datos inválidos.", fieldErrors };
}

/** Rol en la tx del caller (sin una segunda conexión del pool). */
async function roleInTx(tx: Tx, actor: Actor): Promise<Role | null> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

/**
 * Gate de escritura/prefill, en la tx: módulo `plantillas`
 * (`canBuildTemplates`) primero —sin él no importa el rol— y después
 * `plans.manage`. Tira `ForbiddenError`.
 */
async function templateGateInTx(
  tx: Tx,
  actor: Actor
): Promise<{ gate: ExerciseCapabilities; isAdmin: boolean }> {
  const gate = await gatingForActor(tx);
  if (!gate.canBuildTemplates) throw new ForbiddenError(COPY.upgrade);
  const role = await roleInTx(tx, actor);
  if (!capabilitiesFor(role).has("plans.manage")) throw new ForbiddenError(COPY.role);
  return { gate, isAdmin: isTenantAdminRole(role) };
}

/**
 * Valida servicio, disciplina, duración y ejercicios contra el tenant.
 *
 * Con servicio: `validatePlanRefsInTx` (C8) con el AUTOR de la plantilla
 * como responsable — el mismo validador del motor, así una plantilla que se
 * guarda es una que su autor puede aplicar (servicio del tenant, de la misma
 * disciplina y habilitado para él; duración efectiva en 15..240; ejercicios
 * asignables). P3.Z: antes era el actor, así que un admin que editaba la
 * plantilla de un colega validaba el servicio contra SU agenda (rechazaba uno
 * que el autor sí tiene y aceptaba uno que el autor no puede usar).
 * Sin servicio: solo los ejercicios, con el mismo filtro `assignable`.
 *
 * Devuelve la disciplina a guardar: la elegida, o la del servicio si no se
 * eligió (así `/planes/[disciplina]` la encuentra).
 */
async function validateTemplateRefsInTx(
  tx: Tx,
  actor: Actor,
  gate: ExerciseCapabilities,
  refs: { discipline: Discipline | null; serviceId: string | null; durationMin: number | null },
  exerciseIds: ReadonlyArray<string> | undefined,
  authorId: string
): Promise<Discipline | null> {
  if (refs.serviceId) {
    const ok = await validatePlanRefsInTx(tx, actor, {
      discipline: refs.discipline,
      practitionerId: authorId,
      serviceId: refs.serviceId,
      locationId: null,
      durationMin: refs.durationMin,
      exerciseIds,
    });
    return refs.discipline ?? ok.service.discipline;
  }
  if (exerciseIds?.length) {
    const ok = await tx.exercise.findMany({
      where: { AND: [{ id: { in: [...exerciseIds] } }, assignableExerciseWhere(gate)] },
      select: { id: true },
    });
    if (ok.length !== exerciseIds.length) throw new PlanRejected(PLAN_ENGINE_COPY.exercises, "exerciseIds");
  }
  return refs.discipline;
}

/** Pricing del input → las 3 columnas (CHECK `PlanTemplate_pricing_check`: modo + un solo precio). */
function pricingColumns(p: PlanPricingInput) {
  if (!p) return { pricingMode: null, pricePerSessionCents: null, totalPriceCents: null };
  return p.mode === "PER_SESSION"
    ? { pricingMode: p.mode, pricePerSessionCents: p.pricePerSessionCents, totalPriceCents: null }
    : { pricingMode: p.mode, pricePerSessionCents: null, totalPriceCents: p.totalPriceCents };
}

function pricingOf(r: {
  pricingMode: "PER_SESSION" | "PACKAGE" | null;
  pricePerSessionCents: number | null;
  totalPriceCents: number | null;
}): PlanPricingInput {
  if (r.pricingMode === "PER_SESSION" && r.pricePerSessionCents != null) {
    return { mode: "PER_SESSION", pricePerSessionCents: r.pricePerSessionCents };
  }
  if (r.pricingMode === "PACKAGE" && r.totalPriceCents != null) {
    return { mode: "PACKAGE", totalPriceCents: r.totalPriceCents };
  }
  return null;
}

function exerciseIdsOf(json: Prisma.JsonValue): string[] {
  return Array.isArray(json) ? json.filter((v): v is string => typeof v === "string") : [];
}

/** Schedule guardado → C6 si sigue siendo válido (una fila vieja o rota = sin horario). */
function scheduleOf(json: Prisma.JsonValue | null): PlanScheduleV1 | null {
  if (json == null) return null;
  const parsed = PlanTemplateUpdateSchema.shape.schedule.safeParse(json);
  return parsed.success ? (parsed.data ?? null) : null;
}

const ROW_SELECT = {
  id: true,
  name: true,
  description: true,
  totalSessions: true,
  frequency: true,
  exerciseIds: true,
  discipline: true,
  serviceId: true,
  durationMin: true,
  schedule: true,
  pricingMode: true,
  pricePerSessionCents: true,
  totalPriceCents: true,
  notes: true,
  authorId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  service: { select: { name: true } },
  author: { select: { user: { select: { fullName: true } } } },
} satisfies Prisma.PlanTemplateSelect;

type RowRecord = Prisma.PlanTemplateGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(r: RowRecord, canEdit: (authorId: string) => boolean): PlanTemplateRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    totalSessions: r.totalSessions,
    frequency: r.frequency,
    exerciseCount: exerciseIdsOf(r.exerciseIds).length,
    discipline: r.discipline,
    serviceId: r.serviceId,
    serviceName: r.service?.name ?? null,
    durationMin: r.durationMin,
    schedule: scheduleOf(r.schedule),
    pricing: pricingOf(r),
    hasNotes: !!r.notes,
    authorId: r.authorId,
    authorName: r.author.user.fullName ?? null,
    canEdit: canEdit(r.authorId),
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function revalidateTemplates() {
  revalidatePath("/biblioteca");
  revalidatePath("/planes", "layout");
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

/**
 * Plantillas del consultorio. Sin `plantillas` → `[]` (P2-Z · B-L2). Las
 * archivadas solo con `includeArchived` (la pantalla de gestión); el modal
 * de aplicar y el editor no las ofrecen (el motor rechaza un `templateId`
 * archivado).
 */
export async function listPlanTemplates(
  opts: { discipline?: Discipline; includeArchived?: boolean } = {}
): Promise<PlanTemplateRow[]> {
  const actor = await getActor();
  // P2-Z · B-L2: lectura sin el módulo `plantillas` → vacío (convención de
  // VERTICALES: escrituras rechazan, lecturas devuelven []). Antes listaba las
  // plantillas de un consultorio que bajó de plan o es General, y la UI
  // ofrecía aplicarlas aunque el alta después lo rechace.
  if (!modulesFor(actor.entitlements).has("plantillas")) return [];
  const role = await getMembershipRole(actor);
  const manage = capabilitiesFor(role).has("plans.manage");
  const isAdmin = isTenantAdminRole(role);
  const rows = await runWithRls(actor.tenantId, (tx) => tx.planTemplate.findMany({
    where: {
      tenantId: actor.tenantId,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.discipline ? { discipline: opts.discipline } : {}),
    },
    orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
    select: ROW_SELECT,
  }));
  return rows.map((r) => toRow(r, (authorId) => manage && (isAdmin || authorId === actor.practitionerId)));
}

/**
 * Detalle para el drawer de edición: la fila, las notas y los ejercicios con
 * nombre. Un id de otro tenant → "no encontrada" (no oráculo).
 */
export async function getPlanTemplate(id: string): Promise<ActionResult<PlanTemplateDetail>> {
  const actor = await getActor();
  if (typeof id !== "string" || !id || id.length > 64) return fail(COPY.notFound);
  if (!modulesFor(actor.entitlements).has("plantillas")) return fail(COPY.upgrade);
  try {
    return await runWithRls(actor.tenantId, async (tx) => {
      const gate = await gatingForActor(tx);
      if (!gate.canBuildTemplates) throw new ForbiddenError(COPY.upgrade);
      const role = await roleInTx(tx, actor);
      const manage = capabilitiesFor(role).has("plans.manage");
      const isAdmin = isTenantAdminRole(role);
      const r = await tx.planTemplate.findFirst({ where: { id, tenantId: actor.tenantId }, select: ROW_SELECT });
      if (!r) return fail(COPY.notFound);
      const ids = exerciseIdsOf(r.exerciseIds);
      // Nombres con la visibilidad del catálogo (propios / + global): un id
      // de otro consultorio no se nombra. `assignable` = visible y no archivado.
      const [visible, assignable] = ids.length
        ? await Promise.all([
            tx.exercise.findMany({ where: { AND: [{ id: { in: ids } }, gate.visibility] }, select: { id: true, name: true } }),
            tx.exercise.findMany({ where: { AND: [{ id: { in: ids } }, assignableExerciseWhere(gate)] }, select: { id: true } }),
          ])
        : [[], []];
      const names = new Map(visible.map((e) => [e.id, e.name]));
      const ok = new Set(assignable.map((e) => e.id));
      const detail: PlanTemplateDetail = {
        ...toRow(r, (authorId) => manage && (isAdmin || authorId === actor.practitionerId)),
        notes: r.notes,
        exercises: ids.map((eid) => ({ id: eid, name: names.get(eid) ?? "Ejercicio no disponible", assignable: ok.has(eid) })),
      };
      return { ok: true as const, data: detail };
    });
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * "Aplicar plantilla" = prefill del editor (no crea el plan). Devuelve el
 * borrador C10 (`PlanEditorPrefill`, validado con su zod) más el título, las
 * notas y los ejercicios con dosis (`defaultSets/Reps ?? 3×12`).
 *
 * Lo que la plantilla tenga y hoy no sirva se descarta en vez de romper el
 * editor: ejercicios archivados o fuera del catálogo (`droppedExercises`),
 * un servicio borrado o de otra disciplina (`serviceDropped`), un horario
 * que ya no pasa C6. `prefill.templateId` (el vínculo
 * `TreatmentProgram.templateId`) va SIEMPRE: desde P3.Z el motor
 * (`validatePlanRefsInTx`) saltea los ejercicios de la plantilla que ya no son
 * asignables y solo rechaza los que manda el cliente. Antes se omitía si se
 * había descartado alguno (el motor rechazaba el alta entera) y el plan
 * perdía el vínculo con su plantilla.
 */
export async function getTemplatePrefill(templateId: string): Promise<ActionResult<PlanTemplatePrefill>> {
  const actor = await getActor();
  if (typeof templateId !== "string" || !templateId || templateId.length > 64) return fail(COPY.notFound);
  try {
    return await runWithRls(actor.tenantId, async (tx) => {
      const { gate } = await templateGateInTx(tx, actor);
      const t = await tx.planTemplate.findFirst({
        where: { id: templateId, tenantId: actor.tenantId },
        select: ROW_SELECT,
      });
      if (!t) return fail(COPY.notFound);
      if (t.archivedAt) return fail(COPY.archived);

      const ids = exerciseIdsOf(t.exerciseIds);
      const [rows, service] = await Promise.all([
        ids.length
          ? tx.exercise.findMany({
              where: { AND: [{ id: { in: ids } }, assignableExerciseWhere(gate)] },
              select: { id: true, name: true, defaultSets: true, defaultReps: true },
            })
          : Promise.resolve([]),
        t.serviceId
          ? tx.service.findFirst({ where: { id: t.serviceId, tenantId: actor.tenantId }, select: { id: true, discipline: true } })
          : Promise.resolve(null),
      ]);
      const byId = new Map(rows.map((e) => [e.id, e]));
      const exercises = ids
        .map((id) => byId.get(id))
        .filter((e): e is NonNullable<typeof e> => e !== undefined)
        .map((e) => ({ exerciseId: e.id, name: e.name, sets: e.defaultSets ?? DEFAULT_SETS, reps: e.defaultReps ?? DEFAULT_REPS }));
      const droppedExercises = ids.length - exercises.length;
      const serviceOk = !!service && (!t.discipline || !service.discipline || service.discipline === t.discipline);
      const schedule = scheduleOf(t.schedule);
      const pricing = pricingOf(t);

      const draft: PlanEditorPrefill = {
        ...(t.discipline ? { discipline: t.discipline } : {}),
        ...(serviceOk ? { serviceId: service!.id } : {}),
        ...(t.durationMin != null ? { durationMin: t.durationMin } : {}),
        totalSessions: Math.min(PLAN_MAX_SESSIONS, Math.max(1, t.totalSessions)),
        ...(schedule ? { schedule } : {}),
        // Sin modo guardado = el editor usa su default (no se fuerza "Sin precio").
        ...(pricing ? { pricing } : {}),
        templateId: t.id,
      };
      const parsed = PlanEditorPrefillSchema.safeParse(draft);
      if (!parsed.success) return fail(PLAN_ENGINE_COPY.template, "templateId");

      return {
        ok: true as const,
        data: {
          templateId: t.id,
          prefill: parsed.data,
          title: t.name,
          notes: t.notes,
          exercises,
          droppedExercises,
          serviceDropped: !!t.serviceId && !serviceOk,
        },
      };
    });
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

// ─── Escrituras ──────────────────────────────────────────────────────────────

export async function createPlanTemplate(raw: PlanTemplateCreateInput): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const parsed = PlanTemplateCreateSchema.safeParse(raw);
  if (!parsed.success) return zodFail(parsed.error);
  const input = parsed.data;
  try {
    const id = await runWithRls(actor.tenantId, async (tx) => {
      const { gate } = await templateGateInTx(tx, actor);
      const exerciseIds = input.exerciseIds ?? [];
      const discipline = await validateTemplateRefsInTx(
        tx,
        actor,
        gate,
        { discipline: input.discipline ?? null, serviceId: input.serviceId ?? null, durationMin: input.durationMin ?? null },
        exerciseIds,
        actor.practitionerId // el autor de una plantilla nueva es el actor
      );
      const schedule = input.schedule ?? null;
      const row = await tx.planTemplate.create({
        data: {
          tenantId: actor.tenantId,
          authorId: actor.practitionerId,
          name: input.name,
          description: input.description ?? null,
          totalSessions: input.totalSessions,
          frequency: schedule ? legacyFrequency(schedule) : (input.frequency ?? 2),
          exerciseIds,
          discipline,
          serviceId: input.serviceId ?? null,
          durationMin: input.durationMin ?? null,
          // Limpiar/omitir un Json? es `Prisma.DbNull` (SQL NULL): `JsonNull`
          // guarda el literal JSON `null` y viola `PlanTemplate_schedule_check`.
          schedule: schedule ?? Prisma.DbNull,
          ...pricingColumns(input.pricing ?? null),
          notes: input.notes ?? null,
        },
        select: { id: true },
      });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId ?? undefined,
        action: "planTemplate.create",
        entity: "PlanTemplate",
        entityId: row.id,
        payload: { discipline, serviceId: input.serviceId ?? null, exercises: exerciseIds.length },
      });
      return row.id;
    });
    revalidateTemplates();
    return { ok: true, data: { id } };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Edición parcial: campo ausente = se mantiene; `null` = se limpia (horario
 * con `Prisma.DbNull`, precio = las 3 columnas en null). Autor o admin. Con
 * `expectedUpdatedAt` es CAS: si la fila cambió → `stale` sin pisar. Servicio,
 * disciplina y duración se re-validan juntos (sobre el estado resultante) solo
 * si cambia alguno; los ejercicios, solo si vienen: renombrar una plantilla
 * no falla porque un ejercicio guardado se archivó después.
 */
export async function updatePlanTemplate(
  raw: PlanTemplateUpdateInput
): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const actor = await getActor();
  const parsed = PlanTemplateUpdateSchema.safeParse(raw);
  if (!parsed.success) return zodFail(parsed.error);
  const p = parsed.data;
  try {
    const out = await runWithRls(actor.tenantId, async (tx) => {
      const { gate, isAdmin } = await templateGateInTx(tx, actor);
      const cur = await tx.planTemplate.findFirst({
        where: { id: p.id, tenantId: actor.tenantId },
        select: { id: true, authorId: true, updatedAt: true, discipline: true, serviceId: true, durationMin: true },
      });
      if (!cur) return "not_found" as const;
      if (!isAdmin && cur.authorId !== actor.practitionerId) throw new ForbiddenError(COPY.notAuthor);
      if (p.expectedUpdatedAt && +new Date(p.expectedUpdatedAt) !== +cur.updatedAt) return "stale" as const;

      const refsTouched = p.discipline !== undefined || p.serviceId !== undefined || p.durationMin !== undefined;
      const merged = {
        discipline: p.discipline !== undefined ? p.discipline : cur.discipline,
        serviceId: p.serviceId !== undefined ? p.serviceId : cur.serviceId,
        durationMin: p.durationMin !== undefined ? p.durationMin : cur.durationMin,
      };
      let discipline = merged.discipline;
      if (refsTouched || p.exerciseIds !== undefined) {
        discipline = await validateTemplateRefsInTx(
          tx,
          actor,
          gate,
          refsTouched ? merged : { discipline: merged.discipline, serviceId: null, durationMin: null },
          p.exerciseIds,
          cur.authorId
        );
      }

      const data: Prisma.PlanTemplateUncheckedUpdateManyInput = {};
      if (p.name !== undefined) data.name = p.name;
      if (p.description !== undefined) data.description = p.description;
      if (refsTouched) {
        data.discipline = discipline;
        data.serviceId = merged.serviceId;
        data.durationMin = merged.durationMin;
      }
      if (p.totalSessions !== undefined) data.totalSessions = p.totalSessions;
      if (p.schedule !== undefined) {
        data.schedule = p.schedule ?? Prisma.DbNull;
        if (p.schedule) data.frequency = legacyFrequency(p.schedule);
      }
      if (p.frequency !== undefined && !p.schedule) data.frequency = p.frequency;
      if (p.pricing !== undefined) Object.assign(data, pricingColumns(p.pricing));
      if (p.notes !== undefined) data.notes = p.notes;
      if (p.exerciseIds !== undefined) data.exerciseIds = p.exerciseIds;

      // El `updatedAt` en el where cierra la carrera entre la lectura y la
      // escritura (dos admins guardando a la vez): count 0 = otro ganó.
      const upd = await tx.planTemplate.updateMany({
        where: { id: cur.id, tenantId: actor.tenantId, updatedAt: cur.updatedAt },
        data,
      });
      if (upd.count === 0) return "stale" as const;
      const after = await tx.planTemplate.findFirstOrThrow({
        where: { id: cur.id, tenantId: actor.tenantId },
        select: { updatedAt: true },
      });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId ?? undefined,
        action: "planTemplate.update",
        entity: "PlanTemplate",
        entityId: cur.id,
        payload: { fields: Object.keys(data), byAdmin: cur.authorId !== actor.practitionerId },
      });
      return { updatedAt: after.updatedAt.toISOString() };
    });
    if (out === "not_found") return fail(COPY.notFound);
    if (out === "stale") return fail(COPY.stale);
    revalidateTemplates();
    return { ok: true, data: { id: p.id, updatedAt: out.updatedAt } };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Archivar (`archived: true`) o restaurar. Archivada = no se lista por
 * defecto, no se prellena y el motor rechaza su `templateId`; los planes que
 * ya la usaron no cambian. Idempotente. Autor o admin.
 */
export async function setPlanTemplateArchived(id: string, archived: boolean): Promise<ActionResult> {
  const actor = await getActor();
  if (typeof id !== "string" || !id || id.length > 64 || typeof archived !== "boolean") return fail(COPY.notFound);
  try {
    const out = await runWithRls(actor.tenantId, async (tx) => {
      const { isAdmin } = await templateGateInTx(tx, actor);
      const cur = await tx.planTemplate.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, authorId: true, archivedAt: true },
      });
      if (!cur) return "not_found" as const;
      if (!isAdmin && cur.authorId !== actor.practitionerId) throw new ForbiddenError(COPY.notAuthor);
      if ((cur.archivedAt !== null) === archived) return "ok" as const;
      await tx.planTemplate.updateMany({
        where: { id, tenantId: actor.tenantId },
        data: { archivedAt: archived ? new Date() : null },
      });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId ?? undefined,
        action: archived ? "planTemplate.archive" : "planTemplate.restore",
        entity: "PlanTemplate",
        entityId: id,
        payload: { byAdmin: cur.authorId !== actor.practitionerId },
      });
      return "ok" as const;
    });
    if (out === "not_found") return fail(COPY.notFound);
    revalidateTemplates();
    return { ok: true, data: undefined };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * P0-S02t: solo el autor o un OWNER/ADMIN. Antes bastaba con ser miembro del
 * tenant, así que cualquier profesional (o la Secretaria) borraba por id las
 * plantillas de un colega. El chequeo y el borrado van en la misma tx y el
 * `deleteMany` repite el filtro (tenant + autor si no es admin): aunque la
 * fila cambiara entre la lectura y el delete, nunca borra una ajena. En prod
 * la conexión tiene BYPASSRLS, así que el `tenantId` a mano es la barrera.
 *
 * S17t: también exige el módulo `plantillas` (en la tx), como el resto de las
 * escrituras. Los planes que la usaron quedan con `templateId` NULL (FK SET
 * NULL de M1). Para sacarla de la vista sin perder el vínculo: archivar.
 */
export async function deletePlanTemplate(id: string): Promise<ActionResult> {
  const actor = await getActor();
  if (typeof id !== "string" || !id) return { ok: false, error: COPY.notFound };

  try {
    const result = await runWithRls(actor.tenantId, async (tx) => {
      const gate = await gatingForActor(tx);
      if (!gate.canBuildTemplates) throw new ForbiddenError(COPY.upgrade);
      const isAdmin = isTenantAdminRole(await roleInTx(tx, actor));
      const tpl = await tx.planTemplate.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, authorId: true },
      });
      if (!tpl) return "not_found" as const;
      if (!isAdmin && tpl.authorId !== actor.practitionerId) return "forbidden" as const;
      const del = await tx.planTemplate.deleteMany({
        where: {
          id,
          tenantId: actor.tenantId,
          ...(isAdmin ? {} : { authorId: actor.practitionerId }),
        },
      });
      if (del.count === 0) return "not_found" as const;
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId ?? undefined,
        action: "planTemplate.delete",
        entity: "PlanTemplate",
        entityId: id,
        payload: { authorId: tpl.authorId, byAdmin: tpl.authorId !== actor.practitionerId },
      });
      return "ok" as const;
    });

    if (result === "not_found") return { ok: false, error: COPY.notFound };
    if (result === "forbidden") return { ok: false, error: COPY.notAuthorDelete };
    revalidateTemplates();
    return { ok: true, data: undefined };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}
