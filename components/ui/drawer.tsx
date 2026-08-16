"use client";

import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, drawerVariants } from "@/lib/motion";

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
 */
export function Drawer({
  open,
  onClose,
  title,
  // Default sized so a two-column form fits without sideways scrolling
  // (22px padding each side eats 44px of it).
  width = 480,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  children: ReactNode;
}) {
  const trapRef = useFocusTrap<HTMLElement>(open);
  const offset = width + 24;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* backdrop */}
          <motion.div
            onClick={onClose}
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
              zIndex: 45,
            }}
          />
          {/* panel — slides in from the right */}
          <motion.aside
            ref={trapRef}
            tabIndex={-1}
            role="dialog"
            aria-modal
            aria-label={title}
            className="k-glass-strong k-scroll"
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
              zIndex: 46,
              boxShadow: "0 32px 64px rgba(15,30,51,0.18)",
              outline: "none",
            }}
          >
            <ModalCloseButton onClose={onClose} />
            {title && (
              <header style={{ marginRight: 40, marginBottom: 16 }}>
                <h2 className="k-display" style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
                  {title}
                </h2>
              </header>
            )}
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
