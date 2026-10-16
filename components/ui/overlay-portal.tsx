"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHydrated } from "@/components/ui/use-hydrated";

/**
 * [PF1.0-b · C-PF6] Portal de los overlays del design system (`Drawer`, `Modal`) a `document.body`.
 *
 * Por qué: el panel del `Drawer` entra con `transform` (framer). Un `position: fixed` adentro (un `Modal` abierto desde
 * el drawer del turno, p. ej. el «Historial» de EV2) quedaba atado al panel y no a la ventana, y además el `Modal`
 * (z 40) quedaba debajo del drawer (z 46). EV2-Z lo esquivó escondiendo «Ver versiones anteriores» en el drawer y
 * `plan-edit-dialogs.tsx` portaba a mano. Ahora el portal es de la primitiva: todo overlay es hijo directo de `body` y
 * el orden lo dan los tokens `--z-drawer` < `--z-modal` < `--z-confirm` < `--z-toast` de `globals.css`.
 *
 * Antes de hidratar (SSR y el render de hidratación) se pinta EN LÍNEA: `createPortal` no existe en el renderer del
 * server, y los render tests (`renderToStaticMarkup`, sin DOM) siguen viendo el contenido real del diálogo. El primer
 * frame de un overlay abierto en SSR es invisible igual (las variantes de framer arrancan en opacity 0). Después de
 * hidratar, portal. Los eventos de React siguen burbujeando por el árbol de React (contextos, `useConfirm`, toasts):
 * solo cambia el padre en el DOM.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  if (!hydrated || typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}

/** ¿El overlay está activo (foco atrapado, Esc, scroll-lock)? Solo abierto Y ya en su lugar definitivo (portal). */
export function overlayArmed(open: boolean, hydrated: boolean): boolean {
  return open && hydrated;
}
