import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MB-0c · barra de navegación inferior (C-MB1, variante fija MB-D1).
 *
 * Qué se cuida: `<nav aria-label="Navegación principal">` con `<Link>`, `aria-current="page"` sobre el destino activo
 * (el mismo `activeNavHref` del sidebar), «Más» como `<button aria-haspopup="dialog" aria-expanded>`, el teclado
 * virtual la oculta (lógica pura `isVirtualKeyboardOpen` + el atributo que lee el CSS), y el CSS: solo bajo 768 px,
 * 56 px + safe-area, z-index del token, targets ≥ 48 px, sin animación de entrada/salida.
 */
const nav = vi.hoisted(() => ({ pathname: "/sala" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { BottomNav, isEditableTarget, isVirtualKeyboardOpen } from "@/components/layout/bottom-nav";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const SECRETARIA = Array.from(capabilitiesFor("ASSISTANT"));
const css = readFileSync(join(process.cwd(), "components/layout/bottom-nav.module.css"), "utf8");

function render(p: { pathname?: string; defaultMoreOpen?: boolean; defaultKeyboardOpen?: boolean } = {}) {
  nav.pathname = p.pathname ?? "/sala";
  return renderToStaticMarkup(
    <TenantModulesProvider modules={KINE}>
      <BottomNav
        caps={SECRETARIA}
        isPlatformAdmin={false}
        defaultMoreOpen={p.defaultMoreOpen}
        defaultKeyboardOpen={p.defaultKeyboardOpen}
      />
    </TenantModulesProvider>
  );
}

describe("[MB-0c] BottomNav: markup y a11y", () => {
  it("nav principal con 4 links (Inicio, Agenda, Sala, Pacientes) y «Más» como botón de diálogo", () => {
    const html = render();
    expect(html).toMatch(/<nav [^>]*aria-label="Navegación principal"/);
    const hrefs = Array.from(html.matchAll(/<a [^>]*href="([^"]+)"/g), (m) => m[1]);
    expect(hrefs).toEqual(["/dashboard", "/agenda", "/sala", "/pacientes"]);
    for (const l of ["Inicio", "Agenda", "Sala", "Pacientes", "Más"]) expect(html).toContain(`>${l}<`);
    expect(html).toMatch(/<button [^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>/);
  });

  it("aria-current=\"page\" solo en el destino activo (también en subrutas)", () => {
    for (const [path, href] of [
      ["/sala", "/sala"],
      ["/pacientes/abc/historia", "/pacientes"],
      ["/agenda", "/agenda"],
    ] as const) {
      const html = render({ pathname: path });
      expect(html.match(/aria-current="page"/g), path).toHaveLength(1);
      expect(html.match(/<a [^>]*aria-current="page"[^>]*>/)?.[0], path).toContain(`href="${href}"`);
    }
    // Una ruta que no está en la barra (Planes): ningún destino activo.
    expect(render({ pathname: "/planes" })).not.toContain('aria-current="page"');
  });

  it("«Más» refleja el estado del menú en aria-expanded", () => {
    expect(render({ defaultMoreOpen: true })).toMatch(/<button [^>]*aria-expanded="true"/);
  });

  it("teclado virtual abierto: la barra queda marcada para ocultarse (el CSS la saca de la pantalla)", () => {
    const navTag = (html: string) => html.match(/<nav [^>]*>/)?.[0] ?? "";
    expect(navTag(render())).toContain("data-k-bottom-nav");
    expect(navTag(render())).not.toMatch(/\shidden/);
    expect(navTag(render({ defaultKeyboardOpen: true }))).toMatch(/\shidden=""/);
    // `.bar { display: flex }` le gana al [hidden] del navegador: el CSS lo repite.
    expect(css).toMatch(/\.bar\[hidden\]\s*\{\s*display:\s*none;/);
    // Y globals.css (MB-0d) baja `--k-bottom-nav-h` a 0 cuando la barra está oculta.
    const globals = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(globals).toContain(":root:has([data-k-bottom-nav]:not([hidden]))");
  });
});

describe("[MB-0c] detección del teclado virtual (pura)", () => {
  const input = (type = "text") => ({ tagName: "INPUT", type, isContentEditable: false });
  it("con un campo de texto enfocado y el viewport visual < 75 % del alto: teclado abierto", () => {
    expect(isVirtualKeyboardOpen({ editable: true, viewportHeight: 400, innerHeight: 844 })).toBe(true);
    expect(isVirtualKeyboardOpen({ editable: true, viewportHeight: 700, innerHeight: 844 })).toBe(false);
    // Sin foco en un campo (zoom con pellizco achica el viewport visual): no es el teclado.
    expect(isVirtualKeyboardOpen({ editable: false, viewportHeight: 400, innerHeight: 844 })).toBe(false);
  });
  it("qué cuenta como campo que abre teclado", () => {
    expect(isEditableTarget(input())).toBe(true);
    expect(isEditableTarget(input("search"))).toBe(true);
    expect(isEditableTarget(input("checkbox"))).toBe(false);
    expect(isEditableTarget(input("radio"))).toBe(false);
    expect(isEditableTarget({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("[MB-0c] BottomNav: CSS (C-MB1)", () => {
  it("oculta en escritorio; fija abajo solo bajo 768 px, 56 px + safe-area, z-index del token", () => {
    expect(css).toMatch(/\.bar\s*\{\s*display:\s*none;\s*\}/);
    const media = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(media).toMatch(/\.bar\s*\{[^}]*display:\s*flex;/);
    expect(media).toMatch(/position:\s*fixed;/);
    expect(media).toMatch(/height:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\);/);
    expect(media).toMatch(/z-index:\s*var\(--z-bottom-nav, 30\);/);
  });

  it("targets ≥ 48×48 y sin transición de entrada/salida de la barra", () => {
    expect(css).toMatch(/\.item\s*\{[^}]*min-height:\s*48px;[^}]*min-width:\s*48px;/);
    const bar = css.match(/@media \(max-width: 767px\)\s*\{\s*\.bar\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(bar).not.toMatch(/transition|animation/);
  });
});
