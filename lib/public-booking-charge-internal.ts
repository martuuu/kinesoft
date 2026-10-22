import "server-only";
import type { Prisma } from "@prisma/client";
import type { PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import type { MpAccountKind } from "@/lib/online-payments-types";

/**
 * Cobro online del turnero público (T5, C-TP8 del plan §25.5): contexto, copago y cobro TURNERO. Sin Actor
 * (`prismaService` y `tenantId` a mano, como el resto del turnero).
 *
 * **Stub de TP-K3 (tanda T5c):** firmas congeladas. TP-2c lo implementa:
 *   - `loadPublicChargeContext`: con modo `off` o política OFF no hace más lecturas; cuenta = la del profesional ACTIVE →
 *     la del consultorio con `useClinicAccount`; **nunca la de la plataforma** (H-TP1);
 *   - `resolvePublicCopagoCents`: mismos insumos que `lib/bookings.ts:1917-1937` (paridad con la agenda, AUDIT §5.5); con
 *     contacto distinto → particular (TP-D22);
 *   - el cobro nace EN LA MISMA tx que `booking.create` (`idempotencyKey = turnero:<bookingId>`) y la preferencia se crea
 *     después del commit con CAS (`preferenceId IS NULL AND status = ACTIVE`);
 *   - `releaseOwnExpiredPublicHold` vence su cobro en la misma tx.
 *
 * Hasta entonces el contexto es «sin cobro» (modo off, sin política ni cuenta): el turnero reserva como TP-0. Lo que
 * escribiría tira.
 */

export type PublicChargeContext = {
  connectMode: "off" | "fake" | "sandbox" | "live";
  policy: PaymentPolicyInput | null;
  account: { id: string; kind: MpAccountKind; webhookRef: string } | null;
};

const NOT_IMPLEMENTED = "[TP-K3] lib/public-booking-charge-internal.ts: no implementado (lo implementa TP-2c)";

export async function loadPublicChargeContext(tenantId: string, practitionerId: string): Promise<PublicChargeContext> {
  void tenantId;
  void practitionerId;
  return { connectMode: "off", policy: null, account: null };
}

export async function resolvePublicCopagoCents(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; patientId: string; servicePriceCents: number; contactMismatch: boolean }
): Promise<number> {
  void tx;
  void o;
  throw new Error(NOT_IMPLEMENTED);
}

export async function createTurneroChargeInTx(
  tx: Prisma.TransactionClient,
  o: {
    tenantId: string;
    bookingId: string;
    patientId: string;
    practitionerId: string;
    mpAccountId: string;
    kind: "FULL" | "DEPOSIT";
    amountCents: number;
    copagoBasisCents: number | null;
    expiresAt: Date;
  }
): Promise<{ chargeId: string }> {
  void tx;
  void o;
  throw new Error(NOT_IMPLEMENTED);
}

export async function openTurneroPreference(o: {
  tenantId: string;
  chargeId: string;
}): Promise<{ ok: true; initPoint: string } | { ok: false; error: "preference_failed" }> {
  void o;
  return { ok: false, error: "preference_failed" };
}

export async function expireOwnHoldChargeInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string }
): Promise<{ expired: boolean }> {
  void tx;
  void o;
  return { expired: false };
}
