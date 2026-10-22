import { describe, expect, it } from "vitest";
import {
  MIN_ONLINE_CHARGE_CENTS,
  publicOnlineChargeView,
  publicStatusAmountCents,
  turneroChargeExpiresAt,
  turneroReplayStep,
  type TurneroReplayStep,
} from "@/lib/public-booking-payment";
import type { ChargeStatus } from "@/lib/online-charge-logic";

// TP-0 (H-TP2) y T5 (TP-2c, C-TP8): reglas puras del cobro del turnero (vencimiento, replay, vista pública) y el monto
// de la pantalla de estado del checkout legado. Lo que pasa con el turno y el cobro contra Postgres:
// tests/integration/tp0-turnero-sin-cobro.test.ts y tests/integration/tp2t-turnero-cobro.test.ts.

describe("MIN_ONLINE_CHARGE_CENTS", () => {
  it("[TP-2c] el piso del turnero es el de las reglas de plata ($1)", () => {
    // `decidePublicCheckout`/`isOnlineCheckoutAvailable` (TP-0, cuenta de la plataforma) se borraron en TP-2c: el piso
    // lo decide `decideOnlineCharge` (tests/unit/online-charge-logic.test.ts); el wizard sigue importándolo de acá.
    expect(MIN_ONLINE_CHARGE_CENTS).toBe(100);
  });
});

describe("turneroChargeExpiresAt", () => {
  const createdAt = new Date("2026-10-22T13:00:00.000Z");
  it("[TP-2c] REQUIRED vence al final del hold (alta + 30 min)", () => {
    const at = turneroChargeExpiresAt({ required: true, createdAt, scheduledFor: new Date("2026-10-30T13:00:00.000Z") });
    expect(at.toISOString()).toBe("2026-10-22T13:30:00.000Z");
  });
  it("[TP-2c] OPTIONAL vence a las 48 h o al empezar el turno, lo que llegue antes", () => {
    expect(
      turneroChargeExpiresAt({ required: false, createdAt, scheduledFor: new Date("2026-10-30T13:00:00.000Z") }).toISOString()
    ).toBe("2026-10-24T13:00:00.000Z");
    expect(
      turneroChargeExpiresAt({ required: false, createdAt, scheduledFor: new Date("2026-10-22T15:00:00.000Z") }).toISOString()
    ).toBe("2026-10-22T15:00:00.000Z");
  });
});

describe("turneroReplayStep", () => {
  const ch = (status: ChargeStatus, hasPreference = true, cancelReason: string | null = null) => ({
    status,
    hasPreference,
    cancelReason,
  });
  it("[TP-2c] tabla del replay (misma key)", () => {
    const table: Array<[Parameters<typeof turneroReplayStep>[0], TurneroReplayStep]> = [
      [{ bookingStatus: "CANCELLED", holdAlive: true, charge: ch("ACTIVE") }, "cancelled"],
      // Sin cobro de T5: TP-0 tal cual.
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: null }, "reserved"],
      [{ bookingStatus: "PENDING", holdAlive: true, charge: null }, "promote"],
      // REQUIRED: mismo initPoint; sin preferencia (MP caído) → reintento con el mismo cobro (TP-D29); hold vencido.
      [{ bookingStatus: "PENDING", holdAlive: true, charge: ch("ACTIVE") }, "checkout"],
      [{ bookingStatus: "PENDING", holdAlive: true, charge: ch("ACTIVE", false) }, "open-preference"],
      [{ bookingStatus: "PENDING", holdAlive: false, charge: ch("ACTIVE") }, "hold-expired"],
      [{ bookingStatus: "PENDING", holdAlive: true, charge: ch("AUTHORIZED") }, "payment-in-flight"],
      [{ bookingStatus: "PENDING", holdAlive: false, charge: ch("EXPIRED") }, "hold-expired"],
      [{ bookingStatus: "PENDING", holdAlive: true, charge: ch("CANCELLED", false, "preference_failed") }, "preference-error"],
      [{ bookingStatus: "PENDING", holdAlive: true, charge: ch("PAID") }, "reserved"],
      // OPTIONAL: el turno ya está reservado; el link sigue mientras el cobro está vivo.
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("ACTIVE") }, "checkout"],
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("ACTIVE", false) }, "open-preference"],
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("CANCELLED", false, "preference_failed") }, "reserved-notice"],
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("CANCELLED", true, "collected") }, "reserved"],
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("EXPIRED") }, "reserved"],
      [{ bookingStatus: "CONFIRMED", holdAlive: true, charge: ch("AUTHORIZED") }, "reserved"],
      [{ bookingStatus: "COMPLETED", holdAlive: true, charge: ch("REFUNDED") }, "reserved"],
    ];
    for (const [input, expected] of table) expect(turneroReplayStep(input), JSON.stringify(input)).toBe(expected);
  });
});

describe("publicOnlineChargeView", () => {
  const paid = {
    mpPaymentId: "1234567890",
    approvedAt: new Date("2026-10-21T02:30:00.000Z"), // 20/10 23:30 AR
    paidAmountCents: 8000,
    paymentMethodId: "visa",
    paymentTypeId: "credit_card",
    installments: 1,
    mpStatus: "approved",
    refundedAt: null,
  };
  it("[TP-2c] FULL pendiente: falta todo el monto (nunca $0) y sin comprobante", () => {
    expect(
      publicOnlineChargeView({ kind: "FULL", status: "ACTIVE", amountCents: 8000, copagoCents: 0, onlineDepositCents: 0, receipt: null })
    ).toEqual({ kind: "FULL", status: "ACTIVE", amountCents: 8000, remainingCents: 8000, receipt: null });
  });
  it("[TP-2c] FULL pagado: no falta nada y el comprobante en hora AR", () => {
    expect(
      publicOnlineChargeView({ kind: "FULL", status: "PAID", amountCents: 8000, copagoCents: 0, onlineDepositCents: 0, receipt: paid })
    ).toEqual({
      kind: "FULL",
      status: "PAID",
      amountCents: 8000,
      remainingCents: 0,
      receipt: { operationId: "1234567890", approvedAtLabel: "20/10/2026, 23:30", methodLabel: expect.any(String) },
    });
  });
  it("[TP-2c] seña: falta el copago menos lo señado; el comprobante solo con PAID", () => {
    const pending = publicOnlineChargeView({
      kind: "DEPOSIT",
      status: "ACTIVE",
      amountCents: 2000,
      copagoCents: 8000,
      onlineDepositCents: 0,
      receipt: { ...paid, mpPaymentId: null, approvedAt: null, paidAmountCents: null },
    });
    expect([pending.remainingCents, pending.receipt]).toEqual([8000, null]);
    const done = publicOnlineChargeView({
      kind: "DEPOSIT",
      status: "PAID",
      amountCents: 2000,
      copagoCents: 8000,
      onlineDepositCents: 2000,
      receipt: { ...paid, paidAmountCents: 2000 },
    });
    expect(done.remainingCents).toBe(6000);
    expect(done.receipt?.operationId).toBe("1234567890");
  });
});

describe("publicStatusAmountCents", () => {
  it("[TP-0] status pendiente muestra expectedAmountCents, no $0", () => {
    // Pendiente: `amountCents` vale 0 hasta que el webhook acredita.
    expect(
      publicStatusAmountCents({ priceCents: 8000, payment: { status: "UNPAID", amountCents: 0, expectedAmountCents: 7500 } })
    ).toBe(7500);
    expect(
      publicStatusAmountCents({ priceCents: 8000, payment: { status: "FAILED", amountCents: 0, expectedAmountCents: 7500 } })
    ).toBe(7500);
    // Fila legada sin el ancla: el precio del servicio.
    expect(
      publicStatusAmountCents({ priceCents: 8000, payment: { status: "UNPAID", amountCents: 0, expectedAmountCents: null } })
    ).toBe(8000);
    // Pagado: lo capturado.
    expect(
      publicStatusAmountCents({ priceCents: 8000, payment: { status: "PAID", amountCents: 7500, expectedAmountCents: 7500 } })
    ).toBe(7500);
    // Sin pago online (reservado): el precio del servicio, lo que se paga en el consultorio.
    expect(publicStatusAmountCents({ priceCents: 8000, payment: null })).toBe(8000);
  });
});
