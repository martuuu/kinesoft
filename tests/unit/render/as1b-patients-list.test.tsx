import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * [AS-1b] Directorio con filas `admin` (T3c-1b, plan §23.5). Se monta el `PatientsList` real; solo se mockea el router
 * y la server action del menú de fila (no se invoca).
 *
 *  - `admin` (Secretaria, Admin, Facturación): contacto (email en el title, DNI/teléfono) y obra social como `full`;
 *    NADA clínico aunque la fila viniera con datos (plan, última visita) y sin las acciones que mutan la ficha
 *    (selección masiva, archivar: el server exige `full`).
 *  - `basic` sigue igual (sin contacto ni OS) y `full` sigue con todo (controles).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({ setPatientArchived: vi.fn() }));

import { PatientsList, patientRowSubline } from "@/components/patients/patients-list";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { BulkSelectProvider } from "@/components/patients/bulk-select";
import { modulesFor } from "@/lib/tenant-modules";
import type { PatientRow } from "@/lib/patients-types";

const KINE_PRO = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const GENERAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

function wrap(node: ReactNode, modules = KINE_PRO) {
  return renderToStaticMarkup(
    <ToastProvider>
      <TenantModulesProvider modules={Array.from(modules)}>
        <BulkSelectProvider>{node}</BulkSelectProvider>
      </TenantModulesProvider>
    </ToastProvider>
  );
}

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Ana",
    lastName: "García",
    email: "ana@example.test",
    phone: "1144445555",
    documentId: "30111222",
    dateOfBirth: new Date("1985-01-20T00:00:00Z"),
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: null,
    sessionsTotal: 0,
    sessionsDone: 0,
    activePlans: [],
    lastVisit: null,
    upcomingAt: new Date("2026-10-20T13:00:00Z"),
    obraSocial: "OSDE",
    access: "admin",
    ...over,
  };
}

describe("[AS-1b] PatientsList · filas admin", () => {
  it("admin: contacto y obra social visibles; sin plan, sin selección masiva ni acciones", () => {
    // Datos clínicos de más a propósito: la UI no los tiene que pintar en una fila que no es full.
    const html = wrap(
      <PatientsList
        rows={[
          row({
            activeProgramTitle: "Plan lumbar",
            activePlans: [{ discipline: "KINESIOLOGY", done: 3, totalLive: 10 }],
            lastVisit: new Date("2026-10-01T13:00:00Z"),
          }),
        ]}
        archived={false}
      />
    );
    expect(html).toContain("Ana García · ana@example.test");
    expect(html).toContain("DNI 30111222");
    expect(html).toContain("OSDE");
    expect(html).toContain("Sin acceso");
    expect(html).not.toContain("Plan lumbar");
    expect(html).not.toContain("3/10");
    expect(html).not.toContain("Seleccionar paciente");
    expect(html).not.toContain('aria-label="Acciones"');
    expect(html).not.toContain("Inactivo");
  });

  it("admin en un consultorio General: el estado del paciente (no HC) se ve", () => {
    const html = wrap(<PatientsList rows={[row()]} archived={false} />, GENERAL);
    expect(html).toContain(">Activo<");
    expect(html).toContain("OSDE");
  });

  it("controles: basic sin contacto ni OS; full con plan, selección y acciones", () => {
    const basic = wrap(<PatientsList rows={[row({ access: "basic", email: null, obraSocial: null })]} archived={false} />);
    expect(basic).not.toContain("ana@example.test");
    expect(basic).not.toContain("OSDE");

    const full = wrap(
      <PatientsList
        rows={[row({ access: "full", activeProgramTitle: "Plan lumbar", activePlans: [{ discipline: "KINESIOLOGY", done: 3, totalLive: 10 }] })]}
        archived={false}
      />
    );
    expect(full).toContain("Plan lumbar");
    expect(full).toContain("Seleccionar paciente");
    expect(full).toContain('aria-label="Acciones"');
  });

  it("patientRowSubline: admin muestra el teléfono si no hay DNI (como full); basic nunca", () => {
    expect(patientRowSubline({ access: "admin", documentId: null, phone: "1144445555" })).toBe("1144445555");
    expect(patientRowSubline({ access: "basic", documentId: null, phone: "1144445555" })).toBe("Sin acceso");
  });
});
