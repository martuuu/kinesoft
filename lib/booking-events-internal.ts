import "server-only";
import { revalidateTag } from "next/cache";
import { tags } from "@/lib/cache-tags";
import { logger } from "@/lib/logger";
import { publishAvailability, publishBookingChanges } from "@/lib/realtime-publisher-internal";

/**
 * Punto único de "después de que un turno cambió" (P2-C1, ES2b; enmienda
 * Realtime de PLANES.md §10 / VERTICALES.md §5). FIRMA CONGELADA (C-SV3).
 *
 * Por qué existe: la Sala de Espera realtime (SV) publica un evento por cada
 * write-path que crea, mueve, cambia estado/cobro, cancela o borra un
 * `Booking`. Esos write-paths están repartidos en `bookings.ts` y en los
 * archivos de Planes, el turnero, el webhook de MP y el candado; con este punto
 * único todos llaman `afterBookingsCommitted` una vez y el publish vive ACÁ.
 *
 * Qué hace (SV04a), en este orden:
 *   1. invalida `bookingDays` y `dashboard` del tenant (lo que hacía
 *      `invalidateBookingDerivedCaches`), salvo con `invalidateCaches: false`
 *      (un caller que ya los revalidó, o Recepción «llegó», que no cambia nada
 *      cacheado). Antes de SV, `false` hacía un early return y NO emitía: la
 *      Secretaria marcaba «Llegó» y el profesional no se enteraba. Ahora el
 *      flag apaga SOLO la invalidación;
 *   2. publica los refs (`publishBookingChanges`): 1 POST por commit. Con
 *      `refs` vacío no publica (SV-D12): no hay turno que avisar.
 *
 * Por qué invalidar ANTES de publicar: el cliente que recibe el evento re-pide
 * enseguida; si el publish saliera primero, ese refetch podía leer el cache
 * viejo de `bookingDays` y quedarse con el estado anterior hasta el polling.
 *
 * Por qué se ESPERA el publish (SV-D7) en vez de dispararlo suelto: en Vercel
 * la lambda se congela al responder y una promesa suelta se pierde; Next 14.2
 * no tiene `after()`. El publisher tiene tope de 1,5 s y breaker, así que lo
 * peor que paga una action es eso, y con Supabase caído, 0 ms.
 *
 * Reglas de uso (literal de la enmienda):
 *   - se llama **una vez, después del commit y fuera de la tx** (`runWithRls`);
 *     adentro, un rollback dejaría el cache invalidado contra datos viejos (y
 *     un evento publicado de un cambio que no existe) y otro request volvería
 *     a llenar el cache con el estado previo;
 *   - los `*InTx` **devuelven** refs y nunca emiten adentro;
 *   - **nunca tira**: el turno ya está escrito; un fallo de invalidación o del
 *     publish no puede convertir un alta exitosa en un error para el usuario
 *     ni disparar un reintento que duplique. Se loguea y sigue (los clientes se
 *     ponen al día por el polling de 60 s).
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
   * vista de sala); viaja en el mensaje realtime.
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
  if (opts?.invalidateCaches !== false) {
    // Aunque `refs` venga vacío se invalida igual: es lo que hacía
    // `invalidateBookingDerivedCaches`, que no recibía refs, y un caller que
    // todavía no arma refs no tiene que perder la invalidación por eso.
    // Cada tag en su propio try: si el primero falla, el dashboard igual se
    // invalida (con un solo try, el KPI quedaba viejo aunque la agenda no).
    for (const tag of [tags.bookingDays(tenantId), tags.dashboard(tenantId)]) {
      try {
        revalidateTag(tag);
      } catch (e) {
        safeLog(tenantId, refs.length, "invalidate", e);
      }
    }
  }
  if (refs.length === 0) return;
  // Su propio try: el publisher real nunca tira, pero un reemplazo (tests) o un
  // bug futuro no puede romper el contrato del hook.
  try {
    await publishBookingChanges(tenantId, refs);
  } catch (e) {
    safeLog(tenantId, refs.length, "publish", e);
  }
}

/**
 * Candado del día y alta/baja de bloqueos (SV-D12, lo llama SV06b): no cambió
 * ningún turno (o los cancelados ya salen por `afterBookingsCommitted`), pero
 * cambió la disponibilidad. Revalida `bookingDays` (lo que el candado hacía
 * inline) y publica un `availability`; la agenda que lo recibe hace
 * `router.refresh()`. `practitionerId: null` = todo el consultorio. Mismo
 * orden y mismas reglas que el hook de turnos: después del commit, nunca tira.
 *
 * `day: null` (FX1b, aditivo a C-SV3) = varios días o sin día: un bloqueo de
 * una semana se avisa con UNA llamada (1 POST + 1 `revalidateTag`) y no con una
 * por día — §18.2 «1 commit = 1 POST». El cliente ya trata `day: null` como
 * «re-pedí lo que estés mirando».
 */
export async function afterAvailabilityCommitted(
  tenantId: string,
  scope: { practitionerId: string | null; day: string | null },
  // Integrador SV1.2: el candado ya invalidó `bookingDays` con
  // `afterBookingsCommitted` en el mismo request; con `false` no lo repite.
  opts?: { invalidateCaches?: boolean }
): Promise<void> {
  if (opts?.invalidateCaches !== false) {
    try {
      revalidateTag(tags.bookingDays(tenantId));
    } catch (e) {
      safeLog(tenantId, 0, "invalidate", e);
    }
  }
  try {
    await publishAvailability(tenantId, scope);
  } catch (e) {
    safeLog(tenantId, 0, "publish", e);
  }
}

/** El log tampoco puede tirar: "nunca tira" es el contrato. */
function safeLog(tenantId: string, refs: number, stage: "invalidate" | "publish", e: unknown): void {
  try {
    logger.error("booking.events.after_commit_failed", {
      tenantId,
      refs,
      stage,
      err: e instanceof Error ? e.message : String(e),
    });
  } catch {
    // sin salida: no hay a dónde reportar
  }
}
