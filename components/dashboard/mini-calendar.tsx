"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { IconChevL, IconChevR } from "@/components/ui/icons";
import { getMonthBookingDays } from "@/lib/dashboard";
import { toARDateKey } from "@/lib/datetime-ar";

/**
 * Interactive MiniCalendar — month nav + click-day → agenda.
 *
 * Booking-day dots are loaded server-side when the month changes. Today
 * is always highlighted; selected day (if any) takes precedence.
 */
export function MiniCalendar({ initialBookingDays }: { initialBookingDays: number[] }) {
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
      const days = await getMonthBookingDays(year, month);
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

  const firstDayOfMonth = new Date(year, month, 1);
  const offset = (firstDayOfMonth.getDay() + 6) % 7; // Mon = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid: (number | null)[] = [];
  for (let i = 0; i < offset; i++) grid.push(null);
  for (let i = 1; i <= daysInMonth; i++) grid.push(i);
  while (grid.length % 7 !== 0) grid.push(null);

  const monthName = firstDayOfMonth.toLocaleDateString("es-AR", { month: "long" });

  const openDay = (day: number) => {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    router.push(`/agenda?date=${iso}`);
  };

  return (
    <Card glass style={{ padding: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div
          className="k-display"
          style={{ fontSize: 17, fontWeight: 600, textTransform: "capitalize" }}
        >
          {monthName} <span style={{ color: "var(--navy-300)" }}>{year}</span>
          {pending && (
            <span style={{ marginLeft: 6, fontSize: 10, color: "var(--navy-300)" }}>…</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => nav(-1)}
            aria-label="Mes anterior"
            style={chevStyle}
          >
            <IconChevL size={12} />
          </button>
          <button
            type="button"
            onClick={() => nav(1)}
            aria-label="Mes siguiente"
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
            style={{
              textAlign: "center",
              color: "var(--navy-300)",
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
              aria-label={`Ver agenda del ${n}`}
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

const chevStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255,255,255,0.6)",
  color: "var(--navy-700)",
  border: "none",
  cursor: "pointer",
};
