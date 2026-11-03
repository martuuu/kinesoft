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
 *
 * [CF2-ZF4] El diálogo (`ConfirmDialog`, con framer, `Button` y el trap) vive en `./confirm-dialog-panel` y baja con
 * `import()`: este provider está en el first load de todas las rutas con sesión y el diálogo solo se ve al confirmar.
 * Se pide en un idle apenas monta y, si alguien confirma antes de que llegue, al pedir la confirmación (la promesa ya
 * era asíncrona: el diálogo aparece cuando está el chunk). Si el chunk no baja, la confirmación resuelve `false` (nunca
 * queda colgada ni ejecuta la acción sin confirmar) y se reintenta en la próxima.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

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

type DialogModule = typeof import("./confirm-dialog-panel");
let dialogModule: DialogModule | undefined;
let dialogLoad: Promise<DialogModule> | undefined;
/** Exportada para los render tests (`renderToStaticMarkup` no corre effects). */
export function loadConfirmDialog(): Promise<DialogModule> {
  dialogLoad ??= import("./confirm-dialog-panel").then(
    (mod) => (dialogModule = mod),
    (err) => {
      dialogLoad = undefined;
      throw err;
    }
  );
  return dialogLoad;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const [, setDialogReady] = useState(Boolean(dialogModule));
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

  // [CF2-ZF4] El diálogo: en un idle al montar y, sí o sí, cuando llega una confirmación sin el chunk.
  const pendingConfirm = state !== null;
  useEffect(() => {
    if (dialogModule) return;
    let alive = true;
    const go = () =>
      loadConfirmDialog().then(
        () => alive && setDialogReady(true),
        (err: unknown) => {
          if (!alive || !pendingConfirm) return;
          console.error("[confirm] no se pudo cargar el diálogo:", err);
          settle(false);
        }
      );
    if (pendingConfirm) {
      void go();
      return () => {
        alive = false;
      };
    }
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback : null;
    const id = ric ? ric(() => void go().catch(() => {}), { timeout: 4000 }) : window.setTimeout(() => void go().catch(() => {}), 1500);
    return () => {
      alive = false;
      if (ric) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, [pendingConfirm, settle]);

  const Dialog = dialogModule?.ConfirmDialog;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {Dialog ? <Dialog state={state} onCancel={cancel} onConfirm={accept} /> : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
