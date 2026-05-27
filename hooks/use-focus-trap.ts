"use client";

/**
 * Minimal focus trap for modals and drawers.
 *
 *   - On open: focuses the first focusable element inside the container
 *     (or the container itself if it has tabIndex). Remembers the
 *     previously-focused element so we can restore it on close.
 *   - While open: Tab and Shift+Tab cycle within the container — focus
 *     can't escape to the page underneath.
 *   - On close: restores focus to whatever was focused before.
 *
 * Intentionally lightweight (no `focus-trap` dep, ~50 LOC). Covers the
 * common case; doesn't handle exotic widgets like virtual lists or
 * shadow DOM. Pair with `aria-modal` on the container.
 */
import { useEffect, useRef } from "react";

const SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prevActive = document.activeElement as HTMLElement | null;

    // Focus the first focusable child, or the container itself.
    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(SELECTOR)).filter(
        (el) => !el.hasAttribute("data-focus-trap-skip")
      );
    const initial = focusables()[0] ?? node;
    initial.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (current === first || !node.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last || !node.contains(current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // Restore focus only if the previously-focused element still exists.
      if (prevActive && document.contains(prevActive)) {
        try {
          prevActive.focus();
        } catch {
          // ignore
        }
      }
    };
  }, [active]);

  return ref;
}
