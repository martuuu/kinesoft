/**
 * Modo "Bloquear horario" del modal de turno (B5.4 MOD-block, B-pre) — la
 * lógica pura del formulario: estado inicial desde el `startIso` del modal,
 * validación, armado del payload de `createTimeBlock` y el texto del resultado.
 *
 * Separado de `components/agenda/booking-modal/block-mode.tsx` para testearlo
 * en TZ=UTC y TZ=AR sin DOM (AGENTS §3: la lógica pura fuera del componente).
 *
 * Fechas: el formulario habla "día AR" (`YYYY-MM-DD`) + minutos desde las
 * 00:00 AR. Los instantes se arman con `arDayStart` (= `D T00:00-03:00`, AR
 * sin horario de verano) + minutos: nada de `setHours`/`getDate` del host,
 * que en Vercel es UTC y corría el bloqueo 3 h (el bug clásico de la agenda).
 *
 * Alcance (decisión 8): "Este profesional" = `practitionerId`; "Todo el
 * equipo" = `practitionerId: null` (UNA fila, alcanza también a profesionales
 * futuros). El servidor vuelve a chequear la capability (`canManageBlocksFor`);
 * `canBlockAll` acá solo esconde la opción y frena el submit.
 */
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import {
  TIME_BLOCK_MAX_DAYS,
  arDayStart,
  type CreateTimeBlockResult,
  type TimeBlockCreateInput,
} from "@/lib/time-blocks-schemas";

/** Paso de la franja: el mismo de `DateTime24Picker` (05'). */
export const BLOCK_STEP_MIN = 5;
/** Duración por defecto de la franja prefijada desde el slot clickeado. */
export const BLOCK_DEFAULT_SPAN_MIN = 60;
/** Fin de día como "hasta": 24:00 = 00:00 AR del día siguiente. */
export const DAY_END_MIN = 24 * 60;
/** Tope del motivo (igual que `TimeBlockCreate.reason`). */
export const BLOCK_REASON_MAX = 200;
/** Decisión 10: no hay feriados automáticos en B-pre; solo se sugiere el motivo. */
export const BLOCK_REASON_SUGGESTIONS = [
  "Feriado",
  "Congreso",
  "Vacaciones",
  "Capacitación",
  "Trámite",
] as const;

const DAY_MS = 24 * 60 * 60_000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type BlockScope = "practitioner" | "all";
export type BlockKind = "range" | "allDay";

export type BlockFormState = {
  scope: BlockScope;
  kind: BlockKind;
  /** Día AR del bloqueo (con `allDay`: el primer día). */
  dayKey: string;
  /** Solo `allDay`: último día AR inclusivo (Vacaciones, Congreso de 3 días). */
  endDayKey: string;
  /** Solo franja: minutos desde las 00:00 AR, múltiplos de `BLOCK_STEP_MIN`. */
  fromMin: number;
  /** Solo franja: 5..1440 (1440 = hasta el fin del día). */
  toMin: number;
  reason: string;
};

export type BlockFormField = "scope" | "dayKey" | "endDayKey" | "fromMin" | "toMin" | "reason";
export type BlockFormErrors = Partial<Record<BlockFormField, string>>;

/**
 * Estado inicial desde el slot del modal: el día AR de `startIso`, la franja
 * desde esa hora (redondeada hacia abajo a 5') por una hora, sin pasar de las
 * 24:00. Con un `startIso` inválido cae al día AR de `now`, 09:00.
 */
export function initialBlockForm(startIso: string, now: Date = new Date()): BlockFormState {
  const d = new Date(startIso);
  const valid = !Number.isNaN(d.getTime());
  const dayKey = toARDateKey(valid ? d : now);
  const rawMin = valid ? toARMinutes(d) : 9 * 60;
  const fromMin = Math.min(
    Math.floor(rawMin / BLOCK_STEP_MIN) * BLOCK_STEP_MIN,
    DAY_END_MIN - BLOCK_STEP_MIN
  );
  return {
    scope: "practitioner",
    kind: "range",
    dayKey,
    endDayKey: dayKey,
    fromMin,
    toMin: Math.min(fromMin + BLOCK_DEFAULT_SPAN_MIN, DAY_END_MIN),
    reason: "",
  };
}

/** Dirty-guard: compara contra el estado inicial (motivo sin espacios de borde). */
export function isBlockFormDirty(initial: BlockFormState, current: BlockFormState): boolean {
  return (
    initial.scope !== current.scope ||
    initial.kind !== current.kind ||
    initial.dayKey !== current.dayKey ||
    (current.kind === "allDay" && initial.endDayKey !== current.endDayKey) ||
    (current.kind === "range" &&
      (initial.fromMin !== current.fromMin || initial.toMin !== current.toMin)) ||
    initial.reason.trim() !== current.reason.trim()
  );
}

/** "HH:mm" de minutos desde las 00:00 (1440 → "24:00"). */
export function minutesToHHmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Día AR real (descarta "2026-02-30", que `Date` corre al 2 de marzo). */
export function isValidDayKey(dayKey: string): boolean {
  if (!DAY_KEY_RE.test(dayKey)) return false;
  const t = arDayStart(dayKey).getTime();
  return !Number.isNaN(t) && toARDateKey(new Date(t)) === dayKey;
}

/** Instante = 00:00 AR del día + minutos (1440 = 00:00 del día siguiente). */
export function arInstant(dayKey: string, minutes: number): Date {
  return new Date(arDayStart(dayKey).getTime() + minutes * 60_000);
}

export type BlockPayloadResult =
  | { ok: true; payload: TimeBlockCreateInput }
  | { ok: false; errors: BlockFormErrors };

/**
 * Valida y arma el payload de `createTimeBlock`.
 *   - franja: `[día + desde, día + hasta)`, `allDay: false`;
 *   - día completo: `[00:00 AR del primer día, 00:00 AR del día siguiente al
 *     último)`, `allDay: true` — el mismo intervalo que guarda
 *     `normalizeBlockWindow`, así lo que se ve acá es lo que queda.
 * Los instantes van en ISO UTC ("…Z"): offset explícito, como pide el zod.
 */
export function buildBlockPayload(
  state: BlockFormState,
  opts: { practitionerId: string; canBlockAll: boolean }
): BlockPayloadResult {
  const errors: BlockFormErrors = {};

  if (state.scope === "all" && !opts.canBlockAll) {
    errors.scope = "No tenés permiso para bloquear la agenda de todo el equipo.";
  }
  if (state.scope === "practitioner" && !opts.practitionerId) {
    errors.scope = "Elegí un profesional.";
  }
  if (!isValidDayKey(state.dayKey)) {
    errors.dayKey = "Elegí una fecha válida.";
  }

  if (state.kind === "range") {
    const onGrid = (m: number) => Number.isInteger(m) && m % BLOCK_STEP_MIN === 0;
    if (!onGrid(state.fromMin) || state.fromMin < 0 || state.fromMin >= DAY_END_MIN) {
      errors.fromMin = "Hora de inicio inválida.";
    }
    if (!onGrid(state.toMin) || state.toMin <= 0 || state.toMin > DAY_END_MIN) {
      errors.toMin = "Hora de fin inválida.";
    } else if (!errors.fromMin && state.toMin <= state.fromMin) {
      errors.toMin = "El fin tiene que ser posterior al inicio.";
    }
  } else if (!errors.dayKey) {
    if (!isValidDayKey(state.endDayKey)) {
      errors.endDayKey = "Elegí una fecha válida.";
    } else if (state.endDayKey < state.dayKey) {
      errors.endDayKey = "El último día no puede ser anterior al primero.";
    } else {
      const days =
        (arDayStart(state.endDayKey).getTime() - arDayStart(state.dayKey).getTime()) / DAY_MS + 1;
      if (days > TIME_BLOCK_MAX_DAYS) {
        errors.endDayKey = `Un bloqueo puede durar como máximo ${TIME_BLOCK_MAX_DAYS} días.`;
      }
    }
  }

  const reason = state.reason.trim();
  if (reason.length > BLOCK_REASON_MAX) {
    errors.reason = `Máximo ${BLOCK_REASON_MAX} caracteres.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const range =
    state.kind === "range"
      ? { startsAt: arInstant(state.dayKey, state.fromMin), endsAt: arInstant(state.dayKey, state.toMin) }
      : { startsAt: arInstant(state.dayKey, 0), endsAt: arInstant(state.endDayKey, DAY_END_MIN) };

  return {
    ok: true,
    payload: {
      practitionerId: state.scope === "all" ? null : opts.practitionerId,
      startsAt: range.startsAt.toISOString(),
      endsAt: range.endsAt.toISOString(),
      allDay: state.kind === "allDay",
      reason: reason || null,
    },
  };
}

/**
 * `fieldErrors` del servidor (claves de `TimeBlockCreate`) → campos del form.
 * Lo que no tiene campo propio queda en el error general.
 */
export function mapServerFieldErrors(fieldErrors: Record<string, string[]> | undefined): BlockFormErrors {
  const out: BlockFormErrors = {};
  if (!fieldErrors) return out;
  const first = (k: string) => fieldErrors[k]?.[0];
  if (first("practitionerId") ?? first("practitionerIds")) {
    out.scope = first("practitionerId") ?? first("practitionerIds");
  }
  if (first("startsAt")) out.dayKey = first("startsAt");
  if (first("endsAt")) out.toMin = first("endsAt");
  if (first("reason")) out.reason = first("reason");
  return out;
}

/** En un form de día completo el error de `endsAt` va al "hasta" de días. */
export function routeEndsAtError(errors: BlockFormErrors, kind: BlockKind): BlockFormErrors {
  if (kind !== "allDay" || !errors.toMin) return errors;
  const { toMin, ...rest } = errors;
  return { ...rest, endDayKey: toMin };
}

/**
 * Mensaje de una action que TIRÓ (authz: `ForbiddenError`). En prod Next
 * reemplaza el mensaje de un throw en una server action por uno genérico en
 * inglés ("An error occurred in the Server Components render…"), así que solo
 * se muestra el mensaje real si viene en castellano; si no, un copy propio.
 */
export function blockThrownMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  if (msg && !/server components|an error occurred|digest/i.test(msg)) return msg;
  return "No pudimos crear el bloqueo. Revisá que tengas permiso para bloquear esa agenda.";
}

/** "Bloqueado. Hay N turnos en ese horario." (singular/plural/ninguno). */
export function affectedHeadline(count: number): string {
  if (count === 0) return "Bloqueado. No hay turnos en ese horario.";
  if (count === 1) return "Bloqueado. Hay 1 turno en ese horario.";
  return `Bloqueado. Hay ${count} turnos en ese horario.`;
}

// Día armado a mano y no con `Intl` "es-AR": el separador de `day/month`
// cambia según la versión de ICU (Node 20 da "07-10", Chrome "07/10").
const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
function arDayLabel(d: Date): string {
  const [, mm, dd] = toARDateKey(d).split("-");
  return `${DOW_SHORT[toARDow(d)]} ${dd}/${mm}`;
}

export type AffectedLine = { id: string; when: string; patient: string };

/**
 * Filas de la lista de afectados: hora AR (y el día, si el bloqueo cubre más
 * de un día AR) + paciente. Orden cronológico.
 */
export function affectedLines(result: CreateTimeBlockResult): AffectedLine[] {
  const multiDay =
    toARDateKey(result.startsAt) !== toARDateKey(new Date(new Date(result.endsAt).getTime() - 1));
  return [...result.affected.bookings]
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
    .map((b) => {
      const d = new Date(b.scheduledFor);
      // `hour12:false` puede formatear la medianoche como "24:00" (ver
      // `arHour` en lib/datetime-ar.ts): se arma desde los minutos AR.
      const time = minutesToHHmm(toARMinutes(d));
      return {
        id: b.id,
        when: multiDay ? `${arDayLabel(d)} · ${time}` : time,
        patient: b.patientName?.trim() || "Paciente sin nombre",
      };
    });
}

/** Cuántos afectados quedaron fuera del detalle (`AFFECTED_LIST_LIMIT`). */
export function affectedOverflow(result: CreateTimeBlockResult): number {
  return Math.max(0, result.affected.count - result.affected.bookings.length);
}
