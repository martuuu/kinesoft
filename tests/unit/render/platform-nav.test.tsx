import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-P2] Sub-nav de Plataforma. Se monta el componente real; solo se mockea
 * `usePathname` (el router de Next no existe en node).
 */
let pathname = "/plataforma";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { PlatformNav, isPlatformNavActive, PLATFORM_NAV_ITEMS } from "@/components/plataforma/platform-nav";

function render(path: string): string {
  pathname = path;
  return renderToStaticMarkup(<PlatformNav />);
}

/** Texto del único link con aria-current="page" (o null si no hay). */
function activeLabels(html: string): string[] {
  return [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

describe("[EV0-P2] PlatformNav", () => {
  beforeEach(() => {
    pathname = "/plataforma";
  });

  it("muestra los 5 links con su href, dentro de un nav con aria-label", () => {
    const html = render("/plataforma");
    expect(html).toMatch(/<nav[^>]*aria-label="Secciones de Plataforma"/);
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "")]);
    expect(links).toEqual([
      ["/plataforma", "Resumen"],
      ["/plataforma/consultorios", "Consultorios"],
      ["/plataforma/ejercicios", "Ejercicios"],
      ["/plataforma/tags", "Tags"],
      ["/plataforma/catalogo/prestadoras", "Catálogo global"],
    ]);
    expect(PLATFORM_NAV_ITEMS).toHaveLength(5);
  });

  it("/plataforma activa solo Resumen (match exacto, no prefijo)", () => {
    expect(activeLabels(render("/plataforma"))).toEqual(["Resumen"]);
    expect(activeLabels(render("/plataforma/"))).toEqual(["Resumen"]);
  });

  it("/plataforma/consultorios/123 activa Consultorios por prefijo (y no Resumen)", () => {
    expect(activeLabels(render("/plataforma/consultorios/123"))).toEqual(["Consultorios"]);
  });

  it("/plataforma/catalogo/practicas activa Catálogo global aunque el link apunte a prestadoras", () => {
    expect(activeLabels(render("/plataforma/catalogo/practicas"))).toEqual(["Catálogo global"]);
  });

  it("ejercicios y tags por prefijo; un prefijo de texto sin segmento no matchea", () => {
    expect(activeLabels(render("/plataforma/ejercicios"))).toEqual(["Ejercicios"]);
    expect(activeLabels(render("/plataforma/tags"))).toEqual(["Tags"]);
    // "/plataforma/tagsx" no es la sección Tags: el match es por segmento.
    expect(isPlatformNavActive(PLATFORM_NAV_ITEMS[3], "/plataforma/tagsx")).toBe(false);
    expect(activeLabels(render("/plataforma/otra"))).toEqual([]);
  });

  it("pathname null (primer render fuera del router) no rompe ni activa nada", () => {
    pathname = null as unknown as string;
    expect(activeLabels(renderToStaticMarkup(<PlatformNav />))).toEqual([]);
  });
});
