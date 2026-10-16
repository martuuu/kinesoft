/**
 * [MB-0d · C-MB2] Primitivas bajo 768 / 640 y tokens mobile.
 *
 * - Drawer < 640: hoja a pantalla completa, encabezado sticky con el cierre de 44×44 y pie sticky con safe-area.
 *   Entre 640 y 1023 y en escritorio, como antes (mismas medidas, ahora en `.k-drawer-panel` en vez de inline: un
 *   estilo inline no se puede pisar desde una media query).
 * - Modal < 640: alto máximo con `dvh`, scroll interno y acciones (`ModalActions`) apiladas a ancho completo.
 * - Toast < 768: abajo y centrado sobre `--k-bottom-nav-h`. Escritorio: arriba a la derecha como siempre, salvo con un
 *   Drawer abierto (pf1z-toast-tapa-drawer: tapaba la X del drawer): ahí se corre a la izquierda.
 * - Tokens de safe-area, barra inferior y las utilidades `.k-tap` / `.k-fab` / `.k-vh-full`.
 *
 * Vitest en `node` (sin jsdom, como el resto de `tests/unit/render`): markup real por SSR + el CSS real de
 * `app/globals.css` (sin comentarios) + las decisiones puras que corren en los efectos. Lo que depende del layout
 * vivo (medidas a 390) lo mide el revisor B con Playwright.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/ui/confirm-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/confirm-dialog")>();
  return { ...actual, useConfirm: () => vi.fn(async () => true) };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/plataforma",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// Marcador visible del registro del SW (el real devuelve null y solo actúa en un efecto).
vi.mock("@/components/pwa/sw-register", () => ({ SwRegister: () => <i data-sw-register="" /> }));

import { Drawer, drawerOpenMark } from "@/components/ui/drawer";
import { Modal, ModalActions } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastRegion } from "@/components/ui/toast";
import { PlatformShell } from "@/components/plataforma/platform-shell";

const noop = () => {};
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const GLOBALS = read("app/globals.css");

/** Cuerpo de la primera regla `selector { … }` dentro de `@media (<query>)`. */
function ruleIn(query: string | null, selector: string): string {
  let scope = GLOBALS;
  if (query) {
    const blocks = [...GLOBALS.matchAll(new RegExp(`@media \\(${query.replace(/[()]/g, "\\$&")}\\)\\s*\\{`, "g"))];
    scope = blocks
      .map((b) => {
        // Recorta el bloque balanceando llaves.
        let depth = 0;
        const start = b.index! + b[0].length - 1;
        for (let i = start; i < GLOBALS.length; i++) {
          if (GLOBALS[i] === "{") depth++;
          else if (GLOBALS[i] === "}" && --depth === 0) return GLOBALS.slice(start + 1, i);
        }
        return "";
      })
      .join("\n");
  }
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = scope.match(new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`falta la regla ${selector}${query ? ` en @media (${query})` : ""}`);
  return m[1].replace(/\s+/g, " ");
}

describe("[MB-0d] tokens y utilidades (C-MB2)", () => {
  it("safe-area, alto de la barra inferior (0 por defecto) y su capa debajo del backdrop del Drawer", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(GLOBALS).toMatch(new RegExp(`--safe-${side}:\\s*env\\(safe-area-inset-${side},\\s*0px\\);`));
    }
    expect(GLOBALS).toMatch(/--k-bottom-nav-h:\s*0px;/);
    const z = (n: string) => Number(GLOBALS.match(new RegExp(`--${n}:\\s*(\\d+)\\s*;`))![1]);
    expect(z("z-bottom-nav")).toBe(30);
    expect(z("z-bottom-nav")).toBeLessThan(z("z-drawer-backdrop"));
  });

  it("con la barra inferior montada, `--k-bottom-nav-h` vale su alto también fuera del shell (toast por portal)", () => {
    expect(ruleIn("max-width: 767px", ":root:has([data-k-bottom-nav]:not([hidden]))")).toContain(
      "--k-bottom-nav-h: calc(56px + env(safe-area-inset-bottom, 0px))"
    );
  });

  it(".k-tap ≥ 44×44 y .k-fab de 56 px sobre la barra inferior, con anillo de foco", () => {
    const tap = ruleIn(null, ".k-tap");
    expect(tap).toContain("min-width: 44px");
    expect(tap).toContain("min-height: 44px");
    const fab = ruleIn(null, ".k-fab");
    expect(fab).toContain("width: 56px");
    expect(fab).toContain("height: 56px");
    expect(fab).toContain("bottom: calc(var(--k-bottom-nav-h) + 16px)");
    expect(fab).toContain("right: 16px");
    expect(fab).toContain("position: fixed");
    expect(fab).toMatch(/box-shadow: /);
    expect(ruleIn(null, ".k-fab:focus-visible")).toContain("var(--focus-ring)");
  });

  it(".k-vh-full: 100dvh con 100vh de respaldo (nada de 100vh solo)", () => {
    const r = ruleIn(null, ".k-vh-full");
    expect(r.indexOf("min-height: 100vh")).toBeGreaterThanOrEqual(0);
    expect(r.indexOf("min-height: 100dvh")).toBeGreaterThan(r.indexOf("min-height: 100vh"));
  });
});

describe("[MB-0d] Drawer < 640 a pantalla completa (C-MB2)", () => {
  const html = renderToStaticMarkup(
    <Drawer open onClose={noop} title="Nuevo turno">
      <input aria-label="Paciente" />
      <div data-drawer-footer="">
        <button type="button">Guardar</button>
      </div>
    </Drawer>
  );

  it("misma API y mismo diálogo; el ancho va por variable (default 480) y las medidas por clase", () => {
    expect(html).toMatch(/<aside[^>]*tabindex="-1"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Nuevo turno"/);
    expect(html).toContain("k-drawer-panel");
    expect(html).toContain("--k-drawer-width:480px");
    expect(html).not.toMatch(/<aside[^>]*style="[^"]*(?:top:12px|border-radius:22px)/);
    const custom = renderToStaticMarkup(<Drawer open onClose={noop} width={640}><p>x</p></Drawer>);
    expect(custom).toContain("--k-drawer-width:640px");
  });

  it("encabezado con el cierre ANTES que el contenido (primer focuseable del trap) y el título adentro", () => {
    const head = html.match(/<div class="k-drawer-head"[^>]*>([\s\S]*?)<\/div>/)![1];
    expect(head).toMatch(/<button[^>]*class="k-drawer-close"[^>]*aria-label="Cerrar"/);
    expect(head).toContain(">Nuevo turno</h2>");
    expect(html.indexOf("k-drawer-close")).toBeLessThan(html.indexOf('aria-label="Paciente"'));
    // Sin título, el encabezado igual existe (en el celular el cierre sticky es el único camino visible).
    const bare = renderToStaticMarkup(<Drawer open onClose={noop}><p>x</p></Drawer>);
    expect(bare).toMatch(/<div class="k-drawer-head"[^>]*>\s*<button[^>]*k-drawer-close/);
    expect(bare).not.toContain("<h2");
  });

  it("escritorio y tablet: las medidas de siempre (12 px de margen, radio 22, padding 22, X de 32 a 16/16)", () => {
    const panel = ruleIn(null, ".k-drawer-panel");
    for (const d of ["top: 12px", "right: 12px", "bottom: 12px", "width: var(--k-drawer-width, 480px)", "max-width: calc(100vw - 24px)", "border-radius: 22px", "padding: 22px"]) {
      expect(panel).toContain(d);
    }
    const close = ruleIn(null, ".k-drawer-close");
    expect(close).toContain("position: absolute");
    expect(close).toContain("width: 32px");
    expect(close).toContain("height: 32px");
    // Relativo al encabezado, que arranca en el padding (22): 22 − 6 = 16 px del borde, como `ModalCloseButton`.
    expect(close).toContain("top: -6px");
    expect(close).toContain("right: -6px");
  });

  it("< 640: inset 0, sin radio, encabezado sticky con safe-area y cierre de 44×44", () => {
    const panel = ruleIn("max-width: 639px", ".k-drawer-panel");
    expect(panel).toContain("inset: 0");
    expect(panel).toContain("width: auto");
    expect(panel).toContain("max-width: none");
    expect(panel).toContain("border-radius: 0");
    expect(panel).toContain("var(--safe-left)");
    expect(panel).toContain("var(--safe-right)");
    const head = ruleIn("max-width: 639px", ".k-drawer-head");
    expect(head).toContain("position: sticky");
    expect(head).toContain("var(--safe-top)");
    const close = ruleIn("max-width: 639px", ".k-drawer-close");
    expect(close).toContain("width: 44px");
    expect(close).toContain("height: 44px");
    expect(close).toContain("position: static");
  });

  it("< 640: el pie marcado (`data-drawer-footer`) deja el indicador de inicio libre", () => {
    expect(ruleIn("max-width: 639px", ".k-drawer-panel [data-drawer-footer]")).toContain(
      "padding-bottom: max(16px, env(safe-area-inset-bottom))"
    );
  });

  it("drawerOpenMark: cuenta drawers abiertos en el <html> (el toast se corre) y publica el alto del pie", () => {
    const props = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string | undefined>,
      style: {
        setProperty: (k: string, v: string) => void props.set(k, v),
        removeProperty: (k: string) => void props.delete(k),
      },
    };
    drawerOpenMark(root, +1);
    expect(root.dataset.kDrawerOpen).toBe("1");
    drawerOpenMark(root, +1, 72.4);
    expect(root.dataset.kDrawerOpen).toBe("2");
    expect(props.get("--k-drawer-footer-h")).toBe("73px");
    drawerOpenMark(root, -1);
    expect(root.dataset.kDrawerOpen).toBe("1");
    drawerOpenMark(root, -1);
    expect(root.dataset.kDrawerOpen).toBeUndefined();
    expect(props.has("--k-drawer-footer-h")).toBe(false);
    // Nunca negativo (un cleanup de más no deja la marca colgada).
    drawerOpenMark(root, -1);
    expect(root.dataset.kDrawerOpen).toBeUndefined();
  });
});

describe("[MB-0d] Modal < 640 (C-MB2)", () => {
  it("panel con clase propia; < 640 alto máximo 100dvh − 32 con scroll interno", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={noop} title="Cobrar">
        <p>x</p>
        <ModalActions>
          <button type="button">Cancelar</button>
          <button type="button">Cobrar</button>
        </ModalActions>
      </Modal>
    );
    expect(html).toContain("k-modal-panel");
    expect(html).toMatch(/<div class="k-modal-actions">\s*<button[^>]*>Cancelar/);
    const panel = ruleIn("max-width: 639px", ".k-modal-panel");
    expect(panel).toContain("max-height: calc(100dvh - 32px)");
    // El alto inline (escritorio) va por variable para que la media query lo pueda pisar; el fondo deja 16 px.
    expect(panel).toContain("--k-modal-max-h: calc(100dvh - 32px)");
    expect(html).toContain("max-height:var(--k-modal-max-h, calc(100dvh - 40px))");
    expect(ruleIn("max-width: 639px", ".k-modal-backdrop")).toContain("--k-modal-pad: 16px");
    expect(panel).toContain("overflow-y: auto");
  });

  it("acciones: en fila a la derecha; < 640 apiladas a ancho completo y de 44 px", () => {
    const row = ruleIn(null, ".k-modal-actions");
    expect(row).toContain("display: flex");
    expect(row).toContain("justify-content: flex-end");
    expect(ruleIn("max-width: 639px", ".k-modal-actions")).toContain("flex-direction: column");
    const child = ruleIn("max-width: 639px", ".k-modal-actions > *");
    expect(child).toContain("width: 100%");
    expect(child).toContain("min-height: 44px");
  });

  it("la confirmación usa las mismas acciones (apiladas en el celular) sin perder foco ni marca", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog state={{ title: "¿Descartar?", confirmLabel: "Descartar" }} onCancel={noop} onConfirm={noop} />
    );
    expect(html).toMatch(/<div class="k-modal-actions"[^>]*>[\s\S]*Cancelar[\s\S]*data-confirm-accept/);
    expect(html).toMatch(/<div[^>]*tabindex="-1"[^>]*data-confirm-panel/);
  });
});

describe("[MB-0d] Toast (C-MB2 + pf1z-toast-tapa-drawer)", () => {
  const html = renderToStaticMarkup(
    <ToastRegion>
      <p>t</p>
    </ToastRegion>
  );

  it("región viva con clase y token de capa; sin posición inline (la da el CSS por ancho)", () => {
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*class="k-toaster"/);
    expect(html).toContain("z-index:var(--z-toast)");
    expect(html).not.toMatch(/top:16px|right:16px/);
  });

  it("escritorio: arriba a la derecha como siempre", () => {
    const r = ruleIn(null, ".k-toaster");
    expect(r).toContain("top: 16px");
    expect(r).toContain("right: 16px");
    expect(r).toContain("width: min(360px, calc(100vw - 32px))");
  });

  it("≥ 768 con un Drawer abierto: a la izquierda (no tapa la X ni el encabezado del drawer)", () => {
    const r = ruleIn("min-width: 768px", "html[data-k-drawer-open] .k-toaster");
    expect(r).toContain("left: 16px");
    expect(r).toContain("right: auto");
  });

  it("< 768: abajo y centrado sobre la barra inferior; con un Drawer, sobre su pie", () => {
    const r = ruleIn("max-width: 767px", ".k-toaster");
    expect(r).toContain("top: auto");
    expect(r).toContain("bottom: calc(var(--k-bottom-nav-h) + 12px)");
    expect(r).toContain("width: min(100% - 24px, 420px)");
    expect(r).toContain("margin-inline: auto");
    const withDrawer = ruleIn("max-width: 767px", "html[data-k-drawer-open] .k-toaster");
    expect(withDrawer).toContain("var(--k-drawer-footer-h, 0px)");
  });
});

describe("[MB-0d] PlatformShell", () => {
  it("monta el registro del SW y usa 100dvh con respaldo (sin 100vh inline)", () => {
    const html = renderToStaticMarkup(
      <PlatformShell name="Marta Admin" email="a@b.c" hasHome={false} support={null} endSupportAction={null}>
        <p>c</p>
      </PlatformShell>
    );
    expect(html).toContain("data-sw-register");
    expect(html).toMatch(/<div class="k-app k-vh-full"/);
    expect(html).not.toContain("min-height:100vh");
  });
});
