"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, drawerVariants } from "@/lib/motion";
import { OverlayPortal, overlayArmed } from "@/components/ui/overlay-portal";
import { useHydrated } from "@/components/ui/use-hydrated";

/** Pura (para el test): ¿este Esc cierra el drawer? No si ya lo consumió un overlay de arriba (Modal, ConfirmDialog). */
export function drawerHandlesEscape(e: { key: string; defaultPrevented: boolean }): boolean {
  return e.key === "Escape" && !e.defaultPrevented;
}

/**
 * Right-side sliding drawer.
 *
 * Use this instead of a modal when the content is contextual to the
 * underlying view (e.g. a booking preview overlaid on the calendar).
 * The page behind stays visible and the drawer slides in from the right.
 *
 * Escape + outside-click close the drawer. Body scroll is locked while
 * open so the page underneath doesn't reflow. Enter/exit animated via
 * framer-motion AnimatePresence.
 *
 * Dirty-guard (A2b-S-ui): con `dirty` en true, Esc / click en el fondo / la X
 * piden confirmación antes de cerrar ("¿Descartar los cambios?"). Antes un Esc
 * de más o un click fuera del panel tiraba el formulario de turno o de paciente
 * a medio cargar. Los botones propios del formulario ("Cancelar") siguen
 * llamando a `onClose` directo: ahí la intención de descartar es explícita.
 * Un Esc que ya consumió otro overlay (p. ej. el `ConfirmDialog`, que corta la
 * propagación) no cierra el drawer; por las dudas también se respeta
 * `defaultPrevented`.
 *
 * PF1.0-b (C-PF6): portal a `document.body` (`OverlayPortal`). Un `Modal` abierto desde el drawer ya no queda
 * encerrado por el `transform` del panel y queda por encima (`--z-drawer` < `--z-modal`). Foco atrapado, Esc y
 * scroll-lock se arman recién con el panel en su lugar definitivo (`overlayArmed`): un drawer abierto en SSR pasa de
 * en línea a portal al hidratar, y el trap tiene que apuntar al nodo nuevo.
 */
export function Drawer({
  open,
  onClose,
  title,
  // Default sized so a two-column form fits without sideways scrolling
  // (22px padding each side eats 44px of it).
  width = 480,
  dirty = false,
  dirtyMessage,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  /** Hay cambios sin guardar: cerrar con Esc / fondo / X pide confirmación. */
  dirty?: boolean;
  /** Texto del aviso de descarte (default genérico). */
  dirtyMessage?: string;
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  const armed = overlayArmed(open, hydrated);
  const trapRef = useFocusTrap<HTMLElement>(armed);
  const offset = width + 24;
  const confirm = useConfirm();
  // Evita apilar dos confirmaciones (Esc + click en el fondo seguidos).
  const asking = useRef(false);

  const requestClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirm({
        title: "¿Descartar los cambios?",
        message: dirtyMessage ?? "Tenés cambios sin guardar. Si cerrás, se pierden.",
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  }, [dirty, dirtyMessage, onClose, confirm]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (drawerHandlesEscape(e)) void requestClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [armed, requestClose]);

  return (
    <OverlayPortal>
      <AnimatePresence>
        {open && (
          <>
            {/* backdrop */}
            <m.div
              onClick={() => void requestClose()}
              aria-hidden
              variants={backdropVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(15,30,51,0.32)",
                backdropFilter: "blur(2px)",
                zIndex: "var(--z-drawer-backdrop)",
              }}
            />
            {/* panel — slides in from the right */}
            <m.aside
              ref={trapRef}
              tabIndex={-1}
              role="dialog"
              aria-modal
              aria-label={title}
              className="k-glass-strong k-scroll k-overlay-panel k-drawer-panel"
              custom={offset}
              variants={drawerVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: "fixed",
                top: 12,
                right: 12,
                bottom: 12,
                width,
                maxWidth: "calc(100vw - 24px)",
                borderRadius: 22,
                padding: 22,
                overflowY: "auto",
                zIndex: "var(--z-drawer)",
              }}
            >
              <ModalCloseButton onClose={() => void requestClose()} />
              {title && (
                <header style={{ marginRight: 40, marginBottom: 16 }}>
                  <h2 className="k-display" style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
                    {title}
                  </h2>
                </header>
              )}
              {children}
            </m.aside>
          </>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
