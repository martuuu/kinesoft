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
import { getActor } from "@/lib/session";
import { gatingForActor } from "@/lib/plan-gating";
import type { ActionResult } from "@/lib/validation";

export async function toggleFavourite(exerciseId: string): Promise<ActionResult<{ favourited: boolean }>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  const gate = await gatingForActor();
  if (!gate.canFavourite) {
    return { ok: false, error: "Mejorá tu plan para guardar favoritos." };
  }
  // Ownership / visibility check.
  const ex = await prisma.exercise.findFirst({
    where: { AND: [{ id: exerciseId }, gate.visibility] },
    select: { id: true },
  });
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
