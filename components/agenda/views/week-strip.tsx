"use client";

import type { ReactNode } from "react";
import type { DayKey } from "@/lib/availability/types";
import type { AggregatedDayLock } from "@/lib/agenda-client-state";
import { DAYS, type BookingDTO } from "../agenda-utils";
import styles from "./views.module.css";

/** Estado de candado de un día (el agregado de `dayLockOf` en `agenda-client`). */
type StripDayLock = Pick<AggregatedDayLock, "status" | "detail">;

/**
 * [CF2-WS] Tooltip del día con candado: «Bloqueado: Congreso» / «Bloqueado en parte: Reunión». Abierto o «off» (nadie
 * atiende ese día) no llevan tooltip: no hay nada que explicar.
 */
function lockTitle(lock: StripDayLock | undefined): string | undefined {
  if (!lock) return undefined;
  const why = lock.detail ? `: ${lock.detail}` : "";
  if (lock.status === "locked") return `Bloqueado${why}`;
  if (lock.status === "partial") return `Bloqueado en parte${why}`;
  return undefined;
}

/**
 * Glifo de candado NO interactivo (cerrado o en parte). Repite el dibujo de `LockIcon` de `day-lock-button.tsx` en
 * vez de importarlo: allá es privado y es un `<button>`, y en la tira el día ya es el botón (nunca botón en botón).
 * Lo de afuera (lectores de pantalla) va en texto: el ícono es `aria-hidden`.
 */
function LockGlyph({ status }: { status: "locked" | "partial" }) {
  return (
    <span data-strip-lock-glyph={status} className={styles.stripGlyph} aria-hidden="true">
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        <rect x="5" y="11" width="14" height="10" rx="2.5" fill={status === "locked" ? "currentColor" : "none"} />
        {status === "partial" && <path d="M5 16h14v2.5A2.5 2.5 0 0 1 16.5 21h-9A2.5 2.5 0 0 1 5 18.5Z" fill="currentColor" />}
      </svg>
    </span>
  );
}

/**
 * Tira de días de la semana.
 *
 * Handoff de B4.3 (integrador final): recibe los 7 DayKeys AR de la semana
 * (`weekDayKeys(weekStartKey)`, lunes primero) en vez de un `Date` que se
 * avanzaba con `setDate(getDate()+i)` del reloj del host. Con DayKeys no hay
 * aritmética de fechas acá: la etiqueta sale del índice (0=Lun … 6=Dom) y el
 * número del propio DayKey, así que no depende de la zona del navegador.
 *
 * PF1.1 (G4): 52 px de alto en una línea + conteo (antes ~70 px en tres) y el
 * día elegido con `aria-current="date"` (antes solo color).
 *
 * [CF2-WS] D-CF2-6 (plan §29, brief A.3): dos variantes.
 * - `picker` (Día, Lista, Recepción; la de siempre, sobre la vista): `aria-current` = el día ELEGIDO. Con `dayLocks`
 *   suma el estado del candado SIN interacción (glifo + rayado + motivo en el tooltip): el candado que se toca está
 *   en el header de la vista.
 * - `columns` (encabezado ÚNICO de la Semana, lo dibuja `WeekGridView` adentro de su scroll): una columna vacía de
 *   52 px (la de las horas) y las mismas columnas que la grilla. Por día un `div[data-day-status]` con dos HERMANOS:
 *   el botón del día (abre ese día en Día) y el candado (`renderDayLock`, el `DayLockButton` de `agenda-client`).
 *   Antes la Semana tenía dos encabezados: esta tira afuera y una fila «Lun 12 🔒» propia de la grilla con `1fr`,
 *   que se ensanchaba con el contenido y no quedaba alineada. `aria-current` = HOY (`todayKey`).
 *
 * El picker sin `dayLocks` sale byte a byte igual que antes (golden `[SV09]` de `agenda-client.test.tsx`): los
 * `data-strip-day` / `data-day-key` son solo de `columns`.
 *
 * Sin hooks a propósito: el test la recorre como función (render estático, sin jsdom) para disparar el click real.
 */
export function WeekStrip({
  variant = "picker",
  weekDays,
  dayKey,
  bookingsByDay,
  counts,
  showSaturday,
  showSunday,
  onPick,
  dayLocks,
  renderDayLock,
  todayKey,
}: {
  /** `picker` (sobre Día/Lista) o `columns` (encabezado de la grilla semanal). Default `picker`. */
  variant?: "picker" | "columns";
  /** Los 7 días AR de la semana, lunes primero. */
  weekDays: readonly DayKey[];
  /** Día elegido (resaltado en `picker`). */
  dayKey: DayKey;
  /** Turnos por DayKey AR (el conteo sale de acá si no viene `counts`). */
  bookingsByDay?: ReadonlyMap<string, readonly BookingDTO[]>;
  /** Conteo por DayKey AR; gana sobre `bookingsByDay`. */
  counts?: Readonly<Record<string, number>>;
  showSaturday: boolean;
  showSunday: boolean;
  /** Click en un día. Sin él, el día se dibuja pero no es un botón (no hay acción que anunciar). */
  onPick?: (dayKey: DayKey) => void;
  /** Candado agregado por día. En `picker` solo se muestra; en `columns` también pinta el rayado. */
  dayLocks?: Readonly<Record<string, StripDayLock | undefined>>;
  /** Solo `columns`: el candado interactivo de cada día, hermano del botón del día. */
  renderDayLock?: (dayKey: DayKey) => ReactNode;
  /** Solo `columns`: hoy (AR), marcado con `aria-current="date"`. */
  todayKey?: DayKey;
}) {
  const columns = variant === "columns";
  // Same weekend visibility as the week grid (0=Mon … 6=Sun) so the day
  // strip reflects the user's "Mostrar sábado/domingo" choice in every view.
  const visibleDays = [0, 1, 2, 3, 4];
  if (showSaturday) visibleDays.push(5);
  if (showSunday) visibleDays.push(6);
  const cols = `repeat(${visibleDays.length}, minmax(0, 1fr))`;

  const day = (i: number) => {
    const key = weekDays[i];
    if (!key) return null;
    const label = DAYS[i];
    const count = counts?.[key] ?? bookingsByDay?.get(key)?.length ?? 0;
    const lock = dayLocks?.[key];
    const status = lock?.status;
    const blocked = status === "locked" || status === "partial" ? status : null;
    const title = lockTitle(lock);
    const on = columns ? key === todayKey : key === dayKey;
    // En `columns` el candado lo pone `renderDayLock`; el glifo queda para el picker (y para una Semana sin candado).
    const lockNode = columns ? renderDayLock?.(key) ?? null : null;
    const content = (
      <>
        <span className={styles.stripTop}>
          <span className={styles.stripLabel}>{label}</span>
          <span className={`k-display ${styles.stripNum}`}>{Number(key.slice(8, 10))}</span>
          {blocked && !lockNode && <LockGlyph status={blocked} />}
        </span>
        <span className={styles.stripCount}>
          {status === "locked" ? (
            <>
              <span className={styles.stripBlocked}>Bloqueado</span>
              {/* El conteo no se pierde para el lector (un bloqueo puede caer sobre turnos ya dados). */}
              {count > 0 && <span className="k-sr-only">, {count} {count === 1 ? "turno" : "turnos"}</span>}
            </>
          ) : (
            <>
              {count}
              <span className={styles.stripWord}> {count === 1 ? "turno" : "turnos"}</span>
              {status === "partial" && <span className="k-sr-only">, bloqueado en parte</span>}
            </>
          )}
        </span>
      </>
    );
    const glass = columns || on ? "" : "k-glass ";
    const dayEl = onPick ? (
      <button
        key={columns ? undefined : key}
        type="button"
        data-strip-day={columns || undefined}
        data-day-key={columns ? key : undefined}
        onClick={() => onPick(key)}
        aria-current={on ? "date" : undefined}
        className={`${glass}${styles.stripDay}`}
        data-day-status={columns ? undefined : status}
        title={columns ? undefined : title}
      >
        {content}
      </button>
    ) : (
      <div
        key={columns ? undefined : key}
        data-strip-day={columns || undefined}
        data-day-key={columns ? key : undefined}
        aria-current={on ? "date" : undefined}
        className={`${glass}${styles.stripDay}`}
        data-day-status={columns ? undefined : status}
        title={columns ? undefined : title}
      >
        {content}
      </div>
    );
    if (!columns) return dayEl;
    return (
      <div key={key} className={styles.stripCell} data-day-status={status} data-today={on || undefined} title={title}>
        {dayEl}
        {lockNode}
      </div>
    );
  };

  if (columns) {
    return (
      <div
        data-week-header
        className={`${styles.strip} ${styles.stripColumns}`}
        // Sticky adentro del scroll de `WeekGridView`, con fondo de card: la grilla pasa por debajo. El `padding-bottom`
        // reemplaza al `gap` con la grilla para que el fondo tape también esa franja al scrollear.
        style={{ position: "sticky", top: 0, zIndex: 8, background: "var(--card-bg)", paddingBottom: 6, gridTemplateColumns: `52px ${cols}` }}
      >
        <div aria-hidden="true" />
        {visibleDays.map(day)}
      </div>
    );
  }
  return (
    <div className={styles.strip} style={{ gridTemplateColumns: cols }}>
      {visibleDays.map(day)}
    </div>
  );
}
