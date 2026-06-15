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
 * / "Cancelar" resolve `false`; the confirm button resolves `true`.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
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

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog state={state} onCancel={() => settle(false)} onConfirm={() => settle(true)} />
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
  return (
    <AnimatePresence>
      {state && (
        <motion.div
          key="confirm-backdrop"
          role="dialog"
          aria-modal
          aria-label={state.title}
          onClick={onCancel}
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") onConfirm();
          }}
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
          <motion.div
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
                    ? { background: "#9F1F1F", boxShadow: "0 4px 14px rgba(159,31,31,0.3)" }
                    : undefined
                }
              >
                {state.confirmLabel ?? "Confirmar"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
