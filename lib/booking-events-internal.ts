import "server-only";
import { revalidateTag } from "next/cache";
import { tags } from "@/lib/cache-tags";
import { logger } from "@/lib/logger";

/**
 * Punto único de "después de que un turno cambió" (P2-C1, ES2b; enmienda
 * Realtime de PLANES.md §10 / VERTICALES.md §5). FIRMA CONGELADA.
 *
 * Por qué existe antes de que haya realtime: la Sala de Espera realtime (SV)
 * necesita publicar un evento por cada write-path que crea, mueve, cambia
 * estado/cobro, cancela o borra un `Booking`. Esos write-paths están
 * repartidos en `bookings.ts` (S07c/S12) y en los archivos de Planes (S11e,
 * S12b, S15, S16a, S16b, S25a, S17d). Si cada uno invalidara caches a su
 * manera, SV tendría que volver a tocar todos esos archivos. Con este punto
 * único, los write-paths llaman `afterBookingsCommitted` una vez y SV le suma
 * el publish ACÁ sin cambiar la firma.
 *
 * Reglas de uso (literal de la enmienda):
 *   - se llama **una vez, después del commit y fuera de la tx** (`runWithRls`);
 *     adentro, un rollback dejaría el cache invalidado contra datos viejos y
 *     otro request lo volvería a llenar con el estado previo;
 *   - los `*InTx` **devuelven** refs y nunca emiten adentro;
 *   - **nunca tira**: el turno ya está escrito; un fallo de invalidación (o,
 *     con SV, del publish) no puede convertir un alta exitosa en un error para
 *     el usuario ni disparar un reintento que duplique. Se loguea y sigue.
 *
 * Hoy hace exactamente lo de `invalidateBookingDerivedCaches` de
 * `lib/bookings.ts` (revalidateTag de `bookingDays` y `dashboard` del tenant),
 * salvo con `invalidateCaches: false` (para un caller que ya los revalidó, o
 * un camino que solo tiene que emitir el evento cuando SV exista).
 * S07c reemplaza `invalidateBookingDerivedCaches` por esta función.
 */

/**
 * Un turno que cambió. `prev` = dónde estaba antes de un movimiento (otro
 * profesional u otro horario): SV avisa a las dos agendas. `kind` distingue
 * el cambio de turno de los de Recepción ("llegó", "en atención") y del
 * llamado de la Sala de Espera; default `'booking'`.
 */
export type BookingChangeRef = {
  bookingId: string;
  practitionerId: string;
  scheduledFor: Date;
  /**
   * SR (aditivo, opcional): sala del turno DESPUÉS del cambio; null = sin sala,
   * ausente = el write-path no la informa. La consume SV (M5: "Llamar" y la
   * vista de sala); hoy esta función no la lee.
   */
  roomId?: string | null;
  /** `roomId` = sala de antes (SR): un cambio de sala avisa a las dos salas. */
  prev?: { practitionerId: string; scheduledFor: Date; roomId?: string | null } | null;
  kind?: "booking" | "reception" | "called";
};

export async function afterBookingsCommitted(
  tenantId: string,
  refs: ReadonlyArray<BookingChangeRef>,
  opts?: { invalidateCaches?: boolean }
): Promise<void> {
  if (opts?.invalidateCaches === false) return;
  // Aunque `refs` venga vacío se invalida igual: es lo que hacía
  // `invalidateBookingDerivedCaches`, que no recibía refs, y un caller que
  // todavía no arma refs (S07c migra de a uno) no tiene que perder la
  // invalidación por eso.
  // Cada tag en su propio try: si el primero falla, el dashboard igual se
  // invalida (con un solo try, el KPI quedaba viejo aunque la agenda no).
  for (const tag of [tags.bookingDays(tenantId), tags.dashboard(tenantId)]) {
    try {
      revalidateTag(tag);
    } catch (e) {
      safeLog(tenantId, refs.length, e);
    }
  }
}

/** El log tampoco puede tirar: "nunca tira" es el contrato. */
function safeLog(tenantId: string, refs: number, e: unknown): void {
  try {
    logger.error("booking.events.after_commit_failed", {
      tenantId,
      refs,
      err: e instanceof Error ? e.message : String(e),
    });
  } catch {
    // sin salida: no hay a dónde reportar
  }
}
