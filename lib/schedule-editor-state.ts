/**
 * Estado del editor de horarios de Configuración (B3.4 CFG-UI-1, B-pre).
 *
 * Puro (sin React, sin DB, sin reloj implícito): lo usan
 * `components/configuracion/panels/practitioners/{schedule-editor,exceptions-editor}.tsx`
 * y lo cubre `tests/unit/schedule-editor-state.test.ts`.
 *
 * Por qué existe: la action `savePractitionerWeek` recibe un array PLANO de
 * franjas y devuelve los errores por POSICIÓN (`fieldErrors["ranges.<i>"]`),
 * pero la UI edita por día y por fila (con agregar/quitar/copiar en el medio).
 * Sin un mapa estable índice → fila, un error del server se pintaba en la
 * fila equivocada apenas el usuario borraba una franja de otro día. Acá:
 *   • `WeekDraft` = franjas por `dow`, cada una con `key` estable;
 *   • `draftToPayload` aplana en orden fijo (Lun…Dom) y devuelve `keys[i]`;
 *   • `fieldErrorsToRowErrors` vuelve de `ranges.<i>` a la `key` de la fila.
 *
 * Convenciones (las de `lib/schedule-validate.ts`): minutos de pared AR desde
 * 00:00, semiabiertos, pasos de 5; `dow` 0=Dom … 6=Sáb.
 */
import {
  MAX_RANGES_PER_DAY,
  SCHEDULE_STEP_MIN,
  formatHHMM,
  validateDayRanges,
  validateWeekRanges,
  type WeekRangeInput,
} from "@/lib/schedule-validate";
import type { DayKey } from "@/lib/availability/types";

export type DraftRange = { key: string; startMin: number; endMin: number; locationId: string };
/** Índice = dow (0=Dom … 6=Sáb). Siempre 7 entradas. */
export type WeekDraft = DraftRange[][];

/** Orden de la semana en pantalla: lunes primero (igual que `summarizeWeek`). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DOW_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;
/** Lun-Sáb: la semana de la red de seguridad del motor (`FALLBACK_WORKING_DOWS`). */
const FALLBACK_DOWS = [1, 2, 3, 4, 5, 6] as const;

let seq = 0;
/** Clave local de fila (solo para React y para mapear errores; nunca viaja al server). */
export function newRangeKey(): string {
  seq += 1;
  return `r${seq}`;
}

export function emptyWeek(): WeekDraft {
  return [[], [], [], [], [], [], []];
}

/**
 * Semana inicial del editor. Con `isFallback` (el profesional no tiene
 * franjas) se precarga lo que el motor YA le aplica: horario del consultorio
 * lun-sáb en la sede principal. Así "guardar sin tocar" deja escrito lo mismo
 * que hoy rige, y editar parte de lo real, no de una semana en blanco.
 */
export function draftFromView(
  view: {
    ranges: ReadonlyArray<{ dow: number; startMin: number; endMin: number; locationId: string }>;
    isFallback: boolean;
    tenantHours: { startMin: number; endMin: number };
  },
  primaryLocationId: string
): WeekDraft {
  const week = emptyWeek();
  if (view.isFallback) {
    for (const dow of FALLBACK_DOWS) {
      week[dow].push({
        key: newRangeKey(),
        startMin: view.tenantHours.startMin,
        endMin: view.tenantHours.endMin,
        locationId: primaryLocationId,
      });
    }
    return week;
  }
  for (const r of view.ranges) {
    if (r.dow < 0 || r.dow > 6) continue;
    week[r.dow].push({ key: newRangeKey(), startMin: r.startMin, endMin: r.endMin, locationId: r.locationId });
  }
  for (const day of week) day.sort((a, b) => a.startMin - b.startMin);
  return week;
}

/** Aplana en orden Lun…Dom y fila; `keys[i]` es la fila de `ranges[i]`. */
export function draftToPayload(week: WeekDraft): { ranges: WeekRangeInput[]; keys: string[] } {
  const ranges: WeekRangeInput[] = [];
  const keys: string[] = [];
  for (const dow of WEEK_ORDER) {
    for (const r of week[dow] ?? []) {
      ranges.push({ dow, startMin: r.startMin, endMin: r.endMin, locationId: r.locationId });
      keys.push(r.key);
    }
  }
  return { ranges, keys };
}

/** Firma comparable de la semana (sin keys, días ordenados): base del dirty-guard. */
export function weekSignature(week: WeekDraft): string {
  return week
    .map((day) =>
      [...day]
        .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
        .map((r) => `${r.startMin}-${r.endMin}@${r.locationId}`)
        .join(",")
    )
    .join("|");
}

export function rangesSignature(ranges: ReadonlyArray<{ startMin: number; endMin: number; locationId: string }>): string {
  return [...ranges]
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
    .map((r) => `${r.startMin}-${r.endMin}@${r.locationId}`)
    .join(",");
}

/** `{ "ranges.3": ["…"] }` + `keys` → `{ [rowKey]: "…" }`. Ignora claves que no son de fila. */
export function fieldErrorsToRowErrors(
  fieldErrors: Record<string, string[] | undefined> | undefined,
  keys: ReadonlyArray<string>
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fieldErrors) return out;
  for (const [k, msgs] of Object.entries(fieldErrors)) {
    const m = /^ranges\.(\d+)$/.exec(k);
    if (!m || !msgs?.length) continue;
    const key = keys[Number(m[1])];
    if (key && !out[key]) out[key] = msgs[0];
  }
  return out;
}

/**
 * Errores de la semana calculados en el cliente con el MISMO validador que la
 * action (`validateWeekRanges`): marcan la fila mala sin ir al server. Con
 * `activeLocationIds`, una franja en una sede archivada también se marca.
 */
export function validateDraft(
  week: WeekDraft,
  activeLocationIds?: ReadonlySet<string>
): Record<string, string> {
  const { ranges, keys } = draftToPayload(week);
  const res = validateWeekRanges(ranges, activeLocationIds ? { activeLocationIds } : {});
  if (res.ok) return {};
  const out: Record<string, string> = {};
  for (const e of res.errors) {
    const key = keys[e.index];
    if (key) out[key] = e.message;
  }
  return out;
}

/** Igual que `validateDraft` pero para las franjas de UN día (excepción CUSTOM_HOURS). */
export function validateDayDraft(
  rows: ReadonlyArray<DraftRange>,
  activeLocationIds?: ReadonlySet<string>
): Record<string, string> {
  const res = validateDayRanges(rows, activeLocationIds ? { activeLocationIds } : {});
  if (res.ok) return {};
  const out: Record<string, string> = {};
  for (const e of res.errors) {
    const key = rows[e.index]?.key;
    if (key) out[key] = e.message;
  }
  return out;
}

/**
 * Franja nueva para un día: sin franjas → el horario del consultorio; con
 * franjas → arranca donde termina la última y dura 4 h (o hasta 24:00).
 * null si no entra (la última termina a las 24:00 o se llegó al tope).
 */
export function nextRange(
  day: ReadonlyArray<DraftRange>,
  defaults: { startMin: number; endMin: number; locationId: string }
): DraftRange | null {
  if (day.length >= MAX_RANGES_PER_DAY) return null;
  if (day.length === 0) {
    return { key: newRangeKey(), ...defaults };
  }
  const last = [...day].sort((a, b) => a.endMin - b.endMin)[day.length - 1];
  const start = last.endMin;
  if (start >= 1440) return null;
  return {
    key: newRangeKey(),
    startMin: start,
    endMin: Math.min(start + 240, 1440),
    locationId: last.locationId || defaults.locationId,
  };
}

/** Copia las franjas de `fromDow` a cada día de `toDows` (reemplaza; keys nuevas). */
export function copyDay(week: WeekDraft, fromDow: number, toDows: ReadonlyArray<number>): WeekDraft {
  const src = week[fromDow] ?? [];
  return week.map((day, dow) =>
    dow !== fromDow && toDows.includes(dow) ? src.map((r) => ({ ...r, key: newRangeKey() })) : day
  );
}

/** Opciones de hora en pasos de 5 min. `end` incluye 24:00 y excluye 00:00. */
export function timeOptions(kind: "start" | "end"): Array<{ value: number; label: string }> {
  const out: Array<{ value: number; label: string }> = [];
  const from = kind === "start" ? 0 : SCHEDULE_STEP_MIN;
  const to = kind === "start" ? 1440 - SCHEDULE_STEP_MIN : 1440;
  for (let m = from; m <= to; m += SCHEDULE_STEP_MIN) out.push({ value: m, label: formatHHMM(m) });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meses y días (lista de excepciones). Un DayKey es una ETIQUETA de día AR; la
// aritmética se hace sobre la etiqueta en UTC (como `dayKeyDiff`), nunca con
// el reloj del host.
// ─────────────────────────────────────────────────────────────────────────────

/** "2026-10" */
export type MonthKey = string;

export function monthOf(dayKey: DayKey): MonthKey {
  return dayKey.slice(0, 7);
}

export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Primer y último DayKey del mes (inclusive), para `listExceptions`. */
export function monthRange(month: MonthKey): { from: DayKey; to: DayKey } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Día de la semana (0=Dom) de una etiqueta de día. */
export function dowOfDayKey(dayKey: DayKey): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;
const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** "Octubre 2026" (sin Intl: el label no depende del locale ni del TZ del navegador). */
export function monthLabel(month: MonthKey): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1] ?? "?";
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

/** "jue 1 oct" */
export function dayKeyLabel(dayKey: DayKey): string {
  const [, m, d] = dayKey.split("-").map(Number);
  return `${DOW_SHORT[dowOfDayKey(dayKey)]} ${d} ${(MONTHS[m - 1] ?? "?").slice(0, 3)}`;
}

/** "9-13, 15-19" para una lista de franjas. */
export function rangesLabel(ranges: ReadonlyArray<{ startMin: number; endMin: number }>): string {
  return [...ranges]
    .sort((a, b) => a.startMin - b.startMin)
    .map((r) => `${formatHHMM(r.startMin)}–${formatHHMM(r.endMin)}`)
    .join(", ");
}
