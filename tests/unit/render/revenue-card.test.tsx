/**
 * S14r (ES3) · widget de ingresos del dashboard. Se monta el componente real
 * con `renderToStaticMarkup`; se mockean solo las actions y el toast.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/dashboard", () => ({
  getRevenue: vi.fn(),
  getSessionsChart: vi.fn(async () => []),
  getMonthBookingDays: vi.fn(async () => []),
}));
vi.mock("@/lib/preferences", () => ({ updateDashboardPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
// PL-Z: el menú de perfil monta el switch del propio turnero (server action: red).
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: { enabled: true } }) }));
// SR-D5I: el screen completo monta la campana, el menú de perfil y los
// recientes; se mockean sus server actions (red) y el router de Next.
vi.mock("@/lib/notifications", () => ({
  dismissReminder: vi.fn(),
  restoreReminder: vi.fn(),
  listNotifications: vi.fn(async () => []),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingStatus: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { RevenueCard, revenueCardView, revenueRangeAfterFetch, revenueShown } from "@/components/dashboard/revenue-card";
import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { DashboardData } from "@/lib/dashboard";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import { summarizeRevenue } from "@/lib/dashboard-revenue";
import { formatARS } from "@/lib/format";

const week = summarizeRevenue(
  "week",
  { mpCents: 1_000_000, manualCents: 500_000, insurerCents: 300_000 },
  { mpCents: 1_000_000, manualCents: 0 }
);
const month = summarizeRevenue(
  "month",
  { mpCents: 4_000_000, manualCents: 2_000_000, insurerCents: 900_000 },
  { mpCents: 0, manualCents: 0 }
);

describe("RevenueCard", () => {
  it("arranca en el período guardado: título, total (MP + copagos) y OS aparte", () => {
    const html = renderToStaticMarkup(<RevenueCard initial={week} month={month} />);
    expect(html).toContain("Ingresos de la semana");
    expect(html).toContain(formatARS(1_500_000));
    expect(html).toContain(`Obras sociales · ${formatARS(300_000)}`);
    // El selector marca el período elegido (a11y: aria-pressed).
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Semana/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Mes/);
  });

  it("mes guardado: 'Ingresos del mes' y sin delta si el anterior fue 0", () => {
    const html = renderToStaticMarkup(<RevenueCard initial={month} month={month} />);
    expect(html).toContain("Ingresos del mes");
    expect(revenueCardView(month).delta).toBeNull();
  });

  it("delta con su período en el label accesible", () => {
    const v = revenueCardView(week);
    expect(v.delta).toEqual({ up: true, text: "+50%", label: "+50% vs. la semana pasada" });
    expect(v.breakdown).toBe(`Copagos ${formatARS(500_000)} · Mercado Pago ${formatARS(1_000_000)}`);
  });

  it("[P3-F3a] mientras carga el período nuevo, el título es el del número que se ve (no el del botón)", () => {
    // Se eligió Semana y todavía solo está el mes: se muestra el mes con SU título.
    const shown = revenueShown({ month }, "week", month);
    expect(shown).toBe(month);
    expect(revenueCardView(shown).title).toBe("Ingresos del mes");
    expect(revenueCardView(revenueShown({ month, week }, "week", month)).title).toBe("Ingresos de la semana");
  });

  it("[P3-F3a] si la lectura falla (error o excepción) el selector vuelve al período anterior", () => {
    expect(revenueRangeAfterFetch("month", "week", { ok: true })).toBe("week");
    expect(revenueRangeAfterFetch("month", "week", { ok: false })).toBe("month");
    expect(revenueRangeAfterFetch("week", "month", null)).toBe("week"); // excepción de red
  });
});

describe("[SR-D5I] ingresos por rol en el dashboard", () => {
  function data(over: Partial<DashboardData>): DashboardData {
    return {
      greetingName: "Ana",
      todayCount: 3,
      weeklyBars: [],
      pinned: {
        activePatients: 1,
        weekSessions: 2,
        activePrograms: 1,
        adherencePct: 90,
        newPatientsMonth: 0,
        nearingDischarge: 0,
      },
      pinnedKpis: ["todayCount", "monthRevenue"],
      recent: [],
      next: [],
      monthRevenue: month,
      revenue: week,
      revenueScope: "tenant",
      reminderDismissed: true,
      reminderKey: "near-discharge:2026-W41",
      ownPublicBooking: null,
      ...over,
    };
  }
  const screen = (d: DashboardData) =>
    renderToStaticMarkup(
      <TweaksProvider>
        <ConfirmProvider>
          <DashboardScreen data={d} preferences={DEFAULT_PREFERENCES} initialBookingDays={[]} />
        </ConfirmProvider>
      </TweaksProvider>
    );

  it("con scope propio, el widget dice 'Tus ingresos de la semana' y la KPI 'Tus ingresos del mes'", () => {
    expect(revenueCardView(week, "own").title).toBe("Tus ingresos de la semana");
    expect(renderToStaticMarkup(<RevenueCard initial={month} month={month} scope="own" />)).toContain(
      "Tus ingresos del mes"
    );
    const html = screen(data({ revenueScope: "own" }));
    expect(html).toContain("Tus ingresos de la semana");
    expect(html).toContain("Tus ingresos del mes");
    expect(html).toContain(formatARS(6_000_000));
  });

  it("consultorio (billing.manage): títulos de siempre", () => {
    const html = screen(data({}));
    expect(html).toContain("Ingresos de la semana");
    expect(html).toContain(">Ingresos del mes<");
    expect(html).not.toContain("Tus ingresos");
  });

  it("sin ingresos (Secretaria): ni widget ni KPI, aunque la KPI esté fijada", () => {
    const html = screen(data({ monthRevenue: null, revenue: null, revenueScope: "none" }));
    expect(html).not.toContain("ngresos");
    expect(html).not.toContain("Período de los ingresos");
    expect(html).not.toContain(formatARS(6_000_000));
    // Las otras KPIs fijadas siguen.
    expect(html).toContain("Turnos hoy");
  });
});
