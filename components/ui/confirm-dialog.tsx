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

function ConfirmDialog({
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
            zIndex: 80,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <m.div
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
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <Button variant="ghost" onClick={onCancel}>
                {state.cancelLabel ?? "Cancelar"}
              </Button>
              <Button
                variant="primary"
                onClick={onConfirm}
                autoFocus
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
