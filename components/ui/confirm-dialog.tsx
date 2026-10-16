"use client";

/**
 * Promise-based confirmation dialog — the in-house replacement for the
 * native `window.confirm()` (which can't be styled and breaks the visual
 * language of the app).
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "¿Eliminar turno?", tone: "danger",
 *                       confirmLabel: "Eliminar" })) { ... }
 *
 * Renders a single shared `<Modal>`-style dialog driven by promise state,
 * so any number of callsites reuse one mounted instance. Escape / backdrop
 * / "Cancelar" resolve `false`; the confirm button resolves `true`. Escape
 * no se propaga a overlays de abajo (Drawer, menús): ver el efecto del diálogo.
 *
 * Foco (PF1-Z-F2): el panel es un `useFocusTrap` (Tab cicla adentro y, al cerrar, el foco vuelve al elemento que lo
 * abrió). Antes no había trap: tras Esc/Cancelar el foco quedaba en <body> y Tab seguía por la página con el Drawer de
 * abajo abierto.
 */
import { AnimatePresence, m } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, modalVariants } from "@/lib/motion";

type ConfirmTone = "default" | "danger";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setState(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setState(null);
  }, []);

  const cancel = useCallback(() => settle(false), [settle]);
  const accept = useCallback(() => settle(true), [settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog state={state} onCancel={cancel} onConfirm={accept} />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

/**
 * PF1-Z-F2 (puro, para el test): foco inicial en el botón de aceptar. No se usa `autoFocus`: React lo aplica en el
 * commit, ANTES del efecto del trap, y el trap guardaba como «elemento a devolver» al propio botón del confirm (que se
 * desmonta) en vez del que abrió el diálogo. Así el trap captura primero al que abrió y después se enfoca el botón.
 */
export function focusConfirmAccept(
  panel: { querySelector(sel: string): { focus(): void } | null } | null
): void {
  panel?.querySelector("[data-confirm-accept]")?.focus();
}

export function ConfirmDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmOptions | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const danger = state?.tone === "danger";
  const open = !!state;
  // Orden de efectos (importa): primero el del trap (guarda `document.activeElement` = el que abrió y enfoca el
  // primer focuseable), después este, que pasa el foco a «Confirmar» como hacía el viejo `autoFocus`.
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  useEffect(() => {
    if (open) focusConfirmAccept(trapRef.current);
    // `trapRef` es estable (useRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Esc cierra SOLO este diálogo (A2b-S-ui). Antes el keydown del backdrop no
  // frenaba el evento y el listener de `window` del Drawer de abajo también lo
  // veía: un Esc cancelaba la confirmación Y cerraba el drawer (perdiendo el
  // formulario). Se escucha en fase de CAPTURA sobre `window` — corre antes que
  // cualquier listener en burbuja (Drawer, menús) — y se corta la propagación.
  // Enter queda en manos del botón enfocado: el viejo handler de Enter en el
  // backdrop confirmaba aunque el foco estuviera en "Cancelar".
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);
  return (
    <AnimatePresence>
      {state && (
        <m.div
          key="confirm-backdrop"
          role="dialog"
          aria-modal
          aria-label={state.title}
          onClick={onCancel}
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,30,51,0.45)",
            backdropFilter: "blur(4px)",
            zIndex: "var(--z-confirm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <m.div
            ref={trapRef}
            tabIndex={-1}
            data-confirm-panel
            className="k-glass-strong"
            onClick={(e) => e.stopPropagation()}
            variants={modalVariants}
            style={{
              width: "min(420px, 100%)",
              borderRadius: 20,
              padding: 22,
            }}
          >
            <h2 className="k-display" style={{ fontSize: 18, margin: 0, fontWeight: 700, color: "var(--navy-900)" }}>
              {state.title}
            </h2>
            {state.message && (
              <p style={{ marginTop: 8, marginBottom: 0, fontSize: 13.5, color: "var(--navy-500)", lineHeight: 1.5 }}>
                {state.message}
              </p>
            )}
            {/* MB-0d (C-MB2): misma fila que `ModalActions` (sin importar modal.tsx: este archivo va en los providers de la raíz); < 640 apilada a ancho completo y 44 px (antes dos botones
                chicos lado a lado en el celular). Escritorio: igual (flex a la derecha, gap 8, 20 arriba). */}
            <div className="k-modal-actions">
              <Button variant="ghost" onClick={onCancel}>
                {state.cancelLabel ?? "Cancelar"}
              </Button>
              <Button
                variant="primary"
                onClick={onConfirm}
                data-confirm-accept
                style={
                  danger
                    ? { background: "var(--danger-fg)", boxShadow: "0 4px 14px rgba(159,31,31,0.3)" }
                    : undefined
                }
              >
                {state.confirmLabel ?? "Confirmar"}
              </Button>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
