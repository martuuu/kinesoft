"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * [PF1.0-b · C-PF6] ¿Ya hidrató React en el browser?
 *
 * `useSyncExternalStore` y no `useState(false)` + `useEffect`: durante la hidratación React usa el snapshot del server
 * (`false`, igual que el HTML: sin mismatch) y re-renderiza con `true`; pero un componente que se monta DESPUÉS de
 * hidratar (un Drawer que aparece con `{open && <Drawer/>}`) lee `true` en su primer render. Con el par
 * useState/useEffect ese Drawer se pintaba primero en línea y en el frame siguiente se movía al portal: React lo
 * desmontaba y volvía a montar (estado del form perdido, autoFocus y efectos dos veces).
 *
 * Módulo aparte para que el test de portal pueda simular «ya hidratado» sin DOM (es una sonda del entorno, como la
 * cookie: no es el símbolo bajo test).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}
