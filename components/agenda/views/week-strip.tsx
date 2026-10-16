"use client";

import type { DayKey } from "@/lib/availability/types";
import { DAYS, type BookingDTO } from "../agenda-utils";
import styles from "./views.module.css";

/**
 * Tira de días de la semana sobre la vista Día/Lista.
 *
 * Handoff de B4.3 (integrador final): recibe los 7 DayKeys AR de la semana
 * (`weekDayKeys(weekStartKey)`, lunes primero) en vez de un `Date` que se
 * avanzaba con `setDate(getDate()+i)` del reloj del host. Con DayKeys no hay
 * aritmética de fechas acá: la etiqueta sale del índice (0=Lun … 6=Dom) y el
 * número del propio DayKey, así que no depende de la zona del navegador.
 *
 * PF1.1 (G4): 52 px de alto en una línea + conteo (antes ~70 px en tres) y el
 * día elegido con `aria-current="date"` (antes solo color).
 */
export function WeekStrip({
  weekDays,
  dayKey,
  bookingsByDay,
  showSaturday,
  showSunday,
  onPick,
}: {
  /** Los 7 días AR de la semana, lunes primero. */
  weekDays: readonly DayKey[];
  /** Día elegido (resaltado). */
  dayKey: DayKey;
  bookingsByDay: Map<string, BookingDTO[]>;
  showSaturday: boolean;
  showSunday: boolean;
  onPick: (dayKey: DayKey) => void;
}) {
  // Same weekend visibility as the week grid (0=Mon … 6=Sun) so the day
  // strip reflects the user's "Mostrar sábado/domingo" choice in every view.
  const visibleDays = [0, 1, 2, 3, 4];
  if (showSaturday) visibleDays.push(5);
  if (showSunday) visibleDays.push(6);
  return (
    <div className={styles.strip} style={{ gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))` }}>
      {visibleDays.map((i) => {
        const key = weekDays[i];
        if (!key) return null;
        const label = DAYS[i];
        const count = bookingsByDay.get(key)?.length ?? 0;
        const on = key === dayKey;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onPick(key)}
            aria-current={on ? "date" : undefined}
            className={on ? styles.stripDay : `k-glass ${styles.stripDay}`}
          >
            <span className={styles.stripTop}>
              <span className={styles.stripLabel}>{label}</span>
              <span className={`k-display ${styles.stripNum}`}>{Number(key.slice(8, 10))}</span>
            </span>
            <span className={styles.stripCount}>
              {count}
              <span className={styles.stripWord}> {count === 1 ? "turno" : "turnos"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
