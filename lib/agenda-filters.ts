/**
 * Filtros de visibilidad de la agenda y estado de pago de la reserva pública —
 * lógica pura (sin React, sin DOM, sin reloj propio), testeable en unit con
 * TZ=UTC (docs/TESTING.md capa 1). A2b-S-ui ítem 4 + handoff de A2a-S06.
 *
 * Los toggles "Mostrar cancelados" / "Mostrar ausentes" arrancan PRENDIDOS: es
 * la conducta de siempre (la agenda mostraba todo) y la secretaria no tiene que
 * descubrir que "faltan" turnos. Cuando se apagan, el header muestra cuántos
 * quedaron ocultos para que nunca parezca un hueco libre.
 *
 * Se persisten en `localStorage` por usuario (sin migración: es una preferencia
 * de pantalla, no un dato). La lectura tolera basura y storage bloqueado.
 */
import { isUnpaidPublicPending, publicHoldExpired } from "@/lib/booking-capacity";

export type AgendaVisibility = {
  showCancelled: boolean;
  showNoShow: boolean;
};

export const DEFAULT_AGENDA_VISIBILITY: AgendaVisibility = {
  showCancelled: true,
  showNoShow: true,
};

type WithStatus = { status: string };

/** ¿Este turno se dibuja con los toggles actuales? */
export function isVisibleInAgenda(b: WithStatus, vis: AgendaVisibility): boolean {
  if (b.status === "CANCELLED") return vis.showCancelled;
  if (b.status === "NO_SHOW") return vis.showNoShow;
  return true;
}

export function applyAgendaVisibility<T extends WithStatus>(
  bookings: readonly T[],
  vis: AgendaVisibility
): T[] {
  return bookings.filter((b) => isVisibleInAgenda(b, vis));
}

export type HiddenCounts = { cancelled: number; noShow: number; total: number };

export function countHidden(bookings: readonly WithStatus[], vis: AgendaVisibility): HiddenCounts {
  let cancelled = 0;
  let noShow = 0;
  for (const b of bookings) {
    if (b.status === "CANCELLED" && !vis.showCancelled) cancelled++;
    else if (b.status === "NO_SHOW" && !vis.showNoShow) noShow++;
  }
  return { cancelled, noShow, total: cancelled + noShow };
}

/** "3 ocultos · 2 cancelados, 1 ausente" — null si no hay nada oculto. */
export function hiddenCountLabel(c: HiddenCounts): string | null {
  if (c.total === 0) return null;
  const parts: string[] = [];
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelado${c.cancelled === 1 ? "" : "s"}`);
  if (c.noShow > 0) parts.push(`${c.noShow} ausente${c.noShow === 1 ? "" : "s"}`);
  return `${c.total} oculto${c.total === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

/**
 * Clave de `localStorage` por usuario: en una PC compartida de recepción, cada
 * login conserva sus toggles. Sin id (no debería pasar) cae en una clave común.
 */
export function agendaVisibilityStorageKey(viewerId?: string | null): string {
  return `kinesoft:agenda-visibility:${viewerId || "default"}`;
}

/** Lee lo guardado; cualquier cosa rara (JSON roto, tipos malos) → defaults. */
export function parseAgendaVisibility(raw: string | null | undefined): AgendaVisibility {
  if (!raw) return { ...DEFAULT_AGENDA_VISIBILITY };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof AgendaVisibility, unknown>> | null;
    if (!v || typeof v !== "object") return { ...DEFAULT_AGENDA_VISIBILITY };
    return {
      showCancelled:
        typeof v.showCancelled === "boolean" ? v.showCancelled : DEFAULT_AGENDA_VISIBILITY.showCancelled,
      showNoShow: typeof v.showNoShow === "boolean" ? v.showNoShow : DEFAULT_AGENDA_VISIBILITY.showNoShow,
    };
  } catch {
    return { ...DEFAULT_AGENDA_VISIBILITY };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserva pública impaga (decisión del dueño, 30-sep): sostiene el cupo 30 min.
// Pasado ese plazo deja de contar para la disponibilidad y la agenda la muestra
// como "Pendiente de pago · vencida". La regla vive en `isHoldingCapacity`
// (lib/booking-capacity.ts); acá solo se traduce a una etiqueta.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentHoldState = "pendiente" | "vencida" | null;

export const PAYMENT_HOLD_LABEL: Record<Exclude<PaymentHoldState, null>, string> = {
  pendiente: "Pendiente de pago",
  vencida: "Pendiente de pago · vencida",
};

/**
 * - `null`: no es una reserva pública impaga (o faltan los datos para saberlo:
 *   si el server no manda `paymentStatus`/`createdAt`/`publicReservation`, no
 *   se inventa nada).
 * - `"pendiente"`: reserva pública PENDING + UNPAID/FAILED, todavía dentro de
 *   los 30 min.
 * - `"vencida"`: ídem pero pasados los 30 min → ya no retiene el cupo.
 *
 * Mismo predicado que el servidor (`isUnpaidPublicPending` /
 * `publicHoldExpired`, las dos mitades de `isHoldingCapacity`): antes la UI
 * miraba solo UNPAID + paciente y divergía (revisión A2): un PENDING/FAILED
 * vencido liberaba el cupo sin rótulo, y un guest con paciente asignado se
 * rotulaba "vencida". `publicReservation` lo calcula el server desde la key.
 *
 * `createdAt` llega como ISO (el DTO del cliente es serializable) o Date.
 */
export function paymentHoldState(
  b: {
    status: string;
    paymentStatus?: string | null;
    createdAt?: string | Date | null;
    publicReservation?: boolean;
  },
  now: Date
): PaymentHoldState {
  if (!b.paymentStatus || !b.createdAt || b.publicReservation == null) return null;
  const base = { status: b.status, paymentStatus: b.paymentStatus, publicReservation: b.publicReservation };
  if (!isUnpaidPublicPending(base)) return null;
  const createdAt = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return publicHoldExpired({ ...base, createdAt }, now) ? "vencida" : "pendiente";
}

/**
 * ¿Hay en pantalla alguna reserva pública impaga cuyo rótulo puede cambiar con
 * el reloj? La agenda re-renderiza cada minuto solo si la hay.
 */
export function hasTickingPaymentHold(
  bookings: ReadonlyArray<Parameters<typeof paymentHoldState>[0]>,
  now: Date
): boolean {
  return bookings.some((b) => paymentHoldState(b, now) === "pendiente");
}
