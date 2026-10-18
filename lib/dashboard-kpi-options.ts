/**
 * T3a-0z1: opciones, rótulos y reglas de los KPIs fijados del tablero — puro, client-safe.
 *
 * Por qué un módulo aparte: vivían en `lib/preferences-constants.ts`, que `/agenda` importa por sus prefs de vista
 * (`AgendaViewPrefs`, defaults). Webpack no sacude por export dentro de un módulo compartido por el chunk de la
 * página, así que la agenda cargaba este copy y estas funciones sin usarlos (con `/agenda` en 178,1/180 kB gz).
 * Lo consumen solo el tablero, el selector de KPIs, «Ajustes» y `lib/preferences.ts` (server).
 * NO re-exportar desde `preferences-constants.ts`: el re-export lo vuelve a meter en `/agenda`.
 */
import type { TenantModule } from "@/lib/tenant-modules";
import { DEFAULT_PREFERENCES, type KpiKey } from "@/lib/preferences-constants";
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
