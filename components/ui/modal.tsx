"use client";

import { useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, modalVariants } from "@/lib/motion";

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
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  // BO-Z C2: Esc cierra SOLO el modal de arriba. Antes era un listener en burbuja sobre `document` que no frenaba el
  // evento: con un Modal abierto sobre un Drawer (p. ej. el de re-verificación de Plataforma sobre «Editar
  // suscripción»), un Esc cerraba el Modal Y el Drawer, y con dos Modales cerraba los dos. Mismo molde que
  // confirm-dialog.tsx: CAPTURA sobre `window` (corre antes que el Drawer, que escucha en burbuja) + preventDefault +
  // stopImmediatePropagation. «De arriba» = el último Modal abierto (`openModals`) y, si el foco está en OTRO
  // diálogo modal (un `useConfirm` abierto encima, que hace autoFocus), se lo deja a él.
  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          role="dialog"
          aria-modal
          aria-label={title}
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
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <m.div
            ref={trapRef}
            tabIndex={-1}
            className="k-glass-strong k-scroll"
            onClick={(e) => e.stopPropagation()}
            variants={modalVariants}
            style={{
              position: "relative",
              width: typeof width === "number" ? `min(${width}px, 100%)` : width,
              maxHeight: "calc(100dvh - 40px)",
              overflowY: "auto",
              borderRadius: 24,
              padding: 22,
              outline: "none",
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
  );
}
