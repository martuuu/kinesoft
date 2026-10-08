"use client";

import { motion } from "framer-motion";
import { nextRadioValue } from "@/lib/agenda-client-state";
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
 *
 * SR-U3: N opciones. El caller arma `options` con `availableAgendaModes`
 * (lib/agenda-client-state) → `AGENDA_MODE_OPTIONS[m]`; sin `options` quedan
 * las 2 de B4.2 (no regresión). Las flechas recorren las N con vuelta (antes
 * alternaban entre 2 a ciegas). Roving tabindex: un solo botón tabulable, el
 * marcado; si el modo no está entre las opciones, el primero.
 */
export type ModeOption = { value: AgendaMode; label: string; hint: string };

export const AGENDA_MODE_OPTIONS: Readonly<Record<AgendaMode, ModeOption>> = {
  day: { value: "day", label: "Por día", hint: "Turnos del día en una sola línea de tiempo" },
  practitioner: { value: "practitioner", label: "Por profesional", hint: "Una columna por profesional" },
  room: { value: "room", label: "Por sala", hint: "Una columna por sala" },
};

const DEFAULT_OPTIONS: ReadonlyArray<ModeOption> = [AGENDA_MODE_OPTIONS.day, AGENDA_MODE_OPTIONS.practitioner];

export function ModeToggle({
  mode,
  options = DEFAULT_OPTIONS,
  onChange,
}: {
  mode: AgendaMode;
  options?: ReadonlyArray<ModeOption>;
  onChange: (mode: AgendaMode) => void;
}) {
  const values = options.map((o) => o.value);
  const focusable = values.includes(mode) ? mode : values[0];
  return (
    <div
      role="radiogroup"
      aria-label="Modo de la agenda"
      className="k-glass"
      style={{ display: "inline-flex", alignItems: "center", borderRadius: 999, padding: 3, height: 36 }}
    >
      {options.map((o) => {
        const on = mode === o.value;
        return (
          <motion.button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === focusable ? 0 : -1}
            title={o.hint}
            whileTap={{ scale: 0.95 }}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              // Radiogroup: las flechas cambian la opción (patrón WAI-ARIA), con vuelta entre N.
              const next = nextRadioValue(values, mode, e.key);
              if (next) {
                e.preventDefault();
                if (next !== mode) onChange(next);
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
