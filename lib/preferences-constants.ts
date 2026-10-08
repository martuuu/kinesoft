/**
 * Per-user preference shapes + constants — pure, client-safe.
 *
 * Lives separate from `lib/preferences.ts` (which has `"use server"`) so
 * client components can import the types and the KPI option list without
 * dragging in the server-only Prisma path.
 */
import { z } from "zod";

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
  // B4.2: estado de la agenda multi-profesional (`UserPreferences.agendaPrefs`).
  agendaView: AgendaViewPrefs;
  // S14r (M3a): preferencias del dashboard (`UserPreferences.dashboardPrefs`).
  dashboard: DashboardPrefs;
};

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (S14r, ES3) — `UserPreferences.dashboardPrefs`
//
// Mismo trato que `agendaPrefs`: blob JSON por usuario (un campo nuevo no pide
// migración), lectura total por campo (`.catch`) y escritura estricta. La base
// solo acepta NULL o un objeto (CHECK `UserPreferences_dashboardPrefs_object_check`
// de M3a); para limpiar la columna se usa `Prisma.DbNull`, nunca `JsonNull`.
// ─────────────────────────────────────────────────────────────────────────────

/** Período del widget de ingresos: semana lunes→domingo AR o mes calendario AR. */
export type RevenueRange = "week" | "month";
export const REVENUE_RANGES: ReadonlyArray<RevenueRange> = ["week", "month"];
export const RevenueRangeSchema = z.enum(["week", "month"]);

export type DashboardPrefs = {
  revenueRange: RevenueRange;
};

export const DEFAULT_DASHBOARD_PREFS: DashboardPrefs = {
  // "Mes" = lo que mostraba el widget antes de S14r: un usuario que nunca
  // eligió ve lo mismo que veía.
  revenueRange: "month",
};

/** Lectura: blob no confiable (DB) → `DashboardPrefs` válido. Total, nunca tira. */
export function sanitizeDashboardPrefs(raw: unknown): DashboardPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return z
    .object({ revenueRange: RevenueRangeSchema.catch(DEFAULT_DASHBOARD_PREFS.revenueRange) })
    .parse(o);
}

/** Escritura: patch parcial, estricto (campo desconocido o fuera de dominio → error). */
export const DashboardPrefsPatchSchema = z
  .object({ revenueRange: RevenueRangeSchema })
  .partial()
  .strict();
export type DashboardPrefsPatch = z.input<typeof DashboardPrefsPatchSchema>;

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
  { key: "monthRevenue", label: "Ingresos del mes", description: "Mercado Pago + copagos cobrados" },
  { key: "adherence", label: "Adherencia semanal", description: "Realizadas / total" },
  { key: "nearingDischarge", label: "Cerca del alta", description: "Programas casi terminados" },
  { key: "newPatientsMonth", label: "Pacientes nuevos", description: "Altas este mes" },
];

/**
 * SR-D5I / SRZ-FX3 (B8): de quién son los ingresos que ve el rol. Mismo dominio
 * que `RevenueScopeKind` de `lib/dashboard-revenue.ts`, repetido acá como unión
 * literal para no arrastrar ese módulo (y `datetime-ar`) al bundle de cada
 * pantalla que lee preferencias; `tsc` chequea que coincidan donde se cruzan
 * (`DashboardData.revenueScope` → props de los pickers).
 */
export type KpiRevenueScope = "tenant" | "own" | "none";

/**
 * Las opciones del selector de KPIs fijados según el scope de ingresos.
 *   - `tenant` (billing.manage): la lista de siempre, sin cambios.
 *   - `own` (PRACTITIONER): la KPI se rotula "Tus ingresos del mes", igual que
 *     la tarjeta fijada del dashboard (antes el picker decía "Ingresos del mes"
 *     y la KPI otra cosa).
 *   - `none` (Secretaria): sin la opción. Antes la podía fijar y la KPI nunca se
 *     dibujaba: si fijaba solo esa, la fila quedaba vacía.
 * El server (`updateUserPreferences`) sigue aceptando la clave para cualquier
 * rol: es una preferencia de pantalla, no un dato; lo que filtra la plata es
 * `revenueScopeFor` en `lib/dashboard.ts`.
 */
export function kpiOptionsFor(scope: KpiRevenueScope): typeof KPI_OPTIONS {
  if (scope === "tenant") return KPI_OPTIONS;
  if (scope === "none") return KPI_OPTIONS.filter((o) => o.key !== "monthRevenue");
  return KPI_OPTIONS.map((o) => (o.key === "monthRevenue" ? { ...o, label: "Tus ingresos del mes" } : o));
}

/**
 * El borrador inicial del picker: lo fijado que el rol puede ver. Una KPI
 * oculta (ingresos para la Secretaria) no cuenta para el "N de 6" ni se
 * re-guarda: al guardar desde el picker se cae, porque ese rol nunca la ve.
 */
export function pinnableKpis(pinned: readonly KpiKey[], scope: KpiRevenueScope): KpiKey[] {
  const keys = new Set(kpiOptionsFor(scope).map((o) => o.key));
  return pinned.filter((k) => keys.has(k));
}

// ─────────────────────────────────────────────────────────────────────────────
// Agenda multi-profesional (B4.2 AG-resource) — `UserPreferences.agendaPrefs`
//
// Blob JSON por usuario (mismo patrón que `catalogPrefs`: agregar un campo no
// pide migración). Se llama `AgendaViewPrefs` porque `AgendaPrefs` ya es el
// slice de los toggles de la semana (Sprint 18) que usa el panel de Tweaks.
//
// Dos caminos con zod, a propósito distintos:
//   • LECTURA (`sanitizeAgendaViewPrefs`): total, nunca tira. Cada campo cae a
//     su default por separado (`.catch`), así un blob viejo o editado a mano
//     con un zoom inválido no le borra los favoritos a la secretaria.
//   • ESCRITURA (`AgendaViewPrefsPatchSchema`): estricta. Un patch con un
//     valor fuera de dominio se rechaza con error; no se "corrige" en silencio.
// Los ids (favoritos, sede) son preferencia de pantalla, no FKs: no se validan
// contra el tenant al guardar porque no escriben datos de dominio; al leer, la
// UI los cruza con la lista visible (`practitionerOrder` ignora los ajenos y
// un `locationId` que no está en las sedes del tenant se trata como "todas").
//
// SR-U3 (salas): `mode: "room"` (Día "Por sala") y `roomId` (filtro de sala).
// `roomId` es igual que `locationId`: preferencia de pantalla, no FK. Una sala
// ajena, archivada o de otra sede se trata como "todas" al leer contra el
// catálogo del bootstrap (`effectiveRoomFilter` en lib/agenda-client-state).
// Null (= todas) NO se guarda en el blob: se omite. Así un consultorio sin
// salas tiene exactamente las mismas prefs que antes de SR (no regresión, y los
// tests de B4.2 quedan sin cambios). "none" = el filtro "Sin sala".
// D2: cambiar de sede limpia la sala (`mergeAgendaViewPrefs`), porque una sala
// es de UNA sede; si no, al volver a "Todas las sedes" quedaría filtrando una
// sala que no se ve en el selector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Por día" (vistas de siempre) ↔ "Por profesional" (columnas = profesionales)
 * ↔ "Por sala" (columnas = salas de la sede; SR-U3, solo con ≥1 sala activa).
 */
export type AgendaMode = "day" | "practitioner" | "room";
export const AGENDA_MODES: ReadonlyArray<AgendaMode> = ["day", "practitioner", "room"];
const modeSchema = z.enum(["day", "practitioner", "room"]);
/** Mismo dominio que `AgendaZoom` de `lib/agenda-layout.ts` (no se importa para no
 *  arrastrar el motor al bundle de cada pantalla que lee preferencias). */
export type AgendaViewZoom = 15 | 30 | 60;
export const AGENDA_VIEW_ZOOMS: ReadonlyArray<AgendaViewZoom> = [15, 30, 60];
export type AgendaViewDensity = "comfortable" | "compact";
/** Tope de favoritos guardados (un consultorio grande ronda los 10-15). */
export const AGENDA_MAX_FAVORITES = 50;
const ID_MAX = 64;

export type AgendaViewPrefs = {
  mode: AgendaMode;
  zoom: AgendaViewZoom;
  density: AgendaViewDensity;
  /** En orden: los favoritos van primero en columnas y chips. */
  favoritePractitionerIds: string[];
  /** Filtro de sede; null = todas. */
  locationId: string | null;
  /**
   * Filtro de sala (SR-U3): un id, "none" (= Sin sala) o ausente/null (=
   * todas). Se omite del objeto cuando es "todas" (ver arriba).
   */
  roomId?: string | null;
};

export const DEFAULT_AGENDA_VIEW_PREFS: AgendaViewPrefs = {
  mode: "day",
  zoom: 30,
  density: "comfortable",
  favoritePractitionerIds: [],
  locationId: null,
};

const zoomSchema = z.union([z.literal(15), z.literal(30), z.literal(60)]);
const idSchema = z.string().trim().min(1).max(ID_MAX);

/** Lista de ids → strings válidos, sin duplicados, en orden, con tope. */
function cleanIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const r = idSchema.safeParse(x);
    if (r.success && !out.includes(r.data)) out.push(r.data);
    if (out.length >= AGENDA_MAX_FAVORITES) break;
  }
  return out;
}

/**
 * Lectura: blob no confiable (DB) → `AgendaViewPrefs` válido. Total y por
 * campo. `defaults` permite que el caller ponga su propio default (p. ej. el
 * zoom = `Tenant.agendaSlotMinutes` cuando el usuario nunca eligió uno).
 */
export function sanitizeAgendaViewPrefs(
  raw: unknown,
  defaults: AgendaViewPrefs = DEFAULT_AGENDA_VIEW_PREFS
): AgendaViewPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const schema = z.object({
    mode: modeSchema.catch(defaults.mode),
    zoom: zoomSchema.catch(defaults.zoom),
    density: z.enum(["comfortable", "compact"]).catch(defaults.density),
    favoritePractitionerIds: z.unknown().transform(cleanIds),
    locationId: idSchema.nullable().catch(defaults.locationId),
  });
  const parsed = schema.parse({
    ...o,
    // Campo ausente = default del caller (no `[]`/null forzado).
    favoritePractitionerIds: "favoritePractitionerIds" in o ? o.favoritePractitionerIds : defaults.favoritePractitionerIds,
    locationId: "locationId" in o ? o.locationId : defaults.locationId,
  });
  // `roomId` fuera del schema de arriba: null/ausente/inválido = todas = se omite.
  const room = idSchema.safeParse("roomId" in o ? o.roomId : defaults.roomId);
  return room.success ? { ...parsed, roomId: room.data } : parsed;
}

/** Escritura: patch parcial, estricto (campos desconocidos o fuera de dominio → error). */
export const AgendaViewPrefsPatchSchema = z
  .object({
    mode: modeSchema,
    zoom: zoomSchema,
    density: z.enum(["comfortable", "compact"]),
    favoritePractitionerIds: z
      .array(idSchema)
      .max(AGENDA_MAX_FAVORITES)
      .transform((ids) => Array.from(new Set(ids))),
    locationId: idSchema.nullable(),
    roomId: idSchema.nullable(),
  })
  .partial()
  .strict();
export type AgendaViewPrefsPatch = z.input<typeof AgendaViewPrefsPatchSchema>;

/** Merge puro de un patch YA validado sobre las prefs actuales. */
export function mergeAgendaViewPrefs(
  current: AgendaViewPrefs,
  patch: z.output<typeof AgendaViewPrefsPatchSchema>
): AgendaViewPrefs {
  const next: Record<string, unknown> = { ...current, ...patch };
  // D2: la sala es de una sede. Un patch que cambia la sede sin traer sala la limpia.
  const locationChanged =
    patch.locationId !== undefined && (patch.locationId ?? null) !== (current.locationId ?? null);
  if (locationChanged && patch.roomId === undefined) delete next.roomId;
  return sanitizeAgendaViewPrefs(next);
}

/** Marca/desmarca un profesional como favorito (puro; el nuevo va al final). */
export function toggleFavoritePractitioner(ids: ReadonlyArray<string>, practitionerId: string): string[] {
  return ids.includes(practitionerId)
    ? ids.filter((id) => id !== practitionerId)
    : [...ids, practitionerId].slice(0, AGENDA_MAX_FAVORITES);
}

export const DEFAULT_PREFERENCES: Preferences = {
  palette: "sky",
  pinnedKpis: ["activePatients", "weekSessions", "activePrograms"],
  sidebarCollapsed: false,
  agendaShowWeekHeader: true,
  agendaShowSaturday: true,
  agendaShowSunday: true,
  catalogPrefs: DEFAULT_CATALOG_PREFS,
  agendaView: DEFAULT_AGENDA_VIEW_PREFS,
  dashboard: DEFAULT_DASHBOARD_PREFS,
};
