/**
 * [CF2-ZF1] UN solo criterio de «Por cobrar» (ZB-1, AUDIT «Ronda CF2»). Antes había tres: el tag de la agenda y de las
 * cards de /sala (`copagoTag`: llegó o fue atendido), el chip de Recepción (el mismo tag) y el contador y el drawer de
 * /sala (`owesCopago` → `cashEntries`: SOLO atendidos). Una card de la sala decía «Por cobrar» y no entraba ni en
 * «Por cobrar · N · $X» ni en el drawer: la Secretaria leía dos números para la misma deuda.
 *
 * Regla (la de D-CF2-3, que ya tenía el tag): se debe si
 *   - hay un `paymentStatus` y no es PAID / AUTHORIZED / REFUNDED (FAILED sigue debiendo; sin `paymentStatus` es una
 *     proyección que no trae el cobro: no se adivina, como `copagoCollectViewFor`);
 *   - el turno OCURRIÓ: no cancelado ni ausente, y atendido (COMPLETED) o con llegada (`arrivedAt`). Antes de llegar no:
 *     todos los turnos del día dirían «Por cobrar»;
 *   - falta plata: copago − seña online > 0 (`deskOwedCents`).
 * Lo que NO cambia: la primaria «Cobrar» del escritorio sigue siendo solo del atendido (`deskPrimary`); a quien está
 * en la sala se le cobra desde el menú ⋯ («Cobrar ahora») o desde el drawer.
 *
 * Por qué un módulo propio y chico: lo importan `lib/copago-tag.ts` (first load de /agenda, ratchet de
 * `cf2-first-load-guard`) y `lib/reception-desk-state.ts` (first load de /sala, imports fijados por [CF2-SB8]). Que
 * `reception-desk-state` importara `copago-tag` arrastraría `payment-method` a /sala; que `copago-tag` importara
 * `reception-desk-state` metería el escritorio entero en /agenda. Sin dependencias salvo `formatARS` (ya en las dos).
 * Puro, sin reloj: no depende de la TZ del host.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";

/**
 * Lo que FALTA cobrar en el mostrador (T5, §25.8 «Predicados de plata»): copago − seña pagada por Mercado Pago
 * (`onlineDepositCents`, Σ de las señas PAID que mantiene el trigger de M18), con piso 0. Es la regla de
 * `copagoRemainingCents` (`lib/booking-collect.ts`, la que valida `setBookingCopagoPaid`), fijada con un test de
 * paridad ([TP-3f]); no se importa de ahí porque `booking-collect` arrastra el formateo de fechas del modal. Una seña
 * negativa o no entera es un dato corrupto: se ignora (sumarla AUMENTARÍA lo que se le cobra al paciente).
 */
export function deskOwedCents(row: Pick<BookingDTO, "copagoCents" | "onlineDepositCents">): number {
  const od = row.onlineDepositCents;
  // `Number.isInteger` ya es false para null/undefined/NaN: no hace falta el `typeof` (y este módulo cuenta bytes en el
  // first load de /agenda, ratchet de `cf2-first-load-guard`).
  return Math.max(0, row.copagoCents - (Number.isInteger(od) && od! > 0 ? od! : 0));
}

/** «Por cobrar»: lo que falta si el turno debe (regla de la cabecera), 0 si no. Un solo predicado para todo. */
export function copagoOwedCents(
  b: Pick<BookingDTO, "paymentStatus" | "copagoCents" | "onlineDepositCents" | "status" | "arrivedAt">
): number {
  const ps = b.paymentStatus;
  if (!ps || ps == "PAID" || ps == "AUTHORIZED" || ps == "REFUNDED") return 0;
  if (b.status == "CANCELLED" || b.status == "NO_SHOW" || (b.status != "COMPLETED" && !b.arrivedAt)) return 0;
  // La resta de `deskOwedCents`, en línea: llamarla costaba ~10 B gz de más en el first load de /agenda (ratchet de
  // `cf2-first-load-guard`). La paridad entre las dos la fija [CF2-AD7].
  const od = b.onlineDepositCents;
  return Math.max(0, b.copagoCents - (Number.isInteger(od) && od! > 0 ? od! : 0));
}

/**
 * [CF2-ZF1] (ZB-7) El rótulo de «Por cobrar» en el header de /sala y en el chip de Recepción: «Por cobrar · 3 ·
 * $ 15.000»; sin nada, «Por cobrar · 0» (los dos quedan visibles y deshabilitados en 0: que aparezca y desaparezca
 * movería la barra cada vez que alguien paga).
 */
export function porCobrarLabel(count: number, totalCents: number): string {
  return count > 0 ? `Por cobrar · ${count} · ${formatARS(totalCents)}` : "Por cobrar · 0";
}
