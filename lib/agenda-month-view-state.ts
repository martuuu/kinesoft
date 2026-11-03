/**
 * CF2 (§29 D-CF2-7, brief A.4) — modelo PURO de la vista Mes: de `AgendaMonthSummary` (el cable compacto de
 * `getAgendaMonthSummary`) a lo que pinta cada celda. Client-safe, sin React: lo prueba
 * `tests/unit/cf2-month-view-state.test.ts` en TZ=UTC y AR.
 *
 * Por qué el filtro de profesionales va acá y no en el server: el resumen viaja por profesional, así cambiar los chips
 * no re-pide nada (la sede sí, porque cambia qué turnos y qué franjas cuentan). La cantidad de la celda es la de los
 * ELEGIDOS; con los ausentes ocultos se restan (la misma regla que `showNoShow` en las otras vistas). El candado se
 * agrega con `aggregateDayLock` sobre los visibles, igual que el header de Día y la tira de Semana: el que no atiende
 * ese día no cuenta, y si nadie atiende el día es «Sin atención».
 *
 * Fechas: todo sobre DayKeys AR. El día de la semana sale de la posición en la grilla (`monthGridRange` arranca
 * siempre en lunes) y los nombres de días y meses son tablas fijas: nada de `getDay`/`toLocale*` del host.
 */
import { aggregateDayLock, type AggregatedDayLock } from "@/lib/agenda-client-state";
import { dayKeyDiff } from "@/lib/availability/day";
import type { DayKey, DayLockState } from "@/lib/availability/types";
import type { AgendaMonthDay, AgendaMonthSummary, MonthLockCode } from "@/lib/agenda-month-types";

export type MonthViewPractitioner = { id: string; name: string; initials: string };

export type MonthCellPractitioner = MonthViewPractitioner & { count: number };

/** Estado del día que se pinta (sin `blockIds`: el candado no se abre desde Mes). */
export type MonthCellLock = Pick<AggregatedDayLock, "status" | "detail">;

export type MonthCellModel = {
  key: DayKey;
  /** Número del día (1-31). */
  day: number;
  /** 0 = lunes … 6 = domingo (columna de la grilla). */
  dow: number;
  inMonth: boolean;
  isToday: boolean;
  /** Turnos de los profesionales visibles (sin cancelados; sin ausentes si se ocultan). */
  count: number;
  /** Desglose por profesional (orden de la lista, solo con turnos). Vacío si hay un solo visible o un solo con turnos. */
  perPractitioner: MonthCellPractitioner[];
  lock: MonthCellLock;
  ariaLabel: string;
  /** Tooltip del estado («Bloqueado: Vacaciones»); undefined si está abierto. */
  title: string | undefined;
};

export type MonthCellContext = {
  /** "YYYY-MM" del mes que se mira (el resto de la grilla va atenuado). */
  monthKey: string;
  todayKey: DayKey;
  /** `[]` = «Todos» (como `?pros=` vacío). */
  selectedIds: ReadonlyArray<string>;
  /** En el orden de los chips. */
  practitioners: ReadonlyArray<MonthViewPractitioner>;
  hideNoShow: boolean;
};

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** Encabezado corto de columna (0 = lunes). */
export const MONTH_WEEKDAY_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;

/** «noviembre de 2026» desde "2026-11" (tabla fija: el mismo texto en el server y en cualquier TZ). */
export function monthLabel(monthKey: string): string {
  return `${MONTHS[Number(monthKey.slice(5, 7)) - 1]} de ${monthKey.slice(0, 4)}`;
}

/** Día de la semana de un DayKey, 0 = lunes. Aritmética de etiquetas (2024-01-01 fue lunes), sin reloj del host. */
function mondayDow(key: DayKey): number {
  return (((dayKeyDiff("2024-01-01", key) % 7) + 7) % 7) as number;
}

/**
 * Código del cable → `DayLockState` del motor, para reusar `aggregateDayLock` tal cual. `x` es «sin franjas» (no
 * atiende): `aggregateDayLock` lo descarta. `l` puede venir de un bloqueo o de una excepción CERRADO: para el agregado
 * da igual (solo importa que no es `sin-franjas`).
 */
export function monthLockToState(code: MonthLockCode | undefined, detail: string | undefined): DayLockState {
  if (code === "p") return { status: "partial", reason: "bloqueo", detail: detail ?? null, blockIds: [] };
  if (code === "l") return { status: "locked", reason: "bloqueo", detail: detail ?? null, blockIds: [] };
  if (code === "x") return { status: "locked", reason: "sin-franjas", detail: null, blockIds: [] };
  return { status: "open", reason: null, detail: null, blockIds: [] };
}

/** Tooltip del estado. Mismo copy que la tira (`week-strip.tsx`) + «Sin atención». */
export function monthLockTitle(lock: MonthCellLock): string | undefined {
  const why = lock.detail ? `: ${lock.detail}` : "";
  if (lock.status === "locked") return `Bloqueado${why}`;
  if (lock.status === "partial") return `Bloqueado en parte${why}`;
  if (lock.status === "off") return "Sin atención";
  return undefined;
}

/**
 * «Martes 3 de noviembre: 12 turnos, bloqueado: Vacaciones. Ver el día». El botón es la celda entera: el lector de
 * pantalla tiene que oír todo lo que se ve (cantidad, desglose, estado), porque el contenido visual va `aria-hidden`.
 */
export function monthDayAriaLabel(c: Pick<MonthCellModel, "key" | "isToday" | "count" | "perPractitioner" | "lock">): string {
  const dayName = WEEKDAYS[mondayDow(c.key)];
  const date = `${dayName} ${Number(c.key.slice(8, 10))} de ${MONTHS[Number(c.key.slice(5, 7)) - 1]}`;
  const head = c.isToday ? `Hoy, ${date}` : date.charAt(0).toUpperCase() + date.slice(1);
  let what = c.count === 0 ? "sin turnos" : c.count === 1 ? "1 turno" : `${c.count} turnos`;
  if (c.perPractitioner.length > 0) what += ` (${c.perPractitioner.map((p) => `${p.name} ${p.count}`).join(", ")})`;
  const why = c.lock.detail ? `: ${c.lock.detail}` : "";
  const state =
    c.lock.status === "locked"
      ? `, bloqueado${why}`
      : c.lock.status === "partial"
        ? `, bloqueado en parte${why}`
        : c.lock.status === "off"
          ? ", sin atención"
          : "";
  return `${head}: ${what}${state}. Ver el día`;
}

const countOf = (pair: readonly [number, number] | undefined, hideNoShow: boolean) =>
  pair ? pair[0] - (hideNoShow ? pair[1] : 0) : 0;

export function monthCellModel(day: AgendaMonthDay, ctx: MonthCellContext): MonthCellModel {
  const all = ctx.selectedIds.length === 0;
  const visibleIds = all ? ctx.practitioners.map((p) => p.id) : ctx.selectedIds;
  const c = day.c ?? {};

  // «Todos» suma TODO lo del día, también turnos de un profesional que no está en la lista (suspendido, con turnos
  // viejos): en Semana el filtro vacío los deja pasar, y el Mes no puede dar un número menor que la semana.
  let count = 0;
  if (all) for (const pair of Object.values(c)) count += countOf(pair, ctx.hideNoShow);
  else for (const id of visibleIds) count += countOf(c[id], ctx.hideNoShow);

  const known = new Map(ctx.practitioners.map((p) => [p.id, p]));
  const withCount: MonthCellPractitioner[] = [];
  if (visibleIds.length > 1) {
    for (const id of visibleIds) {
      const p = known.get(id);
      const n = countOf(c[id], ctx.hideNoShow);
      if (p && n > 0) withCount.push({ ...p, count: n });
    }
  }
  // Un solo profesional con turnos: el desglose repetiría la cantidad.
  const perPractitioner = withCount.length > 1 ? withCount : [];

  const agg = aggregateDayLock(visibleIds.map((id) => monthLockToState(day.l?.[id], day.d?.[id])));
  const lock: MonthCellLock = { status: agg.status, detail: agg.detail };

  const base = {
    key: day.k,
    day: Number(day.k.slice(8, 10)),
    dow: mondayDow(day.k),
    inMonth: day.k.slice(0, 7) === ctx.monthKey,
    isToday: day.k === ctx.todayKey,
    count,
    perPractitioner,
    lock,
  };
  return { ...base, ariaLabel: monthDayAriaLabel(base), title: monthLockTitle(lock) };
}

export type MonthGridModel = {
  /** Columnas visibles (0 = lunes … 6 = domingo), en orden. */
  columns: number[];
  /** Semanas de la grilla, cada una con las celdas de `columns`. */
  weeks: MonthCellModel[][];
  /** Turnos visibles en los días DEL MES (para el estado vacío). */
  monthTotal: number;
};

export function monthGridModel(
  summary: AgendaMonthSummary,
  ctx: MonthCellContext & { showSaturday: boolean; showSunday: boolean }
): MonthGridModel {
  const columns = [0, 1, 2, 3, 4];
  if (ctx.showSaturday) columns.push(5);
  if (ctx.showSunday) columns.push(6);
  const show = new Set(columns);
  const weeks: MonthCellModel[][] = [];
  let monthTotal = 0;
  summary.days.forEach((d, i) => {
    const cell = monthCellModel(d, ctx);
    if (cell.inMonth) monthTotal += cell.count;
    if (i % 7 === 0) weeks.push([]);
    if (show.has(cell.dow)) weeks[weeks.length - 1].push(cell);
  });
  return { columns, weeks, monthTotal };
}

/**
 * Conteo de los chips en Mes: turnos de cada profesional en los días DEL MES (los de la semana anterior/siguiente
 * que completan la grilla son de otro mes). Como los chips de Día y Semana: sin filtrar por la selección (cada chip
 * dice cuántos tiene ese profesional) y en la sede elegida (el resumen ya viene de esa sede).
 */
export function monthPractitionerCounts(
  summary: AgendaMonthSummary,
  p: { monthKey: string; hideNoShow: boolean }
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of summary.days) {
    if (d.k.slice(0, 7) !== p.monthKey || !d.c) continue;
    for (const [id, pair] of Object.entries(d.c)) out[id] = (out[id] ?? 0) + countOf(pair, p.hideNoShow);
  }
  return out;
}

/** ¿El resumen cargado es el de esta grilla y esta sede? Si no, hay que pedirlo. */
export function monthSummaryMatches(
  s: Pick<AgendaMonthSummary, "from" | "to" | "locationId"> | null | undefined,
  want: { from: DayKey; to: DayKey; locationId: string | null }
): boolean {
  return !!s && s.from === want.from && s.to === want.to && (s.locationId ?? null) === (want.locationId ?? null);
}
