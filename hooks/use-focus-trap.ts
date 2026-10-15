"use client";

/**
 * Minimal focus trap for modals and drawers.
 *
 *   - On open: focuses the first focusable element inside the container
 *     (or the container itself if it has tabIndex), unless focus is already
 *     inside (an `autoFocus` child wins). Remembers the
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

/**
 * BO-Z C1 (puro, para el test): a dónde va el foco al abrir. null = no se mueve (ya está adentro: ganó un
 * `autoFocus`); si no, el primer focuseable o el contenedor.
 */
export function initialFocusTarget<N extends { contains(el: never): boolean }, E>(
  node: N,
  active: unknown,
  first: E | undefined
): E | N | null {
  if (active && node.contains(active as never)) return null;
  return first ?? node;
}

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
    // BO-Z C1: si el foco YA está adentro (un `autoFocus` del contenido, p. ej. el input del código de MFA o el
    // primer campo de un form), no se lo pisa: antes este efecto corría después del autoFocus y mandaba el foco al
    // primer focuseable (la X de cerrar), y el usuario tenía que hacer clic en el campo para tipear.
    initialFocusTarget(node, document.activeElement, focusables()[0])?.focus();

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
