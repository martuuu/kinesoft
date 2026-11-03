import { canCollectCopago, type Capability } from "@/lib/capabilities";
import { copagoOwedCents } from "@/lib/copago-owed";
import { copagoRemainingCents, withCopagoPaid } from "@/lib/booking-collect";
import type { PaymentMethod } from "@/lib/payment-method";
import type { BookingDTO } from "../agenda-utils";

/**
 * [CF2-RC] Cobro del copago en el modo Recepción (plan §29 D-CF2-3, brief CF2 A.2). Puro (sin React): lo usa
 * `ReceptionView` y lo fija `tests/unit/render/cf2-reception-collect.test.tsx`.
 *
 * `ReceptionCollect` es el viewer del cobro que arma `agenda-client` con las capabilities del actor:
 * `all` = `billing.collect` (Secretaria, Admin, Facturación, Titular: cualquier turno); sin `all` = `billing.collectOwn`
 * (el profesional, solo los turnos de `practitionerId`). Sin ninguna de las dos el padre pasa `null` y la vista es la de
 * antes de CF2 (sin columna «Cobro»).
 */
export type ReceptionCollect = { all: boolean; practitionerId: string | null };

/**
 * ¿El viewer cobra ESTA fila? Es `canCollectCopago` (el mismo que aplica `setBookingCopagoPaid` en el server) con las
 * caps sintéticas, igual que `canCollectRow` de /sala: el botón y la action no pueden divergir. Un actor sin
 * profesional nunca pasa por «lo suyo» (`null === null` lo cuida `canCollectCopago`).
 */
export function receptionCanCollect(collect: ReceptionCollect | null | undefined, row: Pick<BookingDTO, "practitionerId">): boolean {
  if (!collect) return false;
  const caps = new Set<Capability>([collect.all ? "billing.collect" : "billing.collectOwn"]);
  return canCollectCopago(caps, collect.practitionerId, row.practitionerId);
}

/**
 * ¿Mostrar «Cobrar» en la fila? El viewer la cobra y la fila debe según el criterio ÚNICO de «Por cobrar»
 * (`copagoOwedCents`, el del tag y el de `cashEntries` de /sala, [CF2-ZF1]: llegó o fue atendido, no cancelado ni
 * ausente, sin cobro y con plata que falta después de la seña). Antes de llegar NO: el cobro de recepción es del
 * paciente que está o estuvo en el consultorio (D-CF2-3); adelantar un cobro sigue en el drawer.
 */
export function receptionOwes(collect: ReceptionCollect | null | undefined, row: BookingDTO): boolean {
  return receptionCanCollect(collect, row) && copagoOwedCents(row) > 0;
}

/** Lo que falta cobrar: copago − seña online. La misma cuenta que el monto del `CollectModal` (`collectAmountFor`). */
export function receptionOwedCents(row: Pick<BookingDTO, "copagoCents" | "onlineDepositCents">): number {
  return copagoRemainingCents({ resolvedCopagoCents: row.copagoCents, onlineDepositCents: row.onlineDepositCents ?? 0 });
}

/**
 * El chip «Por cobrar · N · $X» (rótulo `porCobrarLabel`, el mismo de /sala): las filas del día que el viewer cobra y
 * deben, y la suma de lo que falta (centavos).
 */
export function receptionOwedSummary(
  collect: ReceptionCollect | null | undefined,
  rows: ReadonlyArray<BookingDTO>
): { count: number; cents: number } {
  let count = 0;
  let cents = 0;
  for (const r of rows) {
    if (!receptionOwes(collect, r)) continue;
    count += 1;
    cents += receptionOwedCents(r);
  }
  return { count, cents };
}

type OnChanged = (b: BookingDTO, opts?: { stale?: boolean }) => void;
type Warn = (title: string, opts: { description: string }) => void;

/**
 * Lo que la vista le pasa al `CollectModal` para la fila `b`.
 * - `onSaved`: la fila con el cobro aplicado (`withCopagoPaid`). Hace falta porque `setBookingCopagoPaid`
 *   (`toggleBilling`) NO revalida /agenda: sin esto el tag seguía en «Por cobrar» hasta el próximo re-listado.
 * - `onStale`: «El turno cambió en otra sesión» con el mismo copy que las acciones de Recepción, y la fila VIEJA con
 *   `{ stale: true }` para que el padre traiga la vigente (contrato de `onChanged`, cabecera de `ReceptionView`).
 */
export function receptionCollectHandlers(b: BookingDTO, onChanged: OnChanged, warn: Warn) {
  return {
    onSaved: (r: { updatedAt: string; method: PaymentMethod | null }) => onChanged(withCopagoPaid(b, r)),
    onStale: () => {
      warn("El turno cambió en otra sesión", {
        description: `Actualizamos la lista con lo último de ${b.patientName}. Revisalo y reintentá.`,
      });
      onChanged(b, { stale: true });
    },
  };
}
