"use client";

import { createContext, useContext, useState } from "react";
import dynamic from "next/dynamic";

/**
 * «Pantallas» en /sala (TV-2w2, brief §26.4): el botón que abre el drawer de las pantallas de la sala (TV-2w1).
 *
 * - Va en los DOS headers (Tablero en `sala-header.tsx`, Lista y Flujo en `desk/desk-header.tsx`) a través de un
 *   contexto que provee `SalaClient`: así ningún header suma props ni el permiso viaja por las caras, que son chunks
 *   aparte (C-PF2). Sin provider (tests, demo) el default es `canManage: false` → no hay botón.
 * - `canManage` = `agenda.operateAll` sin sesión de soporte (lo calcula la page; el módulo `salaEspera` ya lo exige
 *   el layout). El server lo vuelve a exigir en cada action (`lib/reception-displays.ts`): esto solo esconde.
 * - El drawer entra por `next/dynamic` y SOLO se monta después del primer click: el bundle de /sala está al tope
 *   (§26.10, ≤ 155,6 kB) y un import estático lo sumaría entero a la ruta (lo vigila el test de fuente). Hover/foco
 *   precargan el chunk, como «Vista» con las caras. `ssr: false`: cerrado no tiene nada que pintar en el server.
 * - `k-btn-sm`: 40 px en desktop, 44 px en mobile (target táctil, `globals.css`).
 */
export const DisplaysContext = createContext<{ canManage: boolean }>({ canManage: false });

const loadDrawer = () => import("./displays-drawer");
const DisplaysDrawer = dynamic(() => loadDrawer().then((mod) => mod.DisplaysDrawer), { ssr: false });

export function DisplaysButton() {
  const { canManage } = useContext(DisplaysContext);
  const [open, setOpen] = useState(false);
  // Una vez montado queda montado: cerrar no desmonta (la animación de salida y el estado del drawer viven ahí).
  const [mounted, setMounted] = useState(false);
  if (!canManage) return null;

  const preload = () => {
    void loadDrawer().catch(() => {});
  };

  return (
    <>
      <button
        type="button"
        className="k-btn k-btn-ghost k-btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        onPointerEnter={preload}
        onFocus={preload}
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
        <span>Pantallas</span>
      </button>
      {mounted && <DisplaysDrawer open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
