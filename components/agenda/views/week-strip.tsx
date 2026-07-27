"use client";

import { toARDateKey, toARDow } from "@/lib/datetime-ar";
import { DAYS, type BookingDTO } from "../agenda-utils";

export function WeekStrip({
  weekStart,
  anchor,
  bookingsByDay,
  showSaturday,
  showSunday,
  onPick,
}: {
  weekStart: Date;
  anchor: Date;
  bookingsByDay: Map<string, BookingDTO[]>;
  showSaturday: boolean;
  showSunday: boolean;
  onPick: (d: Date) => void;
}) {
  // Same weekend visibility as the week grid (0=Mon … 6=Sun) so the day
  // strip reflects the user's "Mostrar sábado/domingo" choice in every view.
  const visibleDays = [0, 1, 2, 3, 4];
  if (showSaturday) visibleDays.push(5);
  if (showSunday) visibleDays.push(6);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${visibleDays.length}, 1fr)`, gap: 8 }}>
      {visibleDays.map((i) => {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + i);
        const key = toARDateKey(day);
        // Label from the column's real AR weekday — keeps name + number in
        // sync regardless of how weekStart was computed.
        const label = DAYS[(toARDow(day) + 6) % 7];
        const count = bookingsByDay.get(key)?.length ?? 0;
        const on = toARDateKey(day) === toARDateKey(anchor);
        return (
          <button
            key={key}
            onClick={() => onPick(day)}
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
