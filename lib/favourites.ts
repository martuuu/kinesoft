"use server";

/**
 * Per-user favourite exercises.
 *
 * Star surfaced on the Biblioteca card; filter chip in the toolbar.
 * Gated by plan: FREE tenants don't get favourites (returns a plan
 * upgrade hint).
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { getActor, writableError } from "@/lib/session";
import { gatingForActor } from "@/lib/plan-gating";
import type { ActionResult } from "@/lib/validation";

// EV1-E1 (readonly-residual-actions): el cuerpo va en `toggleFavouriteImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function toggleFavourite(...args: Parameters<typeof toggleFavouriteImpl>): ReturnType<typeof toggleFavouriteImpl> {
  return withReadOnlyResult(() => toggleFavouriteImpl(...args));
}

async function toggleFavouriteImpl(exerciseId: string): Promise<ActionResult<{ favourited: boolean }>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  // BO1-A (C-BO3): el delete/create de abajo van por el cliente base, fuera de `runWithRls` → corte explícito.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const gate = await gatingForActor();
  if (!gate.canFavourite) {
    return { ok: false, error: "Mejorá tu plan para guardar favoritos." };
  }
  // Ownership / visibility check.
  const ex = await runWithRls(actor.tenantId, (tx) => tx.exercise.findFirst({
    where: { AND: [{ id: exerciseId }, gate.visibility] },
    select: { id: true },
  }));
  if (!ex) return { ok: false, error: "Ejercicio no disponible." };

  const existing = await prisma.favorite.findUnique({
    where: { userId_exerciseId: { userId: actor.userId, exerciseId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    revalidatePath("/biblioteca");
    return { ok: true, data: { favourited: false } };
  }

  await prisma.favorite.create({
    data: {
      userId: actor.userId,
      tenantId: actor.tenantId,
      exerciseId,
    },
  });
  revalidatePath("/biblioteca");
  return { ok: true, data: { favourited: true } };
}
