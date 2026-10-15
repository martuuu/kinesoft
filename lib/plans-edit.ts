"use server";

/**
 * Planes · cantidad, precio y autorización de la OS (S16b, ES2b P2.2) —
 * server actions finas. La lógica y el orden de locks viven en
 * `lib/plans-edit-internal.ts` (server-only) y la plata en
 * `lib/plan-pricing-internal.ts`; acá solo el camino de AGENTS §4: `getActor()`
 * → zod (`lib/plans-edit-types.ts`) → `runWithRls` con el gate de
 * `plan-authz-internal` adentro (arranca con `assertModule('planes')`).
 *
 * Errores como resultado (`PlanWriteResult` / `PlanEngineWriteResult`), no
 * como throw: en prod Next oculta el mensaje de un throw y la UI no
 * distinguiría "sin permiso" de "el plan cambió". Lo inesperado (la base, una
 * violación de invariantes del verificador) sí se propaga.
 *
 * Escrituras: una `runWithRls(t, fn, {timeout:15000, maxWait:5000})` con un
 * reintento ante P2034/40P01 (`withTxConflictRetry`, C2). Post-commit, una vez
 * y fuera de la tx (enmienda Realtime): `afterBookingsCommitted` con los refs
 * de los turnos creados, cancelados o re-estampados, y el revalidate del
 * perfil del paciente.
 *
 * Exporta SOLO funciones async.
 */
import { withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { PLAN_LIFECYCLE_COPY } from "@/lib/plans-lifecycle-state";
import { PlanRejected, StalePlanPreview } from "@/lib/plans-engine-internal";
import { PlanPricingConflict } from "@/lib/plan-pricing-internal";
import { ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import {
  addSessionsInTx,
  archiveSessionsInTx,
  PlanEditNeedsConfirmation,
  PlanEditStale,
  previewAddSessionsInTx,
  previewRepriceInTx,
  renewAuthorizationInTx,
  repricePlanInTx,
  restoreSessionInTx,
  roleAndCapsInTx,
} from "@/lib/plans-edit-internal";
import {
  AddPlanSessionsCommitSchema,
  AddPlanSessionsPreviewSchema,
  ArchivePlanSessionsSchema,
  RenewAuthorizationSchema,
  RepricePlanSchema,
  RestorePlanSessionSchema,
  type AddPlanSessionsInput,
  type AddPlanSessionsPreviewInput,
  type AddPlanSessionsResult,
  type ArchivePlanSessionsInput,
  type ArchivePlanSessionsResult,
  type PlanFail,
  type PlanPreviewResult,
  type RenewAuthorizationInput,
  type RenewAuthorizationResult,
  type RepricePlanInput,
  type RepricePlanPreviewResult,
  type RepricePlanResult,
  type RestorePlanSessionInput,
  type RestorePlanSessionResult,
} from "@/lib/plans-edit-types";

const COMMIT_TX = { timeout: 15_000, maxWait: 5_000 };

/**
 * Copy del verificador (P2-Z · B-M2). Mismo texto que `plans-lifecycle-internal`
 * y `plans-adopt-internal`: el verificador ya reportó a Sentry y la tx hizo
 * rollback; sin este mapeo el throw llegaba al cliente como un 500 genérico.
 */
const INCONSISTENT = "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.";

function invalidInput(err: z.ZodError): PlanFail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Rechazos esperables → resultado; lo demás (null) se propaga. */
function rejection(
  e: unknown
): PlanFail | { ok: false; kind: "stale"; error: string } | { ok: false; kind: "needs-confirmation"; error: string } | null {
  if (e instanceof PlanRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  if (e instanceof PlanEditStale || e instanceof PlanPricingConflict) {
    return { ok: false, kind: "stale", error: PLAN_LIFECYCLE_COPY.stale };
  }
  // P2002 que se coló pese al lock del paciente (p. ej. el único parcial de la
  // autorización vigente o el de `index` vivo): el plan cambió → stale.
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return { ok: false, kind: "stale", error: PLAN_LIFECYCLE_COPY.stale };
  }
  if (e instanceof PlanEditNeedsConfirmation) return { ok: false, kind: "needs-confirmation", error: e.message };
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: INCONSISTENT };
  return null;
}

/** Una escritura: tx con reintento, rechazos → resultado, post-commit una vez. */
async function write<T extends { refs?: BookingChangeRef[]; patientId: string }>(
  actor: Actor,
  run: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<{ ok: true; out: T } | NonNullable<ReturnType<typeof rejection>>> {
  let out: T;
  try {
    out = await withTxConflictRetry(() => runWithRls(actor.tenantId, run, COMMIT_TX));
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
  if (out.refs?.length) await afterBookingsCommitted(actor.tenantId, out.refs);
  revalidatePath(`/pacientes/${out.patientId}`);
  return { ok: true, out };
}

// ─── Agregar sesiones ────────────────────────────────────────────────────────

/** Preview de "agregar sesiones" (`append` N al final o una "a medida"). Gate `plans.manage`. */
export async function previewAddPlanSessions(raw: AddPlanSessionsPreviewInput): Promise<PlanPreviewResult> {
  const actor = await getActor();
  const parsed = AddPlanSessionsPreviewSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const preview = await runWithRls(actor.tenantId, async (tx) => {
      const { caps } = await roleAndCapsInTx(tx, actor);
      return previewAddSessionsInTx(tx, actor, caps, parsed.data, new Date());
    });
    return { ok: true, preview };
  } catch (e) {
    const r = rejection(e);
    if (r) return { ok: false, error: r.error, ...("fieldErrors" in r && r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}) };
    throw e;
  }
}

/**
 * Commit de "agregar sesiones" por el motor (`mode:'add'`). Reabre un
 * COMPLETED solo con `confirmReopen`. PACKAGE exige `packagePricing`. Si la
 * agenda o el plan cambiaron: `{kind:'stale-preview', preview}`.
 */
// BO3-F: el cuerpo va en `addPlanSessionsImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function addPlanSessions(...args: Parameters<typeof addPlanSessionsImpl>): Promise<AddPlanSessionsResult> {
  return withReadOnlyResult(() => addPlanSessionsImpl(...args));
}

async function addPlanSessionsImpl(raw: AddPlanSessionsInput): Promise<AddPlanSessionsResult> {
  const actor = await getActor();
  const parsed = AddPlanSessionsCommitSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const now = new Date();
  try {
    const r = await write(actor, async (tx) => {
      const { caps } = await roleAndCapsInTx(tx, actor);
      return addSessionsInTx(tx, actor, caps, input, now);
    });
    if (!r.ok) return r;
    const { sessionIds, createdBookings, totalSessions, reopened } = r.out;
    return { ok: true, data: { sessionIds, createdBookings, totalSessions, reopened } };
  } catch (e) {
    if (!(e instanceof StalePlanPreview)) throw e;
    if (e.preview) return { ok: false, kind: "stale-preview", preview: e.preview };
    // Conflicto visto recién al escribir: preview fresco en una tx nueva.
    const fresh = await previewAddPlanSessions({ ...raw, rows: raw.rows, stateToken: undefined });
    return fresh.ok ? { ok: false, kind: "stale-preview", preview: fresh.preview } : fresh;
  }
}

// ─── Archivar / restaurar sesiones ───────────────────────────────────────────

/** Archivar sesiones o reducir la cantidad (CAS `expectedUpdatedAt`). Gate `plans.manage`. */
// BO3-F: el cuerpo va en `archivePlanSessionsImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function archivePlanSessions(...args: Parameters<typeof archivePlanSessionsImpl>): Promise<ArchivePlanSessionsResult> {
  return withReadOnlyResult(() => archivePlanSessionsImpl(...args));
}

async function archivePlanSessionsImpl(raw: ArchivePlanSessionsInput): Promise<ArchivePlanSessionsResult> {
  const actor = await getActor();
  const parsed = ArchivePlanSessionsSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  const r = await write(actor, async (tx) => {
    const { caps } = await roleAndCapsInTx(tx, actor);
    return archiveSessionsInTx(tx, actor, caps, parsed.data, now);
  });
  if (!r.ok) return r;
  const { updatedAt, archivedSessionIds, cancelledBookings, totalSessions } = r.out;
  return { ok: true, data: { updatedAt, archivedSessionIds, cancelledBookings, totalSessions } };
}

/** Restaurar una sesión archivada (OWNER/ADMIN). "Ya hay una sesión N viva" si otra tomó su index. */
// BO3-F: el cuerpo va en `restoreSessionImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function restoreSession(...args: Parameters<typeof restoreSessionImpl>): Promise<RestorePlanSessionResult> {
  return withReadOnlyResult(() => restoreSessionImpl(...args));
}

async function restoreSessionImpl(raw: RestorePlanSessionInput): Promise<RestorePlanSessionResult> {
  const actor = await getActor();
  const parsed = RestorePlanSessionSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const r = await write(actor, async (tx) => {
    const { caps, role } = await roleAndCapsInTx(tx, actor);
    return restoreSessionInTx(tx, actor, caps, role, parsed.data);
  });
  if (!r.ok) return r;
  return { ok: true, data: { updatedAt: r.out.updatedAt, totalSessions: r.out.totalSessions } };
}

// ─── Precio ──────────────────────────────────────────────────────────────────

/** C13: "Cambiar precio: de $X a $Y en N turnos · M quedan como están". Solo lectura. */
export async function previewRepricePlan(raw: RepricePlanInput): Promise<RepricePlanPreviewResult> {
  const actor = await getActor();
  const parsed = RepricePlanSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const preview = await runWithRls(actor.tenantId, async (tx) => {
      const { caps } = await roleAndCapsInTx(tx, actor);
      return previewRepriceInTx(tx, actor, caps, parsed.data, new Date());
    });
    return { ok: true, preview };
  } catch (e) {
    const r = rejection(e);
    if (r) return { ok: false, error: r.error };
    throw e;
  }
}

/** Reprecio C5 (solo futuros impagos; CAS por fila; rollback total). Gate `plans.manage`. */
// BO3-F: el cuerpo va en `repricePlanImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function repricePlan(...args: Parameters<typeof repricePlanImpl>): Promise<RepricePlanResult> {
  return withReadOnlyResult(() => repricePlanImpl(...args));
}

async function repricePlanImpl(raw: RepricePlanInput): Promise<RepricePlanResult> {
  const actor = await getActor();
  const parsed = RepricePlanSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  const r = await write(actor, async (tx) => {
    const { caps } = await roleAndCapsInTx(tx, actor);
    return repricePlanInTx(tx, actor, caps, parsed.data, now);
  });
  if (!r.ok) return r;
  const { updatedAt, stampedBookings, sessionsChanged } = r.out;
  return { ok: true, data: { updatedAt, stampedBookings, sessionsChanged } };
}

// ─── Autorización de la OS ───────────────────────────────────────────────────

/** E2: renovar (o cargar la primera) autorización de la OS. Gate `plans.authorize`. */
// BO3-F: el cuerpo va en `renewPlanAuthorizationImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function renewPlanAuthorization(...args: Parameters<typeof renewPlanAuthorizationImpl>): Promise<RenewAuthorizationResult> {
  return withReadOnlyResult(() => renewPlanAuthorizationImpl(...args));
}

async function renewPlanAuthorizationImpl(raw: RenewAuthorizationInput): Promise<RenewAuthorizationResult> {
  const actor = await getActor();
  const parsed = RenewAuthorizationSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  const r = await write(actor, async (tx) => {
    const { caps } = await roleAndCapsInTx(tx, actor);
    return renewAuthorizationInTx(tx, actor, caps, parsed.data, now);
  });
  if (!r.ok) return r;
  return { ok: true, data: { authorizationId: r.out.authorizationId, supersededId: r.out.supersededId } };
}
