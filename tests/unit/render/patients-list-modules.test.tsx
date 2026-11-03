import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * [EV1-B] Directorio de pacientes por módulos. Se montan los componentes reales
 * (`PatientsList`, `PatientsSearchBar`, `AdvancedPatientFilters`) con el
 * `TenantModulesProvider` de cada vertical; solo se mockea el router de Next y
 * la server action del menú de fila (`setPatientArchived`, no se invoca).
 *
 *  - GENERAL: sin «Último diagnóstico».
 *  - CF2 (§29): sin columna de plan ni pills «Con plan/Sin plan» en ninguna
 *    vertical; estado desde `activity`.
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

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const KINE_PRO = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

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
  // CF2 (§29, decisión 3 de Martin): «Plan activo» salió para todos; la grilla es una sola (8 columnas) y el «Estado»
  // sale de `activity` (D-CF2-14) en las dos verticales. El detalle de la celda de profesionales vive en
  // `cf2-patients-list.test.tsx`.
  it("GENERAL: sin columna de plan, estado Activo desde activity y grid de 8 columnas", () => {
    const html = wrap(GENERAL, <PatientsList rows={[row({ activity: "active" })]} archived={false} practitionerNames={{}} />);
    expect(html).not.toContain("Sin plan activo");
    expect(html).not.toContain("Inactivo");
    expect(html).toContain(">Activo<");
    expect(html).toContain(patientsGridColumns());
    expect(patientsGridColumns().split(" ")).toHaveLength(8);
  });

  it("GENERAL: en la vista de archivados el estado es «Archivado»", () => {
    const html = wrap(GENERAL, <PatientsList rows={[row({ activity: "archived" })]} archived practitionerNames={{}} />);
    expect(html).toContain("Archivado");
    expect(html).not.toContain(">Activo<");
  });

  it("[CF2-U1] Kine: sin chips de plan aunque la fila traiga planes; Activo/Inactivo desde activity, no del plan", () => {
    const html = wrap(
      KINE_PRO,
      <PatientsList
        rows={[
          row({
            id: "p1",
            activeProgramTitle: "Plan lumbar",
            sessionsTotal: 10,
            sessionsDone: 3,
            activePlans: [{ discipline: "KINESIOLOGY", done: 3, totalLive: 10 }],
            // Tiene plan pero ningún turno reciente: el estado NO es «Activo» (D-CF2-14: sale de los turnos).
            activity: "inactive",
          }),
          row({ id: "p2", firstName: "Beto", activePlans: [], activity: "active" }),
        ]}
        archived={false}
        practitionerNames={{}}
      />
    );
    expect(html).not.toContain("Plan lumbar");
    expect(html).not.toContain("3/10");
    expect(html).not.toContain("patients-plan-chip");
    expect(html).not.toContain("Sin plan activo");
    expect(html).toContain(">Activo<");
    expect(html).toContain(">Inactivo<");
    expect(html).toContain(patientsGridColumns());
  });
});

describe("[EV1-B] PatientsSearchBar", () => {
  it("[CF2-U1] sin pills «Con plan/Sin plan» en ninguna vertical (decisión 3)", () => {
    for (const m of [GENERAL, KINE_PRO]) {
      const html = wrap(m, <PatientsSearchBar />);
      expect(html).not.toContain("Con plan");
      expect(html).not.toContain("Sin plan");
      expect(html).not.toContain("filter=active");
      expect(html).toContain("Buscar paciente");
    }
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
    const html = wrap(GENERAL, <AdvancedPatientFilters {...props} clinicalRead />);
    expect(html).toContain("Edad mínima");
    expect(html).not.toContain("Último diagnóstico");
    expect(html).not.toContain('name="diagnosisSlug"');
  });

  it("Kine (golden): con «Último diagnóstico»", () => {
    const html = wrap(KINE_PRO, <AdvancedPatientFilters {...props} clinicalRead />);
    expect(html).toContain("Último diagnóstico");
    expect(html).toContain("Lumbalgia");
  });
});
