import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * [EV1-B] Directorio de pacientes por módulos. Se montan los componentes reales
 * (`PatientsList`, `PatientsSearchBar`, `AdvancedPatientFilters`) con el
 * `TenantModulesProvider` de cada vertical; solo se mockea el router de Next y
 * la server action del menú de fila (`setPatientArchived`, no se invoca).
 *
 *  - GENERAL: sin columna de plan, sin pills «Con plan/Sin plan», sin
 *    «Último diagnóstico», estado = Activo/Archivado.
 *  - Kine PRO (golden): todo como antes de EV1.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({ setPatientArchived: vi.fn() }));

import { PatientsList } from "@/components/patients/patients-list";
import { PatientsSearchBar } from "@/components/patients/patients-search-bar";
import { AdvancedPatientFilters } from "@/components/patients/advanced-filters";
import { patientsGridColumns } from "@/components/patients/patients-grid";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";
import type { PatientRow } from "@/lib/patients-types";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "FREE", publicBookingEnabled: false });
const KINE_PRO = modulesFor({ vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: false });

function wrap(modules: ReadonlySet<TenantModule>, node: ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <TenantModulesProvider modules={Array.from(modules)}>{node}</TenantModulesProvider>
    </ToastProvider>
  );
}

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Ana",
    lastName: "García",
    email: "ana@example.test",
    phone: null,
    documentId: "30111222",
    dateOfBirth: null,
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: null,
    sessionsTotal: 0,
    sessionsDone: 0,
    lastVisit: null,
    upcomingAt: null,
    obraSocial: "OSDE",
    access: "full",
    ...over,
  };
}

describe("[EV1-B] PatientsList", () => {
  it("GENERAL: sin columna de plan, estado Activo y grid de 7 columnas", () => {
    const html = wrap(GENERAL, <PatientsList rows={[row()]} archived={false} />);
    expect(html).not.toContain("Sin plan asignado");
    expect(html).not.toContain("Inactivo");
    expect(html).toContain("Activo");
    expect(html).toContain(patientsGridColumns(false));
    expect(patientsGridColumns(false).split(" ")).toHaveLength(7);
  });

  it("GENERAL: en la vista de archivados el estado es «Archivado»", () => {
    const html = wrap(GENERAL, <PatientsList rows={[row()]} archived />);
    expect(html).toContain("Archivado");
    expect(html).not.toContain(">Activo<");
  });

  it("Kine (golden): columna de plan, sesiones y Activo/Inactivo = tiene plan", () => {
    const html = wrap(
      KINE_PRO,
      <PatientsList
        rows={[
          row({ id: "p1", activeProgramTitle: "Plan lumbar", sessionsTotal: 10, sessionsDone: 3 }),
          row({ id: "p2", firstName: "Beto" }),
        ]}
        archived={false}
      />
    );
    expect(html).toContain("Plan lumbar");
    expect(html).toContain("3 / 10");
    expect(html).toContain("Sin plan asignado");
    expect(html).toContain("Activo");
    expect(html).toContain("Inactivo");
    expect(html).toContain(patientsGridColumns(true));
    expect(patientsGridColumns(true)).toBe("28px 1.6fr 1fr 1fr 1.2fr 100px 90px 40px");
  });
});

describe("[EV1-B] PatientsSearchBar", () => {
  it("GENERAL: sin pills «Con plan/Sin plan»", () => {
    const html = wrap(GENERAL, <PatientsSearchBar filter="all" totals={{ all: 4 }} />);
    expect(html).not.toContain("Con plan");
    expect(html).not.toContain("Sin plan");
    expect(html).not.toContain("filter=active");
    expect(html).toContain("Buscar paciente");
  });

  it("Kine (golden): pills con totales", () => {
    const html = wrap(
      KINE_PRO,
      <PatientsSearchBar filter="all" totals={{ all: 4, withProgram: 1, withoutProgram: 3 }} />
    );
    expect(html).toContain("Todos · 4");
    expect(html).toContain("Con plan · 1");
    expect(html).toContain("Sin plan · 3");
  });
});

describe("[EV1-B] AdvancedPatientFilters", () => {
  const props = {
    conditions: [{ slug: "lumbalgia", name: "Lumbalgia" }],
    preservedParams: {},
    // Abierto (initialOpen) para que el panel se renderice.
    current: { ageMin: "20" },
  };

  it("GENERAL: sin «Último diagnóstico»", () => {
    const html = wrap(GENERAL, <AdvancedPatientFilters {...props} />);
    expect(html).toContain("Edad mínima");
    expect(html).not.toContain("Último diagnóstico");
    expect(html).not.toContain('name="diagnosisSlug"');
  });

  it("Kine (golden): con «Último diagnóstico»", () => {
    const html = wrap(KINE_PRO, <AdvancedPatientFilters {...props} />);
    expect(html).toContain("Último diagnóstico");
    expect(html).toContain("Lumbalgia");
  });
});
