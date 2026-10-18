/**
 * Cobro del copago de un turno: lo puro (T3, C-AS2; plan §23.4). Client-safe, sin DB: lo importan la action
 * (`setBookingCopagoPaid` en `lib/bookings.ts`) y la UI de /sala y del drawer, así el monto que muestra «Marcar
 * pagado · $ 6.000» y lo que valida el server salen de la misma función.
 *
 * Decisión 5 del 19-oct: UN cobro por turno con medio de pago; si hubo seña online (T5), «Pagado» cubre el resto.
 * En T3 no hay señas (el caller pasa `deposits: []` y el restante es el copago entero); T5 enchufa los
 * `Payment.kind = DEPOSIT` de Mercado Pago sin cambiar esta firma.
 */
import type { PaymentMethod } from "@/lib/payment-method";

/** Marcar exige el medio (no hay «pagado» sin saber cómo: decisión 5); desmarcar limpia todo y no lleva medio. */
export type CopagoMarkInput = { paid: true; method: PaymentMethod } | { paid: false };

/**
 * Lo que falta cobrar del copago: `resolvedCopagoCents` menos las señas COBRADAS (`status === "PAID"`), nunca < 0.
 *
 * - Una seña FAILED nunca entró y una REFUNDED se devolvió: restarlas haría que la recepción cobre de menos.
 * - Piso 0: si el copago bajó después de la seña (cambio de cobertura), no hay saldo a favor que cobrar acá.
 * - Un monto de seña negativo o no entero se ignora: es un dato corrupto, y sumarlo AUMENTARÍA lo que se cobra al
 *   paciente; ignorarlo falla del lado de cobrar lo que dice el copago. Plata en centavos `Int` (AGENTS.md §4).
 */
export function copagoRemainingCents({
  resolvedCopagoCents,
  deposits,
}: {
  resolvedCopagoCents: number;
  deposits: { amountCents: number; status: string }[];
}): number {
  let paid = 0;
  for (const d of deposits) {
    if (d.status === "PAID" && Number.isInteger(d.amountCents) && d.amountCents > 0) paid += d.amountCents;
  }
  return Math.max(0, resolvedCopagoCents - paid);
}

/** Copy literal de C-AS2 (lo comparten la action y la UI; no se reescribe en cada lado). */
export const COLLECT_COPY = {
  /** `billing.collectOwn` sobre un turno ajeno. */
  ownOnly: "Solo podés registrar el cobro de tus propios turnos.",
  /** Ni `billing.collect` ni `billing.collectOwn`. */
  roleCannotCollect: "Tu rol no registra cobros.",
  /** Gate «insurer» (`canConfirmInsurer`) sin `billing.manage`. */
  insurerOnly: "Solo Facturación, el titular o el administrador/a confirman pagos de obra social.",
  /** Hay un pago de Mercado Pago de por medio: tocarlo a mano arriesga cobrar dos veces (default del 19-oct). */
  mercadoPagoLocked: "Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.",
  /** Marcar sin medio. */
  methodRequired: "Elegí cómo pagó.",
} as const;
