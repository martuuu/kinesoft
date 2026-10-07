"use server";

/**
 * Planes · ciclo de vida (S15, ES2b · P2.2) — server actions finas. Contratos
 * de P2-C2: zod y resultados en `lib/plans-edit-types.ts`, tabla pura de
 * transiciones en `lib/plans-lifecycle-state.ts`; las tx en
 * `lib/plans-lifecycle-internal.ts` (server-only), que comparten estas actions
 * y los exports legacy de `lib/programs.ts` (delegan hasta que ES3/S27a los
 * retire).
 *
 * Camino de AGENTS §4: `getActor()` → zod → `runWithRls` (con un reintento
 * ante P2034/40P01, C2) → `lockPlanPatient` primero en lo estructural → gate
 * `assertPlanManageInTx` (arranca con `assertModule('planes')`: un consultorio
 * General no llega a la base) → `where {tenantId}` a mano → CAS de
 * `TreatmentProgram.updatedAt` al final → verificador → audit en la tx.
 *
 * Post-commit, UNA vez y fuera de la tx (enmienda Realtime):
 * `afterBookingsCommitted` con los turnos cancelados + revalidate del perfil.
 *
 * Errores como resultado (`{ ok:false, … }`), no como throw: en prod Next
 * oculta el mensaje de un throw. Este archivo exporta SOLO funciones async.
 */
import type { z } from "zod";
import { getActor } from "@/lib/session";
import {
  afterLifecycleCommit,
  archiveProgramFlow,
  changeProgramStatusFlow,
  previewProgramStatusChangeFlow,
  restoreProgramFlow,
  updateProgramDetailsFlow,
  type LifecycleFlow,
} from "@/lib/plans-lifecycle-internal";
import {
  ArchivePlanSchema,
  ChangePlanStatusSchema,
  PlanStatusChangePreviewSchema,
  RestorePlanSchema,
  UpdatePlanDetailsSchema,
  type ArchivePlanInput,
  type ArchivePlanResult,
  type ChangePlanStatusInput,
  type ChangePlanStatusResult,
  type PlanFail,
  type PlanStatusChangePreview,
  type PlanStatusChangePreviewInput,
  type RestorePlanInput,
  type RestorePlanResult,
  type UpdatePlanDetailsInput,
  type UpdatePlanDetailsResult,
} from "@/lib/plans-edit-types";

function invalidInput(err: z.ZodError): PlanFail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

async function finish<R>(tenantId: string, flow: LifecycleFlow<R>): Promise<R> {
  if (flow.commit) await afterLifecycleCommit(tenantId, flow.commit);
  return flow.result;
}

/**
 * Preview del diálogo D7: transición permitida, si pregunta por los turnos,
 * cuántos futuros impagos hay y cuántos tienen cobro ("2 tienen un cobro
 * registrado y no se tocan"), y el `expectedUpdatedAt` para el commit.
 */
export async function previewPlanStatusChange(
  raw: PlanStatusChangePreviewInput
): Promise<{ ok: true; preview: PlanStatusChangePreview } | PlanFail> {
  const actor = await getActor();
  const parsed = PlanStatusChangePreviewSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  return previewProgramStatusChangeFlow(actor, parsed.data, new Date());
}

/**
 * Cambio de estado (D7 + PD-10). ACTIVE → PAUSED/CANCELLED/COMPLETED cancela
 * los futuros impagos salvo `futureBookings: 'keep'`; PAUSED/COMPLETED →
 * ACTIVE re-valida sede y responsable (S13g); COMPLETED → ACTIVE pide
 * `confirm`; CANCELLED es terminal.
 */
export async function changePlanStatus(raw: ChangePlanStatusInput): Promise<ChangePlanStatusResult> {
  const actor = await getActor();
  const parsed = ChangePlanStatusSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const flow = await changeProgramStatusFlow(actor, parsed.data, new Date());
  return finish(actor.tenantId, flow);
}

/** Título y notas, con CAS (lo único que edita `updateProgram`, PD-10). */
export async function updatePlanDetails(raw: UpdatePlanDetailsInput): Promise<UpdatePlanDetailsResult> {
  const actor = await getActor();
  const parsed = UpdatePlanDetailsSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const flow = await updateProgramDetailsFlow(actor, parsed.data);
  return finish(actor.tenantId, flow);
}

/** Archivar (§2.4). Un plan abierto exige `cancelOpen` (D7 a CANCELLED en la misma tx). */
export async function archivePlan(raw: ArchivePlanInput): Promise<ArchivePlanResult> {
  const actor = await getActor();
  const parsed = ArchivePlanSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const flow = await archiveProgramFlow(actor, parsed.data, new Date());
  return finish(actor.tenantId, flow);
}

/** `restoreProgram` de §2.4 (OWNER/ADMIN): vuelve al estado que tenía. */
export async function restoreProgram(raw: RestorePlanInput): Promise<RestorePlanResult> {
  const actor = await getActor();
  const parsed = RestorePlanSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const flow = await restoreProgramFlow(actor, parsed.data);
  return finish(actor.tenantId, flow);
}
