import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-fix] Pestañas de Configuración por módulo y nombre accesible del Switch.
 * Componentes reales con props; sin mocks.
 */
import { TabsBar, Switch } from "@/components/configuracion/controls";
import { modulesFor } from "@/lib/tenant-modules";

const GENERAL = Array.from(modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false }));
const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false }));

const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);

describe("[EV0-fix] TabsBar de Configuración", () => {
  it("con el módulo diagnostico muestra Diagnósticos", () => {
    const html = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="OWNER" modules={KINE} />);
    expect(tabs(html)).toEqual([
      "General",
      "Sedes",
      "Profesionales",
      "Servicios",
      "Obras sociales",
      "Diagnósticos",
      "Usuarios",
      "Plan y uso",
      "Facturación", // PL-3a (PL-D21)
      "Soporte", // PL-2d: Mensajes + Accesos de soporte
      "Exportar datos",
    ]);
  });

  it("sin el módulo diagnostico (consultorio General) no hay pestaña Diagnósticos", () => {
    const html = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="OWNER" modules={GENERAL} />);
    expect(GENERAL).not.toContain("diagnostico");
    expect(tabs(html)).not.toContain("Diagnósticos");
    expect(tabs(html)).toContain("Servicios");
  });

  it("[IAM-D3] Usuarios para OWNER y ADMIN, no para el resto", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const html = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role={role} modules={KINE} />);
      expect(tabs(html)).toContain("Usuarios");
    }
    for (const role of ["PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      const html = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role={role} modules={KINE} />);
      expect(tabs(html)).not.toContain("Usuarios");
    }
  });

  it("[BO5-C] «Exportar datos» solo para el OWNER (ADMIN tampoco: la route también lo rechaza)", () => {
    const owner = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="OWNER" modules={KINE} />);
    expect(tabs(owner)).toContain("Exportar datos");
    for (const role of ["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      const html = renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role={role} modules={KINE} />);
      expect(tabs(html)).not.toContain("Exportar datos");
    }
  });
});

describe("[EV0-fix] Switch", () => {
  it("lleva nombre accesible cuando se le pasa aria-label", () => {
    const html = renderToStaticMarkup(<Switch on onChange={() => {}} aria-label="Turnos online" />);
    expect(html).toMatch(/role="switch"/);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Turnos online"');
  });
});
