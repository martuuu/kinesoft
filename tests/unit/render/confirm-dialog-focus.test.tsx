/**
 * [PF1-Z-F2 · hallazgo 5] La confirmación (`useConfirm`) atrapa y devuelve el foco. Antes no usaba `useFocusTrap`:
 * tras Esc/Cancelar el foco quedaba en <body> y Tab seguía por la página con el Drawer de abajo abierto.
 *
 * Sin jsdom (entorno node): se prueba el componente real en SSR (el panel es el contenedor del trap, con tabIndex -1,
 * y el botón de aceptar está marcado) y la decisión pura del foco inicial (`focusConfirmAccept`), que es lo que corre
 * en el efecto. El trap en sí (Tab cíclico + devolver el foco al cerrar) es `useFocusTrap`, el mismo de Drawer/Modal.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog, focusConfirmAccept } from "@/components/ui/confirm-dialog";

const noop = () => {};

describe("[PF1-Z-F2] ConfirmDialog: foco atrapado y devuelto", () => {
  it("el panel es el contenedor del trap (tabIndex -1) dentro del diálogo modal; el botón de aceptar va marcado", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        state={{ title: "¿Eliminar turno?", confirmLabel: "Eliminar", tone: "danger" }}
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<div[^>]*tabindex="-1"[^>]*data-confirm-panel/);
    expect(html).toMatch(/<button[^>]*data-confirm-accept[^>]*>Eliminar<\/button>/);
    expect(html).toContain("Cancelar");
  });

  it("cerrado no pinta nada", () => {
    expect(renderToStaticMarkup(<ConfirmDialog state={null} onCancel={noop} onConfirm={noop} />)).toBe("");
  });

  it("focusConfirmAccept: lleva el foco al botón de aceptar del panel (el trap ya guardó al que abrió)", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    focusConfirmAccept({ querySelector });
    expect(querySelector).toHaveBeenCalledWith("[data-confirm-accept]");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("focusConfirmAccept: sin panel o sin botón no rompe", () => {
    expect(() => focusConfirmAccept(null)).not.toThrow();
    expect(() => focusConfirmAccept({ querySelector: () => null })).not.toThrow();
  });
});
