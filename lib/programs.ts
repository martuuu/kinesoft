"use server";

/**
 * Planes de tratamiento (TreatmentProgram / Session) — Server Actions y
 * loaders del Tab Plan del paciente.
 *
 * P0-Cs (Planes, ola P0.0): movidos verbatim desde `lib/patients.ts`, que ya
 * pasaba las 2000 líneas, para que las sesiones de Planes tengan un dueño de
 * archivo propio. El único cambio de firma fue
 * `createProgram({ startDate: 'YYYY-MM-DD' })`.
 *
 * P0-S02a (P0.1): `createProgram`, `updateProgram` y `setProgramStatus`
 * validan con zod (`lib/validation.ts`), escriben en día AR y auditan en la
 * misma tx que el write (`auditInTx`).
 *
 * EV0 V.Z (N1, contrato C-EV4): todo esto es del módulo `planes`, que un
 * consultorio General no tiene. Antes de V.Z ninguna action de este archivo
 * lo chequeaba: la UI escondía la pestaña, pero `createProgram` & co. se
 * podían invocar por RPC y escribían igual. Escrituras → `requireModule`
 * (tira `ForbiddenError`); lecturas del perfil del paciente → `[]` (las usa la
 * ficha, que es común a las dos verticales y no tiene que romperse).
 *
 * P2-S15 (ES2b): `updateProgram`, `setProgramStatus` y `deleteProgram`
 * DELEGAN en los flujos de `lib/plans-lifecycle-internal.ts` (los mismos de
 * las actions nuevas de `lib/plans-lifecycle.ts`) para no romper a
 * `plan-view.tsx` hasta ES3; `deleteSession` rechaza ("archivala"). Mantienen
 * `requireModule('planes')` (enmienda EV0: mover código no se lleva el gate).
 * S27a los retira.
 */
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { getMembershipRole, requireModule } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { isTenantAdminRole } from "@/lib/capabilities";
import { auditInTx } from "@/lib/audit";
import { addDays, dayWindow } from "@/lib/availability/day";
import { patientAccessFor } from "@/lib/visibility";
import { hcAccessError } from "@/lib/patient-access-internal";
import { toARDateKey } from "@/lib/datetime-ar";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import {
  afterLifecycleCommit,
  archiveProgramFlow,
  changeProgramStatusFlow,
  updateProgramDetailsFlow,
} from "@/lib/plans-lifecycle-internal";
import {
  ProgramCreate,
  ProgramStatusSet,
  ProgramUpdate,
  type ActionResult,
  type ProgramCreateInput,
  type ProgramStatusSetInput,
  type ProgramUpdateInput,
} from "@/lib/validation";

/**
 * Error de zod → `ActionResult`. El `error` es el mensaje de la primera regla
 * que falló (es lo que muestra el Drawer del plan, que no lee `fieldErrors`).
 * No exportada: un archivo "use server" solo exporta actions async.
 */
function invalidInput(err: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Copy de los rechazos legacy (no exportado: "use server" solo exporta async). */
const LEGACY_EDIT_COPY = {
  count: "La cantidad de sesiones se cambia agregando o archivando sesiones del plan.",
  schedule: "El horario del plan se cambia re-planificando desde una sesión.",
  deleteSession: "Las sesiones no se borran: archivala desde el plan.",
} as const;

/** Resultado del flujo nuevo → `ActionResult` legacy (el Tab Plan solo lee `ok`/`error`). */
function legacyResult(r: { ok: true } | { ok: false; error: string }): ActionResult {
  return r.ok ? { ok: true, data: undefined } : { ok: false, error: r.error };
}

/**
 * Lite list of patient's programs — programs + minimal session metadata
 * (id, index, completedAt, scheduledFor, notes, exercise count) but
 * **no** SessionExercise rows / Exercise joins. Enough for:
 *
 *   - Resumen tab (active program detection + done count)
 *   - SesionesView (list rows with status + exercise count)
 *   - Tab badges (programs.length, allSessionsCount)
 *
 * The heavy join (SessionExercise + Exercise) is only fetched by
 * `getPatientProgramsFull` when the Plan tab opens.
 */
export async function getPatientProgramsLite(patientId: string) {
  const actor = await getActor();
  if (!modulesFor(actor.entitlements).has("planes")) return [];
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  // P2-S15: sin archivados (planes ni sesiones): "Eliminar" ahora archiva,
  // y un plan archivado seguía en la ficha como si el click no hubiera hecho
  // nada. Restaurarlos es de OWNER/ADMIN (`restoreProgram`), con UI en ES3.
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId, tenantId: actor.tenantId, ...liveProgramWhere },
    select: {
      id: true,
      title: true,
      status: true,
      totalSessions: true,
      frequency: true,
      startDate: true,
      createdAt: true,
      sessions: {
        where: liveSessionWhere,
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          scheduledFor: true,
          completedAt: true,
          notes: true,
          _count: { select: { exercises: true } },
        },
      },
      case: {
        select: {
          diagnoses: {
            take: 1,
            orderBy: { rank: "asc" },
            select: { condition: { select: { id: true, name: true, cie10: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  }));
}

/**
 * Full patient programs — all sessions + ordered exercises, with the
 * clinical case + diagnoses. Heavy. Only fetch when the user opens
 * the Sesiones or Plan tab.
 */
export async function getPatientProgramsFull(patientId: string) {
  const actor = await getActor();
  if (!modulesFor(actor.entitlements).has("planes")) return [];
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId, tenantId: actor.tenantId, ...liveProgramWhere },
    include: {
      sessions: {
        where: liveSessionWhere,
        orderBy: { index: "asc" },
        include: {
          exercises: { include: { exercise: true }, orderBy: { order: "asc" } },
        },
      },
      case: { include: { diagnoses: { include: { condition: true } } } },
    },
    orderBy: { createdAt: "desc" },
  }));
}

/**
 * Gate a hard-delete of a plan/session (or other admin-only mutation) to OWNER/ADMIN.
 * Returns an `ActionResult` error when the actor's membership role is
 * anything else, or `null` when the actor may proceed. Mirrors the inline
 * role check in `assignPatientToPractitioner`.
 */
async function requireAdminRole(
  actor: Actor
): Promise<{ ok: false; error: string } | null> {
  // B1.7: el rol sale de `lib/authz` (una query por request, cacheada) y el
  // criterio OWNER/ADMIN de `lib/capabilities` (un solo lugar para C0).
  if (!isTenantAdminRole(await getMembershipRole(actor))) {
    return {
      ok: false,
      error: "Solo el dueño o un administrador puede eliminar definitivamente.",
    };
  }
  return null;
}

/**
 * Alta legacy de un plan (Tab Planes del paciente) con N sesiones sin turno.
 *
 * P0-S02a:
 *   - zod antes de tocar la base (`ProgramCreate`): `frequency` 0 daba
 *     `7 / 0 = Infinity` → `Invalid Date` → 500; `totalSessions` llegaba a 64.
 *   - Día AR: `startDate` y cada `scheduledFor` son la medianoche AR del día
 *     (`dayWindow(dayKey).start`, 03:00Z), la misma convención que ya usaba
 *     `updateProgram`. Antes `new Date('2026-10-06')` = 00:00Z = 21:00 del 05/10
 *     en AR: en Vercel (UTC) la sesión 1 quedaba el día anterior. El slice UTC
 *     de `plan-view.tsx:346` da el día correcto con las dos convenciones (C11).
 *   - Los días se suman sobre el DayKey (`addDays`, aritmética de calendario),
 *     no sumando 86.400.000 ms a un instante. Sin DST en AR da lo mismo, pero
 *     así no depende de eso. La fórmula es la de siempre, `floor(i · 7/f)`
 *     días; se escribe `floor(i·7 / f)` para que un múltiplo exacto no caiga un
 *     día antes por redondeo de punto flotante.
 *   - El audit va en la misma tx (`auditInTx`): existe si y solo si el plan.
 */
export async function createProgram(raw: ProgramCreateInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireModule("planes");
  const parsed = ProgramCreate.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const startDayKey = input.startDate;
  const result = await runWithRls(actor.tenantId, async (tx) => {
    // `hcAccessError` también valida que el paciente sea de este tenant
    // ("none" → no encontrado): la FK de Patient saltea RLS.
    const denied = await hcAccessError(actor, input.patientId, tx);
    if (denied) return { error: denied };
    const program = await tx.treatmentProgram.create({
      data: {
        tenantId: actor.tenantId,
        patientId: input.patientId,
        title: input.title,
        totalSessions: input.totalSessions,
        frequency: input.frequency,
        startDate: dayWindow(startDayKey).start,
        sessions: {
          create: Array.from({ length: input.totalSessions }).map((_, i) => ({
            practitionerId: actor.practitionerId,
            index: i + 1,
            scheduledFor: dayWindow(addDays(startDayKey, Math.floor((i * 7) / input.frequency))).start,
          })),
        },
      },
      select: { id: true },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.create",
      entity: "TreatmentProgram",
      entityId: program.id,
    });
    return program;
  });
  if ("error" in result) return { ok: false, error: result.error };
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: { id: result.id } };
}

// ──────────────────────────────────────────────────────────────────────
// Program / Session CRUD
// ──────────────────────────────────────────────────────────────────────

/**
 * Edición legacy del Tab Plan (`plan-view.tsx` manda SIEMPRE título, total,
 * frecuencia e inicio). P2-S15: delega en `updateProgramDetailsFlow`
 * (`lib/plans-lifecycle-internal.ts`) y edita SOLO el título (PD-10).
 *
 * Antes un total nuevo se escribía en `totalSessions` sin crear ni archivar
 * sesiones (slug `updateProgram-desincroniza-total`: "10 sesiones" con 4
 * filas, I5 roto) y frecuencia/inicio movían el plan sin mover sesiones ni
 * turnos. Ahora: los campos estructurales iguales a los actuales se ignoran
 * (el Drawer los reenvía), y uno DISTINTO se rechaza con a dónde ir —
 * cantidad → agregar/archivar sesiones (S16b), horario → re-planificar (L7).
 *
 * Sin CAS: este caller no conoce el `updatedAt` (la action nueva
 * `updatePlanDetails` sí lo exige). ES3/S27a retira este export.
 */
export async function updateProgram(raw: ProgramUpdateInput): Promise<ActionResult> {
  const actor = await requireModule("planes");
  const parsed = ProgramUpdate.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const row = await runWithRls(actor.tenantId, (tx) =>
    tx.treatmentProgram.findFirst({
      where: { id: input.id, tenantId: actor.tenantId },
      select: { totalSessions: true, frequency: true, startDate: true },
    })
  );
  if (!row) return { ok: false, error: "Plan no encontrado." };
  if (input.totalSessions !== undefined && input.totalSessions !== row.totalSessions) {
    return { ok: false, error: LEGACY_EDIT_COPY.count, fieldErrors: { totalSessions: [LEGACY_EDIT_COPY.count] } };
  }
  // El Drawer arma el inicio con `startDate.toISOString().slice(0,10)`: en un
  // plan nuevo (03:00Z) es el día AR; en un legacy (00:00Z) es el día UTC. Las
  // dos lecturas cuentan como "sin cambio".
  const sameStart =
    input.startDate === undefined ||
    input.startDate === toARDateKey(row.startDate) ||
    input.startDate === row.startDate.toISOString().slice(0, 10);
  if ((input.frequency !== undefined && input.frequency !== row.frequency) || !sameStart) {
    return { ok: false, error: LEGACY_EDIT_COPY.schedule };
  }
  if (input.title === undefined) return { ok: true, data: undefined };
  const flow = await updateProgramDetailsFlow(actor, { programId: input.id, expectedUpdatedAt: null, title: input.title });
  if (flow.commit) await afterLifecycleCommit(actor.tenantId, flow.commit);
  return legacyResult(flow.result);
}

/**
 * Cambio de estado legacy. P2-S15: delega en `changeProgramStatusFlow` (tabla
 * de transiciones + lock del paciente + CAS + verificador + audit). Antes
 * aceptaba cualquier estado → cualquier estado (un CANCELLED volvía a ACTIVE).
 *
 * D7 = `keep` a propósito: el `useConfirm` del Tab Plan de hoy le dice al
 * usuario "Los turnos de la agenda no se tocan" (`programStatusConfirm`). El
 * default `cancel` de PD-10 es el de la UI nueva (S22a), que pregunta.
 * `confirm: true` porque ese mismo diálogo ya confirmó la reapertura.
 */
export async function setProgramStatus(raw: ProgramStatusSetInput): Promise<ActionResult> {
  const actor = await requireModule("planes");
  const parsed = ProgramStatusSet.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const flow = await changeProgramStatusFlow(
    actor,
    { programId: parsed.data.id, expectedUpdatedAt: null, to: parsed.data.status, futureBookings: "keep", confirm: true },
    new Date()
  );
  if (flow.commit) await afterLifecycleCommit(actor.tenantId, flow.commit);
  return legacyResult(flow.result);
}

/**
 * "Eliminar plan" legacy (OWNER/ADMIN). P2-S15: ya NO borra en duro, archiva
 * (`archiveProgramFlow`). El DELETE daba P2003 (500) con turnos vinculados o
 * una `ProgramAuthorization` (RESTRICT de M1) y, sin ellos, perdía la
 * historia (I7: nada vinculado se borra). Un plan abierto se rechaza con
 * "primero hay que cancelarlo": este botón nunca cancela turnos de rebote.
 * Restaurar: `restoreProgram` (`lib/plans-lifecycle.ts`).
 */
export async function deleteProgram(id: string): Promise<ActionResult> {
  const actor = await requireModule("planes");
  const denied = await requireAdminRole(actor);
  if (denied) return denied;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return { ok: false, error: "Plan no encontrado." };
  const flow = await archiveProgramFlow(actor, { programId: id, expectedUpdatedAt: null }, new Date());
  if (flow.commit) await afterLifecycleCommit(actor.tenantId, flow.commit);
  return legacyResult(flow.result);
}

/**
 * P2-S15: las sesiones no se borran en duro (I7). El DELETE + decremento de
 * `totalSessions` daba P2003 con un turno vinculado y, sin él, rompía la
 * numeración estable (`index` fijo) y el saldo del plan. Archivar una sesión
 * es `archivePlanSessions` (S16b, `plans.manage`); la UI llega en ES3.
 */
export async function deleteSession(_id: string): Promise<ActionResult> {
  await requireModule("planes");
  return { ok: false, error: LEGACY_EDIT_COPY.deleteSession };
}
