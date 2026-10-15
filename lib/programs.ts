"use server";

/**
 * Planes de tratamiento — exports legacy que quedan del Tab Plan viejo.
 *
 * Historia:
 *   - P0-Cs (P0.0): movidos verbatim desde `lib/patients.ts`.
 *   - P0-S02a (P0.1): zod, día AR y audit en la misma tx.
 *   - EV0 V.Z (N1, C-EV4): escrituras con `requireModule('planes')` (un
 *     consultorio General las invocaba por RPC aunque la UI no las mostrara).
 *   - P2-S15 (ES2b): delegan en los flujos de `lib/plans-lifecycle-internal.ts`.
 *   - P3-S27a (ES3): RETIRADOS el alta legacy (sesiones sin turno, sin lock
 *     del paciente ni verificador → `createPlan`, `lib/plans.ts`; el nombre
 *     viejo no se escribe: el gate de P3.Z.0 lo greppea en todo el repo),
 *     `updateProgram` (su única rama viva era el título → `updatePlanDetails`,
 *     `lib/plans-lifecycle.ts`, con CAS) y `getPatientProgramsLite/Full` (la
 *     ficha lee `getPatientPlans` / `getPatientPlanBalances`, S22b). Sus tests
 *     de ES1/EV0 se re-afirmaron sobre esas puertas antes de borrarlos
 *     (`programs.test.ts`, `authz-matrix.test.ts`, `ev0-review-fixes.test.ts`,
 *     `patients-rpc-surface.test.ts`). Los gates reimplementados a mano
 *     (`hcAccessError`) se fueron con ellos: la puerta nueva usa
 *     `assertPlanManageInTx`.
 *
 * Quedan `setProgramStatus`, `deleteProgram` y `deleteSession`, sin callers de
 * la app (la UI de ES3 usa `changePlanStatus` / `archivePlan` /
 * `archivePlanSessions`) pero con tests ajenos (`plans-lifecycle.test.ts`).
 * Mientras existan, mantienen `requireModule('planes')` (enmienda EV0: mover
 * o retirar código no se lleva el gate). Retirarlos es de EV1 / C.
 */
import type { z } from "zod";
import { withReadOnlyResult } from "@/lib/read-only-result";
import type { Actor } from "@/lib/session";
import { getMembershipRole, requireModule } from "@/lib/authz";
import { isTenantAdminRole } from "@/lib/capabilities";
import { afterLifecycleCommit, archiveProgramFlow, changeProgramStatusFlow } from "@/lib/plans-lifecycle-internal";
import { ProgramStatusSet, type ActionResult, type ProgramStatusSetInput } from "@/lib/validation";

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
  deleteSession: "Las sesiones no se borran: archivala desde el plan.",
} as const;

/** Resultado del flujo nuevo → `ActionResult` legacy (el Tab Plan solo lee `ok`/`error`). */
function legacyResult(r: { ok: true } | { ok: false; error: string }): ActionResult {
  return r.ok ? { ok: true, data: undefined } : { ok: false, error: r.error };
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
 * Cambio de estado legacy. P2-S15: delega en `changeProgramStatusFlow` (tabla
 * de transiciones + lock del paciente + CAS + verificador + audit). Antes
 * aceptaba cualquier estado → cualquier estado (un CANCELLED volvía a ACTIVE).
 *
 * D7 = `keep` a propósito: el `useConfirm` del Tab Plan viejo le decía al
 * usuario "Los turnos de la agenda no se tocan" (`programStatusConfirm`, de
 * `lib/plan-form-defaults.ts`, borrado en S27a junto con esa UI). El default
 * `cancel` de PD-10 es el de la UI nueva (S22a), que pregunta.
 * `confirm: true` porque ese mismo diálogo ya confirmó la reapertura.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `setProgramStatusImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function setProgramStatus(...args: Parameters<typeof setProgramStatusImpl>): ReturnType<typeof setProgramStatusImpl> {
  return withReadOnlyResult(() => setProgramStatusImpl(...args));
}

async function setProgramStatusImpl(raw: ProgramStatusSetInput): Promise<ActionResult> {
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
// EV1-E1 (readonly-residual-actions): el cuerpo va en `deleteProgramImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function deleteProgram(...args: Parameters<typeof deleteProgramImpl>): ReturnType<typeof deleteProgramImpl> {
  return withReadOnlyResult(() => deleteProgramImpl(...args));
}

async function deleteProgramImpl(id: string): Promise<ActionResult> {
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
