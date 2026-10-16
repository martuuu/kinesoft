/**
 * [SRZ-FX3] B8 · selector de KPIs fijados con el scope de ingresos (SR-D5I).
 *
 * Antes la Secretaria (`revenueScope: "none"`) podía fijar "Ingresos del mes"
 * desde los dos pickers (el "+ Agregar" de la fila y Ajustes del menú de
 * perfil): la KPI nunca se dibuja para ella, así que si fijaba solo esa la fila
 * quedaba vacía. Y el PRACTITIONER veía "Ingresos del mes" en el picker pero
 * "Tus ingresos del mes" en la KPI. Se montan los pickers reales con
 * `renderToStaticMarkup`; se mockean solo la action (red), el router y Tweaks.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/preferences", () => ({ updateUserPreferences: vi.fn() }));
// PL-Z: el menú de perfil monta el switch del propio turnero (server action: red).
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: { enabled: true } }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/components/layout/tweaks-context", () => ({ useTweaks: () => ({ set: () => {} }) }));

// PF1.1-dashboard: los dos pickers viven en su propio módulo (los bajan con `next/dynamic` el botón y el menú).
import { PinKpiModal } from "@/components/dashboard/pin-kpi-modal";
import { SettingsModal } from "@/components/global/settings-modal";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import {
  DEFAULT_PREFERENCES,
  KPI_OPTIONS,
  kpiOptionsFor,
  pinnableKpis,
  type KpiKey,
} from "@/lib/preferences-constants";

const pinned: KpiKey[] = ["activePatients", "monthRevenue", "todayCount"];
const noop = () => {};

const pinModal = (scope: "tenant" | "own" | "none") =>
  renderToStaticMarkup(<PinKpiModal open currentPinned={pinned} onClose={noop} revenueScope={scope} />);
const settings = (scope: "tenant" | "own" | "none") =>
  renderToStaticMarkup(
    <SettingsModal preferences={{ ...DEFAULT_PREFERENCES, pinnedKpis: pinned }} onClose={noop} revenueScope={scope} />
  );

describe("kpiOptionsFor / pinnableKpis (puros)", () => {
  it("tenant = KPI_OPTIONS sin cambios (OWNER/ADMIN/BILLING ven lo de siempre)", () => {
    expect(kpiOptionsFor("tenant")).toEqual(KPI_OPTIONS);
  });
  it("own: misma lista, ingresos rotulados 'Tus ingresos del mes'", () => {
    const opts = kpiOptionsFor("own");
    expect(opts.map((o) => o.key)).toEqual(KPI_OPTIONS.map((o) => o.key));
    expect(opts.find((o) => o.key === "monthRevenue")?.label).toBe("Tus ingresos del mes");
  });
  it("none: sin la opción de ingresos", () => {
    expect(kpiOptionsFor("none").some((o) => o.key === "monthRevenue")).toBe(false);
    expect(kpiOptionsFor("none")).toHaveLength(KPI_OPTIONS.length - 1);
  });
  it("pinnableKpis saca del borrador lo que el rol no puede ver (no cuenta para el tope de 6)", () => {
    expect(pinnableKpis(pinned, "none")).toEqual(["activePatients", "todayCount"]);
    expect(pinnableKpis(pinned, "own")).toEqual(pinned);
    expect(pinnableKpis(pinned, "tenant")).toEqual(pinned);
  });
});

describe("PinKpiModal (+ Agregar)", () => {
  it("Secretaria (none): no ofrece ingresos y el contador no cuenta la KPI oculta", () => {
    const html = pinModal("none");
    expect(html).not.toContain("Ingresos del mes");
    expect(html).not.toContain("ingresos");
    expect(html).toContain("Pacientes activos");
    expect(html).toContain("2 de 6 seleccionados");
  });
  it("PRACTITIONER (own): 'Tus ingresos del mes'", () => {
    const html = pinModal("own");
    expect(html).toContain("Tus ingresos del mes");
    expect(html).toContain("3 de 6 seleccionados");
  });
  it("tenant: 'Ingresos del mes' como siempre", () => {
    const html = pinModal("tenant");
    expect(html).toContain("Ingresos del mes");
    expect(html).not.toContain("Tus ingresos");
  });
});

describe("SettingsModal (Ajustes del menú de perfil)", () => {
  // EV1-A: el picker de Ajustes usa los módulos del consultorio, igual que el «+ Agregar» de la fila.
  it("[EV1-A] Clínica general: sin KPIs de planes y con la fila default de General preseleccionada", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false })}>
        <SettingsModal preferences={DEFAULT_PREFERENCES} onClose={noop} revenueScope="tenant" />
      </TenantModulesProvider>
    );
    expect(html).not.toContain("Planes en curso");
    expect(html).not.toContain("Cerca del alta");
    expect(html).toContain("Pacientes atendidos");
    expect(html).toContain("Turnos esta semana");
  });

  it("Secretaria (none): no ofrece ingresos", () => {
    const html = settings("none");
    expect(html).not.toContain("ngresos del mes");
    expect(html).toContain("Turnos de hoy");
  });
  it("PRACTITIONER (own): 'Tus ingresos del mes'", () => {
    expect(settings("own")).toContain("Tus ingresos del mes");
  });
  it("tenant: 'Ingresos del mes'", () => {
    const html = settings("tenant");
    expect(html).toContain("Ingresos del mes");
    expect(html).not.toContain("Tus ingresos");
  });
});
