"use client";

import { useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, modalVariants } from "@/lib/motion";
import { OverlayPortal, overlayArmed } from "@/components/ui/overlay-portal";
import { useHydrated } from "@/components/ui/use-hydrated";

/** Modales abiertos, en orden de apertura (para que Esc cierre solo el de arriba, BO-Z C2). */
const openModals: number[] = [];
let modalSeq = 0;

/**
 * BO-Z C2 (puro, para el test): ¿este Modal se queda con el Esc? Solo si es el último abierto y el foco no está en
 * OTRO diálogo modal (un `useConfirm` encima). Foco en el body o en este mismo diálogo → sí.
 */
export function modalOwnsEscape(p: {
  stack: readonly number[];
  id: number;
  focusedDialog: unknown | null;
  ownDialog: unknown | null;
}): boolean {
  if (p.stack[p.stack.length - 1] !== p.id) return false;
  return !(p.focusedDialog && p.ownDialog && p.focusedDialog !== p.ownDialog);
}

/**
 * Standard centered modal.
 *
 *   - Glass-strong card with consistent radius + padding.
 *   - X button positioned absolute top-right via `ModalCloseButton`.
 *   - Escape closes. Click-on-backdrop closes (unless `lockBackdrop`).
 *   - Body scroll locked while open.
 *   - Animated open/close (fade + scale) via framer-motion. For the close
 *     animation to play, keep `<Modal open={x} />` mounted and toggle
 *     `open` rather than conditionally mounting the element.
 *
 * Pre-Sprint 12 every screen rolled its own modal markup (10+ callsites).
 * This primitive collapses them to one source of truth.
 *
 * PF1.0-b (C-PF6): portal a `document.body` (`OverlayPortal`) y z-index de token (`--z-modal`, por encima de
 * `--z-drawer`). Antes un Modal abierto desde un Drawer quedaba adentro del panel (que tiene `transform`: el
 * `position: fixed` se ataba al panel) y DEBAJO de él (z 40 contra 46). Foco, Esc y scroll-lock se arman con el
 * diálogo ya en su lugar definitivo (`overlayArmed`).
 *
 * MB-0d (C-MB2): bajo 640 px el panel (`.k-modal-panel`) va a `100dvh − 32` de alto máximo (16 px de aire arriba y
 * abajo) con scroll interno, y las acciones envueltas en `ModalActions` se apilan a ancho completo y 44 px. El alto y
 * el padding del fondo siguen inline (escritorio igual que antes) pero a través de `--k-modal-max-h` / `--k-modal-pad`:
 * un estilo inline le gana a cualquier media query, una variable que la media query redefine no.
 */
export function Modal({
  open = true,
  onClose,
  title,
  description,
  children,
  width = 520,
  lockBackdrop = false,
}: {
  open?: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  width?: number | string;
  lockBackdrop?: boolean;
}) {
  const hydrated = useHydrated();
  const armed = overlayArmed(open, hydrated);
  const trapRef = useFocusTrap<HTMLDivElement>(armed);

  // BO-Z C2: Esc cierra SOLO el modal de arriba. Antes era un listener en burbuja sobre `document` que no frenaba el
  // evento: con un Modal abierto sobre un Drawer (p. ej. el de re-verificación de Plataforma sobre «Editar
  // suscripción»), un Esc cerraba el Modal Y el Drawer, y con dos Modales cerraba los dos. Mismo molde que
  // confirm-dialog.tsx: CAPTURA sobre `window` (corre antes que el Drawer, que escucha en burbuja) + preventDefault +
  // stopImmediatePropagation. «De arriba» = el último Modal abierto (`openModals`) y, si el foco está en OTRO
  // diálogo modal (un `useConfirm` abierto encima, que hace autoFocus), se lo deja a él.
  useEffect(() => {
    if (!armed) return;
    const id = ++modalSeq;
    openModals.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const focusedDialog = (document.activeElement as HTMLElement | null)?.closest?.("[aria-modal]") ?? null;
      const ownDialog = trapRef.current?.closest("[aria-modal]") ?? null;
      if (!modalOwnsEscape({ stack: openModals, id, focusedDialog, ownDialog })) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = openModals.indexOf(id);
      if (i >= 0) openModals.splice(i, 1);
      document.body.style.overflow = prev;
    };
    // `trapRef` es estable (useRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, onClose]);

  return (
    <OverlayPortal>
      <AnimatePresence>
        {open && (
          <m.div
            role="dialog"
            aria-modal
            aria-label={title}
            className="k-modal-backdrop"
            onClick={lockBackdrop ? undefined : onClose}
            variants={backdropVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15,30,51,0.45)",
              backdropFilter: "blur(4px)",
              zIndex: "var(--z-modal)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "var(--k-modal-pad, 20px)",
            }}
          >
            <m.div
              ref={trapRef}
              tabIndex={-1}
              className="k-glass-strong k-scroll k-overlay-panel k-modal-panel"
              onClick={(e) => e.stopPropagation()}
              variants={modalVariants}
              style={{
                position: "relative",
                width: typeof width === "number" ? `min(${width}px, 100%)` : width,
                maxHeight: "var(--k-modal-max-h, calc(100dvh - 40px))",
                overflowY: "auto",
                borderRadius: 24,
                padding: 22,
              }}
            >
              <ModalCloseButton onClose={onClose} />
              {(title || description) && (
                <header style={{ marginBottom: 14, paddingRight: 40 }}>
                  {title && (
                    <h2 className="k-display" style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p
                      style={{
                        marginTop: 6,
                        marginBottom: 0,
                        fontSize: 13,
                        color: "var(--navy-500)",
                      }}
                    >
                      {description}
                    </p>
                  )}
                </header>
              )}
              {children}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}

/**
 * [MB-0d · C-MB2] Fila de acciones de un Modal (o de la confirmación): a la derecha en escritorio; < 640 apiladas a
 * ancho completo y 44 px de alto, en el orden del DOM (la primaria, última, queda abajo, a mano del pulgar).
 * Los llamadores la adoptan en sus sesiones de MB-1 en lugar de su `<div style={{ display: "flex", … }}>`.
 */
export function ModalActions({ children }: { children: React.ReactNode }) {
  return <div className="k-modal-actions">{children}</div>;
}
