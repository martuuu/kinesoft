/**
 * [TP-2h] Lógica pura de las lecturas de cobros online (lib/online-charges-view.ts): DTO, avisos, cursor y período.
 * Corre en TZ=UTC y TZ=AR (el mes del filtro y el comprobante son de Argentina, cualquiera sea el host).
 */
import { describe, it, expect } from "vitest";
import {
  chargeFlagsOf,
  chargeNoticesOf,
  chargePeriodRange,
  chargeViewOf,
  decodeChargesCursor,
  duplicatePaidIds,
  encodeChargesCursor,
  isChargePeriod,
  paymentLinkUrl,
  type OnlineChargeRow,
} from "@/lib/online-charges-view";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"; // 22

function row(over: Partial<OnlineChargeRow> = {}): OnlineChargeRow {
  return {
    id: "c1",
    origin: "LINK",
    kind: "FULL",
    status: "ACTIVE",
    practitionerId: "p1",
    bookingId: "b1",
    amountCents: 10_000_00,
    concept: "Sesión",
    publicToken: TOKEN,
    createdAt: new Date("2026-10-20T13:00:00.000Z"),
    expiresAt: new Date("2026-10-27T13:00:00.000Z"),
    mpPaymentId: null,
    mpStatus: null,
    mpStatusDetail: null,
    paymentMethodId: null,
    paymentTypeId: null,
    installments: null,
    paidAmountCents: null,
    approvedAt: null,
    refundedAt: null,
    cancelledAt: null,
    accountKind: "PRACTITIONER",
    practitionerName: "Ana Kine",
    flags: { duplicate: false, amountMismatch: false },
    ...over,
  };
}

const paid = (over: Partial<OnlineChargeRow> = {}) =>
  row({
    status: "PAID",
    mpPaymentId: "123456789",
    mpStatus: "approved",
    mpStatusDetail: "accredited",
    paymentMethodId: "master",
    paymentTypeId: "credit_card",
    installments: 6,
    paidAmountCents: 10_000_00,
    approvedAt: new Date("2026-10-21T02:30:00.000Z"),
    ...over,
  });

describe("[TP-2h] chargeViewOf", () => {
  it("link vivo: URL /pagar con anular y reenviar solo para quien cobra", () => {
    const v = chargeViewOf(row(), { appUrl: "https://app.test/", canManage: true });
    expect(v.link).toEqual({ url: `https://app.test/pagar/${TOKEN}`, canCancel: true, canResend: true });
    expect(v.statusLabel).toBe("Pendiente de pago");
    expect(v.receipt).toBeNull();
    expect(chargeViewOf(row(), { appUrl: "https://app.test", canManage: false }).link).toBeNull();
  });

  it("pagado: comprobante con labels AR y los datos crudos de las 7 filas; nunca el token suelto", () => {
    const v = chargeViewOf(paid(), { appUrl: "https://app.test", canManage: true });
    expect(v.receipt).toEqual({
      operationId: "123456789",
      approvedAt: "2026-10-21T02:30:00.000Z",
      approvedAtLabel: "20/10/2026, 23:30",
      paidAmountCents: 10_000_00,
      methodLabel: "Tarjeta de crédito Mastercard",
      statusLabel: "Aprobado",
      refundedAt: null,
      paymentMethodId: "master",
      paymentTypeId: "credit_card",
      installments: 6,
      mpStatus: "approved",
      account: { kind: "PRACTITIONER", practitionerName: "Ana Kine" },
    });
    expect(v.link).toMatchObject({ canCancel: false, canResend: false });
    const json = JSON.stringify(v);
    expect(json).not.toContain(`"${TOKEN}"`);
    expect(json).not.toMatch(/publicToken|rawPayload|idempotency/);
  });

  it("cuenta del consultorio: «Acreditado en» sin nombre; turnero sin concepto ni link", () => {
    const v = chargeViewOf(paid({ origin: "TURNERO", publicToken: null, concept: null, accountKind: "CLINIC" }), {
      appUrl: "https://app.test",
      canManage: true,
    });
    expect(v.receipt?.account).toEqual({ kind: "CLINIC", practitionerName: null });
    expect(v.link).toBeNull();
    expect(v.concept).toBeNull();
  });

  it("un comprobante roto (sin número de MP válido) no se muestra", () => {
    expect(chargeViewOf(paid({ mpPaymentId: "abc" }), { appUrl: "https://app.test", canManage: true }).receipt).toBeNull();
  });
});

describe("[TP-2h] avisos", () => {
  it("pago tardío, monto distinto (>5 centavos), reintegro parcial, disputa y duplicado", () => {
    expect(chargeNoticesOf(paid({ cancelledAt: new Date() }))).toEqual(["late-after-cancel"]);
    expect(chargeNoticesOf(paid({ paidAmountCents: 10_000_05 }))).toEqual([]);
    expect(chargeNoticesOf(paid({ paidAmountCents: 10_000_06 }))).toEqual(["amount-mismatch"]);
    expect(chargeNoticesOf(paid({ mpStatusDetail: "partially_refunded" }))).toEqual(["partial-refund"]);
    expect(chargeNoticesOf(paid({ mpStatus: "charged_back", status: "REFUNDED", refundedAt: new Date() }))).toEqual(["disputed"]);
    expect(chargeNoticesOf(paid(), { siblingPaid: true })).toEqual(["duplicate"]);
    expect(chargeNoticesOf(row({ flags: { duplicate: true, amountMismatch: true } }))).toEqual(["duplicate", "amount-mismatch"]);
    expect(chargeNoticesOf(row())).toEqual([]);
  });

  it("chargeFlagsOf solo reconoce dos banderas booleanas del rawPayload", () => {
    expect(chargeFlagsOf({ flags: { duplicate: true, amountMismatch: true, payer: "x" } })).toEqual({ duplicate: true, amountMismatch: true });
    expect(chargeFlagsOf({ flags: { duplicate: "true" } })).toEqual({ duplicate: false, amountMismatch: false });
    expect(chargeFlagsOf(null)).toEqual({ duplicate: false, amountMismatch: false });
    expect(chargeFlagsOf([1, 2])).toEqual({ duplicate: false, amountMismatch: false });
  });

  it("duplicatePaidIds: el segundo FULL pagado del mismo turno (por aprobación) es el duplicado", () => {
    const a = paid({ id: "a", approvedAt: new Date("2026-10-21T10:00:00Z") });
    const b = paid({ id: "b", approvedAt: new Date("2026-10-21T09:00:00Z") });
    const dep = paid({ id: "d", kind: "DEPOSIT" });
    const other = paid({ id: "o", bookingId: "b2" });
    expect([...duplicatePaidIds([a, b, dep, other])]).toEqual(["a"]);
  });
});

describe("[TP-2h] cursor y período de /cobros", () => {
  it("cursor ida y vuelta; basura → null", () => {
    const c = encodeChargesCursor({ createdAt: new Date("2026-10-20T13:00:00.123Z"), id: "cm123abc" });
    expect(decodeChargesCursor(c)).toEqual({ createdAt: new Date("2026-10-20T13:00:00.123Z"), id: "cm123abc" });
    expect(decodeChargesCursor("no-es-un-cursor")).toBeNull();
    expect(decodeChargesCursor(Buffer.from("2026-10-20|x' OR 1=1").toString("base64url"))).toBeNull();
  });

  it("período: relativo y mes calendario de Argentina (con el cambio de año)", () => {
    expect(isChargePeriod("30d")).toBe(true);
    expect(isChargePeriod("2026-13")).toBe(false);
    expect(isChargePeriod("todo")).toBe(false);
    const now = new Date("2026-10-22T12:00:00.000Z");
    expect(chargePeriodRange("7d", now)).toEqual({ from: new Date("2026-10-15T12:00:00.000Z"), to: null });
    expect(chargePeriodRange("2026-10", now)).toEqual({
      from: new Date("2026-10-01T03:00:00.000Z"),
      to: new Date("2026-11-01T03:00:00.000Z"),
    });
    expect(chargePeriodRange("2026-12", now).to).toEqual(new Date("2027-01-01T03:00:00.000Z"));
  });

  it("paymentLinkUrl: solo con un token de 22 caracteres", () => {
    expect(paymentLinkUrl("https://app.test///", TOKEN)).toBe(`https://app.test/pagar/${TOKEN}`);
    expect(paymentLinkUrl("https://app.test", "corto")).toBeNull();
    expect(paymentLinkUrl("https://app.test", null)).toBeNull();
  });
});
