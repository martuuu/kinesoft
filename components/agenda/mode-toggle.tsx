"use client";

import { motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import type { AgendaMode } from "@/lib/preferences-constants";

/**
 * Toggle "Por día ↔ Por profesional" de la agenda (B4.2, plan §11.3 punto 1).
 * Presentacional y controlado: `mode` viene de `agendaPrefs.mode` y
 * `onChange` lo persiste el caller (`updateAgendaViewPrefs`, B4.3).
 *
 * Mismo look que el selector Día / Semana / Lista del toolbar (pastilla navy
 * que se desliza). La animación es de framer-motion bajo
 * `MotionConfig reducedMotion="user"`: con movimiento reducido la pastilla
 * aparece directo en su lugar, y el estado activo también se lee por
 * `aria-checked` y por el texto en blanco.
 */
const OPTIONS: ReadonlyArray<{ value: AgendaMode; label: string; hint: string }> = [
  { value: "day", label: "Por día", hint: "Turnos del día en una sola línea de tiempo" },
  { value: "practitioner", label: "Por profesional", hint: "Una columna por profesional" },
];

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: AgendaMode;
  onChange: (mode: AgendaMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Modo de la agenda"
      className="k-glass"
      style={{ display: "inline-flex", alignItems: "center", borderRadius: 999, padding: 3, height: 36 }}
    >
      {OPTIONS.map((o) => {
        const on = mode === o.value;
        return (
          <motion.button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.hint}
            whileTap={{ scale: 0.95 }}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              // Radiogroup: las flechas cambian la opción (patrón WAI-ARIA).
              if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = mode === "day" ? "practitioner" : "day";
                onChange(next);
                const group = e.currentTarget.parentElement;
                requestAnimationFrame(() =>
                  group?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus()
                );
              }
            }}
            data-mode={o.value}
            style={{
              position: "relative",
              height: 30,
              padding: "0 14px",
              borderRadius: 999,
              border: "none",
              fontSize: 12.5,
              fontWeight: 600,
              background: "transparent",
              color: on ? "#fff" : "var(--navy-500)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {on && (
              <motion.span
                layoutId="agenda-mode-pill"
                transition={{ duration: DUR.base, ease: EASE_OUT }}
                style={{ position: "absolute", inset: 0, borderRadius: 999, background: "var(--navy-900)", zIndex: 0 }}
              />
            )}
            <span style={{ position: "relative", zIndex: 1 }}>{o.label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}
