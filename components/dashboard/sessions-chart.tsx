"use client";

import { useState, useTransition } from "react";
import { m } from "framer-motion";
import { Card } from "@/components/ui/card";
import { springSoft } from "@/lib/motion";
import { getSessionsChart, type ChartBar, type ChartRange } from "@/lib/dashboard";
import styles from "./dashboard.module.css";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "week", label: "Semana" },
  { value: "month", label: "Mes" },
  { value: "3m", label: "3 meses" },
];

/**
 * EV1-A: `unit` = qué se cuenta en el rótulo. Los números son SIEMPRE turnos
 * (`getSessionsChart` y `weeklyBars` leen Booking); en Kine se rotulan
 * "Sesiones" como siempre y en un consultorio sin `sesiones` (General),
 * "Turnos", con "asistencia" en lugar de "adherencia".
 */
const COPY = {
  sessions: { title: "Sesiones", done: "realizadas", doneLegend: "Realizadas", rate: "adherencia" },
  bookings: { title: "Turnos", done: "realizados", doneLegend: "Realizados", rate: "asistencia" },
} as const;

/**
 * Resumen del período, puro (render test). D4 de VX0-b: sin turnos con resultado no hay tasa (nunca «100 %» ni «0 %»
 * sobre 0) y el gráfico muestra su vacío en vez de siete barras de 2 px.
 */
export function chartSummary(bars: readonly ChartBar[]) {
  const totalDone = bars.reduce((s, b) => s + b.done, 0);
  const totalMissed = bars.reduce((s, b) => s + b.missed, 0);
  const total = totalDone + totalMissed;
  return {
    totalDone,
    totalMissed,
    adherence: total ? Math.round((totalDone / total) * 100) : null,
    empty: total === 0,
  };
}

const EMPTY_COPY: Record<ChartRange, string> = {
  week: "Esta semana todavía no hay turnos realizados ni ausentes.",
  month: "Este mes todavía no hay turnos realizados ni ausentes.",
  "3m": "En los últimos 3 meses no hay turnos realizados ni ausentes.",
};

export function SessionsChart({
  initialBars,
  unit = "sessions",
  className,
}: {
  initialBars: ChartBar[];
  unit?: keyof typeof COPY;
  className?: string;
}) {
  const copy = COPY[unit];
  const [range, setRange] = useState<ChartRange>("week");
  const [bars, setBars] = useState<ChartBar[]>(initialBars);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  const setRangeAndFetch = (r: ChartRange) => {
    if (r === range) return;
    const prev = range;
    setRange(r);
    start(async () => {
      // Estado de error: antes una lectura caída dejaba el botón marcado en un período cuyos números no llegaron (o
      // tiraba en la transición). Ahora vuelve al anterior y lo dice.
      try {
        const data = await getSessionsChart(r);
        setBars(data);
        setFailed(false);
      } catch {
        setRange(prev);
        setFailed(true);
      }
    });
  };

  const max = Math.max(10, ...bars.map((b) => b.done + b.missed));
  const { totalDone, totalMissed, adherence, empty } = chartSummary(bars);
  // Con muchas barras (3 meses = 13 semanas) el gap fijo de 16 px desbordaba a 390 y en la columna angosta de 1024.
  const gap = bars.length > 8 ? 4 : 12;

  return (
    <Card className={className} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>
            {copy.title} {pending && <span aria-hidden style={{ fontSize: 11, color: "var(--navy-400)" }}>…</span>}
          </h2>
          <div style={{ fontSize: 11, color: "var(--navy-400)" }}>
            {totalDone} {copy.done} · {totalMissed} ausentes
            {adherence != null && (
              <> · <span style={{ color: "var(--sky-700)", fontWeight: 600 }}>{adherence}% {copy.rate}</span></>
            )}
          </div>
        </div>
        <div
          role="group"
          aria-label="Período del gráfico"
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
                aria-pressed={on}
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
                {/* C-PF1: `m` (núcleo liviano; `layoutId` lo resuelve `domMax`, que llega aparte). C-PF1.4: el orden
                    de las props de `style` es fijo para que server y cliente serialicen igual (S5). */}
                {on && (
                  <m.span
                    layoutId="sessions-range-indicator"
                    transition={springSoft}
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 0,
                      borderRadius: 999,
                      background: "var(--card-bg)",
                      boxShadow: "0 2px 6px rgba(15,30,51,0.08)",
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
          {copy.doneLegend}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--lime-400)" }} />{" "}
          Ausentes
        </span>
      </div>

      {failed && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          No pudimos cargar ese período. Probá de nuevo.
        </div>
      )}

      {empty ? (
        <div
          style={{
            flex: 1,
            minHeight: 160,
            display: "grid",
            placeItems: "center",
            textAlign: "center",
            padding: 16,
            borderRadius: 14,
            border: "1px dashed rgba(15,30,51,0.12)",
            fontSize: 12.5,
            color: "var(--navy-500)",
          }}
        >
          {EMPTY_COPY[range]}
        </div>
      ) : (
        <div
          key={`${bars.length}-${totalDone}-${totalMissed}`}
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, minmax(0, 1fr))`,
            gap,
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
                minWidth: 0,
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
                {/* C-PF1.2: la entrada (crecen desde abajo) es CSS (`.bar`), el estado final es el natural. */}
                <div
                  className={styles.bar}
                  role="img"
                  style={{
                    animationDelay: `${i * 30}ms`,
                    width: "min(18px, 60%)",
                    height: `${(b.done / max) * 130}px`,
                    background: "linear-gradient(180deg, var(--sky-500), var(--sky-700))",
                    borderRadius: "6px 6px 2px 2px",
                    minHeight: 2,
                  }}
                  aria-label={`${b.label}: ${b.done} ${copy.done}`}
                />
                {b.missed > 0 && (
                  <div
                    className={styles.bar}
                    role="img"
                    style={{
                      animationDelay: `${i * 30 + 40}ms`,
                      width: "min(8px, 30%)",
                      height: `${(b.missed / max) * 130}px`,
                      background: "var(--lime-400)",
                      borderRadius: "4px 4px 2px 2px",
                    }}
                    aria-label={`${b.label}: ${b.missed} ausentes`}
                  />
                )}
              </div>
              <div
                className={styles.ellipsis}
                title={b.label}
                style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 500, maxWidth: "100%" }}
              >
                {b.label}
              </div>
              <div className="k-mono" style={{ fontSize: 10, color: "var(--navy-400)" }}>
                {b.done}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
