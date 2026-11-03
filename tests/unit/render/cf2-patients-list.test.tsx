import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * [CF2-U1] Directorio de pacientes de CF2 (§29, decisiones 2 y 3 de Martin; D-CF2-14, D-CF2-15). Se montan los
 * componentes reales (`PatientsList`, `PatientsListHead`, `PatientsSearchBar`, `AdvancedPatientFilters`) con el
 * `TenantModulesProvider` de cada vertical; solo se mockea el router de Next y la server action del menú de fila.
 *
 *  - Mismas columnas para todos los roles y verticales: checkbox · Nombre y apellido · OS · Próx. turno · Última
 *    visita · Kinesiólogo/Profesional · Estado · acciones. Sin «Plan activo» ni las pastillas «Con plan/Sin plan».
 *  - Celda profesional: el a cargo primero con «a cargo», un segundo nombre y «+N»; `title` con todos; sin a cargo
 *    ni turnos, «Consultorio común».
 *  - Estado desde `activity` (Activo/Inactivo/Archivado); la Secretaria (fila `admin`) ve estado y última visita; la
 *    fila `basic`, «—» en los dos.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({ setPatientArchived: vi.fn() }));

import { PatientsList, PatientsListHead } from "@/components/patients/patients-list";
import { PatientsSearchBar } from "@/components/patients/patients-search-bar";
import { AdvancedPatientFilters } from "@/components/patients/advanced-filters";
import {
  patientsGridColumns,
  practitionerCellView,
  practitionerColumnLabel,
} from "@/components/patients/patients-grid";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { BulkSelectProvider } from "@/components/patients/bulk-select";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";
import type { PatientRow } from "@/lib/patients-types";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

const ROOT = join(__dirname, "..", "..", "..");
const DIR_CSS = readFileSync(join(ROOT, "components/patients/patients-directory.module.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** Cuerpo de los bloques `@media (max-width: 767px)` (llaves balanceadas). */
function mobileBlocks(source: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media (max-width: 767px)", from);
    if (at < 0) break;
    const open = source.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(open + 1, i - 1));
    from = i;
  }
  return out.join("\n");
}

const NAMES: Record<string, string> = { "pr-ana": "Ana López", "pr-beto": "Beto Ruiz", "pr-caro": "Carolina Díaz" };

function wrap(modules: ReadonlySet<TenantModule>, node: ReactNode, vertical?: "GENERAL" | "KINESIOLOGY") {
  return renderToStaticMarkup(
    <ToastProvider>
      <TenantModulesProvider modules={Array.from(modules)} vertical={vertical}>
        <BulkSelectProvider>{node}</BulkSelectProvider>
      </TenantModulesProvider>
    </ToastProvider>,
  );
}

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Juana",
    lastName: "Pérez",
    email: "juana@example.test",
    phone: null,
    documentId: "30111222",
    dateOfBirth: null,
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: "Plan lumbar",
    sessionsTotal: 10,
    sessionsDone: 3,
    activePlans: [{ discipline: "KINESIOLOGY", done: 3, totalLive: 10 }],
    lastVisit: new Date("2026-10-28T13:00:00Z"),
    upcomingAt: new Date("2026-11-05T13:00:00Z"),
    obraSocial: "OSDE",
    access: "full",
    assignedPractitionerId: "pr-ana",
    practitionerIds: ["pr-ana"],
    activity: "active",
    ...over,
  };
}

/** Texto visible de las celdas `.cellPros` (sin el rótulo de la card ni el texto para lectores). */
function prosCells(html: string): string[] {
  return Array.from(html.matchAll(/<div class="[^"]*_cellPros_[^"]*"[^>]*>([\s\S]*?)<\/div>/g)).map((m) => m[0]);
}

describe("[CF2-U1] columnas por vertical", () => {
  it("[CF2-U1-1] Kine: encabezados del contrato, «Kinesiólogo» y sin «Plan activo»", () => {
    const html = wrap(KINE, <PatientsListHead selectableIds={["p1"]} />, "KINESIOLOGY");
    const heads = Array.from(html.matchAll(/<span[^>]*>([^<]+)<\/span>/g)).map((m) => m[1]);
    expect(heads).toEqual(["Nombre y apellido", "Obra social", "Próx. turno", "Última visita", "Kinesiólogo", "Estado"]);
    expect(html).not.toContain("Plan activo");
    expect(html).toContain(patientsGridColumns());
    expect(patientsGridColumns().split(" ")).toHaveLength(8);
  });

  it("[CF2-U1-2] General: «Profesional» en vez de «Kinesiólogo»; misma grilla", () => {
    const html = wrap(GENERAL, <PatientsListHead selectableIds={[]} />, "GENERAL");
    expect(html).toContain(">Profesional<");
    expect(html).not.toContain("Kinesiólogo");
    expect(html).toContain(patientsGridColumns());
    expect(practitionerColumnLabel("GENERAL")).toBe("Profesional");
    expect(practitionerColumnLabel("KINESIOLOGY")).toBe("Kinesiólogo");
  });

  it("[CF2-U1-3] la fila Kine no pinta plan (chips, título, «Sin plan activo»)", () => {
    const html = wrap(KINE, <PatientsList rows={[row(), row({ id: "p2", activePlans: [] })]} archived={false} practitionerNames={NAMES} />);
    expect(html).not.toContain("patients-plan-chip");
    expect(html).not.toContain("Plan lumbar");
    expect(html).not.toContain("3/10");
    expect(html).not.toContain("Sin plan activo");
    expect(html).not.toMatch(/_cellPlan_/);
    expect(html.match(/_cellPros_/g)).toHaveLength(2);
    expect(html).toContain(patientsGridColumns());
  });
});

describe("[CF2-U1] celda de profesionales", () => {
  it("[CF2-U1-4] uno: el a cargo con la marca «a cargo»", () => {
    const html = wrap(KINE, <PatientsList rows={[row()]} archived={false} practitionerNames={NAMES} />);
    const [cell] = prosCells(html);
    expect(cell).toContain("Ana López");
    expect(cell).toContain(">a cargo<");
    expect(cell).toContain('title="Ana López (a cargo)"');
    expect(cell).not.toMatch(/>\+\d/);
  });

  it("[CF2-U1-5] dos: el a cargo primero y el otro sin marca", () => {
    const html = wrap(
      KINE,
      <PatientsList rows={[row({ practitionerIds: ["pr-ana", "pr-beto"] })]} archived={false} practitionerNames={NAMES} />,
    );
    const [cell] = prosCells(html);
    expect(cell.indexOf("Ana López")).toBeLessThan(cell.indexOf("Beto Ruiz"));
    expect(cell.match(/>a cargo</g)).toHaveLength(1);
    expect(cell).toContain('title="Ana López (a cargo), Beto Ruiz"');
    expect(cell).not.toMatch(/>\+\d/);
  });

  it("[CF2-U1-6] tres o más: dos nombres y «+N»; el title y el texto para lectores los dicen todos", () => {
    const html = wrap(
      KINE,
      <PatientsList
        rows={[row({ practitionerIds: ["pr-ana", "pr-beto", "pr-caro", "pr-x"] })]}
        archived={false}
        practitionerNames={NAMES}
      />,
    );
    const [cell] = prosCells(html);
    expect(cell).toContain(">+2<");
    // Un id sin nombre (profesional que ya no está en el mapa) cae a «Profesional», nunca al id.
    expect(cell).toContain('title="Ana López (a cargo), Beto Ruiz, Carolina Díaz, Profesional"');
    expect(cell).toContain("k-sr-only");
    expect(cell).not.toContain("pr-x");
  });

  it("[CF2-U1-7] sin a cargo: nadie lleva la marca; sin a cargo ni turnos: «Consultorio común»", () => {
    const html = wrap(
      KINE,
      <PatientsList
        rows={[
          row({ id: "p1", assignedPractitionerId: null, practitionerIds: ["pr-beto"] }),
          row({ id: "p2", assignedPractitionerId: null, practitionerIds: [] }),
        ]}
        archived={false}
        practitionerNames={NAMES}
      />,
    );
    const [withTurns, empty] = prosCells(html);
    expect(withTurns).toContain("Beto Ruiz");
    expect(withTurns).not.toContain("a cargo");
    expect(empty).toContain("Consultorio común");
  });

  it("[CF2-U1-8] practitionerCellView: puro, sin duplicados y con fallback", () => {
    expect(practitionerCellView([], null, NAMES)).toEqual({ empty: true, visible: [], extra: 0, full: "Consultorio común" });
    const v = practitionerCellView(["pr-beto", "pr-caro", "pr-ana"], "pr-ana", NAMES);
    expect(v.visible.map((x) => x.name)).toEqual(["Ana López", "Beto Ruiz"]);
    expect(v.visible[0].assigned).toBe(true);
    expect(v.extra).toBe(1);
    // A cargo sin turnos (no viene en `practitionerIds`): igual se muestra, primero.
    expect(practitionerCellView([], "pr-caro", NAMES).visible).toEqual([{ name: "Carolina Díaz", assigned: true }]);
  });
});

describe("[CF2-U1] estado y última visita (D-CF2-14/15)", () => {
  it("[CF2-U1-9] Secretaria (fila admin): ve Activo/Inactivo y la última visita; sin selección ni acciones", () => {
    const html = wrap(
      KINE,
      <PatientsList
        rows={[
          row({ id: "a1", access: "admin", activity: "active" }),
          row({ id: "a2", access: "admin", activity: "inactive", lastVisit: null, upcomingAt: null }),
        ]}
        archived={false}
        practitionerNames={NAMES}
      />,
    );
    expect(html).toContain(">Activo<");
    expect(html).toContain(">Inactivo<");
    expect(html).toMatch(/28[\s-]oct/);
    expect(html).not.toContain("Seleccionar paciente");
    expect(html).not.toContain('aria-label="Acciones"');
  });

  it("[CF2-U1-10] basic: «Kinesiólogo» visible, estado y última visita «—»", () => {
    const html = wrap(
      GENERAL,
      <PatientsList rows={[row({ access: "basic", activity: null, obraSocial: null })]} archived={false} practitionerNames={NAMES} />,
      "GENERAL",
    );
    expect(prosCells(html)[0]).toContain("Ana López");
    expect(html).not.toContain(">Activo<");
    expect(html).not.toMatch(/28[\s-]oct/);
  });

  it("[CF2-U1-11] archivados: «Archivado» desde activity, igual en General y Kine", () => {
    for (const m of [GENERAL, KINE]) {
      const html = wrap(m, <PatientsList rows={[row({ activity: "archived" })]} archived practitionerNames={NAMES} />);
      expect(html).toContain(">Archivado<");
      expect(html).not.toContain(">Activo<");
    }
  });
});

describe("[CF2-U1] sin pastillas, filtros por permiso, mobile", () => {
  it("[CF2-U1-12] el buscador no tiene «Todos / Con plan / Sin plan» en ninguna vertical", () => {
    for (const m of [GENERAL, KINE]) {
      const html = wrap(m, <PatientsSearchBar />);
      expect(html).not.toContain("Con plan");
      expect(html).not.toContain("Sin plan");
      expect(html).not.toContain("filter=");
      expect(html).toContain("Buscar paciente");
    }
  });

  it("[CF2-U1-13] «Último diagnóstico» oculto sin clinical.read (aun en Kine)", () => {
    const props = { conditions: [{ slug: "lumbalgia", name: "Lumbalgia" }], preservedParams: {}, current: { ageMin: "20" } };
    expect(wrap(KINE, <AdvancedPatientFilters {...props} clinicalRead={false} />)).not.toContain("Último diagnóstico");
    expect(wrap(KINE, <AdvancedPatientFilters {...props} clinicalRead />)).toContain("Último diagnóstico");
  });

  it("[CF2-U1-14] mobile: el área `plan` de la card pasa a `pros` (`.cellPros`)", () => {
    const mobile = mobileBlocks(DIR_CSS);
    expect(mobile).toMatch(/"pros pros pros"/);
    expect(mobile).not.toMatch(/"plan plan plan"/);
    expect(mobile).toMatch(/\.cellPros\s*\{[^}]*grid-area:\s*pros/);
    expect(DIR_CSS).not.toMatch(/\.cellPlan/);
    // El rótulo de la card dice el nombre de la columna.
    const html = wrap(KINE, <PatientsList rows={[row()]} archived={false} practitionerNames={NAMES} />, "KINESIOLOGY");
    expect(prosCells(html)[0]).toMatch(/_cardLabel_[^"]*"[^>]*>Kinesiólogo:/);
  });
});
