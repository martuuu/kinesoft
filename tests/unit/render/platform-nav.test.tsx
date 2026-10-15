import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-P2 → BO3-A] Nav de Plataforma. Desde BO3-A es el sidebar del shell propio (`PlatformShell`), con el orden
 * del plan §19.5 y el separador «Catálogo global». Se monta el componente real; solo se mockea `usePathname` (el
 * router de Next no existe en node).
 */
let pathname = "/plataforma";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { PlatformNav, isPlatformNavActive, PLATFORM_NAV_ITEMS } from "@/components/plataforma/platform-nav";

function render(path: string): string {
  pathname = path;
  return renderToStaticMarkup(<PlatformNav />);
}

/** Texto de los links con aria-current="page". */
function activeLabels(html: string): string[] {
  return [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

describe("[BO3-A] PlatformNav", () => {
  beforeEach(() => {
    pathname = "/plataforma";
  });

  it("muestra los 9 links en el orden del plan, con el separador «Catálogo global» antes de Ejercicios", () => {
    const html = render("/plataforma");
    expect(html).toMatch(/<nav[^>]*aria-label="Secciones de Plataforma"/);
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "")]);
    expect(links).toEqual([
      ["/plataforma", "Resumen"],
      ["/plataforma/consultorios", "Consultorios"],
      ["/plataforma/usuarios", "Usuarios"],
      ["/plataforma/salud", "Salud"],
      ["/plataforma/auditoria", "Auditoría"],
      ["/plataforma/sistema", "Sistema"],
      ["/plataforma/ejercicios", "Ejercicios"],
      ["/plataforma/tags", "Tags"],
      ["/plataforma/catalogo/prestadoras", "Catálogo"],
    ]);
    expect(PLATFORM_NAV_ITEMS).toHaveLength(9);
    const sep = html.indexOf('role="separator"');
    expect(sep).toBeGreaterThan(html.indexOf('href="/plataforma/sistema"'));
    expect(sep).toBeLessThan(html.indexOf('href="/plataforma/ejercicios"'));
    expect(html).toContain("Catálogo global");
  });

  it("/plataforma activa solo Resumen (match exacto, no prefijo)", () => {
    expect(activeLabels(render("/plataforma"))).toEqual(["Resumen"]);
    expect(activeLabels(render("/plataforma/"))).toEqual(["Resumen"]);
  });

  it("subrutas activan su sección por prefijo (y no Resumen)", () => {
    expect(activeLabels(render("/plataforma/consultorios/123"))).toEqual(["Consultorios"]);
    expect(activeLabels(render("/plataforma/usuarios/u-1"))).toEqual(["Usuarios"]);
    expect(activeLabels(render("/plataforma/auditoria"))).toEqual(["Auditoría"]);
  });

  it("/plataforma/catalogo/practicas activa Catálogo aunque el link apunte a prestadoras", () => {
    expect(activeLabels(render("/plataforma/catalogo/practicas"))).toEqual(["Catálogo"]);
  });

  it("un prefijo de texto sin segmento no matchea", () => {
    const tags = PLATFORM_NAV_ITEMS.find((i) => i.label === "Tags")!;
    expect(isPlatformNavActive(tags, "/plataforma/tagsx")).toBe(false);
    expect(activeLabels(render("/plataforma/otra"))).toEqual([]);
  });

  it("pathname null (primer render fuera del router) no rompe ni activa nada", () => {
    pathname = null as unknown as string;
    expect(activeLabels(renderToStaticMarkup(<PlatformNav />))).toEqual([]);
  });
});
