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
};

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
};
