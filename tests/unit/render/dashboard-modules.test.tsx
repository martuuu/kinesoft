/**
 * [EV1-A] Dashboard por módulos.
 *
 * En un consultorio General (sin `planes` ni `sesiones`) el dashboard mostraba
 * cosas de Kine: "Hola, Lic.", "Hoy tenés N sesiones", el recordatorio "N
 * pacientes terminan su plan esta semana" con la foto "kine c/paciente", KPIs de
 * planes que valían 0 siempre y "Últimas sesiones registradas" vacía. Se monta
 * el `DashboardScreen` REAL con `TenantModulesProvider` (General y Kine); se
 * mockean solo las server actions (red), el router y Tweaks.
 *
 * Kine es el golden: con el default del contexto (Kine PRO, sin provider) y con
 * el provider de Kine el render es el de siempre.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
// El menú de perfil no es de esta sesión (su picker va como handoff); se
// reemplaza para no arrastrar el selector de consultorio.
// PL-Z (FX4): el mock guarda las props para verificar que el dashboard le pasa `ownPublicBooking` (el switch del
// propio turnero; el render del switch lo cubre `plz-fx4-account.test.tsx`).
const { profileMenuProps } = vi.hoisted(() => ({ profileMenuProps: [] as Record<string, unknown>[] }));
vi.mock("@/components/global/profile-menu", () => ({
  ProfileMenu: (p: Record<string, unknown>) => {
    profileMenuProps.push(p);
    return null;
  },
  SettingsModalLazy: () => null,
  preloadSettingsModal: () => {},
}));

import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { PinKpiModal } from "@/components/dashboard/pin-kpi-modal";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";
import {
  DEFAULT_PREFERENCES,
  GENERAL_DEFAULT_PINNED_KPIS,
  KPI_OPTIONS,
  effectivePinnedKpis,
  kpiOptionsFor,
  pinnableKpis,
  type KpiKey,
} from "@/lib/preferences-constants";
import type { DashboardData } from "@/lib/dashboard";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false });
const KINE_FREE = modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false });

const data: DashboardData = {
  greetingName: "Martina",
  todayCount: 3,
  weeklyBars: ["L", "M", "M", "J", "V", "S", "D"].map((d, i) => ({ d, c: i, a: 0 })),
  pinned: {
    activePatients: 7,
    weekSessions: 21,
    activePrograms: 4,
    adherencePct: 90,
    newPatientsMonth: 2,
    nearingDischarge: 1,
  },
  pinnedKpis: DEFAULT_PREFERENCES.pinnedKpis,
  recent: [],
  next: [{ id: "b1", time: "10:00", name: "Ana Pérez", tag: "Consulta" }],
  monthRevenue: null,
  revenue: null,
  revenueScope: "none",
  reminderDismissed: false,
  reminderKey: "near-discharge:2026-W42",
  ownPublicBooking: null,
};

function screen(modules: ReadonlySet<TenantModule> | null, d: DashboardData = data) {
  const tree: ReactNode = (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardScreen data={d} preferences={DEFAULT_PREFERENCES} initialBookingDays={[]} />
      </ConfirmProvider>
    </ToastProvider>
  );
  return renderToStaticMarkup(
    modules ? <TenantModulesProvider modules={Array.from(modules)}>{tree}</TenantModulesProvider> : tree
  );
}

describe("kpiOptionsFor / pinnableKpis / effectivePinnedKpis con módulos (puros)", () => {
  it("sin módulos o con Kine: la lista de siempre", () => {
    expect(kpiOptionsFor("tenant")).toEqual(KPI_OPTIONS);
    expect(kpiOptionsFor("tenant", KINE_FREE)).toEqual(KPI_OPTIONS);
  });

  it("General: sin KPIs de planes y rotuladas con turnos", () => {
    const opts = kpiOptionsFor("tenant", GENERAL);
    const keys = opts.map((o) => o.key);
    expect(keys).not.toContain("activePrograms");
    expect(keys).not.toContain("nearingDischarge");
    expect(opts.find((o) => o.key === "activePatients")?.label).toBe("Pacientes atendidos");
    expect(opts.find((o) => o.key === "weekSessions")?.label).toBe("Turnos esta semana");
    expect(opts.find((o) => o.key === "adherence")?.label).toBe("Asistencia semanal");
    const text = JSON.stringify(opts).toLowerCase();
    expect(text).not.toMatch(/plan|sesi|cerca del alta|programs/);
  });

  it("General + Secretaria: se combinan los dos filtros", () => {
    const keys = kpiOptionsFor("none", GENERAL).map((o) => o.key);
    expect(keys).not.toContain("monthRevenue");
    expect(keys).not.toContain("activePrograms");
  });

  it("pinnableKpis saca del borrador las de planes en General", () => {
    const pinned: KpiKey[] = ["activePrograms", "todayCount", "nearingDischarge"];
    expect(pinnableKpis(pinned, "tenant", GENERAL)).toEqual(["todayCount"]);
    expect(pinnableKpis(pinned, "tenant", KINE_FREE)).toEqual(pinned);
  });

  it("effectivePinnedKpis: la default de Kine en General pasa a la default de General", () => {
    expect(effectivePinnedKpis(DEFAULT_PREFERENCES.pinnedKpis, "tenant", GENERAL)).toEqual(
      GENERAL_DEFAULT_PINNED_KPIS
    );
    // Kine no cambia.
    expect(effectivePinnedKpis(DEFAULT_PREFERENCES.pinnedKpis, "tenant", KINE_FREE)).toEqual(
      DEFAULT_PREFERENCES.pinnedKpis
    );
  });

  it("effectivePinnedKpis: una elección propia se respeta (sin las que no aplican); vacía → default", () => {
    expect(effectivePinnedKpis(["monthRevenue", "nearingDischarge"], "tenant", GENERAL)).toEqual(["monthRevenue"]);
    // Solo planes guardados → no queda nada → default de General.
    expect(effectivePinnedKpis(["activePrograms", "nearingDischarge"], "tenant", GENERAL)).toEqual(
      GENERAL_DEFAULT_PINNED_KPIS
    );
    // Secretaria en General con solo ingresos guardado: la default sin ingresos.
    expect(effectivePinnedKpis(["monthRevenue"], "none", GENERAL)).toEqual(GENERAL_DEFAULT_PINNED_KPIS);
  });
});

describe("DashboardScreen · General", () => {
  const html = screen(GENERAL);
  // Copy visible (sin atributos ni estilos: "kine" no tiene que aparecer como texto).
  const text = html.replace(/<[^>]+>/g, " ");

  it("saludo sin 'Lic.' y 'Hoy tenés N turnos agendados'", () => {
    expect(text).toContain("Hola, Martina");
    expect(text).not.toContain("Lic.");
    expect(text).toMatch(/Hoy tenés\s+3\s+turnos\s+agendados/);
    expect(text).toContain("Buscar paciente…");
  });

  it("sin recordatorio de planes ni foto 'kine'", () => {
    expect(text).not.toContain("Recordatorio");
    expect(text).not.toContain("su plan");
    expect(html).not.toContain("kine c/paciente");
  });

  it("KPIs: la default de General, sin planes ni sesiones", () => {
    expect(text).toContain("Pacientes atendidos");
    expect(text).toContain("Últimos 30 días");
    expect(text).toContain("Turnos esta semana");
    expect(text).toContain("90% asistencia");
    expect(text).toContain("Turnos hoy");
    expect(text).not.toContain("Planes en curso");
    expect(text).not.toContain("Cerca del alta");
    expect(text).not.toContain("Pacientes activos");
  });

  it("gráfico 'Turnos' y sin 'Últimas sesiones registradas'", () => {
    expect(text).toMatch(/Turnos\s/);
    expect(text).toContain("realizados");
    expect(text).not.toContain("Últimas sesiones registradas");
  });

  it("ninguna palabra de Kine en el copy", () => {
    expect(text).not.toMatch(/plan\b|planes|sesi[oó]n|sesiones|kine|Lic\.|adherencia|alta\b/i);
  });
});

describe("DashboardScreen · Kine (golden)", () => {
  for (const [name, modules] of [
    ["sin provider (default Kine PRO)", null],
    ["Kine FREE", KINE_FREE],
  ] as const) {
    it(`${name}: lo de siempre`, () => {
      const text = screen(modules).replace(/<[^>]+>/g, " ");
      expect(text).toContain("Hola, Lic. Martina");
      expect(text).toMatch(/Hoy tenés\s+3\s+sesiones\s+agendadas/);
      expect(text).toContain("Buscar paciente, ejercicio…");
      expect(text).toContain("paciente termina su plan");
      expect(text).toContain("Pacientes activos");
      expect(text).toContain("Sesiones esta semana");
      expect(text).toContain("90% adherencia");
      expect(text).toContain("Planes en curso");
      expect(text).toContain("Últimas sesiones registradas");
      expect(text).toMatch(/Sesiones\s/);
      // PF1.1-dashboard (D3 de VX0-b): el placeholder «kine c/paciente» del hero se fue también en Kine.
      expect(screen(modules)).not.toContain("kine c/paciente");
    });
  }

  it("Kine con planes guardados de un vertical anterior: se dibujan (no se filtran)", () => {
    const text = screen(KINE_FREE, { ...data, pinnedKpis: ["nearingDischarge"] }).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Cerca del alta");
  });
});

describe("PinKpiModal · General", () => {
  it("no ofrece KPIs de planes y rotula con turnos", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={Array.from(GENERAL)}>
        <PinKpiModal open currentPinned={["activePrograms", "todayCount"]} onClose={() => {}} revenueScope="tenant" />
      </TenantModulesProvider>
    );
    expect(html).not.toContain("Planes en curso");
    expect(html).not.toContain("Cerca del alta");
    expect(html).toContain("Pacientes atendidos");
    expect(html).toContain("Turnos esta semana");
    // La de planes guardada no cuenta para el tope.
    expect(html).toContain("1 de 6 seleccionados");
  });
});

describe("[PL-Z FX4] menú de perfil del dashboard", () => {
  it("le pasa al ProfileMenu la ficha propia (`ownPublicBooking`) o null si no atiende", () => {
    profileMenuProps.length = 0;
    screen(null, { ...data, ownPublicBooking: { practitionerId: "pr-1", enabled: false } });
    expect(profileMenuProps.at(-1)?.ownPublicBooking).toEqual({ practitionerId: "pr-1", enabled: false });
    screen(null, data);
    expect(profileMenuProps.at(-1)?.ownPublicBooking).toBeNull();
  });
});
