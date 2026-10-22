/**
 * [TP-P5] Vista pura del comprobante de Mercado Pago (`lib/mp-receipt.ts`, TP-D20 / TP-UI-D11).
 *
 * Por qué importa la TZ: el comprobante se arma en el server (Vercel corre en UTC) y en el cliente (el navegador del
 * consultorio, en AR). Un pago aprobado a las 23:30 AR es 02:30 UTC del día SIGUIENTE: con `toISOString().slice(0, 10)`
 * o `getDate()` del host, el comprobante del drawer diría «21/10» para un pago del 20/10 (lo mismo que motivó
 * `lib/datetime-ar.ts`). Esta suite se corre con `TZ=UTC` (`npm test`) y con `TZ=America/Argentina/Buenos_Aires`: los
 * literales esperados no cambian entre las dos.
 */
import { describe, expect, it } from "vitest";
import {
  buildMpReceipt,
  chargeReceiptOf,
  formatArDateTime,
  mpInstallmentsLabel,
  mpMethodLabel,
  mpReceiptSummary,
  mpStatusLabel,
  type MpReceiptInput,
} from "@/lib/mp-receipt";
import { formatARS } from "@/lib/format";

const BASE: MpReceiptInput = {
  mpPaymentId: "1234567890",
  // 23:30 AR del 20/10 = 02:30 UTC del 21/10.
  approvedAt: "2026-10-21T02:30:00.000Z",
  paidAmountCents: 600_000,
  paymentMethodId: "visa",
  paymentTypeId: "credit_card",
  installments: 3,
  mpStatus: "approved",
  refundedAt: null,
};

describe("[TP-P5] comprobante: fecha y hora AR en cualquier TZ del host", () => {
  it("23:30 AR → mismo día (no salta al 21 en un host UTC)", () => {
    expect(formatArDateTime("2026-10-21T02:30:00.000Z")).toBe("20/10/2026, 23:30");
    const r = buildMpReceipt(BASE);
    expect(r?.approvedAtLabel).toBe("20/10/2026, 23:30");
  });

  it("medianoche AR sale 00:00 (no 24:00) y del día nuevo", () => {
    expect(formatArDateTime(new Date("2026-10-21T03:00:00.000Z"))).toBe("21/10/2026, 00:00");
  });

  it("fecha inválida o vacía → cadena vacía (nunca «Invalid Date»)", () => {
    expect(formatArDateTime("no-es-fecha")).toBe("");
    expect(formatArDateTime(null)).toBe("");
  });
});

describe("[TP-P5] comprobante: filas y etiquetas", () => {
  it("arma N° de operación, fecha, monto con formatARS, medio, cuotas y estado", () => {
    const r = buildMpReceipt(BASE)!;
    expect(r.operationId).toBe("1234567890");
    expect(r.approvedAt).toBe("2026-10-21T02:30:00.000Z");
    expect(r.paidAmountCents).toBe(600_000);
    expect(r.amountLabel).toBe(formatARS(600_000));
    expect(r.methodLabel).toBe("Tarjeta de crédito Visa");
    expect(r.installmentsLabel).toBe("3 cuotas");
    expect(r.statusLabel).toBe("Aprobado");
    expect(r.refundedAt).toBeNull();
    expect(r.rows.map((x) => x.key)).toEqual(["operation", "date", "amount", "method", "installments", "status"]);
    expect(r.rows.map((x) => x.label)).toEqual([
      "N° de operación",
      "Fecha",
      "Monto",
      "Medio de pago",
      "Cuotas",
      "Estado",
    ]);
    expect(r.rows[1].value).toBe("20/10/2026, 23:30");
  });

  it("con la cuenta que cobró suma «Acreditado en» (7 filas)", () => {
    const own = buildMpReceipt({ ...BASE, account: { kind: "PRACTITIONER", practitionerName: "Ana Pérez" } })!;
    expect(own.rows).toHaveLength(7);
    expect(own.rows[6]).toEqual({ key: "account", label: "Acreditado en", value: "Mercado Pago de Ana Pérez" });
    const clinic = buildMpReceipt({ ...BASE, account: { kind: "CLINIC" } })!;
    expect(clinic.rows[6].value).toBe("Mercado Pago del consultorio");
  });

  it("reintegrado: estado «Reintegrado» y fila con la fecha AR del reintegro", () => {
    const r = buildMpReceipt({ ...BASE, mpStatus: "refunded", refundedAt: new Date("2026-10-22T02:59:00.000Z") })!;
    expect(r.statusLabel).toBe("Reintegrado");
    expect(r.refundedAt).toBe("2026-10-22T02:59:00.000Z");
    expect(r.refundedAtLabel).toBe("21/10/2026, 23:59");
    expect(r.rows.at(-1)).toEqual({ key: "refunded", label: "Reintegrado el", value: "21/10/2026, 23:59" });
  });

  it("sin comprobante (no pagado, id inválido o fecha rota) → null", () => {
    expect(buildMpReceipt({ ...BASE, mpPaymentId: null })).toBeNull();
    expect(buildMpReceipt({ ...BASE, mpPaymentId: "abc" })).toBeNull();
    expect(buildMpReceipt({ ...BASE, approvedAt: null })).toBeNull();
    expect(buildMpReceipt({ ...BASE, approvedAt: "x" })).toBeNull();
    expect(buildMpReceipt({ ...BASE, paidAmountCents: null })).toBeNull();
  });

  it("medio: tipo + marca conocida; desconocidos caen a algo legible, nunca al id crudo", () => {
    expect(mpMethodLabel("debit_card", "debvisa")).toBe("Tarjeta de débito Visa");
    expect(mpMethodLabel("credit_card", "master")).toBe("Tarjeta de crédito Mastercard");
    expect(mpMethodLabel("credit_card", "marca_rara")).toBe("Tarjeta de crédito");
    expect(mpMethodLabel("account_money", "account_money")).toBe("Dinero en cuenta de Mercado Pago");
    expect(mpMethodLabel("ticket", "rapipago")).toBe("Efectivo");
    expect(mpMethodLabel(null, null)).toBe("Mercado Pago");
    expect(mpMethodLabel("algo_nuevo", "xyz")).toBe("Mercado Pago");
  });

  it("cuotas y estado de MP", () => {
    expect(mpInstallmentsLabel(1)).toBe("En un pago");
    expect(mpInstallmentsLabel(null)).toBe("En un pago");
    expect(mpInstallmentsLabel(12)).toBe("12 cuotas");
    expect(mpStatusLabel("charged_back")).toBe("Contracargo");
    expect(mpStatusLabel("in_mediation")).toBe("En disputa");
    expect(mpStatusLabel(null)).toBe("Sin informar");
    expect(mpStatusLabel("otro")).toBe("Sin informar");
  });

  it("formas derivadas para los DTO de C-TP8/C-TP9 (resumen público y OnlineChargeView.receipt)", () => {
    const r = buildMpReceipt(BASE)!;
    expect(mpReceiptSummary(r)).toEqual({
      operationId: "1234567890",
      approvedAtLabel: "20/10/2026, 23:30",
      methodLabel: "Tarjeta de crédito Visa",
    });
    expect(chargeReceiptOf(r)).toEqual({
      operationId: "1234567890",
      approvedAt: "2026-10-21T02:30:00.000Z",
      approvedAtLabel: "20/10/2026, 23:30",
      paidAmountCents: 600_000,
      methodLabel: "Tarjeta de crédito Visa",
      statusLabel: "Aprobado",
      refundedAt: null,
    });
  });
});
