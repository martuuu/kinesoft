"use client";

/**
 * Atajo ⌘K / Ctrl+K del workspace (PF1.0-a, C-PF2).
 *
 * Por qué existe: `CommandPalette` se montaba siempre en el AppShell para escuchar el atajo, y con eso su código (la
 * búsqueda, los grupos, la llamada a `globalSearch`) viajaba en el bundle inicial de TODAS las rutas de `(app)`. Ahora
 * el shell solo lleva este listener; el panel se baja con `next/dynamic` la primera vez que se abre y se desmonta al
 * cerrar (montado = abierto, ver `command-palette.tsx`).
 *
 * Precarga (para que el atajo no espere red): al apretar ⌘ o Ctrl (el atajo viene enseguida) y en hover/foco de los
 * disparadores visibles (buscador del topbar y de la barra móvil, vía `preloadCommandPalette`). El buscador del
 * dashboard dispara el MISMO evento de teclado (`openCommandPalette`), así que no necesita conocer este módulo.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

const loadPalette = () => import("@/components/global/command-palette");

/** `import()` sin await: deja el chunk en camino (C-PF2, precarga en hover/foco). */
export function preloadCommandPalette(): void {
  void loadPalette();
}

/** Abre el ⌘K desde un botón: el mismo evento que escucha el launcher (y que usa el buscador del dashboard). */
export function openCommandPalette(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
}

/** ¿Es el atajo que abre/cierra el ⌘K? Puro, para el unit test. */
export function isPaletteToggle(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
}

const CommandPalette = dynamic(() => loadPalette().then((m) => m.CommandPalette), {
  ssr: false,
  // Capa fija sobre toda la pantalla: no desplaza nada mientras llega (CLS 0). Sin esqueleto: el chunk se precarga
  // al apretar ⌘/Ctrl y en el hover/foco de los buscadores, así que en la práctica ya está.
  loading: () => null,
});

export function CommandPaletteLauncher() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteToggle(e)) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Meta" || e.key === "Control") preloadCommandPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return open ? <CommandPalette onClose={close} /> : null;
}
