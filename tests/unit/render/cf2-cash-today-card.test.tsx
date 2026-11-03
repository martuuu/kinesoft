/**
 * [CF2-PD-R] Tarjeta «Cobrado hoy» del Inicio de la Secretaria (CF2 · P.2, sesión P-D; D-CF2-17). Se monta el
 * `CashTodayCard` REAL (y el `DashboardScreen` real para el slot y el recordatorio); se mockean solo las server
 * actions (red), el router y Tweaks. Montos en centavos con `formatARS`, hora en AR con el host en UTC.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/dashboard", () => ({
  getSessionsChart: vi.fn(),
  getMonthBookingDays: vi.fn(),
  getRevenue: vi.fn(),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: vi.fn(), updateDashboardPrefs: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  dismissReminder: vi.fn(),
  restoreReminder: vi.fn(),
  listNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingStatus: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ t: { dashChrome: "sidebar", palette: "sky" }, set: () => {} }),
}));
vi.mock("@/components/global/profile-menu", () => ({
  ProfileMenu: () => null,
  SettingsModalLazy: () => null,
  preloadSettingsModal: () => {},
}));

import { CashTodayCard, cashTodayCardView } from "@/components/dashboard/cash-today-card";
import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import { formatARS } from "@/lib/format";
import type { DashboardCashToday, DashboardData } from "@/lib/dashboard";

// 17:42 AR = 20:42 UTC: la hora tiene que salir en AR aunque el host esté en UTC.
const AT = "2026-10-20T20:42:00.000Z";

const summary: DashboardCashToday = {
  rows: [
    { practitionerId: "a", practitionerName: "Ana Principal", grossCents: 0, givenCents: 0, receivedCents: 577_502, netCents: 577_502, givenTo: [] },
    {
      practitionerId: "b",
      practitionerName: "Bruno Junior",
      grossCents: 2_650_005,
      givenCents: 577_502,
      receivedCents: 0,
      netCents: 2_072_503,
      givenTo: [{ practitionerId: "a", practitionerName: "Ana Principal", cents: 577_502 }],
    },
    { practitionerId: "c", practitionerName: "Carla Tercera", grossCents: 600_000, givenCents: 0, receivedCents: 0, netCents: 600_000, givenTo: [] },
  ],
  totalCents: 3_250_005,
  computedAt: AT,
};

const html = (s: DashboardCashToday) => renderToStaticMarkup(<CashTodayCard summary={s} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** `formatARS` usa espacio duro; `text` lo normaliza, así que el esperado también. */
const ars = (c: number) => formatARS(c).replace(/\s+/g, " ");

describe("[CF2-PD-R] CashTodayCard", () => {
  it("[CF2-PD-R1] por profesional: total y «Destina $X a …»; total del día, hora AR y «Ver caja»", () => {
    const out = text(html(summary));
    expect(out).toContain("Cobrado hoy");
    expect(out).toContain(`Bruno Junior ${ars(2_650_005)}`);
    expect(out).toContain(`Destina ${ars(577_502)} a Ana Principal`);
    expect(out).toContain(`Recibe ${ars(577_502)}`);
    expect(out).toContain(`Carla Tercera ${ars(600_000)}`);
    expect(out).toContain(`Total del día ${ars(3_250_005)}`);
    expect(out).toContain("Actualizado a las 17:42");
    expect(html(summary)).toMatch(/<a[^>]+href="\/caja"[^>]*>[^<]*Ver caja/);
    // Carla no destina ni recibe: sin línea de reparto.
    expect(cashTodayCardView(summary).rows.find((r) => r.id === "c")).toMatchObject({ given: null, received: null });
  });

  it("[CF2-PD-R2] varios destinatarios se listan con «y»", () => {
    const v = cashTodayCardView({
      ...summary,
      rows: [
        {
          ...summary.rows[1],
          givenTo: [
            { practitionerId: "a", practitionerName: "Ana Principal", cents: 300_000 },
            { practitionerId: "c", practitionerName: "Carla Tercera", cents: 277_502 },
          ],
        },
      ],
    });
    expect(v.rows[0].given).toBe(`Destina ${formatARS(577_502)} a Ana Principal y Carla Tercera`);
  });

  it("[CF2-PD-R3] sin cobros: «Todavía no hay cobros registrados hoy» (ZB-13, igual que /caja), con total $0 y «Ver caja»", () => {
    const out = text(html({ rows: [], totalCents: 0, computedAt: AT }));
    expect(out).toContain("Todavía no hay cobros registrados hoy.");
    expect(out).not.toContain("Destina");
    expect(out).toContain("Ver caja");
  });
});

describe("[CF2-PD-R] DashboardScreen", () => {
  const data: DashboardData = {
    greetingName: "Sofía",
    todayCount: 2,
    weeklyBars: ["L", "M", "M", "J", "V", "S", "D"].map((d) => ({ d, c: 0, a: 0 })),
    pinned: { activePatients: 1, weekSessions: 0, activePrograms: 0, adherencePct: null, newPatientsMonth: 0, nearingDischarge: 2 },
    pinnedKpis: DEFAULT_PREFERENCES.pinnedKpis,
    recent: [],
    next: [],
    monthRevenue: null,
    revenue: null,
    revenueScope: "none",
    cashToday: summary,
    reminderDismissed: false,
    reminderKey: "near-discharge:2026-W43",
    ownPublicBooking: null,
  };
  const screen = (d: DashboardData) =>
    renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <DashboardScreen data={d} preferences={DEFAULT_PREFERENCES} initialBookingDays={[]} />
        </ConfirmProvider>
      </ToastProvider>
    );

  it("[CF2-PD-R4] la Secretaria ve la tarjeta (y no el widget de Ingresos); sin cashToday no se monta", () => {
    const withCard = text(screen(data));
    expect(withCard).toContain("Cobrado hoy");
    expect(withCard).not.toContain("Ingresos del");
    expect(text(screen({ ...data, cashToday: null }))).not.toContain("Cobrado hoy");
  });

  it("[CF2-PD-R5] el recordatorio de altas lleva a /planes con «Revisar planes»", () => {
    const h = screen(data);
    expect(h).toMatch(/<a[^>]+href="\/planes"[^>]*>[^<]*Revisar planes/);
    expect(text(h)).not.toContain("Revisar pacientes");
  });
});
