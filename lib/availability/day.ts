/**
 * Día AR ↔ instantes — B2.1a del motor de disponibilidad (puro, sin DB ni reloj).
 *
 * Todo el motor razona en `DayKey` ("YYYY-MM-DD" de pared AR) + minutos de pared
 * 0..1440; acá está el ÚNICO puente con los instantes (`Date` UTC real). Nada
 * de `getDay/getHours/setHours/toISOString().slice(0,10)` del host: en Vercel
 * el host es UTC y esos métodos corren el día 3 h (21:00 AR ya es "mañana").
 *
 * Por qué así:
 *   • El ancla del día se arma con `localToARIso` (offset AR de
 *     `lib/datetime-ar.ts`), igual que `arDayWindow` de
 *     `lib/public-booking-slots.ts` (el turnero de hoy; NO está en
 *     `lib/bookings.ts`, que tiene su propio `T03:00:00Z` literal en ~:186).
 *     Se replica acá en vez de importarlo para que el motor no dependa del
 *     módulo del turnero, que B3.2 convierte en un envoltorio del motor; la
 *     paridad la fija `tests/unit/availability-day.test.ts`.
 *   • Minuto m del día = medianoche AR + m min. Vale porque Argentina no tiene
 *     DST desde 2009 (todo día AR dura 24 h; mismo supuesto que `arDayWindow`).
 *     Si volviera el DST, este archivo es el único lugar a tocar.
 *   • `minutesOfDayAR` normaliza `% 1440`: `toARMinutes` devolvía 1440 a la
 *     medianoche AR porque `Intl` con `hour12:false` formatea la hora "24"
 *     (medido en Node 20). El integrador de B2 lo arregló en
 *     `lib/datetime-ar.ts` (`% 24`); el `% 1440` queda como defensa.
 *   • `@db.Date` (validFrom/validUntil, ScheduleException.date) llega de
 *     Prisma como `Date` a 00:00 UTC: se pasa a DayKey con el slice UTC
 *     (intencional, como `dateOfBirth`). Con `toARDateKey` daría el día
 *     ANTERIOR (00:00 UTC = 21:00 AR).
 *   • La aritmética de calendario (`addDays`) usa `Date.UTC` a propósito: es
 *     sobre fechas sin hora, no sobre el reloj, así que no hay huso en juego.
 */
import { localToARIso, toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import { MINUTES_PER_DAY, type DayKey, type Dow } from "@/lib/availability/types";

const DAY_MS = MINUTES_PER_DAY * 60_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es un "YYYY-MM-DD" que existe en el calendario? (2026-02-29 no). */
export function isDayKey(s: string): s is DayKey {
  const m = DAY_KEY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function assertDayKey(k: string): void {
  if (!isDayKey(k)) throw new RangeError(`DayKey inválido: ${JSON.stringify(k)}`);
}

/** Medianoche AR del día (como instante). Tira RangeError si la clave es inválida. */
function dayStart(dayKey: DayKey): Date {
  assertDayKey(dayKey);
  return new Date(localToARIso(`${dayKey}T00:00:00`));
}

/** `[start, end)` del día AR: medianoche AR y la siguiente (+24 h, sin DST). */
export function dayWindow(dayKey: DayKey): { start: Date; end: Date } {
  const start = dayStart(dayKey);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Instante de la hora de pared `minute` (0..1440) del día AR `dayKey`.
 * 1440 = la medianoche siguiente (fin semiabierto de una franja que cierra a
 * las 24:00).
 */
export function instantAt(dayKey: DayKey, minute: number): Date {
  if (!(minute >= 0 && minute <= MINUTES_PER_DAY)) {
    throw new RangeError(`Minuto fuera de 0..${MINUTES_PER_DAY}: ${minute}`);
  }
  return new Date(dayStart(dayKey).getTime() + minute * 60_000);
}

/**
 * Minutos (pueden ser fraccionarios o salirse de 0..1440) entre la medianoche
 * AR de `dayKey` y `instant`. Es lo que usa `ranges.ts` para llevar un
 * TimeBlock (instantes) a minutos de pared de UN día y después recortarlo.
 */
export function minuteInDay(dayKey: DayKey, instant: Date): number {
  return (instant.getTime() - dayStart(dayKey).getTime()) / 60_000;
}

/** Minutos de pared AR (0..1439) de un instante, dentro de SU día AR. */
export function minutesOfDayAR(instant: Date): number {
  return toARMinutes(instant) % MINUTES_PER_DAY;
}

/** DayKey AR de un instante. */
export function dayKeyOf(instant: Date): DayKey {
  return toARDateKey(instant);
}

/** Día de la semana AR del día (0=Dom … 6=Sáb, convención de `toARDow`). */
export function dowOfDayKey(dayKey: DayKey): Dow {
  // Mediodía AR: lejos de cualquier borde de día.
  return toARDow(instantAt(dayKey, 12 * 60)) as Dow;
}

/** `@db.Date` (Date a 00:00 UTC) → DayKey. Slice UTC intencional (ver cabecera). */
export function dbDateToDayKey(d: Date): DayKey;
export function dbDateToDayKey(d: Date | null): DayKey | null;
export function dbDateToDayKey(d: Date | null): DayKey | null {
  if (d == null) return null;
  return d.toISOString().slice(0, 10);
}

/** DayKey → `Date` a 00:00 UTC, que es lo que Prisma espera para un `@db.Date`. */
export function dayKeyToDbDate(dayKey: DayKey): Date {
  assertDayKey(dayKey);
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/** Suma `n` días de calendario (n puede ser negativo). */
export function addDays(dayKey: DayKey, n: number): DayKey {
  assertDayKey(dayKey);
  const m = DAY_KEY_RE.exec(dayKey)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** Días de calendario entre dos DayKeys (b − a), exacto: aritmética UTC sobre
 *  etiquetas sin hora. Antes vivía duplicado en `lib/schedule-validate.ts`
 *  (B2.4a); el integrador de B2 lo consolidó acá y aquel lo re-exporta. */
export function dayKeyDiff(a: DayKey, b: DayKey): number {
  return Math.round((dayKeyToDbDate(b).getTime() - dayKeyToDbDate(a).getTime()) / DAY_MS);
}

/** Días de `from` a `to`, inclusive en ambos extremos; vacío si `from > to`. */
export function dayKeyRange(from: DayKey, to: DayKey): DayKey[] {
  assertDayKey(from);
  assertDayKey(to);
  const out: DayKey[] = [];
  // Comparación de strings: "YYYY-MM-DD" ordena igual que el calendario.
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

/** "HH:MM" de minutos de pared (para mostrar; el cliente no lo recalcula). */
export function formatWallTime(minute: number): string {
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
