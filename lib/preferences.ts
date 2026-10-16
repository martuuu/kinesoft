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
import { getActor, writableError } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";
import {
  AgendaViewPrefsPatchSchema,
  DashboardPrefsPatchSchema,
  mergeAgendaViewPrefs,
  sanitizeAgendaViewPrefs,
} from "@/lib/preferences-schemas";
import {
  DEFAULT_PREFERENCES,
  KPI_OPTIONS,
  sanitizeCatalogPrefs,
  sanitizeDashboardPrefs,
  type AgendaViewPrefs,
  type DashboardPrefs,
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
    agendaShowWeekHeader: row.agendaShowWeekHeader ?? DEFAULT_PREFERENCES.agendaShowWeekHeader,
    agendaShowSaturday: row.agendaShowSaturday ?? DEFAULT_PREFERENCES.agendaShowSaturday,
    agendaShowSunday: row.agendaShowSunday ?? DEFAULT_PREFERENCES.agendaShowSunday,
    // Untrusted JSON blob → coerced to a valid shape (never throws).
    catalogPrefs: sanitizeCatalogPrefs(row.catalogPrefs),
    // B4.2: estado de la agenda multi-profesional; mismo trato (total, por campo).
    agendaView: sanitizeAgendaViewPrefs(row.agendaPrefs),
    // S14r: mismo trato (total, por campo). NULL (fila previa a M3a) → default.
    dashboard: sanitizeDashboardPrefs(row.dashboardPrefs),
  };
}

export async function updateUserPreferences(
  patch: Partial<Preferences>
): Promise<ActionResult<Preferences>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  // BO1-A (C-BO3): escritura fuera de `runWithRls` (UserPreferences no tiene RLS) → corte explícito.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
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
  // B4.2: `agendaView` se valida estricto y se escribe SOLO si vino en el patch
  // (ver abajo); el resto del flujo no cambia.
  let agendaPatch: ReturnType<typeof AgendaViewPrefsPatchSchema.parse> | null = null;
  if (patch.agendaView !== undefined) {
    const parsed = AgendaViewPrefsPatchSchema.safeParse(patch.agendaView);
    if (!parsed.success) return { ok: false, error: "Preferencias de agenda inválidas." };
    agendaPatch = parsed.data;
  }
  const current = await getUserPreferences();
  const merged: Preferences = {
    ...current,
    ...patch,
    agendaView: agendaPatch ? mergeAgendaViewPrefs(current.agendaView, agendaPatch) : current.agendaView,
    // S14r: `dashboardPrefs` tiene su propia action (`updateDashboardPrefs`) y
    // este flujo no la escribe; si un patch lo trae, se ignora (no se devuelve
    // un valor que no quedó guardado).
    dashboard: current.dashboard,
  };
  const writable = {
    palette: merged.palette,
    pinnedKpis: merged.pinnedKpis,
    sidebarCollapsed: merged.sidebarCollapsed,
    agendaShowWeekHeader: merged.agendaShowWeekHeader,
    agendaShowSaturday: merged.agendaShowSaturday,
    agendaShowSunday: merged.agendaShowSunday,
    // Re-sanitised on the way in too, so a malformed client patch can't persist.
    catalogPrefs: sanitizeCatalogPrefs(merged.catalogPrefs),
    // Solo si el patch lo trajo: este flujo lee-y-reescribe todas las columnas,
    // y no queremos pisar un `updateAgendaViewPrefs` concurrente (toggle de
    // favorito mientras el panel de Tweaks guarda otra cosa).
    ...(agendaPatch ? { agendaPrefs: merged.agendaView } : {}),
  };
  await prisma.userPreferences.upsert({
    where: { userId: actor.userId },
    create: { userId: actor.userId, tenantId: actor.tenantId, ...writable },
    update: writable,
  });
  // Only the dashboard reads preferences server-side (pinned KPIs / palette).
  // Agenda prefs are applied live via the Tweaks context, so revalidating
  // /agenda here would just force a wasteful refetch on every toggle.
  revalidatePath("/dashboard");
  return { ok: true, data: merged };
}

/**
 * B4.2 AG-resource: guarda un patch de `UserPreferences.agendaPrefs` (modo
 * Por día ↔ Por profesional, zoom 15/30/60, densidad, favoritos, sede).
 *
 * Escribe SOLO esa columna (no el lee-y-reescribe de `updateUserPreferences`),
 * porque la agenda dispara varios toggles seguidos y no debe pisar la paleta o
 * los KPIs. El merge es contra lo guardado en la fila, no contra el estado del
 * cliente. Sin `revalidatePath`: la agenda aplica el cambio en vivo; un
 * refetch de /agenda por cada toggle sería puro costo (mismo criterio que los
 * toggles de la semana).
 *
 * `UserPreferences` es por usuario (PK `userId`), no por tenant: la escritura
 * va con `where: { userId }` del Actor, igual que `updateUserPreferences`.
 */
export async function updateAgendaViewPrefs(
  patch: unknown
): Promise<ActionResult<AgendaViewPrefs>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  // BO1-A (C-BO3): escritura fuera de `runWithRls` (UserPreferences no tiene RLS) → corte explícito.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const parsed = AgendaViewPrefsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "Preferencias de agenda inválidas." };
  const row = await prisma.userPreferences.findUnique({
    where: { userId: actor.userId },
    select: { agendaPrefs: true },
  });
  const next = mergeAgendaViewPrefs(sanitizeAgendaViewPrefs(row?.agendaPrefs), parsed.data);
  await prisma.userPreferences.upsert({
    where: { userId: actor.userId },
    create: { userId: actor.userId, tenantId: actor.tenantId, agendaPrefs: next },
    update: { agendaPrefs: next },
  });
  return { ok: true, data: next };
}

/**
 * S14r (ES3): guarda un patch de `UserPreferences.dashboardPrefs` (hoy solo el
 * período del widget de ingresos, Mes/Semana). Escribe SOLO esa columna, con
 * merge contra lo guardado en la fila — mismo criterio que
 * `updateAgendaViewPrefs`: no pisa paleta/KPIs de un `updateUserPreferences`
 * concurrente. Sin `revalidatePath`: el widget ya cambió en vivo y el próximo
 * render del dashboard lee la preferencia de la base.
 */
export async function updateDashboardPrefs(
  patch: unknown
): Promise<ActionResult<DashboardPrefs>> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  // BO1-A (C-BO3): escritura fuera de `runWithRls` (UserPreferences no tiene RLS) → corte explícito.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const parsed = DashboardPrefsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "Preferencias del dashboard inválidas." };
  const row = await prisma.userPreferences.findUnique({
    where: { userId: actor.userId },
    select: { dashboardPrefs: true },
  });
  const next: DashboardPrefs = sanitizeDashboardPrefs({ ...sanitizeDashboardPrefs(row?.dashboardPrefs), ...parsed.data });
  await prisma.userPreferences.upsert({
    where: { userId: actor.userId },
    create: { userId: actor.userId, tenantId: actor.tenantId, dashboardPrefs: next },
    update: { dashboardPrefs: next },
  });
  return { ok: true, data: next };
}
