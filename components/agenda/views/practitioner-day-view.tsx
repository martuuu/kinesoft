"use client";

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Card } from "@/components/ui/card";
import { nowOffset, type AgendaDayLayout, type AgendaZoom, type PractitionerColumn } from "@/lib/agenda-layout";
import type { DayLockState } from "@/lib/availability/types";
import { matchesHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import { PractitionerBadge } from "../grid/practitioner-badge";
import { SlotCell, type PractitionerDayBooking } from "../grid/slot-cell";
import { GUTTER_WIDTH, TimeGutterCell, rowMinHeight } from "../grid/time-gutter";
import { NowLine } from "../grid/now-line";
import { LockIcon } from "../grid/unavailable-overlay";

export type { PractitionerDayBooking } from "../grid/slot-cell";

/**
 * Vista "Día por profesional" (B4.2 AG-resource, plan §11.3 "La agenda de la
 * Secretaria es CRÍTICA"): un día, una COLUMNA por profesional. Es la pantalla
 * donde la secretaria mira a la vez el gimnasio de kinesio (cupo ilimitado,
 * varios pacientes por franja) y al osteópata (cupo 1).
 *
 * ── Contrato (presentacional y controlado) ─────────────────────────────────
 * No busca datos, no tiene reloj ni persiste nada: `agenda-client` (B4.3) arma
 * todo y recibe los clicks.
 *
 * - `dayKey`: día AR "YYYY-MM-DD" que se muestra.
 * - `layout`: salida de `buildPractitionerColumns` (`lib/agenda-layout.ts`) con
 *   los turnos del DTO de la agenda. Las columnas se dibujan EN ESE ORDEN (el
 *   caller ya aplicó `practitionerOrder` con favoritos y el filtro de chips).
 *   `layout.rows` define las filas (zoom) y `layout.window` la ventana.
 * - `practitioners`: datos extra de cada profesional por id (hoy `subtitle`
 *   opcional, p. ej. la especialidad). Un id sin entrada usa solo lo del layout.
 * - `zoom`: el mismo con el que se armó `layout` (alto de fila y etiquetas).
 * - `density`: "comfortable" | "compact" (alto de fila, ancho de columna, cards
 *   visibles por celda antes del "+N más").
 * - `now`: instante actual (línea de "ahora"); el caller lo refresca.
 * - `onSlotClick(practitionerId, iso)`: click/Enter en el hueco de una celda →
 *   alta rápida con profesional + hora. `iso` es la hora de pared AR con offset
 *   (`localToARIso`, igual que `onCreate` de la vista Día). No se dispara en
 *   celdas bloqueadas (ver `grid/slot-cell.tsx`).
 * - `onBookingClick(booking)`: click en una card → drawer del turno.
 * - `highlight?`: resaltado de la leyenda (`lib/agenda-highlight.ts`: servicio,
 *   plan o suelto; levanta lo que coincide, atenúa el resto; opacidad = filtro).
 *   S19e: en cada celda lo que coincide va primero y el "+N más" cuenta lo que
 *   esconde (`denseOverflow`); el header de cada columna suma "· N resaltados"
 *   (`columnHighlightCount`), así la Secretaria ve en qué profesional están los
 *   turnos de plan sin recorrer la grilla. El chip de plan y "Fuera de plan"
 *   son de la card (S19a).
 * - `lockStateByPractitioner?`: `dayLockState` del motor por profesional
 *   (abierto / parcial / bloqueado + motivo). Si falta para un profesional, el
 *   estado del header se DERIVA de sus celdas (`columnDayStatus`).
 * - `onDayLockClick?(practitionerId)`: con valor, el estado del header es un
 *   botón (candado) que abre el diálogo de B4.4; sin valor, es solo lectura
 *   (p. ej. sin la capability `agenda.manageBlocks`).
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * Un contenedor con scroll en los dos ejes. Cada fila es su propia grilla CSS
 * con el mismo `gridTemplateColumns` (gutter + N × minmax(colMin, 1fr)), así
 * las columnas quedan alineadas y cada fila crece con sus cards (en flujo, sin
 * posicionar por hora: misma decisión que la vista Día). Header de
 * profesionales `sticky top`, gutter de horas `sticky left`. Con muchas
 * columnas aparece scroll horizontal (ancho mínimo por columna).
 *
 * ── Accesibilidad ───────────────────────────────────────────────────────────
 * `role="grid"` con `row`/`columnheader`/`rowheader`/`gridcell`. Roving
 * tabindex: una sola celda en el orden de Tab; flechas, Inicio/Fin y
 * RePág/AvPág mueven el foco entre celdas; Enter/Espacio crean el turno. Cada
 * celda dice hora, profesional y estado ("2 de 3 lugares ocupados",
 * "bloqueado: Feriado"). Sin animaciones propias (`reducedMotion="user"`: el
 * estado final se ve completo).
 */
export type PractitionerDayViewProps<B extends PractitionerDayBooking = PractitionerDayBooking> = {
  dayKey: string;
  layout: AgendaDayLayout<B>;
  practitioners: ReadonlyArray<{ id: string; name: string; subtitle?: string | null }>;
  zoom: AgendaZoom;
  density: "comfortable" | "compact";
  now: Date;
  onSlotClick: (practitionerId: string, iso: string) => void;
  onBookingClick: (booking: B) => void;
  highlight?: AgendaHighlight | null;
  lockStateByPractitioner?: Readonly<Record<string, DayLockState | undefined>>;
  onDayLockClick?: (practitionerId: string) => void;
};

/** Ancho mínimo de columna: debajo de esto la card no deja leer el nombre. */
export function columnMinWidth(density: "comfortable" | "compact"): number {
  return density === "compact" ? 164 : 200;
}

export type ColumnDayStatus = {
  status: "open" | "partial" | "locked" | "off";
  /** Texto corto del header. */
  label: string;
  /** Motivo (tooltip). */
  detail: string | null;
};

/**
 * Estado del día de una columna para el header. Con `lock` (motor) manda el
 * motor; sin él se deriva de las celdas: todas las celdas en horario
 * bloqueadas → "Bloqueado"; alguna → "Parcial"; ninguna celda en horario →
 * "Sin horario" (no atiende ese día).
 */
export function columnDayStatus(
  column: Pick<PractitionerColumn, "slots">,
  lock?: DayLockState
): ColumnDayStatus {
  if (lock) {
    if (lock.status === "locked") {
      if (lock.reason === "sin-franjas") return { status: "off", label: "Sin horario", detail: null };
      return { status: "locked", label: "Bloqueado", detail: lock.detail };
    }
    if (lock.status === "partial") return { status: "partial", label: "Parcial", detail: lock.detail };
    return { status: "open", label: "Abierto", detail: null };
  }
  const working = column.slots.filter((s) => !s.outOfHours);
  const blocked = column.slots.filter((s) => s.blocked);
  const reason = blocked.find((s) => s.blockReason)?.blockReason ?? null;
  if (working.length === 0 && blocked.length === 0) return { status: "off", label: "Sin horario", detail: null };
  if (working.length > 0 && working.every((s) => s.blocked)) return { status: "locked", label: "Bloqueado", detail: reason };
  if (blocked.length > 0) return { status: "partial", label: "Parcial", detail: reason };
  return { status: "open", label: "Abierto", detail: null };
}

/**
 * Turnos del día de la columna (no cancelados, mismo criterio que
 * `bookingCount`) que coinciden con el resaltado. `null` sin resaltado.
 */
export function columnHighlightCount(
  column: Pick<PractitionerColumn, "slots">,
  highlight: AgendaHighlight | null
): number | null {
  if (highlight == null) return null;
  let n = 0;
  for (const s of column.slots) {
    for (const b of s.bookings) if (b.status !== "CANCELLED" && matchesHighlight(highlight, b)) n += 1;
  }
  return n;
}

/** Filas donde ARRANCA un tramo bloqueado (ahí va el texto del motivo). */
export function blockedRunStarts(column: Pick<PractitionerColumn, "slots">): Set<number> {
  const out = new Set<number>();
  column.slots.forEach((s, i) => {
    if (s.state === "bloqueado" && (i === 0 || column.slots[i - 1].state !== "bloqueado")) out.add(i);
  });
  return out;
}

const PAGE_ROWS = 4;

export function PractitionerDayView<B extends PractitionerDayBooking>({
  dayKey,
  layout,
  practitioners,
  zoom,
  density,
  now,
  onSlotClick,
  onBookingClick,
  highlight = null,
  lockStateByPractitioner,
  onDayLockClick,
}: PractitionerDayViewProps<B>) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const { rows, columns } = layout;
  const rowMin = rowMinHeight(zoom, density);
  const colMin = columnMinWidth(density);
  const template = `${GUTTER_WIDTH}px repeat(${Math.max(1, columns.length)}, minmax(${colMin}px, 1fr))`;
  const minWidth = GUTTER_WIDTH + Math.max(1, columns.length) * colMin;

  const extra = useMemo(() => new Map(practitioners.map((p) => [p.id, p])), [practitioners]);
  const runStarts = useMemo(() => columns.map((c) => blockedRunStarts(c)), [columns]);

  // Línea de "ahora": fila que contiene el minuto y posición dentro de ella.
  const now$ = useMemo(() => {
    const off = nowOffset(dayKey, now, layout.window);
    if (!off || rows.length === 0) return null;
    let idx = rows.findIndex((r) => off.minute >= r.startMin && off.minute < r.endMin);
    if (idx === -1) idx = rows.length - 1; // minuto == fin de la ventana
    const row = rows[idx];
    const ratio = (off.minute - row.startMin) / (row.endMin - row.startMin);
    const hh = String(Math.floor(off.minute / 60)).padStart(2, "0");
    const mm = String(off.minute % 60).padStart(2, "0");
    return { idx, ratio, time: `${hh}:${mm}` };
  }, [dayKey, now, layout.window, rows]);

  // Foco tabulable dentro de los límites aunque cambien filas/columnas.
  const fr = Math.min(focus.r, Math.max(0, rows.length - 1));
  const fc = Math.min(focus.c, Math.max(0, columns.length - 1));

  const onFocusCell = useCallback((r: number, c: number) => setFocus({ r, c }), []);
  const onGridKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
      const lastR = rows.length - 1;
      const lastC = columns.length - 1;
      let nr = r;
      let nc = c;
      switch (e.key) {
        case "ArrowDown": nr = Math.min(lastR, r + 1); break;
        case "ArrowUp": nr = Math.max(0, r - 1); break;
        case "ArrowRight": nc = Math.min(lastC, c + 1); break;
        case "ArrowLeft": nc = Math.max(0, c - 1); break;
        case "PageDown": nr = Math.min(lastR, r + PAGE_ROWS); break;
        case "PageUp": nr = Math.max(0, r - PAGE_ROWS); break;
        case "Home": if (e.ctrlKey) nr = 0; nc = 0; break;
        case "End": if (e.ctrlKey) nr = lastR; nc = lastC; break;
        default: return;
      }
      e.preventDefault();
      if (nr === r && nc === c) return;
      setFocus({ r: nr, c: nc });
      gridRef.current?.querySelector<HTMLElement>(`[data-cell="${nr}:${nc}"]`)?.focus();
    },
    [rows.length, columns.length]
  );

  const dayLabel = new Date(`${dayKey}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });

  if (columns.length === 0) {
    return (
      <Card style={{ padding: 24, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
          No hay profesionales para mostrar. Elegí al menos uno en los filtros de arriba.
        </p>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        ref={gridRef}
        role="grid"
        aria-label={`Agenda del ${dayLabel} por profesional`}
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
        className="k-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
      >
        <div style={{ minWidth }}>
          {/* Header de profesionales (sticky arriba) */}
          <div role="rowgroup" style={{ position: "sticky", top: 0, zIndex: 5 }}>
            <div
              role="row"
              aria-rowindex={1}
              style={{
                display: "grid",
                gridTemplateColumns: template,
                background: "var(--card-bg)",
                borderBottom: "1px solid rgba(15,30,51,0.1)",
                boxShadow: "0 2px 6px rgba(15,30,51,0.04)",
              }}
            >
              <div
                role="columnheader"
                aria-colindex={1}
                style={{
                  position: "sticky",
                  left: 0,
                  zIndex: 6,
                  background: "var(--card-bg)",
                  borderRight: "1px solid rgba(15,30,51,0.08)",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "flex-end",
                  padding: "0 8px 6px 0",
                  fontSize: 10,
                  color: "var(--navy-300)",
                }}
              >
                <span>Hora</span>
              </div>
              {columns.map((col, c) => (
                <ColumnHeader
                  key={col.practitionerId}
                  column={col}
                  colIndex={c}
                  subtitle={extra.get(col.practitionerId)?.subtitle ?? null}
                  status={columnDayStatus(col, lockStateByPractitioner?.[col.practitionerId])}
                  density={density}
                  highlightCount={columnHighlightCount(col, highlight)}
                  onDayLockClick={onDayLockClick}
                />
              ))}
            </div>
          </div>

          {/* Cuerpo: una fila por franja */}
          <div role="rowgroup">
            {rows.map((row, r) => {
              const onTheHour = row.startMin % 60 === 0;
              const isNowRow = now$?.idx === r;
              return (
                <div
                  key={row.startMin}
                  role="row"
                  aria-rowindex={r + 2}
                  style={{
                    position: "relative",
                    display: "grid",
                    gridTemplateColumns: template,
                    borderTop: onTheHour ? "1px solid rgba(15,30,51,0.08)" : "1px dashed rgba(15,30,51,0.05)",
                  }}
                >
                  <TimeGutterCell time={row.time} startMin={row.startMin} zoom={zoom} isNowRow={isNowRow} />
                  {columns.map((col, c) => (
                    <SlotCell<B>
                      key={col.practitionerId}
                      cell={col.slots[r]}
                      dayKey={dayKey}
                      practitionerId={col.practitionerId}
                      practitionerName={col.name}
                      rowIndex={r}
                      colIndex={c}
                      tabbable={r === fr && c === fc}
                      rowMin={rowMin}
                      density={density}
                      showBlockLabel={runStarts[c].has(r)}
                      highlight={highlight}
                      onSlotClick={onSlotClick}
                      onBookingClick={onBookingClick}
                      onFocusCell={onFocusCell}
                      onGridKeyDown={onGridKeyDown}
                    />
                  ))}
                  {isNowRow && now$ && <NowLine ratio={now$.ratio} time={now$.time} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

const STATUS_STYLE: Record<ColumnDayStatus["status"], { color: string; background: string; border: string }> = {
  open: { color: "var(--navy-500)", background: "transparent", border: "1px solid rgba(15,30,51,0.12)" },
  partial: { color: "var(--navy-700)", background: "rgba(15,30,51,0.05)", border: "1px dashed rgba(15,30,51,0.3)" },
  locked: { color: "var(--navy-900)", background: "rgba(15,30,51,0.1)", border: "1px solid rgba(15,30,51,0.35)" },
  off: { color: "var(--navy-300)", background: "rgba(15,30,51,0.04)", border: "1px solid transparent" },
};

function ColumnHeader<B extends PractitionerDayBooking>({
  column,
  colIndex,
  subtitle,
  status,
  density,
  highlightCount,
  onDayLockClick,
}: {
  column: PractitionerColumn<B>;
  colIndex: number;
  subtitle: string | null;
  status: ColumnDayStatus;
  density: "comfortable" | "compact";
  /** Coincidencias del resaltado en la columna; `null` = sin resaltado. */
  highlightCount: number | null;
  onDayLockClick?: (practitionerId: string) => void;
}) {
  const compact = density === "compact";
  const count = column.bookingCount;
  const countLabel = `${count} ${count === 1 ? "turno" : "turnos"}`;
  const st = STATUS_STYLE[status.status];
  const statusContent = (
    <>
      <LockIcon locked={status.status === "locked"} partial={status.status === "partial"} size={11} />
      <span>{status.label}</span>
    </>
  );
  const statusTitle = status.detail ? `${status.label} · ${status.detail}` : status.label;
  const statusStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10.5,
    fontWeight: 600,
    borderRadius: 999,
    padding: "1px 7px",
    whiteSpace: "nowrap" as const,
    ...st,
  };
  // El candado de "Sin horario" no se ofrece: no hay nada que bloquear.
  const lockable = onDayLockClick && status.status !== "off";

  return (
    <div
      role="columnheader"
      aria-colindex={colIndex + 2}
      data-practitioner={column.practitionerId}
      data-day-status={status.status}
      style={{
        minWidth: 0,
        padding: compact ? "6px 8px" : "8px 10px",
        borderLeft: "1px solid rgba(15,30,51,0.06)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <PractitionerBadge initials={column.initials} name={column.name} size={compact ? 24 : 30} decorative />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          title={column.name}
          style={{
            fontSize: compact ? 12 : 13,
            fontWeight: 700,
            color: "var(--navy-900)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {column.name}
        </div>
        {subtitle && !compact && (
          <div style={{ fontSize: 10.5, color: "var(--navy-300)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {subtitle}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
          <span className="k-mono" data-count={count} style={{ fontSize: 10.5, color: "var(--navy-500)" }}>
            {countLabel}
          </span>
          {highlightCount != null && (
            <span
              className="k-mono"
              data-highlight-count={highlightCount}
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: highlightCount > 0 ? "var(--navy-900)" : "var(--navy-300)",
              }}
            >
              · {highlightCount} {highlightCount === 1 ? "resaltado" : "resaltados"}
            </span>
          )}
          {lockable ? (
            <button
              type="button"
              onClick={() => onDayLockClick(column.practitionerId)}
              title={statusTitle}
              aria-label={
                status.status === "locked"
                  ? `Día bloqueado para ${column.name}${status.detail ? ` (${status.detail})` : ""}. Desbloquear`
                  : `Día ${status.label.toLowerCase()} para ${column.name}${status.detail ? ` (${status.detail})` : ""}. Bloquear el día`
              }
              style={{ ...statusStyle, cursor: "pointer" }}
            >
              {statusContent}
            </button>
          ) : (
            <span title={statusTitle} aria-label={`Día: ${statusTitle}`} role="img" style={statusStyle}>
              {statusContent}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
