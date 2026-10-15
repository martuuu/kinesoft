"use client";

import type { SalaLive } from "@/components/sala/sala-live-types";

/**
 * B · «Flujo» (C-RX5). STUB de RX-1b: devuelve el contenedor vacío con las props del contrato; RX-2b lo completa
 * (línea de tiempo «Hoy» a la izquierda a todo el alto, `DeskStrip` a la derecha y tres carriles: Llegan pronto,
 * Sala de espera y Por cobrar o En atención; CSS propio `DESK_FLOW_CSS`).
 *
 * Las piezas comunes ya existen: `DeskStrip` (desk-strip.tsx), `DeskPrimaryAction`, `DeskMenu`, `DeskStateTag`
 * (desk-actions.tsx, conectadas por el shell vía `DeskActionsProvider`: no hace falta pasar callbacks).
 */
export function DeskFlow(p: {
  live: SalaLive;
  query: string;
  proFilter: string | null;
  onProFilter(id: string | null): void;
}): JSX.Element {
  void p;
  return <div className="desk-face desk-flow" data-face="flow" />;
}
