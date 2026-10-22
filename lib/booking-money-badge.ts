/**
 * [TP-3e] Mini-badge de plata online de la card de la agenda (§25.10 «Agenda», TP-UI-D4): solo «Seña» o «Pagado MP».
 *
 * Por qué existe aparte de `bookingMoneyBadge` (`lib/booking-money-view.ts`, TP-P5): este es lo ÚNICO de T5 que entra
 * estático al first load de `/agenda`, con techo de +0,3 kB gz (§25.11) que además comparte con el ítem del menú «Mi
 * Mercado Pago», y `/agenda` llegó a T5e con 0,2 kB de margen. Medido con `next build` en TP-3e:
 *  - `bookingMoneyBadge` + `MONEY_BADGE_COPY` (objeto con `kind`, helper aparte): 315 B en el medidor del guard;
 *  - versión mínima con el objeto de copy: +241 B reales en `/agenda` (badge + Card, Lista y Semana);
 *  - esta (tupla y textos en línea): +168 B reales en `/agenda` (208 B en el medidor del guard).
 * Los textos son los de `MONEY_BADGE_COPY` (`lib/online-payments-copy.ts`, la fuente del vocabulario) copiados a
 * propósito: el import del objeto arrastraba sus claves y el módulo entero como dependencia del chunk compartido. La
 * paridad (texto, nombre accesible y `data-badge`) contra `bookingMoneyBadge` la fija `tests/unit/booking-money-badge.test.ts`:
 * si alguien cambia el copy allá, ese test frena acá.
 *
 * Regla (C-TP10): la entrada es el cable de la agenda (`od` → `onlineDepositCents`, `po` → `paidOnline`), que se omite
 * cuando es 0/false → `null` y la card queda con los mismos nodos que antes de T5. «Pagado MP» gana sobre la seña (si
 * se pagó entero online, la seña es parte de ese pago). Un monto que no es un número finito > 0 no es una seña.
 */
import { formatARS } from "@/lib/format";

/** `[data-badge, texto visible, nombre accesible completo]`. Tupla y no objeto: las claves pesan en el first load. */
export type CardMoneyBadge = readonly [dataBadge: "sena" | "mp", label: string, ariaLabel: string];

export function cardMoneyBadge(b: { onlineDepositCents?: number | null; paidOnline?: boolean | null }): CardMoneyBadge | null {
  const c = b.onlineDepositCents;
  // `c < Infinity` en vez de `Number.isFinite(c)`: misma defensa (NaN y ±Infinity quedan afuera) y unos bytes menos.
  return b.paidOnline
    ? ["mp", "Pagado MP", "Pagado por Mercado Pago"]
    : typeof c == "number" && c > 0 && c < Infinity
      ? ["sena", "Seña", "Seña pagada por Mercado Pago: " + formatARS(Math.trunc(c))]
      : null;
}
