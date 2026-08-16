"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { DUR, EASE_OUT, springSoft } from "@/lib/motion";
import { getSessionsChart, type ChartBar, type ChartRange } from "@/lib/dashboard";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "week", label: "Semana" },
  { value: "month", label: "Mes" },
  { value: "3m", label: "3 meses" },
];

export function SessionsChart({ initialBars }: { initialBars: ChartBar[] }) {
  const [range, setRange] = useState<ChartRange>("week");
  const [bars, setBars] = useState<ChartBar[]>(initialBars);
  const [pending, start] = useTransition();

  const setRangeAndFetch = (r: ChartRange) => {
    setRange(r);
    start(async () => {
      const data = await getSessionsChart(r);
      setBars(data);
    });
  };

  const max = Math.max(10, ...bars.map((b) => b.done + b.missed));
  const totalDone = bars.reduce((s, b) => s + b.done, 0);
  const totalMissed = bars.reduce((s, b) => s + b.missed, 0);
  const adherence = totalDone + totalMissed
    ? Math.round((totalDone / (totalDone + totalMissed)) * 100)
    : null;

  return (
    <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>
            Sesiones {pending && <span style={{ fontSize: 11, color: "var(--navy-300)" }}>…</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
            {totalDone} realizadas · {totalMissed} ausentes
            {adherence != null && (
              <> · <span style={{ color: "var(--sky-700)", fontWeight: 600 }}>{adherence}% adherencia</span></>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: 3,
            borderRadius: 999,
            background: "rgba(15,30,51,0.04)",
          }}
        >
          {RANGES.map((r) => {
            const on = r.value === range;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => setRangeAndFetch(r.value)}
                style={{
                  position: "relative",
                  padding: "5px 12px",
                  borderRadius: 999,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "transparent",
                  color: on ? "var(--navy-900)" : "var(--navy-500)",
                  cursor: "pointer",
                }}
              >
                {on && (
                  <motion.span
                    layoutId="sessions-range-indicator"
                    transition={springSoft}
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 999,
                      background: "#fff",
                      boxShadow: "0 2px 6px rgba(15,30,51,0.08)",
                      zIndex: 0,
                    }}
                  />
                )}
                <span style={{ position: "relative", zIndex: 1 }}>{r.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 11,
          color: "var(--navy-500)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--sky-700)" }} />{" "}
          Realizadas
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--lime-400)" }} />{" "}
          Ausentes
        </span>
      </div>

      <div
        key={`${bars.length}-${totalDone}-${totalMissed}`}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, 1fr)`,
          gap: 16,
          flex: 1,
          alignItems: "end",
          padding: "8px 6px 0",
          minHeight: 160,
        }}
      >
        {bars.map((b, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                position: "relative",
                width: "100%",
                height: 130,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <motion.div
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: DUR.slow, ease: EASE_OUT, delay: i * 0.03 }}
                style={{
                  width: 18,
                  height: `${(b.done / max) * 130}px`,
                  background: "linear-gradient(180deg, var(--sky-500), var(--sky-700))",
                  borderRadius: "6px 6px 2px 2px",
                  minHeight: 2,
                  transformOrigin: "bottom",
                }}
                aria-label={`${b.label}: ${b.done} realizadas`}
              />
              {b.missed > 0 && (
                <motion.div
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: DUR.slow, ease: EASE_OUT, delay: i * 0.03 + 0.04 }}
                  style={{
                    width: 8,
                    height: `${(b.missed / max) * 130}px`,
                    background: "var(--lime-400)",
                    borderRadius: "4px 4px 2px 2px",
                    transformOrigin: "bottom",
                  }}
                  aria-label={`${b.label}: ${b.missed} ausentes`}
                />
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 500 }}>
              {b.label}
            </div>
            <div className="k-mono" style={{ fontSize: 10, color: "var(--navy-300)" }}>
              {b.done}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
