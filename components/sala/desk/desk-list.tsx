"use client";

import type { SalaLive } from "@/components/sala/sala-live-types";

/**
 * A · «Lista y panel» (C-RX5). STUB de RX-1b: devuelve el contenedor vacío con las props del contrato; RX-2a lo
 * completa (franja `DeskStrip` arriba a todo el ancho, tabla «Turnos de hoy» con chips y línea de «ahora», panel
 * Sala de espera / Próximos 30 min / Por cobrar o En atención, CSS propio `DESK_LIST_CSS`).
 *
 * Las piezas comunes ya existen: `DeskStrip` (desk-strip.tsx), `DeskPrimaryAction`, `DeskMenu`, `DeskStateTag`
 * (desk-actions.tsx, conectadas por el shell vía `DeskActionsProvider`: no hace falta pasar callbacks).
 */
export function DeskList(p: {
  live: SalaLive;
  query: string;
  proFilter: string | null;
  onProFilter(id: string | null): void;
}): JSX.Element {
  void p;
  return <div className="desk-face desk-list" data-face="list" />;
}
