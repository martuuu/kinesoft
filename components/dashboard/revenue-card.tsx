"use client";

/**
 * Widget de ingresos del dashboard (S14r, ES3). Extraído de
 * `components/screens/dashboard-screen.tsx`.
 *
 * Antes: "Ingresos del mes" fijo, solo con los pagos de Mercado Pago, y un
 * "% obras sociales" que en realidad era MP de pacientes con cobertura. Ahora:
 * ingresos = MP + copagos cobrados a mano, la obra social APARTE (no suma en
 * el total), y un selector Mes/Semana (mismo patrón que `SessionsChart`) que
 * se recuerda por usuario en `dashboardPrefs`. Los números y la regla viven en
 * el server (`getRevenue`, `lib/dashboard-revenue.ts`); acá solo se muestran.
 */
import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { IconArrowUp } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { DUR, EASE_OUT, springSoft } from "@/lib/motion";
import { formatARS } from "@/lib/format";
import { getRevenue } from "@/lib/dashboard";
import { updateDashboardPrefs } from "@/lib/preferences";
import {
  revenuePrevLabel,
  revenueTitle,
  type RevenueRange,
  type RevenueSummary,
} from "@/lib/dashboard-revenue";

const RANGES: { value: RevenueRange; label: string }[] = [
  { value: "week", label: "Semana" },
  { value: "month", label: "Mes" },
];

/** Textos del widget, puros (render test). */
export function revenueCardView(s: RevenueSummary) {
  const delta =
    s.deltaPct == null
      ? null
      : {
          up: s.deltaPct >= 0,
          text: `${s.deltaPct >= 0 ? "+" : ""}${s.deltaPct}%`,
          label: `${s.deltaPct >= 0 ? "+" : ""}${s.deltaPct}% ${revenuePrevLabel(s.range)}`,
        };
  return {
    title: revenueTitle(s.range),
    total: formatARS(s.totalCents),
    delta,
    breakdown: `Copagos ${formatARS(s.manualCents)} · Mercado Pago ${formatARS(s.mpCents)}`,
    patients: `Pacientes · ${formatARS(s.totalCents)}`,
    insurer: `Obras sociales · ${formatARS(s.insurerCents)}`,
  };
}

type ByRange = Partial<Record<RevenueRange, RevenueSummary>>;

/**
 * El período que se ve: el elegido si ya llegó; si no, el último que hay.
 * El título sale de ESTE (`shown.range`), no del botón: mientras carga
 * "Semana" se seguía viendo el número del mes bajo "Ingresos de la semana"
 * (P3.Z F3a).
 */
export function revenueShown(byRange: ByRange, range: RevenueRange, initial: RevenueSummary): RevenueSummary {
  return byRange[range] ?? byRange[range === "week" ? "month" : "week"] ?? initial;
}

/**
 * A qué período vuelve el selector después de pedir uno. Si la lectura falla
 * (`ok: false`) o tira (`null`: red caída), vuelve al anterior: si no, el
 * botón quedaba marcado en un período cuyos números nunca llegaron.
 */
export function revenueRangeAfterFetch(
  prev: RevenueRange,
  requested: RevenueRange,
  res: { ok: boolean } | null
): RevenueRange {
  return res?.ok ? requested : prev;
}

export function RevenueCard({
  initial,
  month,
}: {
  /** El período que el usuario dejó elegido (`dashboardPrefs.revenueRange`). */
  initial: RevenueSummary;
  /** El mes ya calculado para la KPI: cambiar a "Mes" se ve sin esperar. */
  month?: RevenueSummary;
}) {
  const toast = useToast();
  const [range, setRange] = useState<RevenueRange>(initial.range);
  const [byRange, setByRange] = useState<Partial<Record<RevenueRange, RevenueSummary>>>(() => ({
    ...(month ? { month } : {}),
    [initial.range]: initial,
  }));
  const [pending, start] = useTransition();

  const choose = (r: RevenueRange) => {
    if (r === range) return;
    const prev = range;
    setRange(r);
    start(async () => {
      // La lectura y la preferencia van juntas; si la preferencia falla, el
      // widget igual muestra el período (solo no se recuerda al recargar).
      let res: Awaited<ReturnType<typeof getRevenue>> | null = null;
      try {
        [res] = await Promise.all([getRevenue(r), updateDashboardPrefs({ revenueRange: r }).catch(() => null)]);
      } catch {
        res = null;
      }
      if (res?.ok) {
        const data = res.data;
        setByRange((m) => ({ ...m, [r]: data }));
      } else {
        toast.error("No pudimos cargar los ingresos", res ? { description: res.error } : undefined);
      }
      setRange(revenueRangeAfterFetch(prev, r, res));
    });
  };

  // Mientras llega el período nuevo se sigue viendo el último que hay.
  const shown = revenueShown(byRange, range, initial);
  const v = revenueCardView(shown);

  return (
    <Card
      style={{
        padding: 18,
        background: "linear-gradient(160deg, var(--navy-900), var(--navy-700))",
        color: "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div
          id="revenue-card-title"
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.6)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {v.title}
          {pending && <span aria-hidden> …</span>}
        </div>
        <div
          role="group"
          aria-label="Período de los ingresos"
          style={{ display: "flex", gap: 2, padding: 3, borderRadius: 999, background: "rgba(255,255,255,0.08)" }}
        >
          {RANGES.map((r) => {
            const on = r.value === range;
            return (
              <button
                key={r.value}
                type="button"
                aria-pressed={on}
                onClick={() => choose(r.value)}
                style={{
                  position: "relative",
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "transparent",
                  color: on ? "var(--navy-900)" : "rgba(255,255,255,0.75)",
                  cursor: "pointer",
                }}
              >
                {on && (
                  <motion.span
                    layoutId="revenue-range-indicator"
                    transition={springSoft}
                    style={{ position: "absolute", inset: 0, borderRadius: 999, background: "#fff", zIndex: 0 }}
                  />
                )}
                <span style={{ position: "relative", zIndex: 1 }}>{r.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        aria-labelledby="revenue-card-title"
        aria-busy={pending}
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}
      >
        <div className="k-display" style={{ fontSize: 28, fontWeight: 600 }}>
          {v.total}
        </div>
        {v.delta && (
          <span
            aria-label={v.delta.label}
            title={v.delta.label}
            style={{
              padding: "4px 8px",
              borderRadius: 8,
              background: v.delta.up ? "rgba(180,233,74,0.2)" : "rgba(228,70,70,0.2)",
              color: v.delta.up ? "var(--lime-300)" : "#FFC0C0",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {v.delta.text}{" "}
            {v.delta.up && <IconArrowUp size={10} style={{ display: "inline-block", verticalAlign: -2 }} />}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 12 }}>{v.breakdown}</div>
      <div
        aria-hidden
        style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "rgba(255,255,255,0.1)" }}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${shown.privateShare}%` }}
          transition={{ duration: DUR.slow, ease: EASE_OUT }}
          style={{ background: "var(--lime-400)" }}
        />
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${shown.insurerShare}%` }}
          transition={{ duration: DUR.slow, ease: EASE_OUT, delay: 0.06 }}
          style={{ background: "var(--sky-500)" }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 10,
          fontSize: 11,
          color: "rgba(255,255,255,0.7)",
        }}
      >
        <span>{v.patients}</span>
        <span title="Lo que paga la obra social se informa aparte: no suma en los ingresos.">
          {v.insurer} (aparte)
        </span>
      </div>
    </Card>
  );
}
