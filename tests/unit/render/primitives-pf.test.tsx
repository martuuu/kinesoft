/**
 * [PF1.0-b · C-PF6] Primitivas: Drawer/Modal en SSR (antes de hidratar se pintan en línea), capas de z-index por token,
 * Esc del drawer, `FormField layout="inline"`, `Switch` con área de toque de 44 px (y su re-export desde Configuración)
 * y `PageHeader`. Componentes reales, sin mocks del componente; el portal con «ya hidratado» está en
 * `primitives-portal.test.tsx`.
 *
 * Lo que depende del DOM vivo (foco atrapado y devuelto, el listener de Esc) se prueba en su decisión pura, que es lo
 * que corre adentro del listener (mismo criterio que `boz-ui.test.tsx`): `drawerHandlesEscape`, `modalOwnsEscape`,
 * `initialFocusTarget` y `overlayArmed` (el trap se arma recién con el panel en su lugar definitivo).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { Drawer, drawerHandlesEscape } from "@/components/ui/drawer";
import { Modal, modalOwnsEscape } from "@/components/ui/modal";
import { overlayArmed } from "@/components/ui/overlay-portal";
import { initialFocusTarget } from "@/hooks/use-focus-trap";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { Switch as ConfigSwitch } from "@/components/configuracion/controls";
import { PageHeader } from "@/components/ui/page-header";

const noop = () => {};
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const GLOBALS = read("app/globals.css");

function zToken(name: string): number {
  const m = GLOBALS.match(new RegExp(`--${name}:\\s*(\\d+)\\s*;`));
  if (!m) throw new Error(`falta --${name}`);
  return Number(m[1]);
}

describe("[PF1.0-b] Drawer y Modal antes de hidratar (SSR)", () => {
  it("se pintan en línea, con el contenido real (los render tests del resto de la app siguen viéndolo)", () => {
    const html = renderToStaticMarkup(
      <Drawer open onClose={noop} title="Nuevo turno">
        <p>cuerpo del drawer</p>
        <Modal open onClose={noop} title="Historial">
          <p>cuerpo del modal</p>
        </Modal>
      </Drawer>
    );
    expect(html).toMatch(/<aside[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Nuevo turno"/);
    expect(html).toContain("cuerpo del drawer");
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Historial"/);
    expect(html).toContain("cuerpo del modal");
  });

  it("cerrados no pintan nada", () => {
    expect(renderToStaticMarkup(<Drawer open={false} onClose={noop} title="A"><p>x</p></Drawer>)).toBe("");
    expect(renderToStaticMarkup(<Modal open={false} onClose={noop} title="A"><p>x</p></Modal>)).toBe("");
  });
});

describe("[PF1.0-b] capas: --z-drawer < --z-modal < --z-confirm < --z-toast", () => {
  it("los tokens existen y están en orden", () => {
    const backdrop = zToken("z-drawer-backdrop");
    const drawer = zToken("z-drawer");
    const modal = zToken("z-modal");
    const confirm = zToken("z-confirm");
    const toast = zToken("z-toast");
    expect(backdrop).toBeLessThan(drawer);
    expect(drawer).toBeLessThan(modal);
    expect(modal).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(toast);
  });

  it("Drawer y Modal usan los tokens (no números sueltos): el Modal queda sobre el Drawer", () => {
    const html = renderToStaticMarkup(
      <Drawer open onClose={noop} title="D">
        <Modal open onClose={noop} title="M">
          <p>m</p>
        </Modal>
      </Drawer>
    );
    expect(html).toContain("z-index:var(--z-drawer-backdrop)");
    expect(html).toContain("z-index:var(--z-drawer)");
    expect(html).toContain("z-index:var(--z-modal)");
    expect(html).not.toMatch(/z-index:\s*\d{2}/); // la X (z 1, dentro del panel) no cuenta
  });

  it("los números de ConfirmDialog (80) y Toast (90) coinciden con sus tokens (hasta que los adopten por handoff)", () => {
    expect(read("components/ui/confirm-dialog.tsx")).toMatch(new RegExp(`zIndex:\\s*(${zToken("z-confirm")}|"var\\(--z-confirm\\)")`));
    expect(read("components/ui/toast.tsx")).toMatch(new RegExp(`zIndex:\\s*(${zToken("z-toast")}|"var\\(--z-toast\\)")`));
  });
});

describe("[PF1.0-b] Esc y foco (decisiones puras de los listeners)", () => {
  it("drawerHandlesEscape: Esc libre cierra; un Esc ya consumido (Modal o confirmación encima) no", () => {
    expect(drawerHandlesEscape({ key: "Escape", defaultPrevented: false })).toBe(true);
    expect(drawerHandlesEscape({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(drawerHandlesEscape({ key: "Enter", defaultPrevented: false })).toBe(false);
  });

  it("modalOwnsEscape: el Modal portado desde un Drawer es el de arriba y se queda con el Esc", () => {
    const own = {};
    expect(modalOwnsEscape({ stack: [1, 2], id: 2, focusedDialog: own, ownDialog: own })).toBe(true);
    expect(modalOwnsEscape({ stack: [1, 2], id: 1, focusedDialog: null, ownDialog: own })).toBe(false);
  });

  it("overlayArmed: foco atrapado, Esc y scroll-lock solo con el overlay abierto Y ya en el portal", () => {
    expect(overlayArmed(true, true)).toBe(true);
    expect(overlayArmed(true, false)).toBe(false);
    expect(overlayArmed(false, true)).toBe(false);
  });

  it("initialFocusTarget (el trap de Drawer/Modal): un autoFocus adentro gana; si no, el primer focuseable", () => {
    const inside = {};
    const node = { contains: (el: unknown) => el === inside };
    expect(initialFocusTarget(node, inside, "primero")).toBeNull();
    expect(initialFocusTarget(node, null, "primero")).toBe("primero");
    expect(initialFocusTarget(node, null, undefined)).toBe(node);
  });
});

describe("[PF1.0-b] FormField layout", () => {
  it("default (stack): igual que antes, rótulo con nowrap y sin la clase inline", () => {
    const html = renderToStaticMarkup(<FormField label="Teléfono" name="phone" />);
    expect(html).toMatch(/^<div class="k-field" /);
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain('class="k-input"');
  });

  it('layout="inline": clase `k-field-inline`, el rótulo puede cortar línea y el control es el mismo `.k-input`', () => {
    const html = renderToStaticMarkup(
      <FormField label="Obra social del paciente" name="os" layout="inline" hint="Opcional" />
    );
    expect(html).toMatch(/^<div class="k-field k-field-inline" /);
    expect(html).not.toContain("white-space:nowrap");
    expect(html).toMatch(/<label for="[^"]+" class="k-label"/);
    expect(html).toContain('class="k-input"');
    expect(html).toContain('class="k-hint"');
  });

  it("el CSS de inline no achica el control (44 px / 16 px, D-VX13) y solo pone el rótulo a la izquierda desde 1024", () => {
    expect(GLOBALS).toMatch(/\.k-input \{[^}]*height: 44px;[^}]*font-size: 16px;/);
    const media = GLOBALS.slice(GLOBALS.indexOf("@media (min-width: 1024px) {\n  .k-field-inline"));
    expect(media).toMatch(/^@media \(min-width: 1024px\) \{\s*\.k-field-inline \{[^}]*grid-template-columns/);
    const inlineRules = GLOBALS.match(/\.k-field-inline[^{]*\{[^}]*\}/g) ?? [];
    expect(inlineRules.length).toBeGreaterThan(0);
    for (const r of inlineRules) expect(r).not.toMatch(/height|font-size/);
  });
});

describe("[PF1.0-b] Switch", () => {
  it("rol switch, estado y nombre accesible; Configuración re-exporta el mismo componente", () => {
    const html = renderToStaticMarkup(<Switch on onChange={noop} aria-label="Recordatorios por email" />);
    expect(html).toMatch(/<button type="button" role="switch" aria-checked="true" aria-label="Recordatorios por email"/);
    expect(renderToStaticMarkup(<Switch on={false} onChange={noop} disabled />)).toMatch(/aria-checked="false"[^>]*disabled/);
    expect(ConfigSwitch).toBe(Switch);
  });

  it("dibujo 52×30 y área de toque ≥ 44×44 por el pseudo-elemento", () => {
    const css = read("components/ui/switch.module.css");
    const base = css.match(/\.switch \{[^}]*\}/)![0];
    const w = Number(base.match(/width: (\d+)px/)![1]);
    const h = Number(base.match(/height: (\d+)px/)![1]);
    expect([w, h]).toEqual([52, 30]);
    const before = css.match(/\.switch::before \{[^}]*\}/)![0];
    const [dy, dx] = before.match(/inset: -?(\d+)px (-?\d+)/)!.slice(1).map((n) => Math.abs(Number(n)));
    expect(h + 2 * dy).toBeGreaterThanOrEqual(44);
    expect(w + 2 * dx).toBeGreaterThanOrEqual(44);
    // reducedMotion: sin transición, el estado final se ve igual.
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.switch,\s*\.thumb\s*\{\s*transition: none;/);
  });
});

describe("[PF1.0-b] PageHeader", () => {
  it("eyebrow + h1 + descripción + acciones", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        eyebrow="Panel del consultorio"
        title="Configuración"
        description="Datos del consultorio, equipo y plan."
        actions={<button type="button">Guardar</button>}
      />
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<header[^>]*>.*Panel del consultorio.*<h1[^>]*>Configuración<\/h1>.*Datos del consultorio.*Guardar/);
  });

  it("sin eyebrow, descripción ni acciones no deja contenedores vacíos", () => {
    const html = renderToStaticMarkup(<PageHeader title="Pacientes" />);
    expect(html.match(/<p/g)).toBeNull();
    expect(html.match(/<div/g)).toHaveLength(1);
  });

  it("server-safe: sin \"use client\" ni hooks", () => {
    const src = readFileSync(resolve(process.cwd(), "components/ui/page-header.tsx"), "utf8");
    expect(src).not.toMatch(/^"use client"/m);
    expect(src).not.toMatch(/\buse(State|Effect|Ref|Context|Hydrated)\b/);
  });
});
