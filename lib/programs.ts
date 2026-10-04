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
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { isTenantAdminRole } from "@/lib/capabilities";
import { audit, auditInTx } from "@/lib/audit";
import { addDays, dayWindow } from "@/lib/availability/day";
import { patientAccessFor } from "@/lib/visibility";
import { hcAccessError } from "@/lib/patient-access-internal";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
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
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId },
    select: {
      id: true,
      title: true,
      status: true,
      totalSessions: true,
      frequency: true,
      startDate: true,
      createdAt: true,
      sessions: {
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
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId },
    include: {
      sessions: {
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
  const actor = await getActor();
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
 * Edición legacy (título, total, frecuencia, inicio). La conducta se mantiene
 * hasta P2-S15, que la deja en título y notas con CAS: todavía NO crea, archiva
 * ni mueve sesiones al cambiar el total o el inicio (slug
 * `updateProgram-desincroniza-total`, lo cierra S15).
 *
 * P0-S02a: zod (`ProgramUpdate`) antes de la base, y lectura + gate + write +
 * audit en UNA tx. Antes el chequeo a mano dejaba pasar `NaN` (`NaN < 1` y
 * `NaN > 64` son false) hasta Prisma (500), y el write iba en otra tx que la
 * lectura del gate, con el audit por fuera.
 */
export async function updateProgram(raw: ProgramUpdateInput): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = ProgramUpdate.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id: input.id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, totalSessions: true },
    });
    if (!row) return { error: "Plan no encontrado." };
    const denied = await hcAccessError(actor, row.patientId, tx);
    if (denied) return { error: denied };

    const patch: Prisma.TreatmentProgramUpdateInput = {};
    if (input.title !== undefined) patch.title = input.title;
    // El Drawer reenvía siempre el total actual: igual = no se toca (y un
    // legacy de 61..64 sesiones se puede renombrar). Un total NUEVO respeta
    // el tope de PD-04.
    if (input.totalSessions !== undefined && input.totalSessions !== row.totalSessions) {
      if (input.totalSessions > PLAN_MAX_SESSIONS) {
        return { error: `Sesiones entre 1 y ${PLAN_MAX_SESSIONS}.` };
      }
      patch.totalSessions = input.totalSessions;
    }
    if (input.frequency !== undefined) patch.frequency = input.frequency;
    // Medianoche AR del día elegido (C11), como `createProgram`.
    if (input.startDate !== undefined) patch.startDate = dayWindow(input.startDate).start;
    const fields = Object.keys(patch);
    if (fields.length === 0) return { patientId: row.patientId, changed: false };

    await tx.treatmentProgram.update({ where: { id: row.id }, data: patch });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.update",
      entity: "TreatmentProgram",
      entityId: row.id,
      // Solo nombres de campo, nunca valores (AuditParams: sin PHI).
      payload: { fields },
    });
    return { patientId: row.patientId, changed: true };
  });
  if (result.error) return { ok: false, error: result.error };
  if (result.changed) revalidatePath(`/pacientes/${result.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Cambio de estado legacy (sin D7: no toca turnos ni sesiones; eso llega con
 * P2). P0-S02a: el estado se valida con zod (antes un string cualquiera por
 * RPC llegaba a Prisma como enum inválido → 500) y lectura + gate + write +
 * audit van en una tx.
 */
export async function setProgramStatus(raw: ProgramStatusSetInput): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = ProgramStatusSet.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id: input.id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, status: true },
    });
    if (!row) return { error: "Plan no encontrado." };
    const denied = await hcAccessError(actor, row.patientId, tx);
    if (denied) return { error: denied };
    if (row.status === input.status) return { patientId: row.patientId, changed: false };
    await tx.treatmentProgram.update({ where: { id: row.id }, data: { status: input.status } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "program.status",
      entity: "TreatmentProgram",
      entityId: row.id,
      payload: { from: row.status, to: input.status },
    });
    return { patientId: row.patientId, changed: true };
  });
  if (result.error) return { ok: false, error: result.error };
  if (result.changed) {
    revalidatePath(`/pacientes/${result.patientId}`);
    revalidatePath("/seguimiento");
  }
  return { ok: true, data: undefined };
}

/**
 * Hard-delete a TreatmentProgram + all its Sessions + SessionExercises.
 * Bookings that referenced sessions remain in place (no FK to delete
 * cascade). Audit log records the loss.
 */
export async function deleteProgram(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const denied = await requireAdminRole(actor);
  if (denied) return denied;
  // RLS Etapa 2: cascade delete (sessions + sessionExercises) traverses
  // FKs the app-layer extension can't reach. The GUC ensures Postgres
  // policies guard every cascaded row.
  const program = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, title: true, totalSessions: true },
    });
    if (!row) return null;
    // A2b-S-vis: OWNER/ADMIN ya implica `full`; el gate queda explícito para
    // que no dependa de que `requireAdminRole` siga siendo el único filtro.
    if (await hcAccessError(actor, row.patientId, tx)) return null;
    await tx.treatmentProgram.delete({ where: { id } });
    return row;
  });
  if (!program) return { ok: false, error: "Plan no encontrado." };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.delete",
    entity: "TreatmentProgram",
    entityId: id,
    payload: { title: program.title, totalSessions: program.totalSessions },
  });
  revalidatePath(`/pacientes/${program.patientId}`);
  return { ok: true, data: undefined };
}

export async function deleteSession(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const denied = await requireAdminRole(actor);
  if (denied) return denied;
  const session = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.session.findFirst({
      where: { id, program: { tenantId: actor.tenantId } },
      select: {
        id: true,
        index: true,
        program: { select: { id: true, patientId: true, totalSessions: true } },
      },
    });
    // A2b-S-vis: mismo gate explícito que deleteProgram (OWNER/ADMIN ⇒ full).
    if (!row || (await hcAccessError(actor, row.program.patientId, tx))) return null;
    return row;
  });
  if (!session) return { ok: false, error: "Sesión no encontrada." };

  await runWithRls(actor.tenantId, async (tx) => {
    await tx.session.delete({ where: { id } });
    // Decrement totalSessions so progress bars stay accurate. Atomic
    // decrement (vs. read-modify-write) avoids racing a concurrent edit.
    // The `> 1` guard keeps the counter from ever reaching 0.
    if (session.program.totalSessions > 1) {
      await tx.treatmentProgram.update({
        where: { id: session.program.id },
        data: { totalSessions: { decrement: 1 } },
      });
    }
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.delete",
    entity: "Session",
    entityId: id,
    payload: { index: session.index },
  });
  revalidatePath(`/pacientes/${session.program.patientId}`);
  return { ok: true, data: undefined };
}
