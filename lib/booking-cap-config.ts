/**
 * Configuración del tope de turnos por intervalo (T3, decisión 6 del 19-oct; C-AS3; sesión T3e-2c). Puro y
 * client-safe: lo usan los setters (`lib/tenant-settings.ts#setTenantBookingCap`,
 * `lib/practitioner-schedule.ts#setPractitionerBookingCap`), el loader de Configuración y las tarjetas de UI.
 *
 * La regla de la base (M12, CHECK `Tenant_bookingCap_check` / `Practitioner_bookingCap_check`): los dos campos o
 * ninguno; 1..60 turnos; intervalo 15/30/60. Se valida ACÁ antes de escribir para devolver un copy claro: un CHECK
 * que rebota en la base sale como 500 («No pudimos guardar») y no le dice a nadie qué corregir.
 *
 * Qué significa cada cosa la decide `lib/availability/interval-cap.ts` (`effectiveIntervalCap`): esto solo valida y
 * rotula lo que se guarda.
 */
import {
  INTERVAL_CAP_COUNT_MAX,
  INTERVAL_CAP_COUNT_MIN,
  INTERVAL_CAP_MINUTES,
  isIntervalCapMinutes,
  type BookingCapMode,
  type IntervalCap,
} from "@/lib/availability/interval-cap";

export { INTERVAL_CAP_COUNT_MAX, INTERVAL_CAP_COUNT_MIN, INTERVAL_CAP_MINUTES, type BookingCapMode, type IntervalCap };

export const BOOKING_CAP_MODES: readonly BookingCapMode[] = ["INHERIT", "NONE", "CUSTOM"];

export const BOOKING_CAP_COPY = {
  pair: "Completá cuántos turnos y cada cuántos minutos, o dejá los dos vacíos para no poner tope.",
  count: `El máximo va de ${INTERVAL_CAP_COUNT_MIN} a ${INTERVAL_CAP_COUNT_MAX} turnos.`,
  interval: "El intervalo puede ser de 15, 30 o 60 minutos.",
  mode: "Elegí si usa el tope del consultorio, si no tiene tope o si tiene uno propio.",
  customPair: "Para un tope propio, completá cuántos turnos y cada cuántos minutos.",
} as const;

/**
 * Par (count, intervalMin) que llega de la UI o de un caller cualquiera → el par a guardar.
 * `null`/`undefined`/"" en los dos = sin tope (`cap: null`); uno solo = error (no se adivina el otro).
 */
export function parseBookingCapPair(
  count: unknown,
  intervalMin: unknown
): { ok: true; cap: IntervalCap | null } | { ok: false; error: string } {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(count) && empty(intervalMin)) return { ok: true, cap: null };
  if (empty(count) || empty(intervalMin)) return { ok: false, error: BOOKING_CAP_COPY.pair };
  const n = typeof count === "string" ? Number(count) : count;
  const m = typeof intervalMin === "string" ? Number(intervalMin) : intervalMin;
  if (typeof n !== "number" || !Number.isInteger(n) || n < INTERVAL_CAP_COUNT_MIN || n > INTERVAL_CAP_COUNT_MAX) {
    return { ok: false, error: BOOKING_CAP_COPY.count };
  }
  if (!isIntervalCapMinutes(m)) return { ok: false, error: BOOKING_CAP_COPY.interval };
  return { ok: true, cap: { count: n, intervalMin: m } };
}

/** Lo que se guarda en `Practitioner`: CUSTOM ⇔ par presente (CHECK de M12). INHERIT/NONE limpian el par. */
export type PractitionerBookingCapWrite = {
  bookingCapMode: BookingCapMode;
  bookingCapCount: number | null;
  bookingCapIntervalMin: number | null;
};

export function parsePractitionerBookingCap(input: {
  mode: unknown;
  count?: unknown;
  intervalMin?: unknown;
}): { ok: true; data: PractitionerBookingCapWrite } | { ok: false; error: string } {
  if (!(BOOKING_CAP_MODES as readonly unknown[]).includes(input.mode)) return { ok: false, error: BOOKING_CAP_COPY.mode };
  const mode = input.mode as BookingCapMode;
  if (mode !== "CUSTOM") {
    // Los números que quedaron tipeados en el form al cambiar a «Usar el del consultorio» / «Sin tope» no se
    // rechazan: se descartan (la base exige NULL fuera de CUSTOM y un error ahí sería por algo que no se ve).
    return { ok: true, data: { bookingCapMode: mode, bookingCapCount: null, bookingCapIntervalMin: null } };
  }
  const pair = parseBookingCapPair(input.count, input.intervalMin);
  if (!pair.ok) return pair;
  if (!pair.cap) return { ok: false, error: BOOKING_CAP_COPY.customPair };
  return {
    ok: true,
    data: { bookingCapMode: "CUSTOM", bookingCapCount: pair.cap.count, bookingCapIntervalMin: pair.cap.intervalMin },
  };
}

/** «2 turnos cada 15 min» / «1 turno cada 60 min». */
export function bookingCapLabel(cap: { count: number; intervalMin: number } | null): string {
  if (!cap) return "Sin tope";
  return `${cap.count} ${cap.count === 1 ? "turno" : "turnos"} cada ${cap.intervalMin} min`;
}

/**
 * Lo que la ficha del profesional necesita (lo arma el loader de Configuración, 0 sentencias nuevas): su modo y su
 * par, y el del consultorio para rotular «Usar el del consultorio (2 turnos cada 15 min)».
 */
export type PractitionerBookingCapView = {
  mode: BookingCapMode;
  count: number | null;
  intervalMin: number | null;
  tenant: { count: number; intervalMin: number } | null;
};
