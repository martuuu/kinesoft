/**
 * [AS-3h] Agenda → Ocupación (plan §23.9). Puro: sin DB, sin reloj propio (`now` / `todayKey` los pasa el caller) y sin
 * `Date#getDay/getHours` del host. La sentencia y la sesión viven en `lib/agenda-occupancy-internal.ts` (server-only).
 *
 * Qué responde la página:
 *   - «Lo que pasó»: promedio de turnos por día de la semana × hora de INICIO de las últimas 4/8/12 semanas COMPLETAS
 *     (lunes a domingo AR, sin la semana en curso: una semana a medias bajaría el promedio de los días que faltan).
 *     El promedio divide por la cantidad de semanas, no por las semanas con turnos: un martes sin nadie también es dato.
 *   - «Lo que viene»: turnos YA dados de los próximos 7/14/28 días desde HOY (incluido), conteo real por fecha × hora.
 *
 * Qué cuenta: lo que retiene cupo (`isHoldingCapacity`, AUDIT §5.18): no cancelado y, de las reservas públicas
 * impagas, solo las que siguen dentro de los 30 min. Es el mismo universo que el tope por intervalo
 * (`lib/availability/interval-cap.ts`), así el «x/tope» de acá dice lo mismo que el modal y el turnero. NO_SHOW y
 * COMPLETED cuentan: ocuparon el horario.
 *
 * El tope (decisión 6 del 19-oct) es por intervalo de 15/30/60 alineado a la hora AR y la tabla es por hora. Criterio:
 *   - intervalo 60 → la celda dice «x/tope» (la hora ES el intervalo);
 *   - intervalo 15 o 30 → la celda dice el conteo de la hora y, si ALGÚN intervalo de esa hora llegó al tope, se marca
 *     «con intervalos topeados» (cuántos de cuántos). Un «5/2» por hora con tope 2 cada 15' mentiría: 5 turnos en
 *     la hora pueden no haber topeado ningún intervalo (2+1+1+1) o haber topeado dos.
 *   - en «Lo que pasó» no hay tope: un promedio contra un tope no dice si algún día se llegó.
 *   - con «Todos los profesionales» tampoco: el tope es de cada profesional, la suma del equipo no se compara con nada.
 */
import type { Capability } from "@/lib/capabilities";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { addDays, dayWindow, dowOfDayKey, formatWallTime } from "@/lib/availability/day";
import type { DayKey } from "@/lib/availability/types";
import { weekStartKey } from "@/lib/agenda-client-state";
import type { IntervalCap } from "@/lib/availability/interval-cap";

export const OCCUPANCY_TABS = ["pasado", "proximo"] as const;
export type OccupancyTab = (typeof OCCUPANCY_TABS)[number];
export const OCCUPANCY_TAB_LABEL: Record<OccupancyTab, string> = { pasado: "Lo que pasó", proximo: "Lo que viene" };

export const PAST_WEEK_OPTIONS = [4, 8, 12] as const;
export const UPCOMING_WEEK_OPTIONS = [1, 2, 4] as const;
export const DEFAULT_PAST_WEEKS = 8;
/** Default de «Lo que viene»: una semana = una tabla. Con 2 o 4 son tablas apiladas (una por semana). */
export const DEFAULT_UPCOMING_WEEKS = 1;

/**
 * Tope de filas de la sentencia (pide `LIMIT OCCUPANCY_ROW_LIMIT + 1`). Las filas agrupadas son pocas (≤ 7 × 24 en
 * el pasado, ≤ 28 × 24 × 4 en lo próximo); lo que puede crecer son las reservas públicas impagas viejas, que vuelven
 * una por una para `isHoldingCapacity`. Pasado el tope la página avisa que el número puede quedar corto.
 */
export const OCCUPANCY_ROW_LIMIT = 20_000;

/**
 * ¿Ve la ocupación de todo el equipo y elige profesional? `agenda.viewAll && (operateAll || billing.manage)`:
 * Titular, Administrador/a, Secretaria, Facturación (y soporte, que ve como la Secretaria). El Profesional tiene
 * `agenda.viewAll` (ve la agenda de todos) pero no opera la de otros ni factura: ve la suya.
 */
export function canSeeTeamOccupancy(caps: ReadonlySet<Capability | string>): boolean {
  return caps.has("agenda.viewAll") && (caps.has("agenda.operateAll") || caps.has("billing.manage"));
}

export type OccupancyParams = { tab: OccupancyTab; weeks: number; pro: string | null };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** `?tab=&semanas=&pro=` → parámetros válidos. Semanas fuera de las opciones de la pestaña → el default. */
export function parseOccupancyParams(sp: {
  tab?: string | string[];
  semanas?: string | string[];
  pro?: string | string[];
}): OccupancyParams {
  const rawTab = first(sp.tab);
  const tab: OccupancyTab = rawTab === "proximo" ? "proximo" : "pasado";
  const options: readonly number[] = tab === "pasado" ? PAST_WEEK_OPTIONS : UPCOMING_WEEK_OPTIONS;
  const n = Number(first(sp.semanas));
  const weeks = options.includes(n) ? n : tab === "pasado" ? DEFAULT_PAST_WEEKS : DEFAULT_UPCOMING_WEEKS;
  const rawPro = first(sp.pro)?.trim();
  // Un cuid mide 25; 64 alcanza y corta cualquier basura antes de que llegue a la sentencia.
  const pro = rawPro && rawPro.length <= 64 ? rawPro : null;
  return { tab, weeks, pro };
}

/**
 * De quién es la ocupación que se mira:
 *   - `team`: ve a todos; `practitionerId` = el elegido (si está entre los profesionales del consultorio) o `null`
 *     («Todos»);
 *   - `own`: el resto, SIEMPRE su propio profesional, aunque mande otro `?pro=` (no es filtro: es barrera);
 *   - `none`: sin vista de equipo y sin profesional propio (no tiene agenda que mirar).
 */
export type OccupancyScope =
  | { kind: "team"; practitionerId: string | null }
  | { kind: "own"; practitionerId: string }
  | { kind: "none" };

export function resolveOccupancyScope(
  caps: ReadonlySet<Capability | string>,
  actorPractitionerId: string | null,
  requestedPro: string | null,
  teamPractitionerIds: ReadonlyArray<string>
): OccupancyScope {
  if (canSeeTeamOccupancy(caps)) {
    return {
      kind: "team",
      practitionerId: requestedPro != null && teamPractitionerIds.includes(requestedPro) ? requestedPro : null,
    };
  }
  return actorPractitionerId ? { kind: "own", practitionerId: actorPractitionerId } : { kind: "none" };
}

/** `[from, to)` de la pestaña, en días AR y en instantes. */
export function occupancyWindow(
  tab: OccupancyTab,
  weeks: number,
  todayKey: DayKey
): { fromKey: DayKey; toKey: DayKey; from: Date; to: Date } {
  const fromKey = tab === "pasado" ? addDays(weekStartKey(todayKey), -7 * weeks) : todayKey;
  const toKey = tab === "pasado" ? weekStartKey(todayKey) : addDays(todayKey, 7 * weeks);
  return { fromKey, toKey, from: dayWindow(fromKey).start, to: dayWindow(toKey).start };
}

/** Lo justo de una reserva pública impaga para `isHoldingCapacity` (no sale de este módulo hacia la UI). */
export type OccupancyHold = {
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
};

/**
 * Una fila de la sentencia. `dow` = ISODOW AR (1 = lunes … 7 = domingo), `hour` 0..23 AR, `day` = "YYYY-MM-DD" AR y
 * `q` = cuarto de hora (0..3), estos dos solo en «Lo que viene». Fila agrupada: `n` turnos y `hold = null`. Reserva
 * pública impaga vieja: `n = 1` y `hold` para decidir acá si sigue reteniendo el cupo.
 */
export type OccupancySqlRow = {
  day: string | null;
  dow: number;
  hour: number;
  q: number | null;
  n: number;
  hold: OccupancyHold | null;
};

const bucketKey = (r: { day: string | null; dow: number; hour: number; q: number | null }) =>
  `${r.day ?? r.dow}|${r.hour}|${r.q ?? ""}`;

/** Conteo por bucket con las reservas públicas vencidas afuera. */
export function countOccupancyBuckets(rows: ReadonlyArray<OccupancySqlRow>, now: Date): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.hold && !isHoldingCapacity(r.hold, now)) continue;
    const k = bucketKey(r);
    m.set(k, (m.get(k) ?? 0) + r.n);
  }
  return m;
}

export type OccupancyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** 0 = vacío; 1..5 = quintos del máximo de la vista (5 niveles de `--sky-*`). */
export function occupancyLevel(value: number, max: number): OccupancyLevel {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5))) as OccupancyLevel;
}

export type OccupancyCell = {
  value: number;
  /** El número que se lee en la celda: «1,5», «3», «2/2». */
  text: string;
  level: OccupancyLevel;
  /** Llegó al tope (intervalo 60) o algún intervalo de la hora llegó (15/30): lleva la marca ▲. */
  atCap: boolean;
  /**
   * T3-Z M6: la celda se PINTA como topeada (relleno fuerte). Solo con intervalo 60, donde la hora es el intervalo; con
   * 15/30 basta que UN intervalo llegue para `atCap`, y pintar la hora entera de «en el tope» decía que no entraba nadie
   * más en toda la hora cuando quedaban intervalos libres. Ahí va solo el ▲ y la nota.
   */
  capFill: boolean;
  /** Detalle del tope para el `title` y el lector de pantalla, o null. */
  note: string | null;
};

export type OccupancyColumn = { key: string; label: string; short: string };
export type OccupancyRow = { hour: number; label: string; cells: OccupancyCell[] };
export type OccupancyTable = { id: string; caption: string; columns: OccupancyColumn[]; rows: OccupancyRow[] };

const DOW_LABEL = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DOW_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** "1,5" / "2" / "0": una decimal solo si hace falta (coma decimal, es-AR). */
export function formatOccupancyAverage(v: number): string {
  const r = Math.round(v * 10) / 10;
  if (v > 0 && r === 0) return "0,1";
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace(".", ",");
}

/** "DD/MM" de un DayKey (string, sin `Date`). */
export const dayMonth = (k: DayKey) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;

/** Horas a mostrar: el horario del consultorio y cualquier hora con turnos fuera de él. */
function hoursToShow(dataHours: Iterable<number>, businessHours: { start: number; end: number }): number[] {
  const s = new Set<number>();
  const start = Math.max(0, Math.min(23, Math.floor(businessHours.start)));
  const end = Math.max(start + 1, Math.min(24, Math.ceil(businessHours.end)));
  for (let h = start; h < end; h++) s.add(h);
  for (const h of dataHours) if (h >= 0 && h <= 23) s.add(h);
  return [...s].sort((a, b) => a - b);
}

const hourLabel = (h: number) => formatWallTime(h * 60);

/**
 * «Lo que pasó»: una tabla día de la semana (lunes→sábado, y domingo si hubo turnos) × hora, promedio por semana.
 */
export function buildPastTable(
  rows: ReadonlyArray<OccupancySqlRow>,
  o: { weeks: number; now: Date; fromKey: DayKey; toKey: DayKey; businessHours: { start: number; end: number } }
): OccupancyTable {
  const counts = countOccupancyBuckets(rows, o.now);
  const at = (dow: number, hour: number) => counts.get(bucketKey({ day: null, dow, hour, q: null })) ?? 0;
  const dataHours = new Set<number>();
  let sundayHasData = false;
  for (const r of rows) {
    dataHours.add(r.hour);
    if (r.dow === 7) sundayHasData = true;
  }
  const isoDows = sundayHasData ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6];
  const hours = hoursToShow(dataHours, o.businessHours);
  const avg = (dow: number, h: number) => at(dow, h) / o.weeks;
  let max = 0;
  for (const h of hours) for (const d of isoDows) max = Math.max(max, avg(d, h));
  const lastKey = addDays(o.toKey, -1);
  return {
    id: "pasado",
    caption: `Promedio de turnos por día y hora de inicio · últimas ${o.weeks} semanas completas (del ${dayMonth(
      o.fromKey
    )} al ${dayMonth(lastKey)})`,
    columns: isoDows.map((d) => ({ key: String(d), label: DOW_LABEL[d % 7], short: DOW_SHORT[d % 7] })),
    rows: hours.map((h) => ({
      hour: h,
      label: hourLabel(h),
      cells: isoDows.map((d) => {
        const v = avg(d, h);
        return { value: v, text: formatOccupancyAverage(v), level: occupancyLevel(v, max), atCap: false, capFill: false, note: null };
      }),
    })),
  };
}

/** Celda de «Lo que viene» para una hora con el conteo por cuarto de hora y el tope del profesional (o null). */
export function upcomingCell(
  quarters: readonly [number, number, number, number],
  cap: IntervalCap | null,
  max: number
): OccupancyCell {
  const count = quarters[0] + quarters[1] + quarters[2] + quarters[3];
  const level = occupancyLevel(count, max);
  if (!cap) return { value: count, text: String(count), level, atCap: false, capFill: false, note: null };
  if (cap.intervalMin === 60) {
    const atCap = count >= cap.count;
    return {
      value: count,
      text: `${count}/${cap.count}`,
      level,
      atCap,
      capFill: atCap,
      note: atCap ? (count > cap.count ? "Pasó el tope (hay sobreturnos)" : "En el tope") : null,
    };
  }
  const per = cap.intervalMin / 15; // 1 (15') o 2 (30')
  const intervals = 60 / cap.intervalMin;
  let capped = 0;
  for (let i = 0; i < intervals; i++) {
    let used = 0;
    for (let j = 0; j < per; j++) used += quarters[i * per + j];
    if (used >= cap.count) capped++;
  }
  return {
    value: count,
    text: String(count),
    level,
    atCap: capped > 0,
    capFill: false,
    note:
      capped > 0
        ? `En ${capped} de ${intervals} intervalos de ${cap.intervalMin} min se llegó al tope de ${
            cap.count === 1 ? "1 turno" : `${cap.count} turnos`
          }.`
        : null,
  };
}

/**
 * «Lo que viene»: una tabla por semana (7 días desde `fromKey`, el domingo solo si tiene turnos) × hora. El nivel de
 * color se calcula contra el máximo de TODAS las semanas, así dos tablas apiladas se comparan a ojo.
 */
export function buildUpcomingTables(
  rows: ReadonlyArray<OccupancySqlRow>,
  o: { weeks: number; now: Date; fromKey: DayKey; cap: IntervalCap | null; businessHours: { start: number; end: number } }
): OccupancyTable[] {
  const counts = countOccupancyBuckets(rows, o.now);
  const quartersOf = (day: string, hour: number): [number, number, number, number] => {
    const q = (i: number) => counts.get(bucketKey({ day, dow: 0, hour, q: i })) ?? 0;
    return [q(0), q(1), q(2), q(3)];
  };
  const dataHours = new Set<number>();
  const daysWithData = new Set<string>();
  for (const r of rows) {
    dataHours.add(r.hour);
    if (r.day) daysWithData.add(r.day);
  }
  const hours = hoursToShow(dataHours, o.businessHours);
  const allDays = Array.from({ length: 7 * o.weeks }, (_, i) => addDays(o.fromKey, i));
  let max = 0;
  for (const d of allDays)
    for (const h of hours) {
      const [a, b, c, e] = quartersOf(d, h);
      max = Math.max(max, a + b + c + e);
    }
  const tables: OccupancyTable[] = [];
  for (let w = 0; w < o.weeks; w++) {
    const days = allDays.slice(w * 7, w * 7 + 7).filter((d) => dowOfDayKey(d) !== 0 || daysWithData.has(d));
    const first = allDays[w * 7];
    const last = allDays[w * 7 + 6];
    tables.push({
      id: `proximo-${w + 1}`,
      caption: `Turnos dados por día y hora de inicio · del ${dayMonth(first)} al ${dayMonth(last)}${
        o.cap ? ` · tope: ${o.cap.count} cada ${o.cap.intervalMin} min` : ""
      }`,
      columns: days.map((d) => {
        const dow = dowOfDayKey(d);
        return { key: d, label: `${DOW_LABEL[dow]} ${dayMonth(d)}`, short: `${DOW_SHORT[dow]} ${dayMonth(d)}` };
      }),
      rows: hours.map((h) => ({
        hour: h,
        label: hourLabel(h),
        cells: days.map((d) => upcomingCell(quartersOf(d, h), o.cap, max)),
      })),
    });
  }
  return tables;
}

/** Lo que la página recibe: sin claves de paciente ni de turno (solo conteos por bucket y nombres de profesionales). */
export type OccupancyView = {
  params: OccupancyParams;
  scope: OccupancyScope;
  /** Profesionales para el selector (solo en `team`). */
  practitioners: { id: string; name: string }[];
  /** Nombre del profesional que se mira (`own` o `team` con uno elegido), o null («Todos»). */
  practitionerName: string | null;
  cap: IntervalCap | null;
  tables: OccupancyTable[];
  truncated: boolean;
};
