/**
 * [PF1.1-agenda-a] Lógica pura de la celda (columna × franja) de "Por profesional" / "Por sala" y de la fila densa
 * del Día. Vivía en `components/agenda/grid/slot-cell.tsx` (un `"use client"` con JSX): moverla acá la deja testeable
 * sin jsdom y saca a `timeline-view.tsx` de la dependencia de la celda (el Día no usa `SlotCell`, solo estas
 * funciones). `slot-cell.tsx` las re-exporta para no tocar llamadores ni tests viejos.
 *
 * Sin dependencias de React ni del DOM (brief PF §3.1, fila Agenda).
 */
import type { SlotCell as SlotCellData } from "@/lib/agenda-layout";
import { matchesHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import { isOutOfPlan } from "@/lib/plan-display";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/** Cards visibles por celda antes del "+N más". */
export function visibleCardLimit(density: "comfortable" | "compact"): number {
  return density === "compact" ? 3 : 4;
}

/** Texto del estado para lectores de pantalla y tooltip. */
export function slotStateText(cell: Pick<SlotCellData, "state" | "used" | "cap" | "blockReason" | "overbooked">): string {
  switch (cell.state) {
    case "bloqueado":
      return cell.blockReason ? `bloqueado: ${cell.blockReason}` : "bloqueado";
    case "fuera-de-horario":
      return cell.used > 0 ? `fuera de horario, ${cell.used} ${cell.used === 1 ? "turno" : "turnos"}` : "fuera de horario";
    case "sobreturno":
      return cell.cap == null
        ? `con sobreturno, ${cell.used} ${cell.used === 1 ? "turno" : "turnos"}`
        : `con sobreturno, ${cell.used} de ${cell.cap}`;
    case "lleno":
      return `lleno, ${cell.used} de ${cell.cap}`;
    case "parcial":
      return cell.cap == null
        ? `${cell.used} ${cell.used === 1 ? "turno" : "turnos"}, sin tope de cupo`
        : `${cell.used} de ${cell.cap} lugares ocupados`;
    default:
      return "libre";
  }
}

/**
 * "Fuera de plan" de un turno del DTO de la agenda: la MISMA regla que la card
 * (S19a, `isOutOfPlan` de `lib/plan-display.ts`, V2 de C13b), con
 * `hasPatient = patientId !== null`. Sin el módulo `planes` el DTO trae
 * `patientActiveLinkedPlanDisciplines: []` (C9 neutro) → siempre `false`.
 */
export function bookingOutOfPlan(b: BookingDTO): boolean {
  return isOutOfPlan({ ...b, hasPatient: b.patientId !== null });
}

export type DenseOverflow<B> = {
  /** Cards a dibujar, en orden (con resaltado, primero las que coinciden). */
  shown: B[];
  /** Cuántas quedan detrás del "+N más". */
  hidden: number;
  /** De las ocultas, cuántas coinciden con el resaltado activo (0 sin resaltado). */
  hiddenMatches: number;
  /** De las ocultas, cuántas son "Fuera de plan". */
  hiddenOutOfPlan: number;
};

/**
 * Qué cards se ven en una franja densa (S19e, ES3). Lo comparten la celda de
 * "Por profesional" y la fila de la vista Día.
 *
 * Problema que resuelve: en el gimnasio de kinesio hay 5-10 turnos por franja
 * y solo se ven 3-4 (Por profesional) o 10 (Día) antes del "+N más". El
 * resaltado de la leyenda (servicio, plan, suelto) NO filtra: levanta lo que
 * coincide y atenúa el resto. Si lo que coincide quedaba detrás del "+N más",
 * la Secretaria apretaba "Plan" y la franja se veía toda atenuada aunque
 * hubiera turnos de plan. Por eso, con resaltado activo, las cards que
 * coinciden pasan ADELANTE (partición estable: dentro de cada grupo se
 * conserva el orden del caller, que es por hora). Sin resaltado, el orden no
 * se toca.
 *
 * Lo que igual queda oculto se cuenta (coincidencias y "Fuera de plan") para
 * que el botón "+N más" lo diga: un aviso no se puede esconder detrás de un
 * contador mudo.
 */
export function denseOverflow<B extends BookingDTO>(
  bookings: readonly B[],
  limit: number,
  expanded: boolean,
  highlight: AgendaHighlight | null
): DenseOverflow<B> {
  const ordered =
    highlight == null
      ? bookings.slice()
      : [...bookings.filter((b) => matchesHighlight(highlight, b)), ...bookings.filter((b) => !matchesHighlight(highlight, b))];
  const shown = expanded ? ordered : ordered.slice(0, limit);
  const rest = ordered.slice(shown.length);
  return {
    shown,
    hidden: rest.length,
    hiddenMatches: highlight == null ? 0 : rest.filter((b) => matchesHighlight(highlight, b)).length,
    hiddenOutOfPlan: rest.filter(bookingOutOfPlan).length,
  };
}

/**
 * Texto del botón "+N más". Visible corto (la columna compacta mide 164 px):
 * con resaltado activo dice cuántas de las ocultas coinciden; si no, cuántas
 * son "Fuera de plan". El aria-label dice todo.
 */
export function overflowButtonText(
  o: Pick<DenseOverflow<unknown>, "hidden" | "hiddenMatches" | "hiddenOutOfPlan">,
  highlightActive: boolean,
  where: string
): { text: string; ariaLabel: string } {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  let suffix = "";
  if (highlightActive && o.hiddenMatches > 0) suffix = ` · ${plural(o.hiddenMatches, "resaltado", "resaltados")}`;
  else if (o.hiddenOutOfPlan > 0) suffix = ` · ${o.hiddenOutOfPlan} fuera de plan`;
  const details = [
    highlightActive && o.hiddenMatches > 0 ? plural(o.hiddenMatches, "resaltado", "resaltados") : null,
    o.hiddenOutOfPlan > 0 ? `${o.hiddenOutOfPlan} fuera de plan` : null,
  ].filter(Boolean);
  return {
    text: `+${o.hidden} más${suffix}`,
    ariaLabel: `Ver ${plural(o.hidden, "turno más", "turnos más")} ${where}${details.length ? ` (${details.join(", ")})` : ""}`,
  };
}

/** aria del botón de alta por defecto (vista por profesional, B4.2). */
export function practitionerCreateAriaLabel(columnLabel: string) {
  return (time: string, stateText: string) => `Nuevo turno con ${columnLabel} a las ${time} (${stateText})`;
}

/**
 * G3 (VX0-b): qué filas del Día se muestran de entrada. Con turnos, el rango con turnos ± `padMinutes` (1 h); las
 * filas vacías de los bordes quedan detrás de un «Ver HH:MM–HH:MM (sin turnos)» en la vista (siguen a un click: el
 * alta rápida en una franja vacía no se pierde). Sin turnos, el horario entero (es donde se carga el día).
 *
 * `slots`: inicios de franja en minutos desde 00:00, ascendentes. `occupied`: inicios de franja con turnos o con un
 * turno que sigue corriendo. Devuelve índices inclusivos. Recortar una sola fila no vale el botón: se muestra.
 */
export function visibleSlotWindow(
  slots: readonly number[],
  occupied: Iterable<number>,
  slotMinutes: number,
  padMinutes = 60
): { from: number; to: number } {
  const all = { from: 0, to: slots.length - 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const s of occupied) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (!Number.isFinite(min) || slots.length === 0) return all;
  const lo = min - padMinutes;
  const hi = max + slotMinutes + padMinutes; // fin de la última franja ocupada + margen
  let from = slots.findIndex((s) => s >= lo);
  if (from < 0) from = slots.length - 1;
  let to = slots.length - 1;
  while (to > from && slots[to] >= hi) to--;
  if (from < 2) from = 0;
  if (slots.length - 1 - to < 2) to = slots.length - 1;
  return { from, to };
}

/**
 * G5 (VX0-b): turno «pasado sin cerrar». Terminó (inicio + duración ≤ ahora) y sigue Pendiente o Confirmado: nadie
 * marcó Atendido ni Ausente. En la Lista se ve como «Confirmado» igual que uno de la tarde; la Secretaria necesita
 * verlo para cerrarlo. Instantes absolutos: no depende de la zona del host.
 */
export function isPastUnclosed(
  b: { status: string; scheduledFor: string; durationMin: number },
  now: Date
): boolean {
  if (b.status !== "PENDING" && b.status !== "CONFIRMED") return false;
  const end = Date.parse(b.scheduledFor) + b.durationMin * 60_000;
  return Number.isFinite(end) && end <= now.getTime();
}
