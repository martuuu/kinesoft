"use server";

/**
 * Per-user preferences — server actions only.
 *
 * Pure types + `KPI_OPTIONS` live in `lib/preferences-constants.ts` so
 * client components can consume them without violating the
 * "use server" → every-export-must-be-async rule.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";
import {
  DEFAULT_PREFERENCES,
  KPI_OPTIONS,
  type KpiKey,
  type Palette,
  type Preferences,
} from "@/lib/preferences-constants";

export async function getUserPreferences(): Promise<Preferences> {
  const actor = await getActor();
  if (!actor.userId) return DEFAULT_PREFERENCES;
  const row = await prisma.userPreferences.findUnique({ where: { userId: actor.userId } });
  if (!row) return DEFAULT_PREFERENCES;
  const pinned = Array.isArray(row.pinnedKpis)
    ? (row.pinnedKpis as unknown[]).filter(
        (k): k is KpiKey => typeof k === "string" && KPI_OPTIONS.some((o) => o.key === k)
      )
    : DEFAULT_PREFERENCES.pinnedKpis;
  return {
    palette: (row.palette as Palette) ?? DEFAULT_PREFERENCES.palette,
    pinnedKpis: pinned.length ? pinned : DEFAULT_PREFERENCES.pinnedKpis,
    sidebarCollapsed: row.sidebarCollapsed ?? DEFAULT_PREFERENCES.sidebarCollapsed,
  };
}

export async function updateUserPreferences(
  patch: Partial<Preferences>
): Promise<ActionResult<Preferences>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  const palettes: Palette[] = ["sky", "mint", "coral", "violet"];
  if (patch.palette && !palettes.includes(patch.palette)) {
    return { ok: false, error: "Paleta inválida." };
  }
  if (patch.pinnedKpis) {
    if (patch.pinnedKpis.length > 6) return { ok: false, error: "Máx 6 KPIs fijados." };
    const valid = KPI_OPTIONS.map((o) => o.key);
    if (patch.pinnedKpis.some((k) => !valid.includes(k))) {
      return { ok: false, error: "KPI inválido." };
    }
  }
  const current = await getUserPreferences();
  const merged: Preferences = { ...current, ...patch };
  await prisma.userPreferences.upsert({
    where: { userId: actor.userId },
    create: {
      userId: actor.userId,
      tenantId: actor.tenantId,
      palette: merged.palette,
      pinnedKpis: merged.pinnedKpis,
      sidebarCollapsed: merged.sidebarCollapsed,
    },
    update: {
      palette: merged.palette,
      pinnedKpis: merged.pinnedKpis,
      sidebarCollapsed: merged.sidebarCollapsed,
    },
  });
  revalidatePath("/dashboard");
  return { ok: true, data: merged };
}
