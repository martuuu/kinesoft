/**
 * Validación y resumen de franjas horarias (B2.4a CFG-api-1, B-pre).
 *
 * Puro: sin DB, sin reloj, sin `server-only`. Lo usan `lib/practitioner-schedule.ts`
 * (antes de escribir) y la UI de Configuración (para marcar la fila mala sin
 * esperar al server). La barrera real es la action: valida otra vez acá Y
 * contra la base (sede activa del tenant).
 *
 * Convenciones (las de `lib/availability/types.ts`):
 *   • minutos de pared AR desde 00:00, rangos SEMIABIERTOS [startMin, endMin):
 *     8-13 y 13-17 se tocan en el borde y NO se solapan;
 *   • `dow` 0=Dom … 6=Sáb (`toARDow`), lo que guarda `PractitionerSchedule.dow`.
 *
 * Reglas (las mismas que el CHECK de la base, más las que la base no expresa):
 *   1. `0 <= startMin < endMin <= 1440` (CHECK `PractitionerSchedule_range_check`).
 *   2. Múltiplos de 5: la grilla del motor arranca en el inicio de cada franja
 *      (`buildSlots`); una franja 8:07 generaría turnos 8:07, 8:52… que nadie
 *      pidió. La UI ofrece pasos de 5.
 *   3. Sin solapes en el mismo día, AUNQUE sean sedes distintas: un profesional
 *      no puede estar en dos sedes a la vez, y el motor (`workingRanges`) suma
 *      franjas sin deduplicar → un solape duplicaría slots.
 *   4. `locationId` presente (y, si se pasa el set, entre las sedes activas).
 *   5. (SR1c) Vigencia por franja (`validFrom`/`validUntil`, DayKeys inclusive,
 *      null = abierta): fin >= inicio, y el solape de la regla 3 solo cuenta si
 *      las vigencias se cruzan en una fecha de ese día de la semana. Así se
 *      carga "los lunes en el Consultorio 2 hasta el 31/3 y desde el 1/4 en el
 *      Gimnasio" como dos franjas del mismo horario sin que choquen.
 *   La sala NO se valida acá: el choque entre profesionales vive en
 *   `lib/room-schedule-validate.ts` (necesita las franjas de los demás).
 */
import type { DayKey, Dow, ScheduleRange } from "@/lib/availability/types";
import { formatClock, windowsMeetOnDow } from "@/lib/room-schedule-validate";
import { isDayKey } from "@/lib/availability/day";

export const SCHEDULE_STEP_MIN = 5;
export const MAX_RANGES_PER_WEEK = 70; // 10 por día alcanza y sobra
export const MAX_RANGES_PER_DAY = 10;

/**
 * Franja de la semana como la manda la UI. `roomId` y la vigencia son
 * opcionales (SR1c): omitidos = sin sala y siempre (lo que escribían el editor
 * y el onboarding antes de SR).
 */
export type WeekRangeInput = ScheduleRange & {
  dow: number;
  validFrom?: DayKey | null;
  validUntil?: DayKey | null;
};

export const VALIDITY_ORDER_ERROR = "La fecha de fin tiene que ser igual o posterior a la de inicio.";

/** Error de una fila: `index` = posición en el array que mandó la UI. */
export type RangeRowError = { index: number; message: string };

export type RangesValidation = { ok: true } | { ok: false; errors: RangeRowError[] };

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
/** Orden de la semana para mostrar: lunes primero, domingo al final. */
const WEEK_ORDER: ReadonlyArray<Dow> = [1, 2, 3, 4, 5, 6, 0];

/** "8", "8:30", "24" (fin de día). Para resúmenes y mensajes. */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, "0")}`;
}

/** "08:00" (para inputs `type=time` y mensajes precisos). */
export function formatHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function dowLabel(dow: number): string {
  return DOW_LABELS[dow] ?? "?";
}

function checkOne(r: { startMin: number; endMin: number; locationId: string }): string | null {
  if (!Number.isInteger(r.startMin) || !Number.isInteger(r.endMin)) {
    return "Los horarios tienen que ser minutos enteros.";
  }
  if (r.startMin < 0 || r.endMin > 1440) return "El horario tiene que estar entre 00:00 y 24:00.";
  if (r.startMin >= r.endMin) return "La hora de fin tiene que ser posterior a la de inicio.";
  if (r.startMin % SCHEDULE_STEP_MIN !== 0 || r.endMin % SCHEDULE_STEP_MIN !== 0) {
    return `Los horarios van de a ${SCHEDULE_STEP_MIN} minutos.`;
  }
  if (!r.locationId) return "Elegí la sede.";
  return null;
}

/** Vigencia (SR1c): DayKeys válidas y fin >= inicio (mismo CHECK que la base). */
function checkValidity(r: { validFrom?: DayKey | null; validUntil?: DayKey | null }): string | null {
  if ((r.validFrom && !isDayKey(r.validFrom)) || (r.validUntil && !isDayKey(r.validUntil))) {
    return "Fecha inválida (AAAA-MM-DD).";
  }
  if (r.validFrom && r.validUntil && r.validUntil < r.validFrom) return VALIDITY_ORDER_ERROR;
  return null;
}

/**
 * Solapes dentro de un grupo (un día). Marca AMBAS filas: la UI resalta las dos.
 * Semiabierto: `a.end <= b.start` no es solape.
 */
function overlapErrors(
  dow: number,
  rows: ReadonlyArray<{
    index: number;
    startMin: number;
    endMin: number;
    locationId: string;
    validFrom?: DayKey | null;
    validUntil?: DayKey | null;
  }>,
  out: Map<number, string>
): void {
  const sorted = [...rows].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.startMin >= a.endMin) break; // ordenadas por inicio: ninguna siguiente solapa con a
      // SR1c: con vigencias que no comparten ninguna fecha de este dow, no rigen juntas.
      if (
        !windowsMeetOnDow(dow, [
          { from: a.validFrom, until: a.validUntil },
          { from: b.validFrom, until: b.validUntil },
        ])
      ) {
        continue;
      }
      const span = `${formatClock(Math.max(a.startMin, b.startMin))}-${formatClock(Math.min(a.endMin, b.endMin))}`;
      const msg =
        a.locationId !== b.locationId
          ? `Se superpone (${span}) con una franja en otra sede: no se puede atender en dos sedes a la vez.`
          : `Se superpone con otra franja en las mismas fechas (${span}).`;
      if (!out.has(a.index)) out.set(a.index, msg);
      if (!out.has(b.index)) out.set(b.index, msg);
    }
  }
}

function finish(errs: Map<number, string>): RangesValidation {
  if (errs.size === 0) return { ok: true };
  return {
    ok: false,
    errors: [...errs.entries()].sort((a, b) => a[0] - b[0]).map(([index, message]) => ({ index, message })),
  };
}

/**
 * Valida la semana completa de un profesional (reemplazo atómico: lo que no
 * viene, se borra). `activeLocationIds` opcional: si se pasa, toda franja
 * tiene que caer en una de esas sedes.
 */
export function validateWeekRanges(
  ranges: ReadonlyArray<WeekRangeInput>,
  opts: { activeLocationIds?: ReadonlySet<string> } = {}
): RangesValidation {
  const errs = new Map<number, string>();
  const byDow = new Map<number, Array<WeekRangeInput & { index: number }>>();
  ranges.forEach((r, index) => {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) {
      errs.set(index, "Día de la semana inválido.");
      return;
    }
    const e = checkOne(r) ?? checkValidity(r);
    if (e) {
      errs.set(index, e);
      return;
    }
    if (opts.activeLocationIds && !opts.activeLocationIds.has(r.locationId)) {
      errs.set(index, "La sede no existe o está archivada.");
      return;
    }
    const list = byDow.get(r.dow) ?? [];
    list.push({ ...r, index });
    byDow.set(r.dow, list);
  });
  for (const [dow, rows] of byDow) overlapErrors(dow, rows, errs);
  return finish(errs);
}

/**
 * Valida las franjas de UN día (excepción CUSTOM_HOURS): mismas reglas sin
 * `dow`. Vacío no es válido acá: un día sin franjas es `CLOSED`.
 */
export function validateDayRanges(
  ranges: ReadonlyArray<ScheduleRange>,
  opts: { activeLocationIds?: ReadonlySet<string> } = {}
): RangesValidation {
  return validateWeekRanges(
    ranges.map((r) => ({ ...r, dow: 0 })),
    opts
  );
}

/** `{ "ranges.3": ["…"] }` — la forma de `ActionResult.fieldErrors`. */
export function rangeErrorsToFieldErrors(errors: ReadonlyArray<RangeRowError>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors) (out[`ranges.${e.index}`] ??= []).push(e.message);
  return out;
}

/**
 * Resumen legible de una semana: "Lun-Vie 8-13, 15-19 · Sáb 9-12". Agrupa
 * días CONSECUTIVOS (lunes primero) con exactamente las mismas franjas. La
 * sede no entra en el texto (la UI la muestra aparte cuando hay varias).
 * Semana vacía → "".
 */
export function summarizeWeek(
  ranges: ReadonlyArray<{ dow: number; startMin: number; endMin: number }>
): string {
  const sig = new Map<number, string>();
  for (const dow of WEEK_ORDER) {
    const day = ranges
      .filter((r) => r.dow === dow)
      .sort((a, b) => a.startMin - b.startMin)
      .map((r) => `${formatMinutes(r.startMin)}-${formatMinutes(r.endMin)}`);
    sig.set(dow, day.join(", "));
  }
  const parts: string[] = [];
  let i = 0;
  while (i < WEEK_ORDER.length) {
    const s = sig.get(WEEK_ORDER[i])!;
    if (!s) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < WEEK_ORDER.length && sig.get(WEEK_ORDER[j + 1]) === s) j++;
    const label =
      i === j
        ? dowLabel(WEEK_ORDER[i])
        : j === i + 1
          ? `${dowLabel(WEEK_ORDER[i])}, ${dowLabel(WEEK_ORDER[j])}`
          : `${dowLabel(WEEK_ORDER[i])}-${dowLabel(WEEK_ORDER[j])}`;
    parts.push(`${label} ${s}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// DayKey ↔ `@db.Date`
// ─────────────────────────────────────────────────────────────────────────────
// `ScheduleException.date` es `@db.Date`: Postgres guarda solo la fecha y
// Prisma la ida/vuelta como `Date` a MEDIANOCHE UTC. Por eso, y solo para
// columnas `@db.Date`, la conversión correcta es por UTC (`T00:00:00Z` y
// `toISOString().slice(0,10)`): no es un instante AR, es una etiqueta de día.
// Usar `toARDateKey` acá corre el día (00:00Z = 21:00 AR del día anterior).
// Para instantes reales (turnos, bloqueos) se usa `lib/datetime-ar.ts`.
//
// Implementación ÚNICA en `lib/availability/day.ts` (integrador B2: antes
// había dos copias, B2.4a acá y B2.1a allá). Se re-exporta con los nombres
// que ya consumen `practitioner-schedule`, `locations` y la UI. Diferencia con
// la copia vieja: `dayKeyToDbDate` ahora TIRA RangeError ante una clave
// inválida en vez de devolver un Date inválido; todos los callers validan
// antes con zod (`isValidDayKey`) o pasan `toARDateKey(...)`.
export {
  isDayKey as isValidDayKey,
  dayKeyToDbDate,
  dbDateToDayKey,
  dayKeyDiff,
} from "@/lib/availability/day";
