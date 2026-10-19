"use client";

/**
 * [FC-3e2] Panel del menú «⋯» de la ficha. DIFERIDO (§24.9 «panel del menú»): la tarjeta pinta solo el botón y este
 * archivo se baja al primer click (o al pasar el mouse / enfocar el botón, ver `preloadFichaMenu` en note-card).
 *
 * Presentacional a propósito: los ítems los calcula `fichaMenuItems` (ficha-card-logic.ts) y las acciones las corre la
 * tarjeta en `onSelect`, SINCRÓNICO dentro del click. Eso importa para «Guardar en la carpeta»: el permiso del File
 * System Access se pide al principio del gesto (§24.6); si el panel hiciera un `await` antes, Chrome lo rechaza.
 *
 * Teclado (patrón WAI-ARIA «menu button»): al abrir, foco en el primer ítem; ↑/↓ en ronda, Inicio/Fin; Esc cierra y
 * devuelve el foco al botón; Tab cierra (sale del menú). Click afuera cierra. Sin animación: con reducedMotion el
 * estado final es el mismo.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { FichaMenuItem, FichaMenuItemId } from "@/components/fichas/ficha-card-logic";

export type FichaMenuProps = {
  id: string;
  /** Etiqueta del menú (`aria-labelledby` del botón no alcanza: el botón es un ícono). */
  label: string;
  items: readonly FichaMenuItem[];
  onSelect: (id: FichaMenuItemId) => void;
  /** `restoreFocus`: Esc sí (el foco vuelve al botón), click afuera / Tab no (el usuario ya lo movió). */
  onClose: (restoreFocus: boolean) => void;
  /** El botón «⋯»: un mousedown sobre él no cuenta como «afuera» (lo maneja su propio toggle). */
  triggerRef?: RefObject<HTMLElement | null>;
};

const itemStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 36,
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--navy-700)",
  borderRadius: 8,
  cursor: "pointer",
};

export function FichaMenu({ id, label, items, onSelect, onClose, triggerRef }: FichaMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef?.current?.contains(t)) return;
      onClose(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose, triggerRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const step = menuKeyStep(e.key, at, all.length);
    if (step === "close") {
      e.preventDefault();
      onClose(true);
    } else if (step === "tab") {
      onClose(false);
    } else if (typeof step === "number") {
      e.preventDefault();
      all[step]?.focus();
    }
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="menu"
      aria-label={label}
      className="k-glass-strong"
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        minWidth: 230,
        borderRadius: 12,
        padding: 4,
        zIndex: 25,
        display: "grid",
      }}
    >
      {items.map((it) => (
        <div key={it.id} role="none" style={it.separatorBefore ? { borderTop: "1px solid var(--navy-100)", marginTop: 4, paddingTop: 4 } : undefined}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-item={it.id}
            onClick={() => onSelect(it.id)}
            style={it.danger ? { ...itemStyle, color: "var(--danger-fg)" } : itemStyle}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Puro (lo prueba el render test): tecla → índice al que mover el foco, cerrar, o nada. */
export function menuKeyStep(key: string, at: number, count: number): number | "close" | "tab" | null {
  if (count === 0) return key === "Escape" ? "close" : null;
  switch (key) {
    case "ArrowDown":
      return at < 0 ? 0 : (at + 1) % count;
    case "ArrowUp":
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "Escape":
      return "close";
    case "Tab":
      return "tab";
    default:
      return null;
  }
}
