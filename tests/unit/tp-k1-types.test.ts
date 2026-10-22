/**
 * TP-K1 (T5c): los DTOs de cobros online son contratos congelados. Este test ata los unions de string (client-safe, sin
 * `@prisma/client` en runtime) a los enums de M18 en tipo (`expectTypeOf`, lo chequea `tsc`) y en runtime (los arrays
 * de valores contra los objetos del cliente generado): un valor nuevo en el enum sin tocar los tipos rompe acá y no en
 * un `switch` sin rama en prod. Además fija los schemas zod que espejan los CHECK de M18.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BookingChargeKind as PrismaBookingChargeKind,
  BookingPaymentMode as PrismaBookingPaymentMode,
  MpAccountKind as PrismaMpAccountKind,
  MpAccountStatus as PrismaMpAccountStatus,
  OnlineChargeKind as PrismaOnlineChargeKind,
  OnlineChargeOrigin as PrismaOnlineChargeOrigin,
  OnlineChargeStatus as PrismaOnlineChargeStatus,
} from "@prisma/client";
import {
  CHARGE_KINDS,
  CHARGE_ORIGINS,
  CHARGE_STATUSES,
  MP_ACCOUNT_KINDS,
  MP_ACCOUNT_STATUSES,
  type ChargeKind,
  type ChargeOrigin,
  type ChargeStatus,
  type MpAccountKind,
  type MpAccountStatus,
} from "@/lib/online-payments-types";
import {
  BOOKING_CHARGE_KINDS,
  BOOKING_PAYMENT_MODES,
  DEFAULT_PAYMENT_POLICY,
  PaymentPolicySchema,
  type BookingChargeKind,
  type BookingPaymentMode,
} from "@/lib/booking-payment-policy-types";
import { CreatePaymentLinkSchema, PublicPaymentTokenSchema } from "@/lib/payment-links-types";
import { SubmitSchema } from "@/lib/public-booking-types";
import type { OnlineChargeStatusValue } from "@/lib/online-payments-copy";

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("[TP-K1] unions de T5 = enums de Prisma de M18", () => {
  it("en tipo", () => {
    expectTypeOf<ChargeStatus>().toEqualTypeOf<PrismaOnlineChargeStatus>();
    expectTypeOf<ChargeOrigin>().toEqualTypeOf<PrismaOnlineChargeOrigin>();
    expectTypeOf<ChargeKind>().toEqualTypeOf<PrismaOnlineChargeKind>();
    expectTypeOf<MpAccountKind>().toEqualTypeOf<PrismaMpAccountKind>();
    expectTypeOf<MpAccountStatus>().toEqualTypeOf<PrismaMpAccountStatus>();
    expectTypeOf<BookingPaymentMode>().toEqualTypeOf<PrismaBookingPaymentMode>();
    expectTypeOf<BookingChargeKind>().toEqualTypeOf<PrismaBookingChargeKind>();
    // El vocabulario de TP-P5 declara su propio union de estado: tiene que ser el mismo.
    expectTypeOf<OnlineChargeStatusValue>().toEqualTypeOf<ChargeStatus>();
  });

  it("en runtime", () => {
    expect(sorted(CHARGE_STATUSES)).toEqual(sorted(Object.values(PrismaOnlineChargeStatus)));
    expect(sorted(CHARGE_ORIGINS)).toEqual(sorted(Object.values(PrismaOnlineChargeOrigin)));
    expect(sorted(CHARGE_KINDS)).toEqual(sorted(Object.values(PrismaOnlineChargeKind)));
    expect(sorted(MP_ACCOUNT_KINDS)).toEqual(sorted(Object.values(PrismaMpAccountKind)));
    expect(sorted(MP_ACCOUNT_STATUSES)).toEqual(sorted(Object.values(PrismaMpAccountStatus)));
    expect(sorted(BOOKING_PAYMENT_MODES)).toEqual(sorted(Object.values(PrismaBookingPaymentMode)));
    expect(sorted(BOOKING_CHARGE_KINDS)).toEqual(sorted(Object.values(PrismaBookingChargeKind)));
  });
});

describe("[TP-K1] PaymentPolicySchema espeja los CHECK de BookingPaymentPolicy", () => {
  const base = { ...DEFAULT_PAYMENT_POLICY, mode: "OPTIONAL" as const };

  it("acepta el default y las tres formas válidas", () => {
    expect(PaymentPolicySchema.safeParse(DEFAULT_PAYMENT_POLICY).success).toBe(true);
    expect(PaymentPolicySchema.safeParse(base).success).toBe(true);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 100 }).success).toBe(true);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 100_000_000 }).success).toBe(true);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "PERCENT", percentBps: 1 }).success).toBe(true);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "PERCENT", percentBps: 10_000 }).success).toBe(true);
  });

  it("rechaza montos fuera de rango y campos de otro tipo de cobro", () => {
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 99 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 100_000_001 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: null }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "PERCENT", percentBps: 0 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "PERCENT", percentBps: 10_001 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "COPAGO", fixedCents: 500 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 500, percentBps: 10 }).success).toBe(false);
    expect(PaymentPolicySchema.safeParse({ ...base, chargeKind: "FIXED", fixedCents: 150.5 }).success).toBe(false);
  });

  it("nota: se recorta, vacía = null, más de 280 rechaza", () => {
    const blank = PaymentPolicySchema.safeParse({ ...base, cancellationNote: "   " });
    expect(blank.success && blank.data.cancellationNote).toBe(null);
    const trimmed = PaymentPolicySchema.safeParse({ ...base, cancellationNote: "  Avisá 24 h antes. " });
    expect(trimmed.success && trimmed.data.cancellationNote).toBe("Avisá 24 h antes.");
    expect(PaymentPolicySchema.safeParse({ ...base, cancellationNote: "x".repeat(280) }).success).toBe(true);
    expect(PaymentPolicySchema.safeParse({ ...base, cancellationNote: "x".repeat(281) }).success).toBe(false);
  });
});

describe("[TP-K1] CreatePaymentLinkSchema", () => {
  const ok = {
    patientId: "pat_1",
    bookingId: "bk_1",
    practitionerId: "pr_1",
    purpose: "REST" as const,
    concept: "Turno del mar 21/10 a las 10:00",
    idempotencyKey: "7f0b5a4e-1c1d-4a63-9d0e-6a2f8f4f0c11",
  };

  it("acepta un link con turno y uno libre con monto", () => {
    expect(CreatePaymentLinkSchema.safeParse(ok).success).toBe(true);
    expect(
      CreatePaymentLinkSchema.safeParse({ ...ok, bookingId: undefined, purpose: "FREE", amountCents: 1500_00, expiresInDays: 30 })
        .success
    ).toBe(true);
  });

  it("rechaza lo que el CHECK o el contrato no admiten", () => {
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, purpose: "FREE", amountCents: 100 }).success).toBe(false); // FREE con turno
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, bookingId: undefined }).success).toBe(false); // REST sin turno
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, purpose: "DEPOSIT" }).success).toBe(false); // seña sin monto
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, purpose: "DEPOSIT", amountCents: 99 }).success).toBe(false);
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, purpose: "DEPOSIT", amountCents: 100_000_001 }).success).toBe(false);
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, concept: "  ab  " }).success).toBe(false);
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, concept: "x".repeat(121) }).success).toBe(false);
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, expiresInDays: 10 }).success).toBe(false);
    expect(CreatePaymentLinkSchema.safeParse({ ...ok, idempotencyKey: "short" }).success).toBe(false);
  });

  it("token público: 22 caracteres base64url", () => {
    expect(PublicPaymentTokenSchema.safeParse("abcdefghijklmnopqrstuv").success).toBe(true);
    expect(PublicPaymentTokenSchema.safeParse("abc-_EFGHIJKLMNOPQRS12").success).toBe(true);
    expect(PublicPaymentTokenSchema.safeParse("abcdefghijklmnopqrstu").success).toBe(false);
    expect(PublicPaymentTokenSchema.safeParse("abcdefghijklmnopqrstu=").success).toBe(false);
  });
});

describe("[TP-K1] SubmitSchema lleva payNow opcional (C-TP8)", () => {
  it("payNow: true/false pasan; ausente queda undefined (sin preselección)", () => {
    const shape = SubmitSchema.shape.payNow;
    expect(shape.safeParse(true).success).toBe(true);
    expect(shape.safeParse(false).success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse("true").success).toBe(false);
  });
});
