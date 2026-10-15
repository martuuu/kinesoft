/**
 * [PL-2b] Lógica pura de los cobros (lib/saas-billing-logic.ts). Corre en TZ=UTC (`npm test`) y en TZ=AR
 * (`npm run test:tz-ar`): el anclaje, los períodos y los vencimientos tienen que dar lo mismo en los dos.
 */
import { describe, it, expect } from "vitest";
import {
  addMonthsKey,
  anchorDayFor,
  arMidnight,
  balanceCents,
  billingStartKey,
  chargeAmountFor,
  chargeInitialState,
  checkReceipt,
  dbDateFromKey,
  firstPeriodStartKey,
  isDateKey,
  isOverdue,
  keyFromDbDate,
  nextSubscriptionStatus,
  periodFor,
  periodStartOnOrBefore,
  receiptStorageKey,
  RECEIPT_MAX_BYTES,
  remainingCents,
  sniffReceiptType,
} from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

describe("[PL-2b] anclaje y períodos (fechas civiles AR)", () => {
  it("fin de prueba 23:59 AR del 14-oct → empieza a cobrar el 15 (aunque en UTC ya sea 15)", () => {
    const trialEndsAt = new Date("2026-10-14T23:59:59.999-03:00"); // 02:59 UTC del 15
    expect(billingStartKey({ trialEndsAt, createdAt: new Date("2026-10-01T12:00:00Z") })).toBe("2026-10-15");
  });

  it("alta 22:30 AR del 31-ene (01:30 UTC del 1-feb) sin prueba → empieza el 31-ene, anclaje 28", () => {
    const start = billingStartKey({ trialEndsAt: null, createdAt: new Date("2026-02-01T01:30:00Z") });
    expect(start).toBe("2026-01-31");
    expect(anchorDayFor(start)).toBe(28);
    // 31 > 28: el primer período arranca el 28 SIGUIENTE (días de regalo, nunca superpuesto con la prueba).
    expect(firstPeriodStartKey(start, 28)).toBe("2026-02-28");
  });

  it("tope 28: un anclaje 28 existe en febrero (también bisiesto) y el período siguiente cae 28", () => {
    expect(periodFor("2028-01-28")).toEqual({ periodStart: "2028-01-28", periodEnd: "2028-02-28", dueDate: "2028-02-02" });
    expect(addMonthsKey("2026-12-28", 1)).toBe("2027-01-28");
    expect(addMonthsKey("2026-01-31", 1)).toBe("2026-02-28"); // por si acaso: nunca «3 de marzo»
  });

  it("vencimiento = inicio + 5 días, cruzando mes y año", () => {
    expect(periodFor("2026-12-28").dueDate).toBe("2027-01-02");
    expect(periodFor("2026-10-15")).toEqual({ periodStart: "2026-10-15", periodEnd: "2026-11-15", dueDate: "2026-10-20" });
  });

  it("primer período: mismo mes si el anclaje no pasó; si no, el mes siguiente", () => {
    expect(firstPeriodStartKey("2026-10-15", 15)).toBe("2026-10-15");
    expect(firstPeriodStartKey("2026-10-29", 28)).toBe("2026-11-28");
  });

  it("período vigente de una fecha", () => {
    expect(periodStartOnOrBefore(15, "2026-10-15")).toBe("2026-10-15");
    expect(periodStartOnOrBefore(15, "2026-10-14")).toBe("2026-09-15");
    expect(periodStartOnOrBefore(28, "2027-01-03")).toBe("2026-12-28");
  });

  it("columnas DATE ↔ clave: sin corrimiento de día en ningún TZ del host", () => {
    for (const k of ["2026-01-01", "2026-02-28", "2026-12-31"]) {
      expect(keyFromDbDate(dbDateFromKey(k))).toBe(k);
    }
    // nextChargeAt es TIMESTAMP: medianoche AR, que en AR sigue siendo ese día.
    expect(toARDateKey(arMidnight("2026-11-15"))).toBe("2026-11-15");
  });

  it("isDateKey rechaza fechas que no existen", () => {
    expect(isDateKey("2026-02-28")).toBe(true);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-2-3")).toBe(false);
  });
});

describe("[PL-2b] montos, saldo y vencidos", () => {
  it("precio a medida > precio del plan; null = sin cargo; 0 = cargo pagado", () => {
    expect(chargeAmountFor({ customPriceCents: 500000, planPriceCents: 1500000 })).toBe(500000);
    expect(chargeAmountFor({ customPriceCents: null, planPriceCents: 1500000 })).toBe(1500000);
    expect(chargeAmountFor({ customPriceCents: null, planPriceCents: null })).toBeNull();
    expect(chargeAmountFor({ customPriceCents: 0, planPriceCents: 1500000 })).toBe(0);
    expect(chargeInitialState(0)).toEqual({ status: "PAID", paid: true });
    expect(chargeInitialState(1)).toEqual({ status: "OPEN", paid: false });
  });

  it("saldo: lo que falta de los abiertos menos lo pagado a cuenta", () => {
    const charges = [
      { status: "OPEN" as const, amountCents: 1000, approvedCents: 400, dueDate: "2026-10-20" },
      { status: "PAID" as const, amountCents: 1000, approvedCents: 1000, dueDate: "2026-09-20" },
      { status: "WAIVED" as const, amountCents: 1000, approvedCents: 0, dueDate: "2026-08-20" },
    ];
    expect(remainingCents(charges[0])).toBe(600);
    expect(balanceCents(charges, 0)).toBe(600);
    expect(balanceCents(charges, 1000)).toBe(-400);
  });

  it("vencido: el día del vencimiento todavía está al día; el siguiente, vencido", () => {
    const c = { status: "OPEN" as const, amountCents: 1000, approvedCents: 0, dueDate: "2026-10-20" };
    expect(isOverdue(c, "2026-10-20")).toBe(false);
    expect(isOverdue(c, "2026-10-21")).toBe(true);
    expect(isOverdue({ ...c, approvedCents: 1000 }, "2026-10-21")).toBe(false);
  });
});

describe("[PL-2b] estado de la suscripción", () => {
  const now = new Date("2026-10-21T15:00:00Z");
  it("ACTIVE con vencido → PAST_DUE; PAST_DUE al día → ACTIVE", () => {
    expect(nextSubscriptionStatus({ current: "ACTIVE", trialEndsAt: null, now, hasOverdue: true, hasSettledCharge: false })).toBe("PAST_DUE");
    expect(nextSubscriptionStatus({ current: "PAST_DUE", trialEndsAt: null, now, hasOverdue: false, hasSettledCharge: true })).toBe("ACTIVE");
    expect(nextSubscriptionStatus({ current: "PAST_DUE", trialEndsAt: null, now, hasOverdue: true, hasSettledCharge: false })).toBeNull();
  });
  it("CANCELLED nunca lo toca el cobro", () => {
    expect(nextSubscriptionStatus({ current: "CANCELLED", trialEndsAt: null, now, hasOverdue: true, hasSettledCharge: true })).toBeNull();
  });
  it("prueba: vencida y con un cargo saldado → ACTIVE; en curso o sin pagar → sigue TRIALING", () => {
    const ended = new Date("2026-10-14T23:59:59-03:00");
    const running = new Date("2026-10-30T23:59:59-03:00");
    expect(nextSubscriptionStatus({ current: "TRIALING", trialEndsAt: ended, now, hasOverdue: false, hasSettledCharge: true })).toBe("ACTIVE");
    expect(nextSubscriptionStatus({ current: "TRIALING", trialEndsAt: running, now, hasOverdue: false, hasSettledCharge: true })).toBeNull();
    expect(nextSubscriptionStatus({ current: "TRIALING", trialEndsAt: ended, now, hasOverdue: true, hasSettledCharge: false })).toBeNull();
  });
});

describe("[PL-2b] comprobantes: magic bytes", () => {
  it("reconoce PDF/JPG/PNG/WEBP por los bytes y nada más", () => {
    expect(sniffReceiptType(PDF)).toBe("application/pdf");
    expect(sniffReceiptType(JPG)).toBe("image/jpeg");
    expect(sniffReceiptType(PNG)).toBe("image/png");
    expect(sniffReceiptType(WEBP)).toBe("image/webp");
    expect(sniffReceiptType(EXE)).toBeNull();
    expect(sniffReceiptType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull(); // RIFF AVI
  });
  it("tamaño, tipo declarado y coincidencia con los bytes", () => {
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: 100, head: PDF })).toMatchObject({ ok: true, ext: "pdf" });
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: 0, head: PDF })).toEqual({ ok: false, reason: "empty" });
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: RECEIPT_MAX_BYTES + 1, head: PDF })).toEqual({ ok: false, reason: "too_large" });
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: RECEIPT_MAX_BYTES, head: PDF }).ok).toBe(true);
    expect(checkReceipt({ declaredType: "application/x-msdownload", sizeBytes: 10, head: EXE })).toEqual({ ok: false, reason: "type_not_allowed" });
    // MIME falso: declara PDF y es un ejecutable / un PNG.
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: 10, head: EXE })).toEqual({ ok: false, reason: "type_mismatch" });
    expect(checkReceipt({ declaredType: "application/pdf", sizeBytes: 10, head: PNG })).toEqual({ ok: false, reason: "type_mismatch" });
  });
  it("clave del objeto: <tenantId>/<paymentId>.<ext>", () => {
    expect(receiptStorageKey("t1", "p1", "pdf")).toBe("t1/p1.pdf");
  });
});
