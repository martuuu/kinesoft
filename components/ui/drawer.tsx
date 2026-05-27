"use client";

import { useEffect, type ReactNode } from "react";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { useFocusTrap } from "@/hooks/use-focus-trap";

/**
 * Right-side sliding drawer.
 *
 * Use this instead of a modal when the content is contextual to the
 * underlying view (e.g. a booking preview overlaid on the calendar).
 * The page behind stays visible and the drawer slides in from the right.
 *
 * Escape + outside-click close the drawer. Body scroll is locked while
 * open so the page underneath doesn't reflow.
 */
export function Drawer({
  open,
  onClose,
  title,
  width = 420,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  children: ReactNode;
}) {
  const trapRef = useFocusTrap<HTMLElement>(open);

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
    <>
      {/* backdrop — fades in/out */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15,30,51,0.32)",
          backdropFilter: open ? "blur(2px)" : "none",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 180ms ease",
          zIndex: 45,
        }}
      />
      {/* panel — slides in from the right */}
      <aside
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label={title}
        className="k-glass-strong k-scroll"
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
          transform: open ? "translateX(0)" : `translateX(calc(${width}px + 24px))`,
          transition: "transform 220ms cubic-bezier(.2,.8,.2,1)",
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
      </aside>
    </>
  );
}
