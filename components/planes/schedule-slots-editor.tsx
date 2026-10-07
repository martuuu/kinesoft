"use client";

/**
 * Editor del horario de un plan (`PlanScheduleV1`, C6) — S18s (ES3).
 *
 * Qué edita:
 *   • D11: hora POR DÍA (lun 09:00, jue 18:00), no una hora única;
 *   • PQ-04: todas las semanas, cada 2/3/4 semanas o una vez por mes;
 *   • resumen corto (C13: "lun y jue 09:00") con `summarizePlanSchedule`.
 *
 * Contratos:
 *   • `value.slots[].dow` es 0=Dom … 6=Sáb (lo que guarda la base). La UI
 *     muestra lunes primero, pero NO convierte a 0=Lun: trabaja directo con
 *     0=Dom y ordena con `DISPLAY_DOWS`. La conversión 0=Dom ↔ 0=Lun vive solo
 *     en `lib/plan-schedule.ts` (C6) y acá no hace falta.
 *   • La validación NO se reimplementa: el mensaje sale de `planScheduleError`
 *     (o del `error` que pasa el padre, p. ej. `fieldErrors.schedule` del
 *     server). Quitar el último día se permite a propósito: el editor queda
 *     inválido y muestra "Elegí de 1 a 7 días" en lugar de bloquear el click
 *     sin explicar por qué.
 *   • Mensual: un solo horario; el día del mes es el del inicio del plan
 *     (`expandPlanDates` usa el `startDayKey`, el `dow` del slot no manda).
 *     Por eso en mensual no se muestran los días de la semana.
 *   • Hora en dos `<select>` 24 h (como `DateTime24Picker` / `block-mode`):
 *     el `<input type="time">` nativo muestra AM/PM según el SO. Si el valor
 *     trae minutos fuera de la grilla de 5' (un plan nacido del multi-turno con
 *     ancla 09:07), se agrega esa opción para no pisarlo en silencio.
 *
 * Las transformaciones son puras y se exportan para el test
 * (`tests/unit/render/schedule-slots.test.tsx`).
 */
import { useId } from "react";
import { planScheduleError, summarizePlanSchedule, type PlanScheduleV1 } from "@/lib/plan-schedule";
import type { ScheduleSlotsEditorProps } from "@/components/planes/plan-editor-types";

export type { ScheduleSlotsEditorProps };

/** Orden de muestra (lunes primero) en la convención de la base (0=Dom). */
export const DISPLAY_DOWS = [1, 2, 3, 4, 5, 6, 0] as const;

const DOW_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
const DOW_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;

/** Hora que toma un día nuevo cuando todavía no hay ninguno. */
export const DEFAULT_SLOT_START_MIN = 9 * 60;

export type ScheduleRepeat = "w1" | "w2" | "w3" | "w4" | "monthly";

export const SCHEDULE_REPEAT_OPTIONS: ReadonlyArray<{ value: ScheduleRepeat; label: string }> = [
  { value: "w1", label: "Todas las semanas" },
  { value: "w2", label: "Cada 2 semanas" },
  { value: "w3", label: "Cada 3 semanas" },
  { value: "w4", label: "Cada 4 semanas" },
  { value: "monthly", label: "Una vez por mes" },
];

export function scheduleRepeatOf(s: PlanScheduleV1): ScheduleRepeat {
  if (s.frequency === "monthly") return "monthly";
  const n = s.everyNWeeks ?? 1;
  return n === 2 ? "w2" : n === 3 ? "w3" : n === 4 ? "w4" : "w1";
}

const byDisplayOrder = (a: { dow: number }, b: { dow: number }) =>
  DISPLAY_DOWS.indexOf(a.dow as (typeof DISPLAY_DOWS)[number]) -
  DISPLAY_DOWS.indexOf(b.dow as (typeof DISPLAY_DOWS)[number]);

/**
 * Cambia la repetición. Semanal → mensual conserva el primer horario (lunes
 * primero): mensual lleva uno solo (`planScheduleError`). Mensual → semanal
 * conserva ese horario como único día. `everyNWeeks` solo existe en semanal
 * (en mensual es un error de validación, así que se borra).
 */
export function withScheduleRepeat(s: PlanScheduleV1, repeat: ScheduleRepeat): PlanScheduleV1 {
  const slots = [...s.slots].sort(byDisplayOrder);
  if (repeat === "monthly") {
    const first = slots[0] ?? { dow: 1 as const, startMin: DEFAULT_SLOT_START_MIN };
    return { v: 1, frequency: "monthly", slots: [{ dow: first.dow, startMin: first.startMin }] };
  }
  const everyNWeeks = Number(repeat.slice(1)) as 1 | 2 | 3 | 4;
  return { v: 1, frequency: "weekly", everyNWeeks, slots: slots.map((x) => ({ ...x })) };
}

/** Prende/apaga un día (0=Dom). Un día nuevo copia la hora del primero ya elegido. */
export function toggleScheduleDay(s: PlanScheduleV1, dow: number): PlanScheduleV1 {
  if (s.frequency !== "weekly") return s;
  const has = s.slots.some((x) => x.dow === dow);
  const slots = has
    ? s.slots.filter((x) => x.dow !== dow)
    : [
        ...s.slots,
        {
          dow: dow as PlanScheduleV1["slots"][number]["dow"],
          startMin: [...s.slots].sort(byDisplayOrder)[0]?.startMin ?? DEFAULT_SLOT_START_MIN,
        },
      ];
  return { ...s, slots: slots.sort(byDisplayOrder) };
}

/** Hora de un día (0=Dom), en minutos de pared AR. */
export function setScheduleSlotTime(s: PlanScheduleV1, dow: number, startMin: number): PlanScheduleV1 {
  return { ...s, slots: s.slots.map((x) => (x.dow === dow ? { ...x, startMin } : x)) };
}

/** "Usar en todos": la misma hora para todos los días elegidos. */
export function applyScheduleTimeToAll(s: PlanScheduleV1, startMin: number): PlanScheduleV1 {
  return { ...s, slots: s.slots.map((x) => ({ ...x, startMin })) };
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_STEP = 5;

/** Minutos en grilla de 5' + el valor actual si está fuera de grilla (no se pisa). */
export function minuteOptionsFor(currentMin: number): number[] {
  const grid = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  const m = currentMin % 60;
  return grid.includes(m) ? grid : [...grid, m].sort((a, b) => a - b);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--navy-500)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const selectStyle: React.CSSProperties = {
  padding: "8px 6px",
  borderRadius: 10,
  border: "1px solid rgba(15,30,51,0.1)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
  flexShrink: 0,
};

export function ScheduleSlotsEditor({ value, onChange, disabled, error, idPrefix }: ScheduleSlotsEditorProps) {
  const autoId = useId();
  const p = idPrefix ?? `sched${autoId.replace(/:/g, "")}`;
  const repeat = scheduleRepeatOf(value);
  const monthly = value.frequency === "monthly";
  const slots = [...value.slots].sort(byDisplayOrder);
  // `error` explícito del padre (incluido null = "todavía no mostrar") manda;
  // sin la prop, el editor muestra su propio diagnóstico.
  const problem = error !== undefined ? error : planScheduleError(value);
  const valid = planScheduleError(value) === null;
  const summary = valid ? summarizePlanSchedule(value) : null;
  const sameHour = slots.every((x) => x.startMin === slots[0]?.startMin);
  const errorId = `${p}-error`;
  const summaryId = `${p}-summary`;

  return (
    <div
      role="group"
      aria-labelledby={`${p}-legend`}
      aria-describedby={[summary ? summaryId : null, problem ? errorId : null].filter(Boolean).join(" ") || undefined}
      style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}
    >
      <div id={`${p}-legend`} style={labelStyle}>
        Horario
      </div>

      <label htmlFor={`${p}-repeat`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Se repite</span>
        <select
          id={`${p}-repeat`}
          value={repeat}
          disabled={disabled}
          onChange={(e) => onChange(withScheduleRepeat(value, e.target.value as ScheduleRepeat))}
          style={{ ...selectStyle, padding: "10px 10px", maxWidth: 260 }}
        >
          {SCHEDULE_REPEAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {!monthly && (
        <div role="group" aria-labelledby={`${p}-days`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span id={`${p}-days`} style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
            Días
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {DISPLAY_DOWS.map((dow) => {
              const on = value.slots.some((x) => x.dow === dow);
              return (
                <button
                  key={dow}
                  type="button"
                  aria-pressed={on}
                  aria-label={DOW_LONG[dow]}
                  disabled={disabled}
                  onClick={() => onChange(toggleScheduleDay(value, dow))}
                  style={{
                    minWidth: 44,
                    padding: "8px 10px",
                    borderRadius: 999,
                    border: "1px solid " + (on ? "var(--sky-700)" : "rgba(15,30,51,0.12)"),
                    background: on ? "var(--sky-700)" : "transparent",
                    color: on ? "#fff" : "var(--navy-700)",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  {DOW_SHORT[dow]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {slots.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map((slot) => {
            const h = Math.floor(slot.startMin / 60);
            const m = slot.startMin % 60;
            const dayLabel = monthly ? "Hora" : DOW_LONG[slot.dow];
            const rowId = `${p}-slot-${slot.dow}`;
            return (
              <li key={slot.dow} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span id={rowId} style={{ minWidth: 84, fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
                  {dayLabel}
                </span>
                <select
                  aria-label={`${dayLabel}: hora`}
                  value={h}
                  disabled={disabled}
                  onChange={(e) => onChange(setScheduleSlotTime(value, slot.dow, Number(e.target.value) * 60 + m))}
                  style={selectStyle}
                >
                  {HOURS.map((x) => (
                    <option key={x} value={x}>
                      {pad2(x)}
                    </option>
                  ))}
                </select>
                <span aria-hidden style={{ color: "var(--navy-300)", fontWeight: 700 }}>
                  :
                </span>
                <select
                  aria-label={`${dayLabel}: minutos`}
                  value={m}
                  disabled={disabled}
                  onChange={(e) => onChange(setScheduleSlotTime(value, slot.dow, h * 60 + Number(e.target.value)))}
                  style={selectStyle}
                >
                  {minuteOptionsFor(slot.startMin).map((x) => (
                    <option key={x} value={x}>
                      {pad2(x)}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 11, color: "var(--navy-300)" }}>hs</span>
                {!monthly && slots.length > 1 && !sameHour && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(applyScheduleTimeToAll(value, slot.startMin))}
                    aria-label={`Usar ${pad2(h)}:${pad2(m)} en todos los días`}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "4px 2px",
                      color: "var(--sky-700)",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    Usar en todos
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {monthly && (
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
          Se repite el mismo día de cada mes que el inicio del plan.
        </div>
      )}

      <div aria-live="polite" style={{ minHeight: 18 }}>
        {summary && (
          <span id={summaryId} style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
            {summary}
          </span>
        )}
      </div>

      {problem && (
        <div id={errorId} role="alert" style={{ fontSize: 12, color: "#9F1F1F", fontWeight: 600 }}>
          {problem}
        </div>
      )}
    </div>
  );
}
