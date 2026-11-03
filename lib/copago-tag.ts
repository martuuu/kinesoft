/**
 * [CF2-AD] Tag de cobro del copago en la agenda y en /sala (plan §29 D-CF2-3, brief CF2 A.2): «Pagado · Efectivo» /
 * «Por cobrar» / «Retenido», a la vista sin abrir el turno. Puro y client-safe: lo pinta `MoneyBadge`
 * (`components/agenda/grid/money-badge.tsx`) en la card, Lista, Semana, Recepción y las caras de /sala.
 *
 * Por qué no es `lib/booking-money-badge.ts`: ese módulo tiene un guard de 300 B (`online-payments-first-load-guard`)
 * y solo dice la plata ONLINE («Seña» / «Pagado MP»). Este dice el cobro A MANO, y solo lo ve quien puede cobrar ese
 * turno (lo decide el caller con `canCollectCopago`; acá no hay permisos).
 *
 * Reglas (D-CF2-3: los textos son los del drawer, Facturación, /sala y los E2E; sin estado nuevo en la base):
 * - **paid**: PAID → `Pagado · <medio>` (`paymentMethodLabel`, «Sin informar» sin medio). Mismo rótulo que
 *   `copagoCollectViewFor` (`lib/booking-collect.ts`), fijado con un test de paridad ([CF2-AD6]). Lo pagado entero por
 *   un cobro online (`paidOnline`, el `po` del cable) da `null`: ya lo dice «Pagado MP» del badge online, que gana
 *   (precedencia «Pagado MP» → este tag → «Seña»). El webhook LEGADO (reserva pública PAID sin medio) no llega como
 *   `paidOnline`: queda como «Pagado MP» acá, con el nombre accesible del drawer («Pagado por Mercado Pago»).
 * - **held**: AUTHORIZED (Mercado Pago retiene el pago): no se cobra a mano; se dice para que nadie lo cobre dos veces.
 * - **owed** («Por cobrar»): sin cobro registrado (no PAID/AUTHORIZED/REFUNDED: FAILED también debe, como `owesCopago`
 *   de /sala), falta plata (copago − seña online > 0, la regla de `deskOwedCents`) y el turno OCURRIÓ: no cancelado ni
 *   ausente, y atendido (COMPLETED) o con llegada (`arrivedAt`). Antes de llegar no se marca: todos los turnos del día
 *   dirían «Por cobrar» y el tag no distinguiría nada. [CF2-ZF1] (ZB-1) La regla es `copagoOwedCents`
 *   (`lib/copago-owed.ts`), la MISMA de `owesCopago`/`cashEntries` de /sala y del chip de Recepción: antes /sala
 *   contaba solo atendidos y una card «Por cobrar» no entraba en el contador. Módulo chico a propósito: importar
 *   `reception-desk-state` arrastraría todo el escritorio de /sala al first load de /agenda. Paridad: [CF2-AD7].
 * - REFUNDED, sin `paymentStatus` (proyección que no lo trae: no se adivina) o sin deuda → `null`.
 *
 * Tupla y no objeto, como `cardMoneyBadge`: este módulo entra al first load de /agenda (≤178 kB al cierre de CF2) y
 * las claves pesan. Sin reloj: no depende de la TZ del host.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { copagoOwedCents } from "@/lib/copago-owed";
import { formatARS } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/payment-method";

/** `[tipo, texto visible, nombre accesible completo]`. */
export type CopagoTag = readonly [kind: "paid" | "owed" | "held", label: string, aria: string];

export function copagoTag(
  b: Pick<
    BookingDTO,
    "paymentStatus" | "copagoPaymentMethod" | "copagoCents" | "onlineDepositCents" | "paidOnline" | "status" | "arrivedAt" | "publicReservation"
  >
): CopagoTag | null {
  const ps = b.paymentStatus;
  if (ps == "PAID") {
    if (b.paidOnline) return null;
    if (b.copagoPaymentMethod == null && b.publicReservation === true) return ["paid", "Pagado MP", "Pagado por Mercado Pago"];
    const t = "Pagado · " + paymentMethodLabel(b.copagoPaymentMethod);
    return ["paid", t, t];
  }
  if (ps == "AUTHORIZED") return ["held", "Retenido", "Pago retenido por Mercado Pago"];
  const owed = copagoOwedCents(b);
  return owed > 0 ? ["owed", "Por cobrar", "Por cobrar: " + formatARS(owed)] : null;
}
