"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { IconChevL, IconChevR } from "@/components/ui/icons";
import { getMonthBookingDays } from "@/lib/dashboard";
import { toARDateKey } from "@/lib/datetime-ar";
import dash from "./dashboard.module.css";

/**
 * Interactive MiniCalendar — month nav + click-day → agenda.
 *
 * Booking-day dots are loaded server-side when the month changes. Today
 * is always highlighted; selected day (if any) takes precedence.
 */
/**
 * Grilla del mes, pura (render test). PF1.1-dashboard: antes salía de `new Date(year, month, 1)` en la zona del
 * navegador y el nombre del mes de `toLocaleDateString` SIN `timeZone` (AGENTS §4: todo `toLocale*` del cliente va con
 * AR). Con el navegador en UTC+1, la medianoche local del 1/10 es el 30/9 en AR y el título decía «septiembre». Ahora
 * todo es aritmética UTC de fecha calendario (sin hora) y el nombre se formatea al mediodía UTC en AR.
 */
export function monthGrid(year: number, month: number): { cells: (number | null)[]; monthName: string } {
  const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  while (cells.length % 7 !== 0) cells.push(null);
  const monthName = new Date(Date.UTC(year, month, 15, 15)).toLocaleDateString("es-AR", {
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });
  return { cells, monthName };
}

export function MiniCalendar({ initialBookingDays, className }: { initialBookingDays: number[]; className?: string }) {
  const router = useRouter();
  // "Today" resolved in the business timezone (AR), not the browser's — so
  // the highlighted day and the initial month don't drift near midnight.
  const [todayYear, todayMonth1, todayDay] = toARDateKey(new Date())
    .split("-")
    .map(Number);
  const todayMonth = todayMonth1 - 1; // 0-indexed
  const [year, setYear] = useState(todayYear);
  const [month, setMonth] = useState(todayMonth); // 0-indexed
  const [bookingDays, setBookingDays] = useState<Set<number>>(new Set(initialBookingDays));
  const [pending, start] = useTransition();
  const isCurrentMonth = year === todayYear && month === todayMonth;

  // Reload booking days when the month changes. Sequence-guarded so a
  // late response from a previous month can't overwrite the current view.
  useEffect(() => {
    // Skip the first fetch — we already received the initial booking days
    // from the server component for the current month.
    if (year === todayYear && month === todayMonth) {
      return;
    }
    let cancelled = false;
    start(async () => {
      // Error de red: el mes se ve sin puntos (no con los del mes anterior, que mentirían sobre qué días hay turnos).
      let days: number[] = [];
      try {
        days = await getMonthBookingDays(year, month);
      } catch {
        days = [];
      }
      if (cancelled) return;
      setBookingDays(new Set(days));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const nav = (delta: -1 | 1) => {
    let m = month + delta;
    let y = year;
    if (m < 0) {
      m = 11;
      y--;
    } else if (m > 11) {
      m = 0;
      y++;
    }
    setMonth(m);
    setYear(y);
  };

  const { cells: grid, monthName } = monthGrid(year, month);

  const openDay = (day: number) => {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    router.push(`/agenda?date=${iso}`);
  };

  return (
    <Card glass className={className} style={{ padding: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h2
          className="k-display"
          aria-live="polite"
          style={{ fontSize: 17, fontWeight: 600, textTransform: "capitalize", margin: 0 }}
        >
          {monthName} <span style={{ color: "var(--navy-500)" }}>{year}</span>
          {pending && (
            <span aria-hidden style={{ marginLeft: 6, fontSize: 10, color: "var(--navy-500)" }}>…</span>
          )}
        </h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => nav(-1)}
            aria-label="Mes anterior"
            className={dash.tap}
            style={chevStyle}
          >
            <IconChevL size={12} />
          </button>
          <button
            type="button"
            onClick={() => nav(1)}
            aria-label="Mes siguiente"
            className={dash.tap}
            style={chevStyle}
          >
            <IconChevR size={12} />
          </button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, fontSize: 11 }}>
        {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              textAlign: "center",
              color: "var(--navy-500)",
              fontWeight: 600,
              padding: "4px 0",
            }}
          >
            {d}
          </div>
        ))}
        {grid.map((n, i) => {
          if (n == null) return <div key={i} />;
          const isToday = isCurrentMonth && n === todayDay;
          const hasBooking = bookingDays.has(n);
          return (
            <button
              key={i}
              type="button"
              onClick={() => openDay(n)}
              aria-label={`Ver agenda del ${n}${hasBooking ? " (con turnos)" : ""}`}
              aria-current={isToday ? "date" : undefined}
              style={{
                aspectRatio: "1",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 8,
                position: "relative",
                background: isToday ? "var(--sky-700)" : "transparent",
                color: isToday ? "#fff" : "var(--navy-700)",
                fontWeight: isToday ? 700 : 500,
                fontSize: 12,
                border: "none",
                cursor: "pointer",
              }}
            >
              {n}
              {hasBooking && !isToday && (
                <span
                  style={{
                    position: "absolute",
                    bottom: 4,
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    background: "var(--lime-400)",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// 32 px (antes 24): el objetivo táctil mínimo razonable sin agrandar el encabezado del calendario. MB-1d: < 768
// `dash.tap` lo lleva a 44 (con la barra inferior el calendario es una tarjeta más de la columna).
const chevStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255,255,255,0.6)",
  color: "var(--navy-700)",
  border: "none",
  cursor: "pointer",
};
