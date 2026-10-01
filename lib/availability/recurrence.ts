/**
 * Fechas de un multi-turno / Plan (B2.1b) — puro, sin DB ni reloj.
 *
 * `expandDates` generaliza `expandBatchDates` (`lib/booking-schedule.ts`, la
 * extracción literal de ef3281f `lib/bookings.ts:1341-1352`) con una
 * frecuencia:
 *   • weekly   → EXACTAMENTE `expandBatchDates` (paridad con el oráculo en
 *                `tests/unit/availability-recurrence.test.ts`), incluido el
 *                tope heredado de 400 iteraciones: count 60 con un solo día
 *                devuelve 58 (hallazgo de B1.6; se conserva para no cambiar el
 *                batch de hoy — si se quiere arreglar, es una decisión de B3.1
 *                y se cambia la paridad, no esto en silencio).
 *   • biweekly → los mismos días, una semana sí y una no. Semanas lun-dom AR
 *                contadas desde la semana del ancla (la del ancla es la 0, la
 *                que "va"); sin el tope de 400: entrega `count`.
 *   • monthly  → mismo día del mes que el ancla (en AR), ajustado al último
 *                día cuando no existe (31/01 → 28/02 → 31/03: vuelve al 31,
 *                no "se queda" en 28) — decisión 4. Misma hora de pared AR.
 *                `daysOfWeek` no aplica.
 * Tope de `RECURRENCE_MAX_COUNT` (60) para todas = el rango que acepta el
 * batch (1..60).
 *
 * Convención de días: `daysOfWeek` es 0=Lun … 6=Dom (la del batch/UI), NO el
 * `Dow` 0=Dom de `PractitionerSchedule` — ver cabecera de `types.ts`.
 *
 * AR no tiene horario de verano desde 2009: +24 h = +1 día AR y la hora de
 * pared se conserva sumando el offset desde la medianoche AR.
 */
import { AR_OFFSET, toARDateKey, toARDow } from "@/lib/datetime-ar";
import type { DayKey, Frequency, RecurrenceInput } from "@/lib/availability/types";

/** Máximo de fechas que devuelve `expandDates` (= tope del batch). */
export const RECURRENCE_MAX_COUNT = 60;

const DAY_MS = 86_400_000;
/** Tope heredado de `expandBatchDates` (≈ 57 semanas). Solo weekly. */
const WEEKLY_GUARD = 400;
/** Biweekly: alcanza para 60 fechas con un solo día elegido (60 × 14 días). */
const BIWEEKLY_GUARD = (RECURRENCE_MAX_COUNT + 1) * 14;

/** 0=Lun … 6=Dom en AR (convención del batch). */
const monDowAR = (d: Date) => (toARDow(d) + 6) % 7;

/** Medianoche AR de un `DayKey` como instante. */
const arMidnight = (key: DayKey) => new Date(`${key}T00:00:00${AR_OFFSET}`);

/** Días del mes (month 1..12), sin depender de la TZ del host. */
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad2 = (n: number) => String(n).padStart(2, "0");

function clampCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.trunc(count), RECURRENCE_MAX_COUNT);
}

/** Set de días 0=Lun..6=Dom normalizado módulo 7; vacío → el del ancla. */
function daySet(anchor: Date, daysOfWeek: ReadonlyArray<number> | undefined): Set<number> {
  const set = new Set((daysOfWeek ?? []).map((d) => ((d % 7) + 7) % 7));
  if (set.size === 0) set.add(monDowAR(anchor));
  return set;
}

/** Recorre de a +24 h desde el ancla inclusive tomando los días que `keep` acepta. */
function walkDays(
  anchor: Date,
  count: number,
  guardMax: number,
  keep: (cursor: Date, dayIndex: number) => boolean
): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(anchor);
  let guard = 0;
  let dayIndex = 0;
  while (dates.length < count && guard++ < guardMax) {
    if (keep(cursor, dayIndex)) dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + DAY_MS); // +1 día AR (sin DST)
    dayIndex++;
  }
  return dates;
}

function expandMonthly(anchor: Date, count: number): Date[] {
  const key = toARDateKey(anchor);
  const [y, m, d] = key.split("-").map(Number);
  // Offset de pared desde la medianoche AR (hora, minutos, segundos y ms).
  const wallMs = anchor.getTime() - arMidnight(key).getTime();
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const monthIndex = m - 1 + i;
    const year = y + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const day = Math.min(d, daysInMonth(year, month));
    const k = `${year}-${pad2(month)}-${pad2(day)}`;
    dates.push(new Date(arMidnight(k).getTime() + wallMs));
  }
  return dates;
}

/**
 * Fechas de un multi-turno según la frecuencia (ver cabecera). Devuelve
 * instancias nuevas, ordenadas, a lo sumo `RECURRENCE_MAX_COUNT`.
 */
export function expandDates(input: RecurrenceInput): Date[] {
  const count = clampCount(input.count);
  if (count === 0) return [];
  const { anchor } = input;

  if (input.frequency === "monthly") return expandMonthly(anchor, count);

  const days = daySet(anchor, input.daysOfWeek);
  if (input.frequency === "weekly") {
    // Literal de expandBatchDates (paridad).
    return walkDays(anchor, count, WEEKLY_GUARD, (c) => days.has(monDowAR(c)));
  }

  // biweekly: semana lun-dom AR relativa a la del ancla; van las pares.
  const anchorMonDow = monDowAR(anchor);
  return walkDays(anchor, count, BIWEEKLY_GUARD, (c, i) => {
    const week = Math.floor((i + anchorMonDow) / 7);
    return week % 2 === 0 && days.has(monDowAR(c));
  });
}

const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: "Semanal",
  biweekly: "Cada 2 semanas",
  monthly: "Mensual",
};

/** Etiqueta es-AR de la frecuencia ("Semanal", "Cada 2 semanas", "Mensual"). */
export function frequencyLabel(frequency: Frequency): string {
  return FREQUENCY_LABEL[frequency];
}

/**
 * Resumen corto para el modal / Planes, en día AR:
 *   "2 sesiones · Mensual 28/09 → 28/10"
 *   "1 sesión · 10/03"
 *   "2 sesiones · Mensual 15/12/2026 → 15/01/2027" (si cruza de año)
 *   "Sin sesiones"
 * Toma el mínimo y el máximo (no asume orden).
 */
export function summarizeRange(dates: ReadonlyArray<Date>, frequency: Frequency): string {
  if (dates.length === 0) return "Sin sesiones";
  let min = dates[0];
  let max = dates[0];
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const first = toARDateKey(min);
  const last = toARDateKey(max);
  const withYear = first.slice(0, 4) !== last.slice(0, 4);
  const fmt = (key: DayKey) => {
    const [y, m, d] = key.split("-");
    return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
  };
  if (dates.length === 1) return `1 sesión · ${fmt(first)}`;
  return `${dates.length} sesiones · ${frequencyLabel(frequency)} ${fmt(first)} → ${fmt(last)}`;
}
