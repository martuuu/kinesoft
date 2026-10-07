"use server";

/**
 * Planes · mover en serie (D23 "este y los siguientes", mismo desfase) y
 * re-planificar (L7 "Editar desde la sesión N") — actions finas (S16a, ES2b
 * P2.2). El núcleo vive en `lib/plans-move-internal.ts` (server-only).
 *
 * Camino de AGENTS §4: `getActor()` → zod (`plans-edit-types`, P2-C2) →
 * `runWithRls` con el gate adentro (mover = `plans.schedule`, la Secretaria
 * puede; re-planificar = `plans.manage`; ambos arrancan con
 * `assertModule('planes')`) → `where {tenantId}` a mano en cada query.
 *
 * Commit: UNA `runWithRls(..., {timeout:15000, maxWait:5000})` con un
 * reintento ante P2034/40P01 (`withTxConflictRetry`). Errores como resultado:
 *   - `StalePlanPreview` → `{kind:'stale-preview', preview}` (el preview fresco
 *     sale de la misma tx o, si el conflicto se vio al escribir, de una nueva);
 *   - P2002 (un turno del paciente o la sesión ganó la carrera fuera del lock
 *     del paciente) → la tx quedó abortada: preview fresco en una tx nueva;
 *   - conflicto del core que el motor no vio → `{ok:false, error}` (nada movido);
 *   - `PlanRejected` / `ForbiddenError` → `{ok:false, error}`.
 *
 * Post-commit, una vez y fuera de la tx (enmienda Realtime):
 * `afterBookingsCommitted(tenantId, refs)` + revalidate del perfil.
 *
 * Exporta SOLO funciones async (los zod y tipos están en `plans-edit-types`).
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { runWithRls, type DbClient } from "@/lib/rls";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { actorCapsInTx } from "@/lib/bookings-core";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { PlanRejected, StalePlanPreview } from "@/lib/plans-engine-internal";
import { ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import {
  MovePlanSeriesCommitSchema,
  MovePlanSeriesPreviewSchema,
  ReplanPlanCommitSchema,
  ReplanPlanPreviewSchema,
  type MovePlanSeriesInput,
  type MovePlanSeriesPreviewInput,
  type MovePlanSeriesResult,
  type PlanFail,
  type PlanPreviewResult,
  type ReplanPlanInput,
  type ReplanPlanInputParsed,
  type ReplanPlanPreviewInput,
  type ReplanPlanResult,
} from "@/lib/plans-edit-types";
import type { PlanPreview } from "@/lib/plans-types";
import {
  MoveSeriesConflict,
  moveSeriesInTx,
  previewMoveSeriesInTx,
  previewReplanInTxOrRollback,
  replanInTx,
} from "@/lib/plans-move-internal";

/** Mismo presupuesto que el alta (§5). */
const COMMIT_TX = { timeout: 15_000, maxWait: 5_000 };

function invalidInput(err: z.ZodError): PlanFail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Rechazos esperables → resultado; lo demás (la base) se propaga. */
function rejection(e: unknown): PlanFail | null {
  if (e instanceof PlanRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  if (e instanceof MoveSeriesConflict) return { ok: false, error: e.message };
  // P2-Z · B-M2: el verificador ya reportó a Sentry y la tx hizo rollback;
  // sin esto el throw llegaba al cliente como un 500 genérico.
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: INCONSISTENT };
  return null;
}

/** Mismo texto que `plans-lifecycle-internal` / `plans-adopt-internal`. */
const INCONSISTENT = "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.";

const isP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ─── Mover en serie ──────────────────────────────────────────────────────────

async function movePreviewInNewTx(actor: Actor, input: { programId: string; fromSessionId: string; at: string }, now: Date): Promise<PlanPreview> {
  return runWithRls(actor.tenantId, async (tx) =>
    previewMoveSeriesInTx(tx, actor, await actorCapsInTx(tx, actor), { ...input, rows: [] }, now)
  );
}

/**
 * Preview de "este y los siguientes": `at` = instante NUEVO de la sesión
 * `fromSessionId`; el desfase se aplica a ella y a las siguientes vivas no
 * realizadas. Solo lectura. Filas = las sesiones con turno.
 */
export async function previewMovePlanSeries(raw: MovePlanSeriesPreviewInput): Promise<PlanPreviewResult> {
  const actor = await getActor();
  const parsed = MovePlanSeriesPreviewSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const now = new Date();
  try {
    const preview = await runWithRls(actor.tenantId, async (tx) =>
      previewMoveSeriesInTx(tx, actor, await actorCapsInTx(tx, actor), parsed.data, now)
    );
    return { ok: true, preview };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/** Commit de "este y los siguientes" en UNA tx (todo o nada). */
export async function movePlanSeries(raw: MovePlanSeriesInput): Promise<MovePlanSeriesResult> {
  const actor = await getActor();
  const parsed = MovePlanSeriesCommitSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const now = new Date();
  const tenantId = actor.tenantId;

  let out: Awaited<ReturnType<typeof moveSeriesInTx>>;
  try {
    out = await withTxConflictRetry(() =>
      runWithRls(tenantId, async (tx: DbClient) => moveSeriesInTx(tx, actor, await actorCapsInTx(tx, actor), input, now), COMMIT_TX)
    );
  } catch (e) {
    if (e instanceof StalePlanPreview || isP2002(e)) {
      try {
        const preview = e instanceof StalePlanPreview && e.preview ? e.preview : await movePreviewInNewTx(actor, input, now);
        return { ok: false, kind: "stale-preview", preview };
      } catch (e2) {
        const r2 = rejection(e2);
        if (r2) return r2;
        throw e2;
      }
    }
    const r = rejection(e);
    if (r) return r;
    throw e;
  }

  if (out.refs.length) await afterBookingsCommitted(tenantId, out.refs);
  revalidatePath(`/pacientes/${out.patientId}`);
  return { ok: true, data: { movedBookings: out.movedBookings, movedSessions: out.movedSessions } };
}

// ─── Re-planificar desde la sesión N ─────────────────────────────────────────

function replanPreview(actor: Actor, input: ReplanPlanInputParsed, now: Date): Promise<PlanPreview> {
  return previewReplanInTxOrRollback(
    (fn) => runWithRls(actor.tenantId, fn),
    actor,
    (tx) => actorCapsInTx(tx, actor),
    input,
    now
  );
}

/**
 * Preview de "Editar desde la sesión N": horario nuevo desde `startDayKey` y,
 * opcional, profesional/servicio/sede/duración nuevos. Solo lectura (las refs
 * nuevas se prueban dentro de una tx que se revierte).
 */
export async function previewReplanPlan(raw: ReplanPlanPreviewInput): Promise<PlanPreviewResult> {
  const actor = await getActor();
  const parsed = ReplanPlanPreviewSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return { ok: true, preview: await replanPreview(actor, { ...parsed.data, stateToken: parsed.data.stateToken ?? "" }, new Date()) };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Commit de L7 en UNA tx: cancela los futuros impagos desde la sesión N y
 * recrea por el motor; los turnos con cobro quedan intactos.
 */
export async function replanPlan(raw: ReplanPlanInput): Promise<ReplanPlanResult> {
  const actor = await getActor();
  const parsed = ReplanPlanCommitSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const now = new Date();
  const tenantId = actor.tenantId;

  let out: Awaited<ReturnType<typeof replanInTx>>;
  try {
    out = await withTxConflictRetry(() =>
      runWithRls(tenantId, async (tx: DbClient) => replanInTx(tx, actor, await actorCapsInTx(tx, actor), input, now), COMMIT_TX)
    );
  } catch (e) {
    if (e instanceof StalePlanPreview || isP2002(e)) {
      try {
        const preview =
          e instanceof StalePlanPreview && e.preview ? e.preview : await replanPreview(actor, { ...input, rows: [] }, now);
        return { ok: false, kind: "stale-preview", preview };
      } catch (e2) {
        const r2 = rejection(e2);
        if (r2) return r2;
        throw e2;
      }
    }
    const r = rejection(e);
    if (r) return r;
    throw e;
  }

  if (out.refs.length) await afterBookingsCommitted(tenantId, out.refs);
  revalidatePath(`/pacientes/${out.patientId}`);
  return {
    ok: true,
    data: {
      cancelledBookings: out.cancelledBookings,
      keptWithPayment: out.keptWithPayment,
      createdBookings: out.createdBookings,
      adoptedBookings: out.adoptedBookings,
    },
    ...(out.keptWithPayment
      ? { notice: `${out.keptWithPayment} ${out.keptWithPayment === 1 ? "turno con cobro quedó" : "turnos con cobro quedaron"} como estaba${out.keptWithPayment === 1 ? "" : "n"}: reprogramalo${out.keptWithPayment === 1 ? "" : "s"} a mano.` }
      : {}),
  };
}
