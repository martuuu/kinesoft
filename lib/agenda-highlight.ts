/**
 * Resaltado de la agenda (P3-C, ES3 · contrato `AgendaHighlight` de PLANES §15).
 *
 * Antes era un `highlightedServiceId: string | null` que cada vista comparaba a
 * mano contra `b.serviceId`. Planes suma la leyenda "Plan / Suelto" (S19b), que
 * **reusa el resaltado** (plan §3.4): no filtra, levanta los turnos que
 * coinciden y atenúa el resto (AGENTS §5: la opacidad es el filtro). Por eso el
 * resaltado pasa a ser una unión y la regla vive en un solo lugar: las vistas
 * preguntan `highlightState(highlight, b)` y no saben qué tipo de resaltado es.
 *
 * Puro (sin React ni reloj): lo importan las vistas, la leyenda y los tests.
 *
 * Regla de los campos C9 (opcionales en `BookingDTO`, patrón B4.1): si el turno
 * no los trae (`programId === undefined`, proyección completa), un resaltado de
 * plan o de suelto **no lo cuenta como coincidencia**: no se adivina (misma
 * regla que `isOutOfPlan` de `lib/plan-display.ts`). La agenda siempre trae la
 * proyección liviana, expandida con `expandPlanFields` (`agenda-utils.ts`), así
 * que ahí `programId` es `string | null`.
 */
import type { Discipline } from "@/lib/plans-constants";

export type AgendaHighlight =
  /** Leyenda de servicios (lo de siempre). */
  | { kind: "service"; serviceId: string }
  /**
   * Turnos de un plan (`programId` no nulo). Con `discipline`, solo los del
   * plan de esa disciplina (un legacy sin disciplina no coincide); sin ella,
   * cualquier plan.
   */
  | { kind: "plan"; discipline?: Discipline }
  /** Turnos sueltos (`programId === null`). */
  | { kind: "loose" };

/** Lo mínimo del turno que mira el resaltado (lo cumplen `BookingDTO` y `DrawerBooking`). */
export type HighlightableBooking = {
  serviceId: string;
  programId?: string | null;
  plan?: { discipline: Discipline | null } | null;
};

/** `none` = no hay resaltado activo; `match` = se levanta; `dimmed` = se atenúa. */
export type HighlightState = "none" | "match" | "dimmed";

export function matchesHighlight(h: AgendaHighlight, b: HighlightableBooking): boolean {
  switch (h.kind) {
    case "service":
      return b.serviceId === h.serviceId;
    case "plan":
      if (typeof b.programId !== "string") return false; // null = suelto; undefined = sin C9
      return h.discipline === undefined || b.plan?.discipline === h.discipline;
    case "loose":
      return b.programId === null;
  }
}

export function highlightState(h: AgendaHighlight | null, b: HighlightableBooking): HighlightState {
  if (h == null) return "none";
  return matchesHighlight(h, b) ? "match" : "dimmed";
}

/** Alguno de los turnos coincide (la celda de Semana se levanta si hay uno). */
export function anyHighlightMatch(h: AgendaHighlight, bookings: readonly HighlightableBooking[]): boolean {
  return bookings.some((b) => matchesHighlight(h, b));
}

export function sameHighlight(a: AgendaHighlight | null, b: AgendaHighlight | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a.kind !== b.kind) return false;
  if (a.kind === "service") return a.serviceId === (b as { serviceId: string }).serviceId;
  if (a.kind === "plan") return a.discipline === (b as { discipline?: Discipline }).discipline;
  return true;
}

/**
 * Click en un ítem de la leyenda: selección única; el mismo ítem activo lo
 * apaga (conducta de la leyenda de servicios desde siempre).
 */
export function toggleHighlight(prev: AgendaHighlight | null, next: AgendaHighlight): AgendaHighlight | null {
  return sameHighlight(prev, next) ? null : next;
}
