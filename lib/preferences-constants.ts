/**
 * Per-user preference shapes + constants — pure, client-safe.
 *
 * Lives separate from `lib/preferences.ts` (which has `"use server"`) so
 * client components can import the types and the KPI option list without
 * dragging in the server-only Prisma path.
 */
import type { TenantModule } from "@/lib/tenant-modules";

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
// PF1-Z (D-PF5): los zod de este bloque (`RevenueRangeSchema`, `DashboardPrefsPatchSchema`) viven en
// `lib/preferences-schemas.ts` (server-only). Este archivo lo importan el shell, el tablero, la sala y la agenda por
// sus tipos y `KPI_OPTIONS`, y con zod adentro arrastraba ~13 kB gz de zod al JS inicial de esas rutas.

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
  // TS puro (antes `z.object({ revenueRange: RevenueRangeSchema.catch(default) }).parse(o)`): misma semántica, valor
  // fuera de dominio o ausente → default y claves extra descartadas.
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const r = o.revenueRange;
  return { revenueRange: REVENUE_RANGES.includes(r as RevenueRange) ? (r as RevenueRange) : DEFAULT_DASHBOARD_PREFS.revenueRange };
}

/** Escritura: patch parcial, estricto. El schema es `DashboardPrefsPatchSchema` de `lib/preferences-schemas.ts`. */
export type DashboardPrefsPatch = { revenueRange?: RevenueRange };

// ─────────────────────────────────────────────────────────────────────────────
// Platform catalog table (Plataforma → Ejercicios)
// ─────────────────────────────────────────────────────────────────────────────

// EV1 (integrador): sin `tier` (Común/Pro). Desde EV0 `Exercise.isBasic` no decide nada (`catalogScope` en
// lib/plan-gating.ts) y EV1-D lo sacó de la tabla; una URL o pref vieja con `tier` cae al default en
// `sanitizeCatalogPrefs` (orden → «name», filtro → se descarta).
export type CatalogSortCol = "name" | "difficulty" | "kind" | "createdAt";
export type CatalogSortDir = "asc" | "desc";
/** Which slice of the catalog the table shows. */
export type CatalogArchived = "active" | "archived" | "all";

export type CatalogFilters = {
  q: string;
  kind: "" | "EXERCISE" | "MANUAL_THERAPY";
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
  "createdAt",
];

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  q: "",
  kind: "",
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
export function kpiOptionsFor(scope: KpiRevenueScope, modules?: KpiModules): typeof KPI_OPTIONS {
  const byScope =
    scope === "tenant"
      ? KPI_OPTIONS
      : scope === "none"
        ? KPI_OPTIONS.filter((o) => o.key !== "monthRevenue")
        : KPI_OPTIONS.map((o) => (o.key === "monthRevenue" ? { ...o, label: "Tus ingresos del mes" } : o));
  return modules ? byModules(byScope, modules) : byScope;
}

/**
 * EV1-A: lo que hace falta de los módulos del consultorio. Lo cumplen tanto el
 * `ReadonlySet<TenantModule>` del server (`modulesFor`) como el valor de
 * `useTenantModules()` en el cliente. Sin módulos (`undefined`) = la lista de
 * Kine de siempre: los callers que todavía no los pasan no cambian.
 */
export type KpiModules = { has: (m: TenantModule) => boolean };

/**
 * EV1-A: KPIs por módulo. En un consultorio sin `planes` (General) los KPIs de
 * planes valían 0 siempre ("Planes en curso", "Cerca del alta") y "Pacientes
 * activos" (= con plan ACTIVE) también: se sacan del picker. `activePatients`
 * se queda, pero en General el loader lo calcula con turnos (pacientes con un
 * turno COMPLETED en los últimos 30 días, `lib/dashboard.ts`) y se rotula así.
 * Sin `sesiones`, lo que decía "sesiones"/"adherencia" se dice con turnos: el
 * número ya salía de turnos, solo cambia el rótulo.
 */
function byModules(opts: typeof KPI_OPTIONS, modules: KpiModules): typeof KPI_OPTIONS {
  const plans = modules.has("planes");
  const sessions = modules.has("sesiones");
  return opts
    .filter((o) => plans || (o.key !== "activePrograms" && o.key !== "nearingDischarge"))
    .map((o) => {
      if (!plans && o.key === "activePatients") return { ...o, ...GENERAL_KPI_COPY.activePatients };
      if (!sessions && o.key === "weekSessions") return { ...o, ...GENERAL_KPI_COPY.weekSessions };
      if (!sessions && o.key === "adherence") return { ...o, ...GENERAL_KPI_COPY.adherence };
      return o;
    });
}

/** EV1-A: rótulos de General. Los usa también la tarjeta del dashboard (mismo texto en picker y KPI). */
export const GENERAL_KPI_COPY = {
  activePatients: { label: "Pacientes atendidos", description: "Con un turno realizado en los últimos 30 días" },
  weekSessions: { label: "Turnos esta semana", description: "Confirmados + realizados" },
  adherence: { label: "Asistencia semanal", description: "Realizados / total" },
} as const;

/** EV1-A: la fila por defecto de un consultorio sin `planes` (la de Kine trae dos KPIs de planes). */
export const GENERAL_DEFAULT_PINNED_KPIS: KpiKey[] = ["activePatients", "weekSessions", "todayCount"];

/**
 * EV1-A: lo que se DIBUJA en la fila de KPIs fijados. Las claves guardadas que
 * no aplican (ingresos sin acceso, planes en General) se ignoran al render; la
 * preferencia guardada no se toca (si el consultorio vuelve a Kine, reaparecen).
 * En General, si el usuario nunca eligió (la fila es la default de Kine) o no
 * le queda ninguna, se usa `GENERAL_DEFAULT_PINNED_KPIS`: la default de Kine
 * dejaba una sola tarjeta.
 */
export function effectivePinnedKpis(
  pinned: readonly KpiKey[],
  scope: KpiRevenueScope,
  modules?: KpiModules
): KpiKey[] {
  const keep = pinnableKpis(pinned, scope, modules);
  if (!modules || modules.has("planes")) return keep;
  const isKineDefault =
    pinned.length === DEFAULT_PREFERENCES.pinnedKpis.length &&
    pinned.every((k, i) => k === DEFAULT_PREFERENCES.pinnedKpis[i]);
  if (!isKineDefault && keep.length > 0) return keep;
  return pinnableKpis(GENERAL_DEFAULT_PINNED_KPIS, scope, modules);
}

/**
 * El borrador inicial del picker: lo fijado que el rol puede ver. Una KPI
 * oculta (ingresos para la Secretaria) no cuenta para el "N de 6" ni se
 * re-guarda: al guardar desde el picker se cae, porque ese rol nunca la ve.
 */
export function pinnableKpis(pinned: readonly KpiKey[], scope: KpiRevenueScope, modules?: KpiModules): KpiKey[] {
  const keys = new Set(kpiOptionsFor(scope, modules).map((o) => o.key));
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
//
// SV (C-SV9): avisos de la Sala de Espera y agrupación de `/sala`, por usuario.
// `arrivalAlert` («Cuando llega un paciente mío») y `callAlert` («Cuando un
// profesional llama a un paciente»): default "visual" PARA TODOS (SV-D4
// enmendada: el sonido arranca apagado y cada usuario lo prende; un chime que
// suena sin que nadie lo pidiera en un consultorio con pacientes es peor que un
// toast). `salaGroupBy`: control «Por profesional | Por sala» de `/sala`
// (SV-D13), default profesional. Mismo patrón que el resto: sanitize total
// (inválido → default) y patch estricto.
//
// RX (brief RX §3, C-RX1): `receptionLayout` = qué cara muestra `/sala`
// («Tablero» de SV10a, A «Lista y panel» o B «Flujo»), elegida en Apariencia.
// Va acá y no en el localStorage de Tweaks porque `/sala` se renderiza en SSR
// (el primer paint sale con la cara correcta, sin flash) y la PC de recepción
// es compartida: la cara sigue al usuario. Default "board" para todos (RX-D2:
// queda «detrás de un flag» y nadie ve un cambio sin elegirlo). Cuando Martin
// elija una cara y se borre otra, se saca del enum y el sanitize lleva lo
// guardado a "board" (o al default que pase el caller).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Por día" (vistas de siempre) ↔ "Por profesional" (columnas = profesionales)
 * ↔ "Por sala" (columnas = salas de la sede; SR-U3, solo con ≥1 sala activa).
 */
export type AgendaMode = "day" | "practitioner" | "room";
export const AGENDA_MODES: ReadonlyArray<AgendaMode> = ["day", "practitioner", "room"];
/** Mismo dominio que `AgendaZoom` de `lib/agenda-layout.ts` (no se importa para no
 *  arrastrar el motor al bundle de cada pantalla que lee preferencias). */
export type AgendaViewZoom = 15 | 30 | 60;
export const AGENDA_VIEW_ZOOMS: ReadonlyArray<AgendaViewZoom> = [15, 30, 60];
export type AgendaViewDensity = "comfortable" | "compact";
/** SV: "visual" = toast; "sound" = toast + chime; "off" = nada. */
export type AlertMode = "visual" | "sound" | "off";
export const ALERT_MODES: ReadonlyArray<AlertMode> = ["visual", "sound", "off"];
/** SV-D13: columnas de `/sala` por profesional o por sala. */
export type SalaGroupBy = "practitioner" | "room";
export const SALA_GROUP_BYS: ReadonlyArray<SalaGroupBy> = ["practitioner", "room"];
/** RX: cara de /sala. "board" = columnas (SV10a), "list" = A · Lista y panel, "flow" = B · Flujo. */
export type ReceptionLayout = "board" | "list" | "flow";
export const RECEPTION_LAYOUTS: ReadonlyArray<ReceptionLayout> = ["board", "list", "flow"];
/** Tope de favoritos guardados (un consultorio grande ronda los 10-15). */
export const AGENDA_MAX_FAVORITES = 50;
export const AGENDA_PREF_ID_MAX = 64;

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
  /** SV: aviso cuando llega un paciente del usuario (si tiene `practitionerId`). */
  arrivalAlert: AlertMode;
  /** SV: aviso cuando un profesional llama a un paciente (si tiene `agenda.operateAll`). */
  callAlert: AlertMode;
  /** SV-D13: agrupación de `/sala`. */
  salaGroupBy: SalaGroupBy;
  /** RX: cara de `/sala` (Apariencia → «Recepción»). */
  receptionLayout: ReceptionLayout;
};

export const DEFAULT_AGENDA_VIEW_PREFS: AgendaViewPrefs = {
  mode: "day",
  zoom: 30,
  density: "comfortable",
  favoritePractitionerIds: [],
  locationId: null,
  arrivalAlert: "visual",
  callAlert: "visual",
  salaGroupBy: "practitioner",
  receptionLayout: "board",
};

// PF1-Z (D-PF5): la lectura total (`sanitizeAgendaViewPrefs`), el patch estricto (`AgendaViewPrefsPatchSchema`) y
// el merge (`mergeAgendaViewPrefs`) viven en `lib/preferences-schemas.ts` (server-only): usan zod y este archivo lo
// importan el shell, la sala y la agenda por sus tipos y constantes. Los consume solo `lib/preferences.ts`.

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
