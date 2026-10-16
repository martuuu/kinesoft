"use client";

import { useState, type KeyboardEvent } from "react";
import type { SlotCell as SlotCellData } from "@/lib/agenda-layout";
import { localToARIso } from "@/lib/datetime-ar";
import { matchesHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import {
  denseOverflow,
  overflowButtonText,
  practitionerCreateAriaLabel,
  slotStateText,
  visibleCardLimit,
} from "@/lib/agenda-slot-helpers";
import type { BookingDTO } from "../agenda-utils";
import { BookingCard, type BookingCardSizing } from "./booking-card";
import { UnavailableOverlay } from "./unavailable-overlay";
import viewStyles from "../views/views.module.css";

/**
 * Celda (columna × franja) de las vistas "Día por profesional" (B4.2) y
 * "Por sala" (SR-U4): la columna es un profesional o una sala.
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

// [PF1.1-agenda-a] La lógica pura vive en `lib/agenda-slot-helpers.ts` (testeable sin jsdom); se re-exporta acá para
// no tocar a los llamadores de siempre.
export {
  bookingOutOfPlan,
  denseOverflow,
  overflowButtonText,
  practitionerCreateAriaLabel,
  slotStateText,
  visibleCardLimit,
  type DenseOverflow,
} from "@/lib/agenda-slot-helpers";

const STATE_BG: Record<SlotCellData["state"], string> = {
  libre: "transparent",
  parcial: "rgba(31,79,190,0.035)",
  lleno: "rgba(15,30,51,0.06)",
  sobreturno: "var(--warn-bg)",
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

/**
 * Qué es la columna de la celda (SR-U4: la misma celda sirve a "Por
 * profesional" y a "Por sala"). Define el atributo `data-practitioner` /
 * `data-room` y la preposición del "+N más" ("de Ana Pérez" / "en Consultorio 2").
 */
export type SlotColumnKind = "practitioner" | "room";

export function SlotCell<B extends PractitionerDayBooking>({
  cell,
  dayKey,
  columnId,
  columnLabel,
  columnKind = "practitioner",
  createAriaLabel,
  stateTextOf = slotStateText,
  practitionerOf,
  roomOf,
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
  /** Id de la columna: profesional o sala (`"none"` = "Sin sala"). Va a `onSlotClick`. */
  columnId: string;
  /** Nombre visible de la columna (aria de la celda y del "+N más"). */
  columnLabel: string;
  columnKind?: SlotColumnKind;
  /** aria del botón de alta; default "Nuevo turno con <columna> a las HH:MM (estado)". */
  createAriaLabel?: (time: string, stateText: string) => string;
  /** Texto del estado; default `slotStateText` (la sala cambia "fuera de horario"). */
  stateTextOf?: (cell: SlotCellData<B>) => string;
  /**
   * Iniciales del profesional de cada card (vista "Por sala"). Sin valor, las
   * cards no llevan iniciales (vista por profesional: la columna ya lo dice).
   */
  practitionerOf?: (b: B) => { initials: string; name: string } | null;
  /**
   * SR-U6 (handoff de SR-U5a): sala de cada card ("· Consultorio 2"). Solo la
   * pasa "Por profesional" cuando la sala aporta (`showRoomOnCards`); en "Por
   * sala" no, porque la columna ya es la sala. Sin valor, la card es la de siempre.
   */
  roomOf?: (b: B) => { name: string } | null;
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
  onSlotClick: (columnId: string, iso: string) => void;
  onBookingClick: (booking: B) => void;
  onFocusCell: (rowIndex: number, colIndex: number) => void;
  onGridKeyDown: (e: KeyboardEvent<HTMLElement>, rowIndex: number, colIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const compact = density === "compact";
  const limit = visibleCardLimit(density);
  const overflow = denseOverflow(cell.bookings, limit, expanded, highlight);
  const { shown, hidden } = overflow;
  const where = `${columnKind === "room" ? "en" : "de"} ${columnLabel} a las ${cell.time}`;
  const more = overflowButtonText(overflow, highlight != null, where);
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
  const stateText = stateTextOf(cell);
  // Instante de la franja en pared AR (mismo formato que el alta de la vista Día).
  const iso = localToARIso(`${dayKey}T${cell.time}`);
  const continuingNames = cell.continuing.filter((b) => b.status !== "CANCELLED").map((b) => b.patientName);

  return (
    <div
      role="gridcell"
      aria-colindex={colIndex + 2}
      data-state={cell.state}
      {...{ [columnKind === "room" ? "data-room" : "data-practitioner"]: columnId }}
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
            ? `${cell.time}, ${columnLabel}: ${stateText}`
            : (createAriaLabel ?? practitionerCreateAriaLabel(columnLabel))(cell.time, stateText)
        }
        onClick={() => {
          if (!blocked) onSlotClick(columnId, iso);
        }}
        onFocus={() => onFocusCell(rowIndex, colIndex)}
        onKeyDown={(e) => onGridKeyDown(e, rowIndex, colIndex)}
        // Anillo de foco hacia adentro (la celda vecina lo taparía): `.slotBtn:focus-visible`, con el token.
        className={viewStyles.slotBtn}
        style={{
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
                color: "var(--warn-fg)",
                background: "var(--warn-bg-strong)",
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
              practitioner={practitionerOf?.(b) ?? null}
              room={roomOf?.(b) ?? null}
            />
          ))}
        </div>
      )}

      {(hidden > 0 || (expanded && cell.bookings.length > limit)) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? `Ver menos turnos ${where}` : more.ariaLabel}
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
