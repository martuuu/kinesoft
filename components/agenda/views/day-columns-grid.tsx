"use client";

import { Fragment, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { nowOffset, type AgendaRow, type AgendaZoom, type MinuteWindow } from "@/lib/agenda-layout";
import { GUTTER_WIDTH, TimeGutterCell, rowMinHeight } from "../grid/time-gutter";
import { NowLine } from "../grid/now-line";
import styles from "./views.module.css";

/**
 * Shell de las vistas de UN día con una COLUMNA por recurso (SR-U4, opción C
 * del relevamiento): "Día por profesional" (`practitioner-day-view`) y "Por
 * sala" (`room-day-view`). Se extrajo tal cual de `PractitionerDayView` (B4.2)
 * para no tener dos copias de la parte delicada (teclado, sticky, línea de
 * "ahora", aria-grid) que la Secretaria usa todo el día: cada vista solo dice
 * cómo se dibuja el header y la celda de su columna.
 *
 * El markup es el mismo byte a byte que antes de la extracción: el contrato es
 * `tests/unit/render/practitioner-day-view.test.tsx` SIN cambios.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * Un contenedor con scroll en los dos ejes. Cada fila es su propia grilla CSS
 * con el mismo `gridTemplateColumns` (gutter + N × minmax(colMin, 1fr)), así
 * las columnas quedan alineadas y cada fila crece con sus cards (en flujo, sin
 * posicionar por hora: misma decisión que la vista Día). Header `sticky top`,
 * gutter de horas `sticky left`. Con muchas columnas aparece scroll
 * horizontal (ancho mínimo por columna).
 *
 * ── Accesibilidad ───────────────────────────────────────────────────────────
 * `role="grid"` con `row`/`columnheader`/`rowheader`/`gridcell`. Roving
 * tabindex: una sola celda en el orden de Tab (`nav.tabbable`); flechas,
 * Inicio/Fin y RePág/AvPág mueven el foco entre celdas (`[data-cell="r:c"]`).
 * Sin animaciones propias (`reducedMotion="user"`).
 *
 * Contrato de `renderHeader(col, c)`: devuelve el `role="columnheader"` con
 * `aria-colindex={c + 2}`. `renderCell(col, r, c, nav)`: el `role="gridcell"`
 * con `aria-colindex={c + 2}` y un control `data-cell="r:c"` que use `nav`.
 * Columnas vacías: el caller muestra su propio estado vacío (no llama al shell).
 */
export type GridCellNav = {
  /** Roving tabindex: esta celda es la del orden de Tab. */
  tabbable: boolean;
  /** Alto mínimo de la fila (zoom × densidad). */
  rowMin: number;
  onFocusCell: (rowIndex: number, colIndex: number) => void;
  onGridKeyDown: (e: KeyboardEvent<HTMLElement>, rowIndex: number, colIndex: number) => void;
};

export type DayColumnsGridProps<C> = {
  dayKey: string;
  rows: ReadonlyArray<AgendaRow>;
  window: MinuteWindow;
  columns: ReadonlyArray<C>;
  columnKey: (col: C) => string;
  /** Ancho mínimo de cada columna en px. */
  columnMinWidth: number;
  zoom: AgendaZoom;
  density: "comfortable" | "compact";
  now: Date;
  /** aria-label de la grilla ("Agenda del lunes 5 de octubre por sala"). */
  ariaLabel: string;
  renderHeader: (col: C, colIndex: number) => ReactNode;
  renderCell: (col: C, rowIndex: number, colIndex: number, nav: GridCellNav) => ReactNode;
};

const PAGE_ROWS = 4;

/** "lunes 5 de octubre" del día AR (para el aria de la grilla). */
export function gridDayLabel(dayKey: string): string {
  return new Date(`${dayKey}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

export function DayColumnsGrid<C>({
  dayKey,
  rows,
  window,
  columns,
  columnKey,
  columnMinWidth: colMin,
  zoom,
  density,
  now,
  ariaLabel,
  renderHeader,
  renderCell,
}: DayColumnsGridProps<C>) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const rowMin = rowMinHeight(zoom, density);
  const template = `${GUTTER_WIDTH}px repeat(${Math.max(1, columns.length)}, minmax(${colMin}px, 1fr))`;
  const minWidth = GUTTER_WIDTH + Math.max(1, columns.length) * colMin;

  // Línea de "ahora": fila que contiene el minuto y posición dentro de ella.
  const now$ = useMemo(() => {
    const off = nowOffset(dayKey, now, window);
    if (!off || rows.length === 0) return null;
    let idx = rows.findIndex((r) => off.minute >= r.startMin && off.minute < r.endMin);
    if (idx === -1) idx = rows.length - 1; // minuto == fin de la ventana
    const row = rows[idx];
    const ratio = (off.minute - row.startMin) / (row.endMin - row.startMin);
    const hh = String(Math.floor(off.minute / 60)).padStart(2, "0");
    const mm = String(off.minute % 60).padStart(2, "0");
    return { idx, ratio, time: `${hh}:${mm}` };
  }, [dayKey, now, window, rows]);

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

  return (
    // MB-1a (C-MB3): < 768 la Card se acota a la ventana (`.columnsCard`) para que el scroll sea interno y el header
    // `sticky top` y las horas `sticky left` funcionen en el celular; ≥ 768 la acota el contenedor de la agenda.
    <Card className={styles.columnsCard} style={{ padding: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        ref={gridRef}
        role="grid"
        aria-label={ariaLabel}
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
        className={`k-scroll ${styles.columnsScroll}`}
        style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
      >
        <div style={{ minWidth }}>
          {/* Header de columnas (sticky arriba) */}
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
                <Fragment key={columnKey(col)}>{renderHeader(col, c)}</Fragment>
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
                    <Fragment key={columnKey(col)}>
                      {renderCell(col, r, c, { tabbable: r === fr && c === fc, rowMin, onFocusCell, onGridKeyDown })}
                    </Fragment>
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

