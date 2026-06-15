"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, modalVariants } from "@/lib/motion";

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
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
          <motion.div
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
