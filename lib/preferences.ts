"use server";

/**
 * Per-user preferences — palette, pinned KPIs, sidebar default.
 *
 * Defaults live here so a brand-new user has a sensible dashboard
 * before they tweak anything.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";

export type Palette = "sky" | "mint" | "coral" | "violet";

export type KpiKey =
  | "activePatients"
  | "weekSessions"
  | "activePrograms"
  | "todayCount"
  | "monthRevenue"
  | "adherence"
  | "nearingDischarge"
  | "newPatientsMonth";

export const KPI_OPTIONS: { key: KpiKey; label: string; description: string }[] = [
  { key: "activePatients", label: "Pacientes activos", description: "Con plan en curso" },
  { key: "weekSessions", label: "Sesiones esta semana", description: "Confirmadas + completadas" },
  { key: "activePrograms", label: "Planes en curso", description: "Programs ACTIVE" },
  { key: "todayCount", label: "Turnos de hoy", description: "Sin contar cancelados" },
  { key: "monthRevenue", label: "Ingresos del mes", description: "Pagos PAID" },
  { key: "adherence", label: "Adherencia semanal", description: "Realizadas / total" },
  { key: "nearingDischarge", label: "Cerca del alta", description: "Programas casi terminados" },
  { key: "newPatientsMonth", label: "Pacientes nuevos", description: "Altas este mes" },
];

export type Preferences = {
  palette: Palette;
  pinnedKpis: KpiKey[];
  sidebarCollapsed: boolean;
};

const DEFAULTS: Preferences = {
  palette: "sky",
  pinnedKpis: ["activePatients", "weekSessions", "activePrograms"],
  sidebarCollapsed: false,
};

export async function getUserPreferences(): Promise<Preferences> {
  const actor = await getActor();
  if (!actor.userId) return DEFAULTS;
  const row = await prisma.userPreferences.findUnique({ where: { userId: actor.userId } });
  if (!row) return DEFAULTS;
  const pinned = Array.isArray(row.pinnedKpis)
    ? (row.pinnedKpis as unknown[]).filter(
        (k): k is KpiKey => typeof k === "string" && KPI_OPTIONS.some((o) => o.key === k)
      )
    : DEFAULTS.pinnedKpis;
  return {
    palette: (row.palette as Palette) ?? DEFAULTS.palette,
    pinnedKpis: pinned.length ? pinned : DEFAULTS.pinnedKpis,
    sidebarCollapsed: row.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
  };
}

export async function updateUserPreferences(
  patch: Partial<Preferences>
): Promise<ActionResult<Preferences>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  // Validate palette + KPIs.
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
