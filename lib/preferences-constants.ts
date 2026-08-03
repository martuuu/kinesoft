/**
 * Per-user preference shapes + constants — pure, client-safe.
 *
 * Lives separate from `lib/preferences.ts` (which has `"use server"`) so
 * client components can import the types and the KPI option list without
 * dragging in the server-only Prisma path.
 */
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

export type Preferences = {
  palette: Palette;
  pinnedKpis: KpiKey[];
  sidebarCollapsed: boolean;
  // Per-user agenda personalisation (Sprint 18).
  agendaShowWeekHeader: boolean;
  agendaShowSaturday: boolean;
  agendaShowSunday: boolean;
  // Platform-catalog table state (Plataforma → Ejercicios).
  catalogPrefs: CatalogPrefs;
};

// ─────────────────────────────────────────────────────────────────────────────
// Platform catalog table (Plataforma → Ejercicios)
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogSortCol = "name" | "difficulty" | "kind" | "tier" | "createdAt";
export type CatalogSortDir = "asc" | "desc";
/** Which slice of the catalog the table shows. */
export type CatalogArchived = "active" | "archived" | "all";

export type CatalogFilters = {
  q: string;
  kind: "" | "EXERCISE" | "MANUAL_THERAPY";
  /** "" = todos · "comun" = isBasic true · "pro" = isBasic false */
  tier: "" | "comun" | "pro";
  difficulty: number | null;
  /** Tag slugs, by kind. */
  muscle: string[];
  equipment: string[];
  discipline: string[];
  archived: CatalogArchived;
};

export type CatalogPrefs = {
  pageSize: number;
  sortCol: CatalogSortCol;
  sortDir: CatalogSortDir;
  filters: CatalogFilters;
};

export const CATALOG_PAGE_SIZES = [15, 30, 50, 100];
export const CATALOG_SORT_COLS: CatalogSortCol[] = [
  "name",
  "difficulty",
  "kind",
  "tier",
  "createdAt",
];

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  q: "",
  kind: "",
  tier: "",
  difficulty: null,
  muscle: [],
  equipment: [],
  discipline: [],
  archived: "active",
};

export const DEFAULT_CATALOG_PREFS: CatalogPrefs = {
  pageSize: 30,
  sortCol: "name",
  sortDir: "asc",
  filters: DEFAULT_CATALOG_FILTERS,
};

/**
 * Coerce an untrusted value (JSON blob from the DB, or URL params) into a valid
 * `CatalogPrefs`. Pure + total: anything unrecognised falls back to the default,
 * so a stale/hand-edited blob can never break the table.
 */
export function sanitizeCatalogPrefs(raw: unknown): CatalogPrefs {
  const o = (raw ?? {}) as Record<string, unknown>;
  const f = (o.filters ?? {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 20) : [];
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const difficulty =
    typeof f.difficulty === "number" && f.difficulty >= 1 && f.difficulty <= 5
      ? Math.floor(f.difficulty)
      : null;
  return {
    pageSize: CATALOG_PAGE_SIZES.includes(Number(o.pageSize))
      ? Number(o.pageSize)
      : DEFAULT_CATALOG_PREFS.pageSize,
    sortCol: oneOf(o.sortCol, CATALOG_SORT_COLS, DEFAULT_CATALOG_PREFS.sortCol),
    sortDir: oneOf(o.sortDir, ["asc", "desc"] as const, DEFAULT_CATALOG_PREFS.sortDir),
    filters: {
      q: typeof f.q === "string" ? f.q.slice(0, 120) : "",
      kind: oneOf(f.kind, ["", "EXERCISE", "MANUAL_THERAPY"] as const, ""),
      tier: oneOf(f.tier, ["", "comun", "pro"] as const, ""),
      difficulty,
      muscle: strArray(f.muscle),
      equipment: strArray(f.equipment),
      discipline: strArray(f.discipline),
      archived: oneOf(f.archived, ["active", "archived", "all"] as const, "active"),
    },
  };
}

/** The agenda-only slice of preferences, used by the Tweaks panel + agenda. */
export type AgendaPrefs = Pick<
  Preferences,
  "agendaShowWeekHeader" | "agendaShowSaturday" | "agendaShowSunday"
>;

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

export const DEFAULT_PREFERENCES: Preferences = {
  palette: "sky",
  pinnedKpis: ["activePatients", "weekSessions", "activePrograms"],
  sidebarCollapsed: false,
  agendaShowWeekHeader: true,
  agendaShowSaturday: true,
  agendaShowSunday: true,
  catalogPrefs: DEFAULT_CATALOG_PREFS,
};
