import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * CF3 ZF3 (hallazgos B del revisor de UI). Sin jsdom, lo que no se puede ejercitar con `renderToStaticMarkup` (un menú
 * que solo existe abierto, CSS de media queries, mensajes de acciones que solo tiran contra la DB) se fija sobre el
 * fuente real que corre en prod.
 */
const src = (p: string) => readFileSync(p, "utf8");

describe("[CF3-ZF3-6] menú por fila de Turnos con teclado", () => {
  const tv = src("components/patients/profile/views/turnos-view.tsx");
  const menu = tv.slice(tv.indexOf("function TurnoActionsMenu("));

  it("[CF3-ZF3-6a] foco al primer ítem al abrir, flechas/Esc/Tab con menuKeyStep y Esc devuelve el foco", () => {
    expect(tv).toContain('import { menuKeyStep } from "@/components/fichas/ficha-menu";');
    expect(menu).toMatch(/if \(open\) menuItems\(menuRef\.current\)\[0\]\?\.focus\(\)/);
    expect(menu).toMatch(/onKeyDown=\{onMenuKeyDown\}/);
    expect(menu).toMatch(/step === "close"[\s\S]*close\(true\)/);
    expect(menu).toMatch(/triggerRef\.current\?\.focus\(\)/);
    // Roving: los ítems no entran al Tab de la página (se llega con flechas).
    expect(menu.match(/role="menuitem" tabIndex=\{-1\}/g)?.length).toBe(2);
  });

  it("[CF3-ZF3-5b] el botón «Opciones ▾» / «⋯» no fija 30 px inline (le ganaba a la pasada de 44 px)", () => {
    expect(menu).not.toMatch(/minHeight: 30/);
    expect(menu).not.toMatch(/width: 30, height: 30/);
    const css = src("components/patients/contact-actions.module.css");
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{\s*\.rowMenuTrigger \{\s*min-height: 44px;\s*\}\s*\.rowMenuDots \{\s*width: 44px;\s*height: 44px;/);
  });
});

describe("[CF3-ZF3-7b] contraste del hint de servicios", () => {
  it(".pse-hint usa --navy-500 (11 px en --navy-300 no llega a AA)", () => {
    const css = src("components/configuracion/panels/practitioners/services-editor.tsx");
    expect(css).toMatch(/\.pse \.pse-hint \{ font-size: 11px; color: var\(--navy-500\); \}/);
  });
});

describe("[CF3-ZF3-9] contadores de «Sitio web»", () => {
  it("sin aria-live (anunciaba en cada tecla) y con id para describir al campo", () => {
    const site = src("components/configuracion/panels/site-panel.tsx");
    const counters = site.match(/<div id="site-(tagline|description)-count" className=\{`\$\{styles\.counter\}[^>]*>/g) ?? [];
    expect(counters).toHaveLength(2);
    for (const c of counters) expect(c).not.toContain("aria-live");
  });
});

describe("[CF3-ZF3-11] permisos en voseo, sin roles en inglés", () => {
  it("salas y coberturas de los profesionales nombran el permiso «Configuración»", () => {
    expect(src("lib/rooms.ts")).toContain('"Solo quien tiene permiso de «Configuración» puede configurar las salas."');
    expect(src("lib/practitioner-payers.ts")).toContain(
      '"Solo quien tiene permiso de «Configuración» puede configurar las coberturas de los profesionales."'
    );
    expect(src("lib/rooms.ts")).not.toMatch(/"Solo OWNER\/ADMIN/);
    expect(src("lib/practitioner-payers.ts")).not.toMatch(/"Solo OWNER\/ADMIN/);
  });
});
