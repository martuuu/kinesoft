"use client";

import { useState, type KeyboardEvent } from "react";
import type { SlotCell as SlotCellData } from "@/lib/agenda-layout";
import { localToARIso } from "@/lib/datetime-ar";
import { matchesHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import { isOutOfPlan } from "@/lib/plan-display";
import type { BookingDTO } from "../agenda-utils";
import { BookingCard, type BookingCardSizing } from "./booking-card";
import { UnavailableOverlay } from "./unavailable-overlay";

/**
 * Celda (profesional × franja) de la vista "Día por profesional" (B4.2).
 * Presentacional: todo el cálculo (cupo, estado, carriles) viene hecho en
 * `SlotCell` de `lib/agenda-layout.ts`; acá solo se dibuja.
 *
 * Capas, de abajo hacia arriba:
 *   0. fondo de DISPONIBILIDAD de la celda (libre / parcial / lleno /
 *      sobreturno) o la capa rayada/gris de `UnavailableOverlay`;
 *   1. botón "Nuevo turno" que cubre toda la celda (click en el hueco = alta
 *      rápida con profesional + hora, plan §11.3 punto 5). Es el destino del
 *      foco con teclado (roving tabindex, lo maneja la vista);
 *   2. ocupación "2/3" / "4/∞", badge de sobreturno y las cards.
 *
 * Color (AGENTS §5): las cards conservan barra = servicio, fondo = estado del
 * turno, opacidad = filtro. El fondo de la CELDA es disponibilidad y usa tintes
 * muy bajos para no competir con eso; lo que distingue lleno/sobreturno para
 * quien no ve color es el texto ("2/2", "Sobreturno") y el aria-label.
 *
 * Celda bloqueada: no crea turno con un click (el botón queda `aria-disabled`
 * con el motivo). Forzar un turno sobre un bloqueo sigue siendo posible desde
 * "Nuevo turno" del toolbar, donde el modal pide confirmarlo como sobreturno
 * (decisión 1 de B-pre). Fuera de horario y lleno SÍ abren el alta: el modal
 * avisa (decisión 2) y el staff decide.
 *
 * Planes (S19e, ES3): el chip de sesión ("Kine · 2/3") y "Fuera de plan" van
 * DENTRO de la card (S19a, `BookingCard`). La ocupación de la celda ("2/3") es
 * otra cosa y se ve distinta a propósito (C13b V1-D18): mono, sin borde,
 * arriba a la derecha y `aria-hidden` (la dice el botón de la celda), contra
 * el chip con borde y `role="img"` dentro de la card. Con resaltado activo las
 * cards que coinciden van primero y el "+N más" cuenta lo que esconde
 * (`denseOverflow`). Sin el módulo `planes` no cambia nada: el resaltado de
 * plan no se ofrece y el DTO trae C9 neutro.
 */

/** Alias: B4.1 sumó `isOverbooked`/`arrivedAt`/`attendingAt` a `BookingDTO` (B4.3). */
export type PractitionerDayBooking = BookingDTO;

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

const STATE_BG: Record<SlotCellData["state"], string> = {
  libre: "transparent",
  parcial: "rgba(31,79,190,0.035)",
  lleno: "rgba(15,30,51,0.06)",
  sobreturno: "rgba(255,176,32,0.12)",
  // Estos dos los pinta `UnavailableOverlay`.
  "fuera-de-horario": "transparent",
  bloqueado: "transparent",
};

const stackedCardSizing: BookingCardSizing = {
  flexBasis: "auto",
  flexGrow: 0,
  flexShrink: 0,
  minWidth: 0,
  maxWidth: "100%",
};

export function SlotCell<B extends PractitionerDayBooking>({
  cell,
  dayKey,
  practitionerId,
  practitionerName,
  rowIndex,
  colIndex,
  tabbable,
  rowMin,
  density,
  showBlockLabel,
  highlight,
  onSlotClick,
  onBookingClick,
  onFocusCell,
  onGridKeyDown,
}: {
  cell: SlotCellData<B>;
  dayKey: string;
  practitionerId: string;
  practitionerName: string;
  rowIndex: number;
  colIndex: number;
  /** Roving tabindex: solo una celda de la grilla está en el orden de Tab. */
  tabbable: boolean;
  rowMin: number;
  density: "comfortable" | "compact";
  /** Primera celda de un tramo bloqueado: lleva el texto del motivo. */
  showBlockLabel: boolean;
  /** Resaltado de la leyenda (`lib/agenda-highlight.ts`); `null` = sin filtro. */
  highlight: AgendaHighlight | null;
  onSlotClick: (practitionerId: string, iso: string) => void;
  onBookingClick: (booking: B) => void;
  onFocusCell: (rowIndex: number, colIndex: number) => void;
  onGridKeyDown: (e: KeyboardEvent<HTMLElement>, rowIndex: number, colIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const compact = density === "compact";
  const limit = visibleCardLimit(density);
  const overflow = denseOverflow(cell.bookings, limit, expanded, highlight);
  const { shown, hidden } = overflow;
  const more = overflowButtonText(overflow, highlight != null, `de ${practitionerName} a las ${cell.time}`);
  // Resaltado a nivel celda (solo con turnos): una franja sin coincidencias
  // atenúa también su ocupación, así la columna se lee de un vistazo.
  const cellHighlight =
    highlight == null || cell.bookings.length === 0
      ? undefined
      : cell.bookings.some((b) => matchesHighlight(highlight, b))
        ? "match"
        : "dimmed";
  const blocked = cell.state === "bloqueado";
  const unavailable = cell.state === "bloqueado" || cell.state === "fuera-de-horario";
  const stateText = slotStateText(cell);
  // Instante de la franja en pared AR (mismo formato que el alta de la vista Día).
  const iso = localToARIso(`${dayKey}T${cell.time}`);
  const continuingNames = cell.continuing.filter((b) => b.status !== "CANCELLED").map((b) => b.patientName);

  return (
    <div
      role="gridcell"
      aria-colindex={colIndex + 2}
      data-state={cell.state}
      data-practitioner={practitionerId}
      data-time={cell.time}
      data-highlight={cellHighlight}
      title={blocked ? `Bloqueado${cell.blockReason ? ` · ${cell.blockReason}` : ""}` : undefined}
      style={{
        position: "relative",
        minHeight: rowMin,
        minWidth: 0,
        padding: compact ? "3px 4px" : "4px 6px",
        borderLeft: "1px solid rgba(15,30,51,0.06)",
        background: STATE_BG[cell.state],
        display: "flex",
        flexDirection: "column",
        gap: compact ? 3 : 4,
      }}
    >
      {unavailable && (
        <UnavailableOverlay
          kind={cell.state as "bloqueado" | "fuera-de-horario"}
          reason={cell.blockReason}
          showLabel={blocked && showBlockLabel}
        />
      )}

      <button
        type="button"
        data-cell={`${rowIndex}:${colIndex}`}
        tabIndex={tabbable ? 0 : -1}
        aria-disabled={blocked || undefined}
        aria-label={
          blocked
            ? `${cell.time}, ${practitionerName}: ${stateText}`
            : `Nuevo turno con ${practitionerName} a las ${cell.time} (${stateText})`
        }
        onClick={() => {
          if (!blocked) onSlotClick(practitionerId, iso);
        }}
        onFocus={() => onFocusCell(rowIndex, colIndex)}
        onKeyDown={(e) => onGridKeyDown(e, rowIndex, colIndex)}
        style={{
          // Anillo de foco del navegador, hacia adentro (la celda vecina lo taparía).
          outlineOffset: -2,
          position: "absolute",
          inset: 0,
          zIndex: 1,
          border: "none",
          borderRadius: 0,
          background: "transparent",
          cursor: blocked ? "not-allowed" : "pointer",
          padding: 0,
        }}
      />

      {(cell.label || cell.overbooked) && (
        <div
          aria-hidden
          style={{
            position: "relative",
            zIndex: 2,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 4,
            pointerEvents: "none",
            minHeight: 14,
            opacity: cellHighlight === "dimmed" ? 0.45 : 1,
          }}
        >
          {cell.overbooked && (
            <span
              data-badge="sobreturno"
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.02em",
                textTransform: "uppercase",
                color: "#9A5B00",
                background: "rgba(255,176,32,0.22)",
                borderRadius: 999,
                padding: "1px 6px",
              }}
            >
              Sobreturno
            </span>
          )}
          {cell.label && (
            <span
              className="k-mono"
              data-occupancy={cell.label}
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: cell.state === "lleno" || cell.state === "sobreturno" ? "var(--navy-900)" : "var(--navy-300)",
                background: cell.state === "lleno" ? "rgba(15,30,51,0.08)" : "transparent",
                borderRadius: 6,
                padding: "0 4px",
              }}
            >
              {cell.label}
            </span>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", gap: compact ? 3 : 4 }}>
          {shown.map((b) => (
            <BookingCard
              key={b.id}
              b={b}
              onEdit={() => onBookingClick(b)}
              highlight={highlight}
              compact
              sizing={stackedCardSizing}
            />
          ))}
        </div>
      )}

      {(hidden > 0 || (expanded && cell.bookings.length > limit)) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? `Ver menos turnos de ${practitionerName} a las ${cell.time}` : more.ariaLabel}
          data-overflow-matches={!expanded && overflow.hiddenMatches > 0 ? overflow.hiddenMatches : undefined}
          data-overflow-out-of-plan={!expanded && overflow.hiddenOutOfPlan > 0 ? overflow.hiddenOutOfPlan : undefined}
          style={{
            position: "relative",
            zIndex: 2,
            alignSelf: "flex-start",
            border: "1px solid rgba(31,79,190,0.25)",
            background: "rgba(255,255,255,0.9)",
            color: "var(--sky-700)",
            borderRadius: 8,
            padding: "2px 8px",
            fontSize: 10.5,
            fontWeight: 700,
            cursor: "pointer",
            maxWidth: "100%",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {expanded ? "Ver menos" : more.text}
        </button>
      )}

      {continuingNames.length > 0 && (
        <span
          aria-hidden
          title={continuingNames.join(" · ")}
          style={{
            position: "relative",
            zIndex: 2,
            pointerEvents: "none",
            fontSize: 10,
            fontStyle: "italic",
            color: "var(--navy-300)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {continuingNames.length === 1 ? `continúa ${continuingNames[0]}` : `continúan ${continuingNames.length} turnos`}
        </span>
      )}
    </div>
  );
}
