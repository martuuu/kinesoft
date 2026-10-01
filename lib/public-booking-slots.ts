/**
 * Grilla de horarios del turnero público — lógica pura (A2b-S-pub).
 *
 * Antes vivía inline en `listPublicSlots` (archivo `"use server"`, hallazgo
 * `logica-en-use-server`) y el submit NO la consultaba: `submitPublicBooking`
 * aceptaba cualquier instante futuro (un domingo, las 03:00, o 10:07 fuera de
 * la grilla de 45 min) con solo armar el request a mano. Ahora las dos puntas
 * usan la misma función: la lista que ve el paciente y la validación del
 * submit no pueden divergir.
 *
 * Sin reloj ni DB propios: `now` y los turnos existentes los pasa el caller
 * (tests en TZ=UTC, `tests/unit/public-slots.test.ts`). Toda la aritmética de
 * pared va por `lib/datetime-ar.ts` (AR fijo UTC−3, sin DST).
 */
import { localToARIso, toARDow } from "@/lib/datetime-ar";
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import type { PublicSlot } from "@/lib/public-booking-types";

/** Horario por defecto si el tenant no configuró `businessHoursStart/End`. */
export const DEFAULT_OPEN_HOUR = 8;
export const DEFAULT_CLOSE_HOUR = 19;
/** Paso de la grilla pública (min). Independiente de la duración del servicio. */
export const PUBLIC_SLOT_STEP_MIN = 45;
/** Anticipación mínima para reservar online: 1 h desde `now`. */
export const PUBLIC_MIN_LEAD_MS = 60 * 60_000;
/**
 * Cuánto antes del inicio del día hay que traer turnos para contar solapes:
 * un turno largo que arrancó antes de medianoche AR puede pisar el primer slot.
 * Lo usan las queries de `listPublicSlots` y del submit.
 */
export const PUBLIC_OVERLAP_LOOKBACK_MS = 4 * 60 * 60_000;

/** Turno existente tal como lo necesita la grilla (ya sin CANCELLED). */
export type PublicSlotBooking = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  /** Discriminante de la reserva pública (`isPublicReservation`). */
  idempotencyKey: string;
};

/** `[inicio, fin)` del día AR `date` ("YYYY-MM-DD"), o null si la fecha es inválida. */
export function arDayWindow(date: string): { dayStart: Date; dayEnd: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dayStart = new Date(localToARIso(`${date}T00:00:00`));
  if (Number.isNaN(dayStart.getTime())) return null;
  // AR no tiene DST: la medianoche siguiente es exactamente +24 h.
  return { dayStart, dayEnd: new Date(dayStart.getTime() + 86_400_000) };
}

/**
 * Arma la grilla de un día AR para un servicio.
 *
 *   - domingo → cerrado (lista vacía);
 *   - slots cada `PUBLIC_SLOT_STEP_MIN` desde `openHour` mientras el turno
 *     completo termine a más tardar en `closeHour`;
 *   - `available = false` si arranca antes de `now + 1 h` o si el cupo del
 *     servicio (`maxConcurrent`) ya está lleno con los turnos que **siguen
 *     reteniendo** (`isHoldingCapacity`: una reserva pública impaga de más
 *     de 30 min ya no bloquea).
 *
 * `existing` son los turnos NO cancelados del mismo profesional + servicio
 * (el caller filtra CANCELLED en la query, como pide el contrato de S06).
 */
export function buildPublicSlots(input: {
  date: string;
  openHour: number | null | undefined;
  closeHour: number | null | undefined;
  durationMin: number;
  maxConcurrent: number | null | undefined;
  existing: ReadonlyArray<PublicSlotBooking>;
  now: Date;
}): PublicSlot[] {
  const win = arDayWindow(input.date);
  if (!win) return [];
  if (toARDow(win.dayStart) === 0) return []; // domingos cerrado

  const holding = input.existing.filter((b) => isHoldingCapacity(b, input.now));
  const openHour = input.openHour ?? DEFAULT_OPEN_HOUR;
  const closeHour = input.closeHour ?? DEFAULT_CLOSE_HOUR;
  const total = input.durationMin;
  const earliest = input.now.getTime() + PUBLIC_MIN_LEAD_MS;

  const slots: PublicSlot[] = [];
  for (let m = openHour * 60; m + total <= closeHour * 60; m += PUBLIC_SLOT_STEP_MIN) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    // El instante AR de esa hora de pared (no `setHours` del host: en Vercel es UTC).
    const slot = new Date(localToARIso(`${input.date}T${hh}:${mm}:00`));
    const slotEnd = new Date(slot.getTime() + total * 60_000);
    const tooSoon = slot.getTime() < earliest;
    const overlapCount = holding.filter((b) => {
      const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
      return b.scheduledFor < slotEnd && bEnd > slot;
    }).length;
    const full = overlapBlocks(overlapCount, input.maxConcurrent);
    slots.push({ iso: slot.toISOString(), time: `${hh}:${mm}`, available: !full && !tooSoon });
  }
  return slots;
}

/**
 * Veredicto del submit para un instante pedido: tiene que ser EXACTAMENTE un
 * slot de la grilla de su día AR, y estar disponible.
 *   - "off-grid"    → domingo, fuera de horario o no alineado a la grilla;
 *   - "unavailable" → es de la grilla pero ya pasó / < 1 h / cupo lleno;
 *   - "ok".
 */
export type PublicSlotVerdict = "ok" | "off-grid" | "unavailable";

export function checkPublicSlot(
  scheduledFor: Date,
  slots: ReadonlyArray<PublicSlot>
): PublicSlotVerdict {
  const iso = scheduledFor.toISOString();
  const hit = slots.find((s) => s.iso === iso);
  if (!hit) return "off-grid";
  return hit.available ? "ok" : "unavailable";
}
