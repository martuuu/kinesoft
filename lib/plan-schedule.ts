/**
 * Horario de un plan (`PlanScheduleV1`, C6) — puro, lo importan server y UI.
 *
 * C6: la conversión 0=Dom ↔ 0=Lun vive SOLO acá (y en
 * `lib/plan-editor-state.ts`, S18). Dos convenciones conviven a propósito:
 *   • `PlanScheduleV1.slots[].dow` = 0=Dom … 6=Sáb, como
 *     `PractitionerSchedule.dow` y `toARDow` (lo que guarda la base).
 *   • La UI, el multi-turno (`RecurrenceInput.daysOfWeek`) y Diagnóstico
 *     (`AssignInput.daysOfWeek`) usan 0=Lun … 6=Dom.
 * Nadie más convierte: si otro módulo necesita pasar de una a otra, importa
 * de acá. Mezclarlas corre los días uno (el lunes pasa a ser martes).
 *
 * El tipo y la validación viven en `lib/availability/plan.ts` (fuente única
 * de los tipos del motor) y se re-exportan acá para los callers de horario.
 */
import { dayKeyOf, minutesOfDayAR } from "@/lib/availability/day";
import type { DayKey, Dow, Frequency } from "@/lib/availability/types";
import { toARDow } from "@/lib/datetime-ar";
import { planScheduleError, type PlanScheduleSlot, type PlanScheduleV1 } from "@/lib/availability/plan";

export { planScheduleError };
export type { PlanScheduleSlot, PlanScheduleV1 };

const mod7 = (n: number) => ((Math.trunc(n) % 7) + 7) % 7;

/** 0=Dom … 6=Sáb → 0=Lun … 6=Dom. Normaliza módulo 7, como el batch. */
export function sunToMonDow(dow: number): number {
  return mod7(dow + 6);
}

/** 0=Lun … 6=Dom → 0=Dom … 6=Sáb. Normaliza módulo 7. */
export function monToSunDow(monDow: number): Dow {
  return mod7(monDow + 1) as Dow;
}

/** Orden de muestra: lunes primero (como la UI). */
const byMonFirst = (a: PlanScheduleSlot, b: PlanScheduleSlot) => sunToMonDow(a.dow) - sunToMonDow(b.dow);

/**
 * Horario semanal desde los días de la UI (0=Lun) con UNA hora para todos
 * (Diagnóstico, el multi-turno del modal, plantillas). Repetidos se colapsan.
 * Sin días → null (el caller exige al menos uno; no se inventa el del inicio).
 */
export function planScheduleFromWeekdays(q: {
  daysOfWeek: ReadonlyArray<number>;
  startMin: number;
  everyNWeeks?: 1 | 2 | 3 | 4;
}): PlanScheduleV1 | null {
  const dows = Array.from(new Set(q.daysOfWeek.map(monToSunDow)));
  if (dows.length === 0) return null;
  return {
    v: 1,
    frequency: "weekly",
    everyNWeeks: q.everyNWeeks ?? 1,
    slots: dows.map((dow) => ({ dow, startMin: q.startMin })).sort(byMonFirst),
  };
}

/** Días del horario en la convención de la UI (0=Lun), ordenados. */
export function planScheduleWeekdays(schedule: PlanScheduleV1): number[] {
  return schedule.slots.map((s) => sunToMonDow(s.dow)).sort((a, b) => a - b);
}

/**
 * El multi-turno del modal (`RecurrenceInput`: ancla + días 0=Lun +
 * frecuencia) como horario de plan + día de inicio ("Crealo como plan…",
 * PD-11). Misma regla que `expandDates`: sin días = el día AR del ancla;
 * biweekly = cada 2 semanas; mensual = el día del ancla. `expandPlanDates`
 * sobre el resultado da las mismas fechas que `expandDates` (test de paridad),
 * salvo el tope: 60 en vez del 58 heredado del batch con un solo día.
 */
export function planScheduleFromBatch(q: {
  anchor: Date;
  daysOfWeek?: ReadonlyArray<number>;
  frequency: Frequency;
}): { schedule: PlanScheduleV1; startDayKey: DayKey } {
  const startDayKey = dayKeyOf(q.anchor);
  const startMin = minutesOfDayAR(q.anchor);
  const anchorDow = toARDow(q.anchor) as Dow;
  if (q.frequency === "monthly") {
    return { schedule: { v: 1, frequency: "monthly", slots: [{ dow: anchorDow, startMin }] }, startDayKey };
  }
  const days = q.daysOfWeek && q.daysOfWeek.length > 0 ? q.daysOfWeek : [sunToMonDow(anchorDow)];
  const schedule = planScheduleFromWeekdays({
    daysOfWeek: days,
    startMin,
    everyNWeeks: q.frequency === "biweekly" ? 2 : 1,
  })!;
  return { schedule, startDayKey };
}

const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** "a", "a y b", "a, b y c". */
function joinEs(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/**
 * Resumen corto del horario (C13: "lun y jue 09:00"):
 *   • misma hora para todos los días → "lun, mié y vie 18:00";
 *   • hora por día → "lun 09:00, jue 18:00 y dom 10:00" (lunes primero);
 *   • cada N semanas → prefijo "cada 3 semanas · ";
 *   • mensual → "mensual 09:30".
 */
export function summarizePlanSchedule(schedule: PlanScheduleV1): string {
  if (schedule.frequency === "monthly") return `mensual ${hhmm(schedule.slots[0].startMin)}`;
  const slots = [...schedule.slots].sort(byMonFirst);
  const sameHour = slots.every((s) => s.startMin === slots[0].startMin);
  const body = sameHour
    ? `${joinEs(slots.map((s) => DOW_SHORT[s.dow]))} ${hhmm(slots[0].startMin)}`
    : joinEs(slots.map((s) => `${DOW_SHORT[s.dow]} ${hhmm(s.startMin)}`));
  const every = schedule.everyNWeeks ?? 1;
  return every > 1 ? `cada ${every} semanas · ${body}` : body;
}
