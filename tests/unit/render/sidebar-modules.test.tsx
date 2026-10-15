import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-EV-S] Shell y nav por módulos: sidebar y topbar renderizan
 * `navFor(modules, caps)` de `lib/nav.ts` (única fuente) con los módulos que
 * publica `TenantModulesProvider`. Se montan los componentes reales; solo se
 * mockea el router de Next (pathname / searchParams).
 */
const nav = vi.hoisted(() => ({ pathname: "/dashboard", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import {
  TenantModulesProvider,
  useTenantModules,
} from "@/components/layout/tenant-modules-context";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";
import { capabilitiesFor } from "@/lib/capabilities";
import type { Role } from "@prisma/client";

const GENERAL = modulesFor({
  vertical: "GENERAL",
  plan: "CLINICA",
  publicBookingEnabled: false,
});
const KINE_PRO = modulesFor({
  vertical: "KINESIOLOGY",
  plan: "CLINICA",
  publicBookingEnabled: false,
});

function caps(role: Role) {
  return Array.from(capabilitiesFor(role));
}

function sidebar(
  modules: ReadonlySet<TenantModule>,
  role: Role,
  opts: { isPlatformAdmin?: boolean } = {}
) {
  return renderToStaticMarkup(
    <TenantModulesProvider modules={Array.from(modules)}>
      <Sidebar caps={caps(role)} isPlatformAdmin={opts.isPlatformAdmin ?? false} />
    </TenantModulesProvider>
  );
}

function topbar(modules: ReadonlySet<TenantModule>, role: Role) {
  return renderToStaticMarkup(
    <TenantModulesProvider modules={Array.from(modules)}>
      <TopBar caps={caps(role)} />
    </TenantModulesProvider>
  );
}

const hrefs = (html: string) =>
  Array.from(html.matchAll(/href="([^"]+)"/g), (m) => m[1].replace(/&amp;/g, "&"));

/** Links con el estado activo (`aria-current="page"`). */
const activeHrefs = (html: string) =>
  Array.from(html.matchAll(/<a[^>]*>/g), (m) => m[0])
    .filter((a) => a.includes('aria-current="page"'))
    .map((a) => (a.match(/href="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&"));

const KINE_ONLY = ["Diagnóstico", "Seguimiento", "Ejercicios", "Terapia Manual", "Reportes"];

beforeEach(() => {
  nav.pathname = "/dashboard";
  nav.search = "";
});

describe("[EV0-EV-S] sidebar por módulos", () => {
  it("consultorio General: sin Diagnóstico/Seguimiento/Ejercicios/Terapia Manual/Reportes", () => {
    const html = sidebar(GENERAL, "OWNER");
    for (const label of KINE_ONLY) expect(html, label).not.toContain(`>${label}<`);
    for (const label of ["Inicio", "Agenda", "Sala de espera", "Pacientes", "Configuración"])
      expect(html, label).toContain(`>${label}<`);
    expect(hrefs(html)).not.toContain("/diagnostico");
  });

  it("consultorio Kine: muestra todo lo de Kine", () => {
    const html = sidebar(KINE_PRO, "OWNER");
    for (const label of KINE_ONLY) expect(html, label).toContain(`>${label}<`);
    expect(hrefs(html)).toEqual(
      expect.arrayContaining([
        "/diagnostico",
        "/seguimiento",
        "/biblioteca",
        "/terapia-manual",
        "/reportes",
      ])
    );
  });

  it("BILLING no ve Sala de espera (no tiene agenda.reception); PRACTITIONER sí", () => {
    expect(sidebar(KINE_PRO, "BILLING")).not.toContain("Sala de espera");
    expect(sidebar(KINE_PRO, "PRACTITIONER")).toContain(">Sala de espera<");
  });

  it("Configuración solo con tenant.admin (la página redirige a los demás roles)", () => {
    expect(hrefs(sidebar(KINE_PRO, "OWNER"))).toContain("/configuracion");
    expect(hrefs(sidebar(KINE_PRO, "PRACTITIONER"))).not.toContain("/configuracion");
    expect(hrefs(sidebar(KINE_PRO, "ASSISTANT"))).not.toContain("/configuracion");
  });

  it("Plataforma: una sola entrada a /plataforma, solo con isPlatformAdmin", () => {
    expect(sidebar(KINE_PRO, "OWNER")).not.toContain("Plataforma");
    const html = sidebar(KINE_PRO, "OWNER", { isPlatformAdmin: true });
    expect(hrefs(html).filter((h) => h.startsWith("/plataforma"))).toEqual(["/plataforma"]);
    expect(html).toContain(">Plataforma<");
  });

  it("[SV11a] Sala de espera activa en /sala no ilumina también Agenda", () => {
    nav.pathname = "/sala";
    expect(activeHrefs(sidebar(KINE_PRO, "OWNER"))).toEqual(["/sala"]);
    nav.pathname = "/agenda";
    nav.search = "view=week";
    expect(activeHrefs(sidebar(KINE_PRO, "OWNER"))).toEqual(["/agenda"]);
  });

  it("[SV11a] el sidebar enlaza Sala de espera a /sala, no a /agenda?view=reception (General y Kine)", () => {
    for (const t of [GENERAL, KINE_PRO]) {
      const h = hrefs(sidebar(t, "OWNER"));
      expect(h).toContain("/sala");
      expect(h.some((x) => x.includes("view=reception"))).toBe(false);
    }
  });

  it("Plataforma activa en cualquier subruta de /plataforma", () => {
    nav.pathname = "/plataforma/catalogo/prestadoras";
    expect(activeHrefs(sidebar(KINE_PRO, "OWNER", { isPlatformAdmin: true }))).toEqual([
      "/plataforma",
    ]);
  });
});

describe("[EV0-EV-S] topbar por módulos", () => {
  it("General: sin entradas de Kine", () => {
    const html = topbar(GENERAL, "OWNER");
    for (const label of KINE_ONLY) expect(html, label).not.toContain(`>${label}<`);
    expect(html).toContain(">Agenda<");
  });

  it("Kine: con entradas de Kine y Config solo para admin", () => {
    const html = topbar(KINE_PRO, "OWNER");
    for (const label of KINE_ONLY) expect(html, label).toContain(`>${label}<`);
    expect(html).toContain(">Config<");
    expect(topbar(KINE_PRO, "PRACTITIONER")).not.toContain(">Config<");
  });

  it("BILLING no ve Sala de espera", () => {
    expect(topbar(KINE_PRO, "BILLING")).not.toContain("Sala de espera");
  });
});

describe("[EV0-EV-S] useTenantModules", () => {
  function Probe() {
    const m = useTenantModules();
    return <span>{Array.from(m.list).sort().join(",") + "|" + String(m.has("diagnostico"))}</span>;
  }

  it("fuera del provider = set de Kine PRO (default solo de UI)", () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain(Array.from(KINE_PRO).sort().join(","));
    expect(html).toContain("|true");
  });

  it("dentro del provider = los módulos recibidos", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={Array.from(GENERAL)}>
        <Probe />
      </TenantModulesProvider>
    );
    expect(html).toContain(Array.from(GENERAL).sort().join(",") + "|false");
  });
});
