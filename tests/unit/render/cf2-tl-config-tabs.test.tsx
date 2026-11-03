import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-TL] Pestaña personal «Mi agenda» (brief CF2 T.C) en la barra de Configuración: el símbolo real
 * (`visibleConfigTabs`, `TabsBar`), sin mocks. Qué recibe el flag lo decide el loader (mismo gate que «Mis fichas»: lo
 * fija tests/integration/cf2-config-mi-agenda.test.ts); acá, que el flag la muestre en su lugar y que sin él no exista.
 */
import {
  CONFIG_TABS,
  TabsBar,
  initialConfigTab,
  legacyConfigAccess,
  parseConfigTab,
  visibleConfigTabs,
  type ConfigTabAccess,
} from "@/components/configuracion/controls";
import { modulesFor } from "@/lib/tenant-modules";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] })
);
const GENERAL = Array.from(
  modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] })
);
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);

const NONE: ConfigTabAccess = { tenantAdmin: false, billing: false, team: false, canExport: false };
const PRO: ConfigTabAccess = { ...NONE, fichas: true, miAgenda: true };

describe("[CF2-TL] pestaña «Mi agenda»", () => {
  it("[CF2-TL5] se abre por URL (`?tab=mi-agenda`) y es una pestaña conocida", () => {
    expect(CONFIG_TABS).toContain("mi-agenda");
    expect(parseConfigTab("mi-agenda")).toBe("mi-agenda");
  });

  it("[CF2-TL6] un Profesional sin delegaciones la ve antes de «Mis fichas» y entra directo ahí", () => {
    expect(visibleConfigTabs(PRO, KINE)).toEqual(["mi-agenda", "mis-fichas", "soporte"]);
    expect(tabs(renderToStaticMarkup(<TabsBar tab="mi-agenda" setTab={() => {}} access={PRO} modules={KINE} />))).toEqual([
      "Mi agenda",
      "Mis fichas",
      "Soporte",
    ]);
    expect(initialConfigTab(undefined, visibleConfigTabs(PRO, KINE))).toBe("mi-agenda");
  });

  it("[CF2-TL7] no depende de un módulo: un consultorio General (sin evoluciones) también la ve", () => {
    expect(visibleConfigTabs(PRO, GENERAL)).toContain("mi-agenda");
  });

  it("[CF2-TL8] sin el flag (Secretaria, Facturación, soporte, tests viejos) no existe, ni por URL", () => {
    expect(visibleConfigTabs({ ...PRO, miAgenda: false }, KINE)).not.toContain("mi-agenda");
    expect(visibleConfigTabs({ ...NONE, tenantAdmin: true, sensitive: true }, KINE)).not.toContain("mi-agenda");
    for (const role of ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      expect(visibleConfigTabs(legacyConfigAccess(role), KINE)).not.toContain("mi-agenda");
    }
    const secretaria = visibleConfigTabs({ ...NONE, tenantAdmin: true }, KINE);
    expect(initialConfigTab("mi-agenda", secretaria)).toBe("general");
  });

  it("[CF2-TL9] Titular con todo: «Mi agenda» entre Facturación y «Mis fichas»", () => {
    const owner: ConfigTabAccess = { tenantAdmin: true, billing: true, team: true, canExport: true, sensitive: true, fichas: true, miAgenda: true };
    const v = visibleConfigTabs(owner, KINE);
    expect(v.indexOf("mi-agenda")).toBe(v.indexOf("facturacion") + 1);
    expect(v.indexOf("mis-fichas")).toBe(v.indexOf("mi-agenda") + 1);
  });
});
