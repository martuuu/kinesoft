/**
 * [PF1.1-dashboard] Textos de los indicadores fijados del tablero, puros (los prueba
 * `tests/unit/render/pf1-dashboard.test.tsx`). Antes vivían como un objeto literal adentro de `PinnedRow`.
 *
 * D4 de VX0-b («sin 100 % con denominador 0»): `getDashboardData` devuelve `adherencePct: 100` cuando la semana no
 * tiene turnos realizados ni ausentes (`totalSlots ? … : 100`, lib/dashboard.ts). Una consultora nueva veía
 * «100% adherencia» sin un solo turno. El loader es de PF2 (handoff); acá el denominador se recalcula con las barras de
 * la semana (`weeklyBars`, la misma fuente que usa el server) y sin turnos se muestra «—» y «Sin turnos esta semana».
 */
import type { KpiKey } from "@/lib/preferences-constants";
import { GENERAL_KPI_COPY } from "@/lib/preferences-constants";
import { formatARS } from "@/lib/format";
import type { DashboardData } from "@/lib/dashboard";

/** [PF-0c] Escalonado de la entrada de las tarjetas (la duración, 120 ms, está en `.kpi` de dashboard.module.css). */
export const KPI_STAGGER_MS = 15;

export type KpiIcon = "users" | "cal" | "activity" | "chart" | "heart";
export type KpiTone = "sky" | "lime" | "soft";
export type KpiView = { key: KpiKey; icon: KpiIcon; n: string; l: string; delta: string; tone: KpiTone };

/** Turnos de la semana con resultado (realizados + ausentes): el denominador de la adherencia. */
export function weekSlots(bars: DashboardData["weeklyBars"]): number {
  return bars.reduce((s, b) => s + b.c + b.a, 0);
}

/** «90%», o «—» si la semana no tiene turnos con resultado (nunca un 100 % sobre 0). */
export function adherenceText(pct: number, slots: number): string {
  return slots > 0 ? `${pct}%` : "—";
}

export function dashboardKpis(p: {
  pinned: DashboardData["pinned"];
  pinnedKpis: readonly KpiKey[];
  weeklyBars: DashboardData["weeklyBars"];
  todayCount: number;
  monthRevenue: DashboardData["monthRevenue"];
  revenueScope: DashboardData["revenueScope"];
  hasPlans: boolean;
  hasSessions: boolean;
}): KpiView[] {
  const { pinned, hasPlans, hasSessions, monthRevenue, revenueScope } = p;
  const slots = weekSlots(p.weeklyBars);
  const rate = hasSessions ? "adherencia" : "asistencia";
  const unit = (n: number) =>
    hasSessions ? (n === 1 ? "sesión" : "sesiones") : n === 1 ? "turno" : "turnos";
  // SR-D5I: sin ingresos para este rol (Secretaria) la KPI fijada no se muestra: ni un "$0" que parezca dato. La
  // preferencia guardada no se toca. EV1-A: en General `pinnedKpis` ya llega sin las de planes
  // (`effectivePinnedKpis`); acá solo cambia el rótulo de las que se quedan (mismo texto que el picker).
  const all: Record<KpiKey, Omit<KpiView, "key"> | null> = {
    activePatients: {
      icon: "users",
      n: pinned.activePatients.toString(),
      l: hasPlans ? "Pacientes activos" : GENERAL_KPI_COPY.activePatients.label,
      delta: hasPlans ? `+${pinned.newPatientsMonth} este mes` : "Últimos 30 días",
      tone: "sky",
    },
    weekSessions: {
      icon: "cal",
      n: pinned.weekSessions.toString(),
      l: hasSessions ? "Sesiones esta semana" : GENERAL_KPI_COPY.weekSessions.label,
      delta: slots > 0 ? `${pinned.adherencePct}% ${rate}` : "Sin turnos esta semana",
      tone: "lime",
    },
    activePrograms: {
      icon: "activity",
      n: pinned.activePrograms.toString(),
      l: "Planes en curso",
      delta: `${pinned.nearingDischarge} cerca del alta`,
      tone: "soft",
    },
    todayCount: {
      icon: "cal",
      n: p.todayCount.toString(),
      l: "Turnos hoy",
      // `todayCount` excluye los cancelados (lib/dashboard.ts). Antes decía «Sin cancelados», que se leía como
      // «hoy no hubo cancelaciones».
      delta: "Sin contar cancelados",
      tone: "sky",
    },
    monthRevenue: monthRevenue
      ? {
          icon: "chart",
          // S14r: MP + copagos cobrados a mano. La obra social va aparte, como en el widget.
          n: formatARS(monthRevenue.totalCents),
          l: revenueScope === "own" ? "Tus ingresos del mes" : "Ingresos del mes",
          delta: monthRevenue.insurerCents
            ? `+ ${formatARS(monthRevenue.insurerCents)} de obras sociales`
            : "MP + copagos",
          tone: "lime",
        }
      : null,
    adherence: {
      icon: "activity",
      n: adherenceText(pinned.adherencePct, slots),
      l: hasSessions ? "Adherencia semanal" : GENERAL_KPI_COPY.adherence.label,
      // EV1: concordancia de número («1 sesión», no «1 sesiones»).
      delta: slots > 0 ? `${pinned.weekSessions} ${unit(pinned.weekSessions)}` : "Sin turnos esta semana",
      tone: "lime",
    },
    nearingDischarge: {
      icon: "heart",
      n: pinned.nearingDischarge.toString(),
      l: "Cerca del alta",
      delta: "Planes a revisar",
      tone: "soft",
    },
    newPatientsMonth: {
      icon: "users",
      n: pinned.newPatientsMonth.toString(),
      l: "Pacientes nuevos",
      delta: "Este mes",
      tone: "sky",
    },
  };
  const out: KpiView[] = [];
  for (const key of p.pinnedKpis) {
    const v = all[key];
    // Sin repetidos: la key de React es la KPI (S5: antes `key={i}`).
    if (v && !out.some((o) => o.key === key)) out.push({ key, ...v });
  }
  return out.slice(0, 6);
}
