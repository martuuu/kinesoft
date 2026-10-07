"use server";

/**
 * Planes · alta (S11e, ES2b P2.1) — server actions finas: `previewPlan` y
 * `createPlan`. El motor vive en `lib/plans-engine-internal.ts` (server-only);
 * acá solo el camino de AGENTS §4: `getActor()` → zod → `runWithRls` con el
 * gate de `plan-authz-internal` adentro (crear = `plans.manage`: full +
 * `clinical.read`; arranca con `assertModule('planes')`) → `where {tenantId}`
 * a mano en cada query del motor.
 *
 * Errores como resultado (`{ ok:false, error }`), no como throw: en prod Next
 * oculta el mensaje de un throw y el editor no distinguiría "sin permiso" de
 * "se cayó la base". Un error inesperado (la base) sí se propaga.
 *
 * Commit (§5): una sola `runWithRls(t, fn, {timeout:15000, maxWait:5000})`
 * con un reintento ante P2034/40P01 (`withTxConflictRetry`). P2002 (carrera
 * con otra alta del mismo plan, o con un turno del paciente que el lock de
 * cupo no serializa): rollback y resolución por los DATOS en una tx nueva —
 * si el plan con esa key existe es éxito idempotente; si no, stale con un
 * preview fresco.
 *
 * Post-commit, una vez y fuera de la tx (enmienda Realtime):
 * `afterBookingsCommitted`, el aviso resumen al responsable
 * (`NotificationKind.SYSTEM`, sin PHI) y el revalidate del perfil.
 *
 * Este archivo exporta SOLO funciones async; tipos y zod en
 * `lib/plans-types.ts` / `lib/plans-schemas.ts`.
 */
import { revalidatePath } from "next/cache";
import { Prisma, NotificationKind } from "@prisma/client";
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { assertPlanManageInTx } from "@/lib/plan-authz-internal";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { notify } from "@/lib/notifications-internal";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { disciplineShortLabel } from "@/lib/plan-display";
import { PlanCreateInputSchema, type PlanCreateInputParsed } from "@/lib/plans-schemas";
import type { CreatePlanResult, PlanCreateInput, PlanPreview } from "@/lib/plans-types";
import {
  createPlanInTx,
  findProgramByKeyInTx,
  PlanRejected,
  previewNewPlanInTx,
  StalePlanPreview,
} from "@/lib/plans-engine-internal";

/** Opciones de la tx del commit (§5: ≤ 60 statements para 20 filas). */
const COMMIT_TX = { timeout: 15_000, maxWait: 5_000 };

/** El preview no necesita key ni token (no escribe): se completan para reusar el MISMO zod que el commit. */
const PREVIEW_KEY = "preview-only";

type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function invalidInput(err: z.ZodError): Fail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Rechazos esperables → resultado; lo demás se propaga. */
function rejection(e: unknown): Fail | null {
  if (e instanceof PlanRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  // P2-Z · B-M2: el verificador ya reportó a Sentry y la tx hizo rollback;
  // sin esto el throw llegaba al cliente como un 500 genérico.
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: INCONSISTENT };
  return null;
}

/** Mismo texto que `plans-lifecycle-internal` / `plans-adopt-internal`. */
const INCONSISTENT = "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.";

/** Capabilities leídas dentro de la tx (sin una segunda conexión del pool). */
async function capsInTx(tx: Prisma.TransactionClient, actor: Actor): Promise<ReadonlySet<Capability>> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  return capabilitiesFor(m?.role);
}

async function previewInNewTx(actor: Actor, input: PlanCreateInputParsed, now: Date): Promise<PlanPreview> {
  return runWithRls(actor.tenantId, async (tx) => {
    const caps = await capsInTx(tx, actor);
    await assertPlanManageInTx(tx, actor, caps, input.patientId);
    return previewNewPlanInTx(tx, actor, input, { now });
  });
}

/**
 * Preview de "Revisá los turnos" (solo lectura, ≤ 30 statements): filas con
 * estado, sugerencia, resoluciones permitidas, cuota y cobro previo; resumen;
 * `stateToken` del borrador; otros planes activos del paciente. Las
 * resoluciones que vengan en `rows` entran al fold (re-preview con las
 * elegidas). `idempotencyKey` y `stateToken` son opcionales acá.
 */
export async function previewPlan(
  raw: Omit<PlanCreateInput, "idempotencyKey" | "stateToken"> & { idempotencyKey?: string; stateToken?: string }
): Promise<{ ok: true; preview: PlanPreview } | Fail> {
  const actor = await getActor();
  const parsed = PlanCreateInputSchema.safeParse({
    ...(raw ?? {}),
    idempotencyKey: raw?.idempotencyKey || PREVIEW_KEY,
    stateToken: raw?.stateToken || PREVIEW_KEY,
    rows: raw?.rows ?? [],
  });
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return { ok: true, preview: await previewInNewTx(actor, parsed.data, new Date()) };
  } catch (e) {
    const r = rejection(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Alta del plan y sus turnos en UNA tx (§5 "Commit"). Idempotente por
 * `idempotencyKey` (UUID del drawer, único por tenant). Si la agenda cambió
 * desde el preview devuelve `{ kind: 'stale-preview', preview }` con las filas
 * re-clasificadas (copy C13: "La agenda cambió mientras armabas el plan…").
 */
export async function createPlan(raw: PlanCreateInput): Promise<CreatePlanResult> {
  const actor = await getActor();
  const parsed = PlanCreateInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const now = new Date();
  const tenantId = actor.tenantId;

  let out: Awaited<ReturnType<typeof createPlanInTx>>;
  try {
    out = await withTxConflictRetry(() =>
      runWithRls(tenantId, async (tx) => createPlanInTx(tx, actor, input, { now, caps: await capsInTx(tx, actor) }), COMMIT_TX)
    );
  } catch (e) {
    if (e instanceof StalePlanPreview) {
      return { ok: false, kind: "stale-preview", preview: e.preview ?? (await previewInNewTx(actor, input, now)) };
    }
    const r = rejection(e);
    if (r) return r;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await runWithRls(tenantId, (tx) => findProgramByKeyInTx(tx, tenantId, input.idempotencyKey));
      if (existing && existing.patientId === input.patientId) {
        return { ok: true, programId: existing.id, idempotent: true };
      }
      try {
        return { ok: false, kind: "stale-preview", preview: await previewInNewTx(actor, input, now) };
      } catch (e2) {
        const r2 = rejection(e2);
        if (r2) return r2;
        throw e2;
      }
    }
    throw e;
  }

  if (!out.idempotent) {
    await afterBookingsCommitted(tenantId, out.refs);
    if (out.practitionerUserId && out.practitionerUserId !== actor.userId) {
      // Aviso resumen al responsable, sin PHI (ni nombre ni título del plan).
      await notify({
        tenantId,
        userId: out.practitionerUserId,
        kind: NotificationKind.SYSTEM,
        title: "Te asignaron un plan nuevo",
        body: `${disciplineShortLabel(input.discipline)} · ${out.sessions} sesiones · ${out.bookings} turnos`,
        link: `/pacientes/${input.patientId}?tab=planes&programa=${out.programId}`,
      });
    }
    revalidatePath(`/pacientes/${input.patientId}`);
  }
  return { ok: true, programId: out.programId, idempotent: out.idempotent };
}
