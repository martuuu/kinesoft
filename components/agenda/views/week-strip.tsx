"use client";

import type { DayKey } from "@/lib/availability/types";
import { DAYS, type BookingDTO } from "../agenda-utils";

/**
 * Tira de días de la semana sobre la vista Día/Lista.
 *
 * Handoff de B4.3 (integrador final): recibe los 7 DayKeys AR de la semana
 * (`weekDayKeys(weekStartKey)`, lunes primero) en vez de un `Date` que se
 * avanzaba con `setDate(getDate()+i)` del reloj del host. Con DayKeys no hay
 * aritmética de fechas acá: la etiqueta sale del índice (0=Lun … 6=Dom) y el
 * número del propio DayKey, así que no depende de la zona del navegador.
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
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${visibleDays.length}, 1fr)`, gap: 8 }}>
      {visibleDays.map((i) => {
        const key = weekDays[i];
        if (!key) return null;
        const label = DAYS[i];
        const count = bookingsByDay.get(key)?.length ?? 0;
        const on = key === dayKey;
        return (
          <button
            key={key}
            onClick={() => onPick(key)}
            className={on ? undefined : "k-glass"}
            style={{
              padding: "10px 6px",
              borderRadius: 14,
              textAlign: "center",
              border: "none",
              cursor: "pointer",
              background: on ? "var(--sky-700)" : undefined,
              color: on ? "#fff" : "var(--navy-500)",
              boxShadow: on ? "0 8px 20px rgba(31,79,190,0.28)" : undefined,
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.7, textTransform: "uppercase", fontWeight: 600 }}>{label}</div>
            <div
              className="k-display"
              style={{ fontSize: 18, fontWeight: 700, color: on ? "#fff" : "var(--navy-900)", margin: "2px 0" }}
            >
              {Number(key.slice(8, 10))}
            </div>
            <div style={{ fontSize: 10, opacity: 0.8 }}>
              {count} {count === 1 ? "turno" : "turnos"}
            </div>
          </button>
        );
      })}
    </div>
  );
}
