/**
 * Lógica pura del modo «Varias sesiones» del modal de turnos (B5.3
 * MOD-sessions). Vive fuera de `components/agenda/booking-modal/
 * sessions-mode.tsx` ("use client") para testearla sin DOM
 * (`tests/unit/sessions-mode-state.test.ts`). Sin reloj, sin red, sin Prisma.
 *
 * Es la puerta liviana al futuro motor de Planes: crea N turnos SUELTOS con
 * `createBookingsBatch` (NO un TreatmentProgram). Por eso el `value` es
 * exactamente lo que el batch entiende (`count`, `daysOfWeek` 0=Lun,
 * `frequency`) y `toBatchFields` es el único lugar donde se traduce.
 *
 * Decisiones:
 *   • Cantidad 1..20 en la UI (`SESSIONS_UI_MAX_COUNT`, como drapp): un
 *     tratamiento real no pasa de ahí y la lista de fechas sigue siendo
 *     legible. El server acepta 1..60 (`RECURRENCE_MAX_COUNT`); no se toca.
 *   • Mensual = mismo día del mes que el ancla, ajustado al último día
 *     (decisión 4 de bpre-design). Los días de la semana NO aplican: la UI los
 *     oculta y `toBatchFields` no los manda, pero `value.daysOfWeek` se
 *     conserva para que volver a Semanal no pierda la selección.
 *   • Estado de cada fecha: el `status` del batch (libre/sobreturno/duplicado)
 *     + los flags `outOfHours`/`blocked` (B3.1: un bloqueo ya sube el status a
 *     sobreturno; fuera de horario es solo aviso, decisión 2). Para la UI se
 *     reduce a UN estado principal con precedencia duplicado > bloqueado >
 *     fuera de horario > sobreturno > libre (la misma de `classifyInstant`),
 *     así un bloqueo no se cuenta dos veces (como bloqueada y como
 *     sobreturno). `describeSessionDate` sirve igual para un ítem de
 *     `previewRecurrence` y para un `BatchDateOutcome` del dryRun del batch.
 */
import { dowOfDayKey } from "@/lib/availability/day";
import {
  expandDates,
  frequencyLabel,
  summarizeRange,
} from "@/lib/availability/recurrence";
import type { DayKey, Frequency } from "@/lib/availability/types";
import type {
  RecurrencePreviewItem,
  RecurrencePreviewQueryInput,
} from "@/lib/availability-actions-types";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import { unitShortfall, type BookingUnit } from "@/lib/copy/booking-unit";

/** Tope de la UI (el server acepta hasta 60). */
export const SESSIONS_UI_MAX_COUNT = 20;
export const SESSIONS_UI_MIN_COUNT = 1;
/** Debounce del preview: tipear "12" no dispara dos consultas. */
export const SESSIONS_PREVIEW_DEBOUNCE_MS = 350;

/** Lo que el modo emite (contrato B5 con `index.tsx`). `daysOfWeek` 0=Lun…6=Dom;
 *  vacío = el día de la semana del ancla. */
export type SessionsValue = {
  count: number;
  daysOfWeek: number[];
  frequency: Frequency;
};

export const DEFAULT_SESSIONS_VALUE: SessionsValue = {
  count: 2,
  daysOfWeek: [],
  frequency: "weekly",
};

/** Opciones del selector, en el orden en que se muestran. */
export const SESSIONS_FREQUENCY_OPTIONS: ReadonlyArray<{
  value: Frequency;
  label: string;
}> = (["weekly", "biweekly", "monthly"] as const).map((value) => ({
  value,
  label: frequencyLabel(value),
}));

// ─── value ──────────────────────────────────────────────────────────────

/** Cantidad acotada a 1..20; basura (NaN, "", negativos) → 1. */
export function clampSessionsCount(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < SESSIONS_UI_MIN_COUNT)
    return SESSIONS_UI_MIN_COUNT;
  return Math.min(v, SESSIONS_UI_MAX_COUNT);
}

/** ¿Se muestran los días de la semana? En mensual no: manda el día del mes. */
export function showsDaysOfWeek(frequency: Frequency): boolean {
  return frequency !== "monthly";
}

/** Días 0..6 únicos y ordenados (descarta lo que no sea un entero 0..6). */
export function normalizeDays(days: ReadonlyArray<number>): number[] {
  return [
    ...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
  ].sort((a, b) => a - b);
}

/** Value saneado (cantidad acotada, días normalizados, frecuencia válida). */
export function normalizeSessionsValue(
  v: Partial<SessionsValue> | null | undefined,
): SessionsValue {
  const frequency: Frequency =
    v?.frequency === "biweekly" || v?.frequency === "monthly"
      ? v.frequency
      : "weekly";
  return {
    count: clampSessionsCount(v?.count ?? DEFAULT_SESSIONS_VALUE.count),
    daysOfWeek: normalizeDays(v?.daysOfWeek ?? []),
    frequency,
  };
}

export function withCount(v: SessionsValue, n: unknown): SessionsValue {
  return { ...v, count: clampSessionsCount(n) };
}

/** Cambia la frecuencia conservando los días (ver cabecera). */
export function withFrequency(
  v: SessionsValue,
  frequency: Frequency,
): SessionsValue {
  return { ...v, frequency };
}

export function withDays(
  v: SessionsValue,
  days: ReadonlyArray<number>,
): SessionsValue {
  return { ...v, daysOfWeek: normalizeDays(days) };
}

/**
 * Campos que `index.tsx` suma al payload de `createBookingsBatch` (dryRun y
 * real). Mensual no manda días; sin días tampoco (el server toma el del
 * ancla). `frequency` siempre explícita.
 */
export function toBatchFields(v: SessionsValue): {
  count: number;
  frequency: Frequency;
  daysOfWeek: number[] | undefined;
} {
  const days = normalizeDays(v.daysOfWeek);
  return {
    count: clampSessionsCount(v.count),
    frequency: v.frequency,
    daysOfWeek:
      showsDaysOfWeek(v.frequency) && days.length > 0 ? days : undefined,
  };
}

// ─── preview ────────────────────────────────────────────────────────────

/**
 * Query de `previewRecurrence`, o null si falta algo para preguntar (sin
 * profesional, servicio o fecha válida no hay preview: el modo muestra solo
 * el resumen local).
 */
export function buildPreviewQuery(p: {
  anchorIso: string;
  practitionerId: string | null | undefined;
  serviceId: string | null | undefined;
  patientId: string | null | undefined;
  value: SessionsValue;
  durationMin?: number | null;
  locationId?: string | null;
}): RecurrencePreviewQueryInput | null {
  if (!p.practitionerId || !p.serviceId || !isValidAnchor(p.anchorIso))
    return null;
  const f = toBatchFields(p.value);
  return {
    anchor: p.anchorIso,
    count: f.count,
    frequency: f.frequency,
    daysOfWeek: f.daysOfWeek,
    practitionerId: p.practitionerId,
    serviceId: p.serviceId,
    patientId: p.patientId || null,
    durationMin: p.durationMin && p.durationMin > 0 ? p.durationMin : undefined,
    locationId: p.locationId || null,
  };
}

/** Clave estable de una query (para no repetir la misma consulta). */
export function previewQueryKey(q: RecurrencePreviewQueryInput | null): string {
  return q ? JSON.stringify(q) : "";
}

function isValidAnchor(iso: string | null | undefined): iso is string {
  return !!iso && !Number.isNaN(new Date(iso).getTime());
}

/**
 * Resumen calculado en el cliente con la MISMA regla que el server
 * (`expandDates` + `summarizeRange`): se muestra al instante, antes (o sin)
 * respuesta del preview. "" si no hay ancla válida. `unit` (VX3-f): la misma
 * que usa el server para el consultorio (`bookingUnitOf`).
 */
export function localSummary(
  anchorIso: string | null | undefined,
  v: SessionsValue,
  unit: BookingUnit,
): string {
  if (!isValidAnchor(anchorIso)) return "";
  const f = toBatchFields(v);
  const dates = expandDates({
    anchor: new Date(anchorIso),
    count: f.count,
    daysOfWeek: f.daysOfWeek,
    frequency: f.frequency,
  });
  return summarizeRange(dates, f.frequency, unit);
}

// ─── estado por fecha ─────────────────────────────────────────────────────

export type SessionDateState =
  "libre" | "sobreturno" | "duplicado" | "fuera-de-horario" | "bloqueado";

/** Lo mínimo que comparten un ítem de `previewRecurrence` y un
 *  `BatchDateOutcome` del dryRun. */
export type SessionDateLike = {
  status: BatchSlotStatus;
  outOfHours: boolean;
  blocked: boolean;
  blockReasons?: ReadonlyArray<string>;
};

export const SESSION_STATE_LABEL: Record<SessionDateState, string> = {
  libre: "Libre",
  sobreturno: "Sobreturno",
  duplicado: "Duplicado",
  "fuera-de-horario": "Fuera de horario",
  bloqueado: "Bloqueado",
};

/** Tono de la píldora: ok = se crea limpio; warn = se crea con aviso
 *  (sobreturno / fuera de horario); danger = bloqueado (sobreturno forzado) o
 *  duplicado (no se crea). El color lo resuelve el componente. */
export type SessionStateTone = "ok" | "warn" | "danger";
export const SESSION_STATE_TONE: Record<SessionDateState, SessionStateTone> = {
  libre: "ok",
  sobreturno: "warn",
  duplicado: "danger",
  "fuera-de-horario": "warn",
  bloqueado: "danger",
};

/** Estado principal (precedencia de la cabecera). */
export function sessionDateState(d: SessionDateLike): SessionDateState {
  if (d.status === "duplicado") return "duplicado";
  if (d.blocked) return "bloqueado";
  if (d.outOfHours) return "fuera-de-horario";
  if (d.status === "sobreturno") return "sobreturno";
  return "libre";
}

/**
 * Estado + texto para la fila: "Bloqueado: Feriado", "Duplicado: el paciente
 * ya tiene un turno a esa hora". `extra` = aviso secundario cuando hay dos
 * cosas (p. ej. bloqueado Y fuera de horario).
 */
export function describeSessionDate(d: SessionDateLike): {
  state: SessionDateState;
  label: string;
  detail: string | null;
  extra: string | null;
} {
  const state = sessionDateState(d);
  const reasons = (d.blockReasons ?? []).map((r) => r.trim()).filter(Boolean);
  let label = SESSION_STATE_LABEL[state];
  let detail: string | null = null;
  switch (state) {
    case "duplicado":
      detail = "El paciente ya tiene un turno a esa hora: no se va a crear";
      break;
    case "bloqueado":
      if (reasons.length > 0) label = `Bloqueado: ${reasons.join(", ")}`;
      detail = "Se carga como sobreturno si confirmás";
      break;
    case "fuera-de-horario":
      detail = "Fuera del horario del profesional";
      break;
    case "sobreturno":
      detail = "El cupo de ese horario está completo";
      break;
    default:
      break;
  }
  const extra =
    state === "bloqueado" && d.outOfHours ? "También fuera de horario" : null;
  return { state, label, detail, extra };
}

export type SessionStateCounts = Record<SessionDateState, number>;

/** Conteo por estado PRINCIPAL (un bloqueo cuenta una sola vez). */
export function countSessionStates(
  items: ReadonlyArray<SessionDateLike>,
): SessionStateCounts {
  const c: SessionStateCounts = {
    libre: 0,
    sobreturno: 0,
    duplicado: 0,
    "fuera-de-horario": 0,
    bloqueado: 0,
  };
  for (const it of items) c[sessionDateState(it)]++;
  return c;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Línea de conteos de arriba de la lista: "2 fuera de horario · 1 bloqueada".
 * Solo los estados con problema; "" si todas están libres.
 */
export function countsLine(c: SessionStateCounts): string {
  const parts: string[] = [];
  if (c["fuera-de-horario"] > 0)
    parts.push(`${c["fuera-de-horario"]} fuera de horario`);
  if (c.bloqueado > 0)
    parts.push(plural(c.bloqueado, "bloqueada", "bloqueadas"));
  if (c.sobreturno > 0)
    parts.push(plural(c.sobreturno, "sobreturno", "sobreturnos"));
  if (c.duplicado > 0)
    parts.push(plural(c.duplicado, "duplicada", "duplicadas"));
  return parts.join(" · ");
}

/** Aviso cuando el server generó menos fechas que las pedidas. */
export function shortfallNote(
  requested: number,
  generated: number,
  unit: BookingUnit,
): string | null {
  if (generated >= requested) return null;
  return unitShortfall(unit, generated, requested);
}

const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** "lun 28/09 · 10:00" (día AR del `dayKey`, hora de pared ya calculada). */
export function formatSessionDate(dayKey: DayKey, time: string): string {
  const [, m, d] = dayKey.split("-");
  return `${DOW_SHORT[dowOfDayKey(dayKey)]} ${d}/${m} · ${time}`;
}

/** Ítem listo para pintar. */
export function sessionRow(item: RecurrencePreviewItem) {
  return {
    key: item.iso,
    when: formatSessionDate(item.dayKey, item.time),
    ...describeSessionDate(item),
  };
}
