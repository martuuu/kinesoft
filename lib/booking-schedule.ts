/**
 * Lógica de agenda pura (sin DB, sin reloj propio, sin "use server") que vivía
 * inline en `lib/bookings.ts` — B1.6 S07 del diseño de Planes. Extracción SIN
 * cambio de comportamiento: la carga de DB quedó en `lib/bookings.ts` y acá
 * solo entra lo ya cargado + `now`. Fijado por la caracterización de
 * `tests/unit/booking-schedule.test.ts` (oráculo = el código de ef3281f).
 *
 * Tres piezas:
 *   1. `findNextFreeSlot` — la sugerencia de próximo hueco ("el profesional
 *      está ocupado, ¿probás a las 11:15?"). Ventana de carga: `suggestLoadWindow`.
 *   2. `expandBatchDates` — las fechas de un multi-turno (días AR elegidos).
 *   3. `classifyBatchSlot` — libre / sobreturno / duplicado por fecha del
 *      batch. Ventana de carga: `batchLoadSpan`.
 *
 * El cupo se decide SOLO con `lib/booking-capacity.ts` (`isHoldingCapacity` +
 * `overlapBlocks`, preservar AUDIT §5.18) y el reloj de pared con
 * `lib/datetime-ar.ts`. El motor de disponibilidad de B2
 * (`lib/availability/*`) parte de acá: cualquier cambio de comportamiento
 * (franjas por profesional, bloqueos, fuera de horario) va allá y con su
 * propia paridad, no editando esto en silencio.
 *
 * B3.1 (AV-bookings): `lib/bookings.ts` ya NO llama a estas funciones — el
 * suggest es `nextFreeSlot`, la expansión `expandDates` y el clasificador
 * `classifyBatchInstant` del motor. Este módulo queda como ORÁCULO congelado
 * de ef3281f: las paridades de `tests/unit/availability-*.test.ts` y la
 * caracterización de `tests/unit/booking-schedule.test.ts` lo usan, y los
 * tipos (`BatchSlotStatus`, `BatchExistingBooking`) siguen siendo contrato del
 * motor. No agregarle callers nuevos; borrarlo en el contract posterior a B-pre
 * (mover los tipos a `lib/availability/types.ts`).
 */
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { toARDow, toARHour } from "@/lib/datetime-ar";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo mínimo de un turno (no cancelado) para decidir cupo: el instante, la
 * duración y lo que `isHoldingCapacity` necesita para saber si una reserva
 * pública impaga ya venció. Es el `select` que hacen las queries de bookings.ts.
 */
export type ScheduleBooking = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
};

/** Turno existente del batch: además, de quién y de qué servicio es. */
export type BatchExistingBooking = ScheduleBooking & {
  practitionerId: string;
  serviceId: string;
};

/** Per-date outcome of a multi-turno batch. */
export type BatchSlotStatus =
  /** Nothing in the way — creates cleanly. */
  | "libre"
  /** Capacity reached for the professional, or the patient already has an
   *  overlapping turno. Creatable as an explicit sobreturno. */
  | "sobreturno"
  /** The patient already has an ACTIVE turno at this exact instant — the DB
   *  unique index forbids a second one, so it can never be created. */
  | "duplicado";

/** Ventana `[gte, lt)` sobre `Booking.scheduledFor` que el caller carga de DB. */
export type LoadWindow = { gte: Date; lt: Date };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sugerencia de próximo hueco
// ─────────────────────────────────────────────────────────────────────────────

/** Paso de la grilla del suggest, en minutos. */
export const SUGGEST_STEP_MIN = 15;
/** Cuántos días hacia adelante mira el suggest antes de rendirse (null). */
export const SUGGEST_HORIZON_DAYS = 14;
/** Horario del consultorio (hora AR) cuando el tenant no lo configuró. */
export const DEFAULT_BUSINESS_HOURS = { start: 8, end: 19 } as const;

const HORIZON_MS = SUGGEST_HORIZON_DAYS * 86_400_000;

/**
 * Qué turnos tiene que cargar el caller para `findNextFreeSlot`: los no
 * cancelados del MISMO profesional + servicio con `scheduledFor` en
 * `[from + 15 min, from + 15 min + 14 días)`.
 *
 * Ojo (comportamiento heredado, hallazgo para B2): un turno que arrancó ANTES
 * de `from + 15` y todavía sigue no entra en la ventana, así que el suggest
 * puede proponer un hueco que en realidad está ocupado por él. El write
 * (`countCapacityOverlaps`, 240 min hacia atrás) igual lo frena; el motor de
 * B2 (`nextFreeSlot`) carga con los 240 min hacia atrás.
 */
export function suggestLoadWindow(from: Date): LoadWindow {
  const gte = new Date(from.getTime() + SUGGEST_STEP_MIN * 60_000);
  return { gte, lt: new Date(gte.getTime() + HORIZON_MS) };
}

/**
 * Next slot of `durationMin` after `from` that doesn't exceed the service's
 * capacity. Walks in 15-min steps within the tenant's business hours (AR),
 * Mon-Sat, capped at 14 days lookahead. Returns the ISO instant, or null if
 * nothing fits within the window.
 *
 * `bookings` = lo que devuelve la carga de `suggestLoadWindow` (mismo
 * profesional + servicio, no cancelados). `now` lo pasa el caller: decide si
 * una reserva pública impaga ya venció (`isHoldingCapacity`).
 */
export function findNextFreeSlot(input: {
  from: Date;
  durationMin: number;
  /** `Service.maxConcurrent`: null = ilimitado. */
  maxConcurrent: number | null;
  /** `Tenant.businessHoursStart/End` (hora AR); null/undefined → 8-19. */
  businessHours: { start: number | null | undefined; end: number | null | undefined };
  bookings: ReadonlyArray<ScheduleBooking>;
  now: Date;
}): string | null {
  const { from, durationMin, maxConcurrent, now } = input;
  const start = suggestLoadWindow(from).gte;
  // Same predicate as the capacity checks: an expired unpaid public pending
  // no longer holds the slot, so it mustn't push the suggestion further out.
  const holding = input.bookings.filter((b) => isHoldingCapacity(b, now));
  const openHour = input.businessHours.start ?? DEFAULT_BUSINESS_HOURS.start;
  const closeHour = input.businessHours.end ?? DEFAULT_BUSINESS_HOURS.end;
  // A slot is "free" when adding this turno wouldn't exceed the service's
  // per-horario capacity — counting SAME-service overlaps only.
  const atCapacity = (slot: Date, end: Date) =>
    overlapBlocks(
      holding.filter((b) => {
        const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
        return b.scheduledFor < end && bEnd > slot;
      }).length,
      maxConcurrent
    );
  const cursor = new Date(start);
  // Round to next 15-min boundary (y a 0 segundos: puede quedar unos segundos
  // ANTES de from+15 — heredado, lo fija el test). Minutos del host a
  // propósito: el offset AR es de horas enteras, así que da lo mismo.
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / SUGGEST_STEP_MIN) * SUGGEST_STEP_MIN, 0, 0);
  while (cursor.getTime() - from.getTime() < HORIZON_MS) {
    // Gate against the AR wall-clock, not the host's — openHour/closeHour are
    // AR business hours, so on a UTC host `getDay()`/`getHours()` would be
    // 3h off and could skip Saturday or include Sunday.
    const dow = toARDow(cursor); // 0 Sun..6 Sat in AR
    const arHour = toARHour(cursor); // fractional AR hour, e.g. 14.5
    // Slot must fit entirely inside the business window.
    const endMinutes = arHour * 60 + durationMin;
    if (dow !== 0 && arHour >= openHour && endMinutes <= closeHour * 60) {
      const end = new Date(cursor.getTime() + durationMin * 60_000);
      if (!atCapacity(cursor, end)) {
        return cursor.toISOString();
      }
    }
    cursor.setTime(cursor.getTime() + SUGGEST_STEP_MIN * 60_000);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Expansión de fechas del batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AR-correct date expansion of a multi-turno. `anchor` is a real instant
 * (tagged -03:00 by `localToARIso` on the client); se recorre de a +24 h desde
 * el ancla inclusive (AR no tiene horario de verano: +24 h = +1 día AR) y se
 * toma cada día cuyo dow AR esté en `daysOfWeek`, hasta juntar `count`.
 *
 * `daysOfWeek` usa 0=Lun..6=Dom (no el 0=Dom de `getDay`) y se normaliza
 * módulo 7. Vacío/undefined → semanal en el dow AR del ancla. Tope de 400
 * iteraciones (≈ 57 semanas): un count más grande devuelve menos fechas.
 * `count` lo acota el caller (bookings.ts: 1..60).
 */
export function expandBatchDates(
  anchor: Date,
  count: number,
  daysOfWeek?: ReadonlyArray<number>
): Date[] {
  const dowSet = new Set((daysOfWeek ?? []).map((d) => ((d % 7) + 7) % 7)); // 0=Mon..6=Sun
  if (dowSet.size === 0) dowSet.add((toARDow(anchor) + 6) % 7);

  const dates: Date[] = [];
  let cursor = new Date(anchor);
  let guard = 0;
  while (dates.length < count && guard++ < 400) {
    const monDow = (toARDow(cursor) + 6) % 7; // 0=Mon..6=Sun in AR
    if (dowSet.has(monDow)) dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000); // +1 AR day (DST-free)
  }
  return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Clasificador del batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qué cargar para clasificar un batch con una sola query: los no cancelados
 * con `scheduledFor` en `[primera − 240 min, última + duración + 240 min)` que
 * sean del mismo profesional + servicio (cupo) O del paciente (solape propio /
 * duplicado). `dates` no puede venir vacío (el caller lo garantiza: count ≥ 1).
 */
export function batchLoadSpan(dates: ReadonlyArray<Date>, durationMin: number): LoadWindow {
  return {
    gte: new Date(dates[0].getTime() - 240 * 60_000),
    lt: new Date(dates[dates.length - 1].getTime() + durationMin * 60_000 + 240 * 60_000),
  };
}

/**
 * Clasifica una fecha del batch, en este orden:
 *   1. `duplicado`  — el paciente ya tiene un turno que arranca en ese mismo
 *      instante (cualquier fila, incluso una reserva vencida: el índice único
 *      parcial igual la rechaza).
 *   2. `sobreturno` — el paciente está ocupado en la ventana (cualquier
 *      profesional/servicio), o el cupo del profesional + servicio está lleno
 *      (`overlapBlocks`, contando solo lo que `isHoldingCapacity` sostiene).
 *   3. `libre`.
 * Sin paciente (guest) solo cuenta el cupo. Solape = intervalos semiabiertos:
 * tocarse en el borde no es solape.
 */
export function classifyBatchSlot(
  when: Date,
  ctx: {
    patientId: string | null | undefined;
    practitionerId: string;
    serviceId: string;
    durationMin: number;
    maxConcurrent: number | null;
    existing: ReadonlyArray<BatchExistingBooking>;
    now: Date;
  }
): BatchSlotStatus {
  const { existing, now } = ctx;
  const end = new Date(when.getTime() + ctx.durationMin * 60_000);
  const overlaps = (e: { scheduledFor: Date; durationMin: number }) =>
    e.scheduledFor < end && new Date(e.scheduledFor.getTime() + e.durationMin * 60_000) > when;

  if (ctx.patientId) {
    // Exact instant → the partial unique index makes this uncreatable.
    if (existing.some((e) => e.patientId === ctx.patientId && +e.scheduledFor === +when)) {
      return "duplicado";
    }
    // The patient is busy elsewhere in this window (any professional/service).
    if (existing.some((e) => e.patientId === ctx.patientId && overlaps(e))) {
      return "sobreturno";
    }
  }
  // Capacity only: an expired unpaid public pending no longer holds the cupo
  // (isHoldingCapacity). The patient checks above use every row — the unique
  // index still rejects the exact instant of a PENDING row.
  const capacityCount = existing.filter(
    (e) =>
      e.practitionerId === ctx.practitionerId &&
      e.serviceId === ctx.serviceId &&
      isHoldingCapacity(e, now) &&
      overlaps(e)
  ).length;
  return overlapBlocks(capacityCount, ctx.maxConcurrent) ? "sobreturno" : "libre";
}
