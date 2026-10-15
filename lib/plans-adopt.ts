"use server";

/**
 * Planes · adopción y generar turnos (S25a, ES2b P2.2) — server actions finas.
 * Contratos de P2-C2 (zod y resultados) en `lib/plans-edit-types.ts`; las tx
 * en `lib/plans-adopt-internal.ts` (server-only).
 *
 * Camino de AGENTS §4: `getActor()` → zod → `runWithRls` (con un reintento
 * ante P2034/40P01, C2) → `assertModule('planes')` → `lockPlanPatient` primero
 * en los commits → gate de `plan-authz-internal` (vincular, adoptar y sacar =
 * `plans.manage`; generar = `plans.schedule`) → `where {tenantId}` a mano en
 * cada query → CAS del plan al final → verificador → audit en la tx.
 *
 * Errores como resultado (`{ ok:false, … }`), no como throw: en prod Next
 * oculta el mensaje de un throw. Un error inesperado (la base) se propaga.
 *   - generar: `StalePlanPreview` / P2002 / CAS final perdido →
 *     `{kind:'stale-preview', preview}` con un preview fresco;
 *   - vincular / adoptar / sacar: turno o plan que cambió → `{kind:'stale'}`.
 *
 * Post-commit, UNA vez y fuera de la tx (enmienda Realtime):
 * `afterBookingsCommitted` + revalidate del perfil (`afterAdoptCommit`).
 *
 * Este archivo exporta SOLO funciones async.
 */
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { actorCapsInTx } from "@/lib/bookings-core";
import { StalePlanPreview } from "@/lib/plans-engine-internal";
import { PlanLifecycleStale } from "@/lib/plans-lifecycle-internal";
import type { PlanPreview } from "@/lib/plans-types";
import {
  AdoptBookingSeriesSchema,
  GeneratePlanBookingsCommitSchema,
  GeneratePlanBookingsPreviewSchema,
  LinkBookingToSessionSchema,
  RemoveBookingFromPlanSchema,
  type AdoptBookingSeriesInput,
  type AdoptBookingSeriesResult,
  type GeneratePlanBookingsCommitInput,
  type GeneratePlanBookingsInput,
  type GeneratePlanBookingsResult,
  type LinkBookingToSessionInput,
  type LinkBookingToSessionResult,
  type PlanFail,
  type PlanPreviewResult,
  type RemoveBookingFromPlanInput,
  type RemoveBookingFromPlanResult,
} from "@/lib/plans-edit-types";
import {
  adoptRejection,
  adoptSeriesInTx,
  afterAdoptCommit,
  generateInTx,
  linkBookingInTx,
  previewGenerateInTx,
  removeBookingFromPlanInTx,
} from "@/lib/plans-adopt-internal";

/** Mismo presupuesto que el alta (§5). */
const COMMIT_TX = { timeout: 15_000, maxWait: 5_000 };

function invalidInput(err: z.ZodError): PlanFail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Rechazo de datos o permisos (sin stale): lo que sale de un preview. */
function failOnly(e: unknown): PlanFail | null {
  const r = adoptRejection(e);
  return r && !("kind" in r) ? r : null;
}

const isP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ─── Generar turnos de sesiones pendientes ───────────────────────────────────

function generatePreviewInNewTx(
  actor: Actor,
  input: { programId: string; sessionIds?: string[] },
  now: Date
): Promise<PlanPreview> {
  return runWithRls(actor.tenantId, async (tx: DbClient) =>
    previewGenerateInTx(tx, actor, await actorCapsInTx(tx, actor), { ...input, rows: [] }, now)
  );
}

/**
 * Preview de "Agendar sesiones pendientes": `sessionIds` ausente = todas las
 * "sin turno"; con ids = una sesión puntual (la Secretaria desde el modal de
 * agenda). Solo lectura. Para quien no gestiona el plan, sin `adopt` ni
 * `mark-done` entre las opciones.
 */
export async function previewGeneratePlanBookings(raw: GeneratePlanBookingsInput): Promise<PlanPreviewResult> {
  const actor = await getActor();
  const parsed = GeneratePlanBookingsPreviewSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  try {
    const preview = await runWithRls(actor.tenantId, async (tx: DbClient) =>
      previewGenerateInTx(tx, actor, await actorCapsInTx(tx, actor), parsed.data, now)
    );
    return { ok: true, preview };
  } catch (e) {
    const r = failOnly(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Commit en UNA tx: turnos nuevos (key `plan:<generationId>:<index>`, otra
 * generación que la del turno cancelado), cobro previo → $0, sesiones movidas
 * con su turno (I3). Si la agenda o el plan cambiaron → preview fresco.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `generatePlanBookingsImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function generatePlanBookings(...args: Parameters<typeof generatePlanBookingsImpl>): ReturnType<typeof generatePlanBookingsImpl> {
  return withReadOnlyResult(() => generatePlanBookingsImpl(...args));
}

async function generatePlanBookingsImpl(raw: GeneratePlanBookingsCommitInput): Promise<GeneratePlanBookingsResult> {
  const actor = await getActor();
  const parsed = GeneratePlanBookingsCommitSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const now = new Date();
  const tenantId = actor.tenantId;

  let out: Awaited<ReturnType<typeof generateInTx>>;
  try {
    out = await withTxConflictRetry(() =>
      runWithRls(tenantId, async (tx: DbClient) => generateInTx(tx, actor, await actorCapsInTx(tx, actor), input, now), COMMIT_TX)
    );
  } catch (e) {
    if (e instanceof StalePlanPreview || e instanceof PlanLifecycleStale || isP2002(e)) {
      try {
        const preview =
          e instanceof StalePlanPreview && e.preview
            ? e.preview
            : await generatePreviewInNewTx(actor, { programId: input.programId, sessionIds: input.sessionIds }, now);
        return { ok: false, kind: "stale-preview", preview };
      } catch (e2) {
        const r2 = failOnly(e2);
        if (r2) return r2;
        throw e2;
      }
    }
    const r = failOnly(e);
    if (r) return r;
    throw e;
  }

  await afterAdoptCommit(tenantId, out);
  return { ok: true, data: { createdBookings: out.createdBookings, adoptedBookings: out.adoptedBookings } };
}

// ─── Vincular un turno a una sesión ──────────────────────────────────────────

/**
 * Vincular un turno suelto del paciente a una sesión pendiente: la sesión toma
 * la fecha del turno (I3); el turno se estampa con la cuota solo si está libre
 * de plata (nunca re-estampa lo cobrado). CAS doble: el turno y el plan.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `linkBookingToSessionImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function linkBookingToSession(...args: Parameters<typeof linkBookingToSessionImpl>): ReturnType<typeof linkBookingToSessionImpl> {
  return withReadOnlyResult(() => linkBookingToSessionImpl(...args));
}

async function linkBookingToSessionImpl(raw: LinkBookingToSessionInput): Promise<LinkBookingToSessionResult> {
  const actor = await getActor();
  const parsed = LinkBookingToSessionSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  try {
    const out = await withTxConflictRetry(() =>
      runWithRls(actor.tenantId, async (tx: DbClient) => linkBookingInTx(tx, actor, await actorCapsInTx(tx, actor), parsed.data, now), COMMIT_TX)
    );
    await afterAdoptCommit(actor.tenantId, out);
    return { ok: true, data: { updatedAt: out.updatedAt.toISOString(), sessionId: out.sessionId } };
  } catch (e) {
    const r = adoptRejection(e);
    if (r) return r;
    throw e;
  }
}

// ─── Adoptar una serie ───────────────────────────────────────────────────────

/**
 * Adoptar varios turnos sueltos a la vez (todo o nada): con `sessionId` van a
 * esa sesión; sin él, a las pendientes por fecha y, si sobran, a sesiones
 * nuevas con la cuota del plan.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `adoptBookingSeriesImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function adoptBookingSeries(...args: Parameters<typeof adoptBookingSeriesImpl>): ReturnType<typeof adoptBookingSeriesImpl> {
  return withReadOnlyResult(() => adoptBookingSeriesImpl(...args));
}

async function adoptBookingSeriesImpl(raw: AdoptBookingSeriesInput): Promise<AdoptBookingSeriesResult> {
  const actor = await getActor();
  const parsed = AdoptBookingSeriesSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  try {
    const out = await withTxConflictRetry(() =>
      runWithRls(actor.tenantId, async (tx: DbClient) => adoptSeriesInTx(tx, actor, await actorCapsInTx(tx, actor), parsed.data, now), COMMIT_TX)
    );
    await afterAdoptCommit(actor.tenantId, out);
    return {
      ok: true,
      data: { updatedAt: out.updatedAt.toISOString(), adopted: out.adopted, totalSessions: out.totalSessions },
    };
  } catch (e) {
    const r = adoptRejection(e);
    if (r) return r;
    throw e;
  }
}

// ─── Sacar del plan ──────────────────────────────────────────────────────────

/**
 * Sacar un turno del plan (C4): con cobro → rechazo (PD-08); si no, queda como
 * turno suelto sin la cuota del plan y su sesión queda "sin turno".
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `removeBookingFromPlanImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function removeBookingFromPlan(...args: Parameters<typeof removeBookingFromPlanImpl>): ReturnType<typeof removeBookingFromPlanImpl> {
  return withReadOnlyResult(() => removeBookingFromPlanImpl(...args));
}

async function removeBookingFromPlanImpl(raw: RemoveBookingFromPlanInput): Promise<RemoveBookingFromPlanResult> {
  const actor = await getActor();
  const parsed = RemoveBookingFromPlanSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const out = await withTxConflictRetry(() =>
      runWithRls(actor.tenantId, async (tx: DbClient) => removeBookingFromPlanInTx(tx, actor, await actorCapsInTx(tx, actor), parsed.data))
    );
    await afterAdoptCommit(actor.tenantId, out);
    return { ok: true, data: { bookingUpdatedAt: out.bookingUpdatedAt.toISOString(), sessionId: out.sessionId } };
  } catch (e) {
    const r = adoptRejection(e);
    if (r) return r;
    throw e;
  }
}
