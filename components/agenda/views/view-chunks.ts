/**
 * [MB-Z-F2] Qué chunks de `next/dynamic` necesita cada vista de la agenda para dibujarse (puro, testeable).
 *
 * Por qué existe: el revisor B midió CLS 0,16-0,18 a 360/390 en Semana, Lista y Recepción (y en el drawer, que se
 * abre sobre Lista); Día y «Por profesional» con un solo profesional (que cae en Día) daban 0. La diferencia: esas
 * vistas son `next/dynamic` (PF1-Z las sacó del first load) y Día no. `next/dynamic` las envuelve en un
 * `<Suspense fallback={null}>`; el HTML del server llega completo, pero al hidratar el `import()` del chunk recién
 * arranca, la frontera queda «deshidratada» y el primer update de prioridad normal que le llega antes de que baje el
 * chunk (las preferencias de Apariencia hidratadas en el effect de `TweaksProvider`, la visibilidad de localStorage,
 * `setLayoutNow` del mount) la obliga a renderizar en el cliente: React borra el HTML del server, muestra el
 * fallback (nada) y lo vuelve a pintar cuando llega el chunk. La leyenda de servicios (un DIV sin clase de ~143 px a
 * 360) subía a y≈354 y volvía a bajar. En escritorio la Semana no se movía porque su contenedor tiene alto fijo;
 * Lista sí (0,03-0,05). `SsrHold` (`./ssr-hold.tsx`) congela el HTML del server hasta que estos chunks están.
 */
export type AgendaViewChunk = "practitioner" | "room" | "week-grid" | "week-list" | "list" | "reception";

/** Día (`timeline`) es import estático: no espera nada. Una vista desconocida tampoco (no se congela). */
export const AGENDA_VIEW_CHUNKS: Readonly<Record<string, readonly AgendaViewChunk[]>> = {
  timeline: [],
  practitioner: ["practitioner"],
  room: ["room"],
  // < 768 se ve la lista por día y ≥ 768 la grilla: se dibujan las dos y elige el CSS (MB-1a).
  week: ["week-grid", "week-list"],
  list: ["list"],
  reception: ["reception"],
};

export function agendaViewChunks(view: string): readonly AgendaViewChunk[] {
  return AGENDA_VIEW_CHUNKS[view] ?? [];
}

/** true = todos los chunks de la vista ya están en el registro del bundler (se puede soltar el HTML del server). */
export function agendaViewChunksReady(view: string, loaded: ReadonlySet<AgendaViewChunk>): boolean {
  return agendaViewChunks(view).every((c) => loaded.has(c));
}
