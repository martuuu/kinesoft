/**
 * [MPS-1a] Lógica pura de la suscripción con Mercado Pago (C-MPS2, plan §26.6 y la enmienda §22.6: cobro el día 4).
 * `lib/saas-billing-logic.ts` (ancla 4, proporcionales, cambios de plan, baja, composición del cargo) y
 * `lib/saas-mp-logic.ts` (monto del débito, `start_date` del preapproval, referencias, estados de MP, redacción).
 *
 * Corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`): todos los casos tienen que dar lo mismo en los dos,
 * porque Vercel corre en UTC y la máquina de Martin en AR. Los instantes de borde (02:59:59Z del 4 = 23:59:59 AR del 3)
 * son los que delatan un `getDate()` del host.
 */
import { describe, it, expect } from "vitest";
import {
  anchorDayFor,
  cancelEffectiveOnFor,
  CHARGE_DUE_DAYS,
  composeCharge,
  effectiveCustomPrice,
  firstPeriodStartKey,
  isOverdue,
  nextAnchorKey,
  nextSubscriptionStatus,
  periodFor,
  planChangeKind,
  PLAN_ORDER,
  prorate,
  SAAS_ANCHOR_DAY,
  stubFor,
} from "@/lib/saas-billing-logic";
import {
  debitStartInstant,
  desiredDebit,
  mapMpPaymentStatus,
  MP_MIN_DEBIT_CENTS,
  nextSaasPaymentStatus,
  parseSaasExternalReference,
  periodStartForDebit,
  redactMpSaas,
  saasExternalReference,
} from "@/lib/saas-mp-logic";
import { toARDateKey } from "@/lib/datetime-ar";

describe("[MPS-1a] ancla en el día 4 (MPS-D7)", () => {
  it("[MPS-1a] SAAS_ANCHOR_DAY = 4 y anchorDayFor devuelve 4 para cualquier inicio", () => {
    expect(SAAS_ANCHOR_DAY).toBe(4);
    for (const k of ["2026-10-01", "2026-10-04", "2026-10-15", "2026-01-31", "2028-02-29"]) expect(anchorDayFor(k)).toBe(4);
  });

  it("[MPS-1a] 2026-11-04T02:59:59Z sigue siendo el 3; 03:00Z ya es el 4", () => {
    const before = new Date("2026-11-04T02:59:59Z");
    const at = new Date("2026-11-04T03:00:00Z");
    expect(toARDateKey(before)).toBe("2026-11-03");
    expect(toARDateKey(at)).toBe("2026-11-04");
    // El próximo 4 ESTRICTAMENTE posterior: el 3 a la noche todavía es «mañana»; el 4 ya es el mes que viene.
    expect(nextAnchorKey(before)).toBe("2026-11-04");
    expect(nextAnchorKey(at)).toBe("2026-12-04");
    expect(nextAnchorKey("2026-11-03")).toBe("2026-11-04");
    expect(nextAnchorKey("2026-11-04")).toBe("2026-12-04");
  });

  it("[MPS-1a] vence el 9; vencido recién el 10", () => {
    expect(CHARGE_DUE_DAYS).toBe(5);
    const p = periodFor("2026-11-04");
    expect(p).toEqual({ periodStart: "2026-11-04", periodEnd: "2026-12-04", dueDate: "2026-11-09" });
    const c = { status: "OPEN" as const, amountCents: 1000, approvedCents: 0, dueDate: p.dueDate };
    expect(isOverdue(c, "2026-11-09")).toBe(false);
    expect(isOverdue(c, "2026-11-10")).toBe(true);
    const base = { current: "ACTIVE" as const, trialEndsAt: null, hasSettledCharge: false };
    expect(nextSubscriptionStatus({ ...base, now: new Date("2026-11-09T23:59:59-03:00"), hasOverdue: isOverdue(c, "2026-11-09") })).toBeNull();
    expect(nextSubscriptionStatus({ ...base, now: new Date("2026-11-10T00:00:00-03:00"), hasOverdue: isOverdue(c, "2026-11-10") })).toBe("PAST_DUE");
  });

  it("[MPS-1a] febrero (28 días) y diciembre → enero", () => {
    expect(periodFor("2027-02-04")).toEqual({ periodStart: "2027-02-04", periodEnd: "2027-03-04", dueDate: "2027-02-09" });
    expect(periodFor("2026-12-04")).toEqual({ periodStart: "2026-12-04", periodEnd: "2027-01-04", dueDate: "2026-12-09" });
    expect(nextAnchorKey("2026-12-05")).toBe("2027-01-04");
    expect(nextAnchorKey("2026-12-31")).toBe("2027-01-04");
    expect(firstPeriodStartKey("2026-12-05", anchorDayFor("2026-12-05"))).toBe("2027-01-04");
    expect(firstPeriodStartKey("2026-11-04", 4)).toBe("2026-11-04");
  });
});

describe("[MPS-1a] PLAN_ORDER y precio a medida (MPS-D14)", () => {
  it("[MPS-1a] PLAN_ORDER es el de tenant-modules (una sola fuente)", () => {
    expect(PLAN_ORDER).toEqual(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
  });

  it("[MPS-1a] el precio a medida vale solo para su plan; NULL plan con precio = legado (cualquier plan)", () => {
    expect(effectiveCustomPrice({ customPriceCents: 500000, customPricePlan: "CONSULTORIO", plan: "CONSULTORIO" })).toBe(500000);
    expect(effectiveCustomPrice({ customPriceCents: 500000, customPricePlan: "CONSULTORIO", plan: "CLINICA" })).toBeNull();
    expect(effectiveCustomPrice({ customPriceCents: 500000, customPricePlan: null, plan: "CLINICA" })).toBe(500000);
    expect(effectiveCustomPrice({ customPriceCents: 0, customPricePlan: "INDIVIDUAL", plan: "INDIVIDUAL" })).toBe(0);
    expect(effectiveCustomPrice({ customPriceCents: null, customPricePlan: "INDIVIDUAL", plan: "INDIVIDUAL" })).toBeNull();
  });
});

describe("[MPS-1a] proporcional de la subida (días AR, half-up)", () => {
  // Noviembre: 4/11 → 4/12 = 30 días (par, para poder probar el .5 exacto).
  const nov = { periodStart: "2026-11-04", periodEnd: "2026-12-04" };

  it("[MPS-1a] días desde la subida (inclusive) hasta el fin (exclusivo), sobre los días del período", () => {
    expect(prorate({ diffCents: 300000, fromKey: "2026-11-19", ...nov })).toEqual({ amountCents: 150000, days: 15, periodDays: 30 });
    expect(prorate({ diffCents: 300000, fromKey: "2026-11-04", ...nov })).toEqual({ amountCents: 300000, days: 30, periodDays: 30 });
    expect(prorate({ diffCents: 300000, fromKey: "2026-12-03", ...nov })).toEqual({ amountCents: 10000, days: 1, periodDays: 30 });
  });

  it("[MPS-1a] half-up entero: .5 sube (no redondeo bancario), por debajo baja", () => {
    expect(prorate({ diffCents: 1, fromKey: "2026-11-19", ...nov })?.amountCents).toBe(1); // 0,5 → 1
    expect(prorate({ diffCents: 5, fromKey: "2026-11-19", ...nov })?.amountCents).toBe(3); // 2,5 → 3 (bancario: 2)
    expect(prorate({ diffCents: 3, fromKey: "2026-11-19", ...nov })?.amountCents).toBe(2); // 1,5 → 2
    expect(prorate({ diffCents: 7, fromKey: "2026-11-21", ...nov })?.amountCents).toBe(3); // 7·13/30 = 3,03 → 3
  });

  it("[MPS-1a] ≤ 0 → null (sin diferencia, bajada, fuera del período o redondea a 0)", () => {
    expect(prorate({ diffCents: 0, fromKey: "2026-11-19", ...nov })).toBeNull();
    expect(prorate({ diffCents: -1000, fromKey: "2026-11-19", ...nov })).toBeNull();
    expect(prorate({ diffCents: 1000, fromKey: "2026-12-04", ...nov })).toBeNull();
    expect(prorate({ diffCents: 1, fromKey: "2026-11-20", ...nov })).toBeNull(); // 14/30 = 0,47 → 0
  });

  it("[MPS-1a] febrero de 28 días", () => {
    expect(prorate({ diffCents: 280000, fromKey: "2027-02-25", periodStart: "2027-02-04", periodEnd: "2027-03-04" })).toEqual({
      amountCents: 70000,
      days: 7,
      periodDays: 28,
    });
  });
});

describe("[MPS-1a] proporcional del primer período (stub)", () => {
  it("[MPS-1a] stub 21/10–4/11 = 14/31", () => {
    expect(stubFor({ billableFrom: "2026-10-21", periodStart: "2026-11-04", priceCents: 1500000 })).toEqual({
      amountCents: 677419, // 1.500.000 · 14 / 31 = 677.419,35
      days: 14,
      periodDays: 31,
      effectiveOn: "2026-10-21",
      idempotencyKey: "stub:2026-10-21",
    });
  });

  it("[MPS-1a] arranca justo el 4 → sin stub; un día antes → 1 día", () => {
    expect(stubFor({ billableFrom: "2026-11-04", periodStart: "2026-11-04", priceCents: 1500000 })).toBeNull();
    expect(stubFor({ billableFrom: "2026-11-03", periodStart: "2026-11-04", priceCents: 3100000 })).toMatchObject({
      amountCents: 100000,
      days: 1,
      periodDays: 31,
    });
  });

  it("[MPS-1a] febrero y diciembre → enero", () => {
    expect(stubFor({ billableFrom: "2027-02-20", periodStart: "2027-03-04", priceCents: 2800000 })).toMatchObject({
      amountCents: 1200000,
      days: 12,
      periodDays: 28,
    });
    expect(stubFor({ billableFrom: "2026-12-20", periodStart: "2027-01-04", priceCents: 3100000 })).toMatchObject({
      days: 15,
      periodDays: 31,
      amountCents: 1500000,
    });
  });

  it("[MPS-1a] sin precio, precio 0 o período mal anclado → null", () => {
    expect(stubFor({ billableFrom: "2026-10-21", periodStart: "2026-11-04", priceCents: null })).toBeNull();
    expect(stubFor({ billableFrom: "2026-10-21", periodStart: "2026-11-04", priceCents: 0 })).toBeNull();
    expect(stubFor({ billableFrom: "2026-11-10", periodStart: "2026-11-04", priceCents: 1000 })).toBeNull();
  });
});

describe("[MPS-1a] tipo de cambio de plan (MPS-D11, D18)", () => {
  const base = { subscriptionStatus: "ACTIVE" as const, cancelAtPeriodEnd: false, hasPeriodCharge: true, diffCents: 500000 };

  it("[MPS-1a] matriz", () => {
    // Subida con cargo del período → proporcional; sin cargo, en prueba o sin diferencia → inmediata sin proporcional.
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "CONSULTORIO" })).toBe("upgrade_prorated");
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "CLINICA", subscriptionStatus: "PAST_DUE" })).toBe("upgrade_prorated");
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "CONSULTORIO", hasPeriodCharge: false })).toBe("immediate");
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "CONSULTORIO", subscriptionStatus: "TRIALING" })).toBe("immediate");
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "CONSULTORIO", diffCents: 0 })).toBe("immediate");
    expect(planChangeKind({ ...base, from: "INDIVIDUAL", to: "LIBRE", diffCents: null })).toBe("immediate");
    // Bajada: programada al próximo período; en prueba (o sin cargos) rige ya.
    expect(planChangeKind({ ...base, from: "CLINICA", to: "INDIVIDUAL" })).toBe("scheduled_downgrade");
    expect(planChangeKind({ ...base, from: "CONSULTORIO", to: "INDIVIDUAL", subscriptionStatus: "PAST_DUE" })).toBe("scheduled_downgrade");
    expect(planChangeKind({ ...base, from: "CLINICA", to: "INDIVIDUAL", subscriptionStatus: "TRIALING" })).toBe("immediate");
    expect(planChangeKind({ ...base, from: "CLINICA", to: "INDIVIDUAL", hasPeriodCharge: false })).toBe("immediate");
    // Mismo plan: no-op inmediato.
    expect(planChangeKind({ ...base, from: "CONSULTORIO", to: "CONSULTORIO" })).toBe("immediate");
    // Baja pendiente (o cancelado): sin cambio de plan.
    for (const [from, to] of [["INDIVIDUAL", "CLINICA"], ["CLINICA", "INDIVIDUAL"]] as const) {
      expect(planChangeKind({ ...base, from, to, cancelAtPeriodEnd: true })).toBe("blocked_cancel_pending");
      expect(planChangeKind({ ...base, from, to, subscriptionStatus: "CANCELLED" })).toBe("blocked_cancel_pending");
    }
  });
});

describe("[MPS-1a] fecha efectiva de la baja (MPS-D6, D18)", () => {
  it("[MPS-1a] activa: el fin del período (el próximo cobro, siempre después de hoy)", () => {
    const p = { subscriptionStatus: "ACTIVE" as const, trialEndsAt: null };
    expect(cancelEffectiveOnFor({ ...p, today: "2026-11-20", nextChargeKey: "2026-12-04" })).toBe("2026-12-04");
    expect(cancelEffectiveOnFor({ ...p, today: "2026-11-20", nextChargeKey: null })).toBe("2026-12-04");
    // El 4 antes de que el cron mueva nextChargeAt: no puede ser hoy.
    expect(cancelEffectiveOnFor({ ...p, today: "2026-12-04", nextChargeKey: "2026-12-04" })).toBe("2027-01-04");
    expect(cancelEffectiveOnFor({ ...p, today: new Date("2026-11-04T02:59:59Z"), nextChargeKey: null })).toBe("2026-11-04");
  });

  it("[MPS-1a] en prueba: el día siguiente al fin de la prueba (MPS-D18)", () => {
    const trialEndsAt = new Date("2026-10-30T23:59:59.999-03:00"); // 02:59 UTC del 31
    expect(cancelEffectiveOnFor({ subscriptionStatus: "TRIALING", trialEndsAt, today: "2026-10-22", nextChargeKey: "2026-11-04" })).toBe(
      "2026-10-31",
    );
    // Prueba vencida y todavía TRIALING (sin pagar): nunca hoy ni antes, mañana.
    expect(
      cancelEffectiveOnFor({ subscriptionStatus: "TRIALING", trialEndsAt: new Date("2026-10-10T23:59:59-03:00"), today: "2026-10-22", nextChargeKey: null }),
    ).toBe("2026-10-23");
  });
});

describe("[MPS-1a] composeCharge: nunca < 0; el CREDIT que cruza 0 → CARRYOVER(+) + CREDIT nuevo(−)", () => {
  it("[MPS-1a] base + proporcional + débito", () => {
    const r = composeCharge({
      baseCents: 1500000,
      pending: [
        { id: "p1", kind: "PRORATION", amountCents: 677419 },
        { id: "d1", kind: "DEBIT", amountCents: 1000 },
      ],
    });
    expect(r).toEqual({
      baseCents: 1500000,
      adjustmentsCents: 678419,
      amountCents: 2178419,
      appliedIds: ["p1", "d1"],
      carryover: null,
      remainingCredit: null,
      leftPendingIds: [],
    });
  });

  it("[MPS-1a] crédito que entra entero", () => {
    const r = composeCharge({ baseCents: 1500000, pending: [{ id: "c1", kind: "CREDIT", amountCents: -500000 }] });
    expect(r).toMatchObject({ amountCents: 1000000, adjustmentsCents: -500000, appliedIds: ["c1"], carryover: null, remainingCredit: null });
  });

  it("[MPS-1a] crédito que cruza 0: se imputa entero, CARRYOVER(+) neutraliza el sobrante y un CREDIT(−) nuevo lo lleva", () => {
    const r = composeCharge({
      baseCents: 1000000,
      pending: [
        { id: "c1", kind: "CREDIT", amountCents: -1500000 },
        { id: "p1", kind: "PRORATION", amountCents: 300000 },
        { id: "c2", kind: "CREDIT", amountCents: -100000 },
      ],
    });
    // Positivos primero (1.300.000), después c1 (−1.500.000) cruza: sobran 200.000 → CARRYOVER +200.000 en este cargo
    // y CREDIT −200.000 pendiente (splitFrom c1). c2 ya no hace falta: queda pendiente para el próximo.
    expect(r).toEqual({
      baseCents: 1000000,
      adjustmentsCents: -1000000,
      amountCents: 0,
      appliedIds: ["p1", "c1"],
      carryover: { amountCents: 200000, splitFromId: "c1" },
      remainingCredit: { amountCents: -200000, splitFromId: "c1" },
      leftPendingIds: ["c2"],
    });
    expect(r.baseCents + r.adjustmentsCents).toBe(r.amountCents); // SaasCharge_breakdown_check
  });

  it("[MPS-1a] crédito exacto → 0 sin carryover; base 0 → los créditos esperan", () => {
    expect(composeCharge({ baseCents: 1000, pending: [{ id: "c1", kind: "CREDIT", amountCents: -1000 }] })).toMatchObject({
      amountCents: 0,
      appliedIds: ["c1"],
      carryover: null,
      remainingCredit: null,
    });
    expect(composeCharge({ baseCents: 0, pending: [{ id: "c1", kind: "CREDIT", amountCents: -1000 }] })).toMatchObject({
      amountCents: 0,
      appliedIds: [],
      leftPendingIds: ["c1"],
    });
  });

  it("[MPS-1a] signos inválidos (los mismos que SaasAdjustment_sign_check) tiran", () => {
    expect(() => composeCharge({ baseCents: 1000, pending: [{ id: "x", kind: "CREDIT", amountCents: 100 }] })).toThrow();
    expect(() => composeCharge({ baseCents: 1000, pending: [{ id: "x", kind: "DEBIT", amountCents: -100 }] })).toThrow();
    expect(() => composeCharge({ baseCents: -1, pending: [] })).toThrow();
    expect(() => composeCharge({ baseCents: 1.5, pending: [] })).toThrow();
  });
});

describe("[MPS-1a] monto deseado del débito (desiredDebit)", () => {
  const base = {
    subscriptionStatus: "ACTIVE" as const,
    collectionMethod: "AUTO_DEBIT" as const,
    autoDebitAllowed: true,
    cancelAtPeriodEnd: false,
    nextBaseCents: 1500000,
    projectedCents: 2177419,
  };

  it("[MPS-1a] días 2, 3, 4, 5, 6: el 3 y el 4 la proyección; el resto, la base", () => {
    const at = (d: string) => desiredDebit({ ...base, today: d });
    expect(at("2026-11-02")).toEqual({ status: "authorized", amountCents: 1500000, basis: "base" });
    expect(at("2026-11-03")).toEqual({ status: "authorized", amountCents: 2177419, basis: "projection" });
    expect(at("2026-11-04")).toEqual({ status: "authorized", amountCents: 2177419, basis: "projection" });
    expect(at("2026-11-05")).toEqual({ status: "authorized", amountCents: 1500000, basis: "base" });
    expect(at("2026-11-06")).toEqual({ status: "authorized", amountCents: 1500000, basis: "base" });
  });

  it("[MPS-1a] el borde del 3 al 4 es en hora AR (instantes)", () => {
    expect(desiredDebit({ ...base, today: new Date("2026-11-03T02:59:59Z") })).toMatchObject({ basis: "base" }); // 23:59 AR del 2
    expect(desiredDebit({ ...base, today: new Date("2026-11-03T03:00:00Z") })).toMatchObject({ basis: "projection" });
    expect(desiredDebit({ ...base, today: new Date("2026-11-05T02:59:59Z") })).toMatchObject({ basis: "projection" }); // 23:59 AR del 4
    expect(desiredDebit({ ...base, today: new Date("2026-11-05T03:00:00Z") })).toMatchObject({ basis: "base" });
  });

  it("[MPS-1a] proyección 0 → paused; 0 < x < mínimo → mínimo", () => {
    expect(MP_MIN_DEBIT_CENTS).toBe(1500);
    expect(desiredDebit({ ...base, today: "2026-11-03", projectedCents: 0 })).toEqual({ status: "paused", reason: "zero" });
    expect(desiredDebit({ ...base, today: "2026-11-04", projectedCents: 800 })).toEqual({
      status: "authorized",
      amountCents: MP_MIN_DEBIT_CENTS,
      basis: "projection",
    });
    expect(desiredDebit({ ...base, today: "2026-11-04", projectedCents: 800, minDebitCents: 500 })).toMatchObject({ amountCents: 800 });
    // Base 0 o «Consultá» fuera de la ventana: no hay nada que debitar.
    expect(desiredDebit({ ...base, today: "2026-11-10", nextBaseCents: 0 })).toEqual({ status: "paused", reason: "zero" });
    expect(desiredDebit({ ...base, today: "2026-11-10", nextBaseCents: null })).toEqual({ status: "paused", reason: "no_price" });
  });

  it("[MPS-1a] baja programada → paused; CANCELLED, método ≠ AUTO_DEBIT o débito bloqueado → cancelled", () => {
    expect(desiredDebit({ ...base, today: "2026-11-03", cancelAtPeriodEnd: true })).toEqual({ status: "paused", reason: "cancel_scheduled" });
    expect(desiredDebit({ ...base, today: "2026-11-03", subscriptionStatus: "CANCELLED" })).toEqual({
      status: "cancelled",
      reason: "subscription_cancelled",
    });
    expect(desiredDebit({ ...base, today: "2026-11-10", collectionMethod: "MP_CHECKOUT" })).toEqual({ status: "cancelled", reason: "method" });
    expect(desiredDebit({ ...base, today: "2026-11-10", collectionMethod: null })).toEqual({ status: "cancelled", reason: "method" });
    expect(desiredDebit({ ...base, today: "2026-11-10", autoDebitAllowed: false })).toEqual({ status: "cancelled", reason: "not_allowed" });
  });
});

describe("[MPS-1a] start_date del preapproval (debitStartInstant)", () => {
  it("[MPS-1a] 23:00 del 3 → el 4 de ese mes; 06:59 del 4 → ese día; 07:30 del 4 → el mes siguiente (< 60′)", () => {
    expect(debitStartInstant(new Date("2026-11-03T23:00:00-03:00"), "2026-11-04")).toBe("2026-11-04T08:00:00.000-03:00");
    expect(debitStartInstant(new Date("2026-11-04T06:59:00-03:00"), "2026-11-04")).toBe("2026-11-04T08:00:00.000-03:00");
    expect(debitStartInstant(new Date("2026-11-04T07:00:00-03:00"), "2026-11-04")).toBe("2026-11-04T08:00:00.000-03:00"); // 60′ justos
    expect(debitStartInstant(new Date("2026-11-04T07:30:00-03:00"), "2026-11-04")).toBe("2026-12-04T08:00:00.000-03:00");
    expect(debitStartInstant(new Date("2026-12-04T07:30:00-03:00"), "2026-12-04")).toBe("2027-01-04T08:00:00.000-03:00");
  });

  it("[MPS-1a] nunca antes del primer cargo (fin de prueba o ancla legada)", () => {
    expect(debitStartInstant(new Date("2026-10-22T12:00:00-03:00"), "2026-12-04")).toBe("2026-12-04T08:00:00.000-03:00");
    expect(debitStartInstant(new Date("2026-10-22T12:00:00-03:00"), "2026-11-15")).toBe("2026-12-04T08:00:00.000-03:00");
    expect(debitStartInstant(new Date("2026-10-22T12:00:00-03:00"), "2026-10-01")).toBe("2026-11-04T08:00:00.000-03:00");
  });
});

describe("[MPS-1a] referencias, estados de MP y período del débito", () => {
  it("[MPS-1a] saas:<t>[:<c>] ida y vuelta; lo demás → null", () => {
    expect(saasExternalReference("cmt1abc")).toBe("saas:cmt1abc");
    expect(saasExternalReference("cmt1abc", "cmc9xyz")).toBe("saas:cmt1abc:cmc9xyz");
    expect(parseSaasExternalReference("saas:cmt1abc")).toEqual({ tenantId: "cmt1abc", chargeId: null });
    expect(parseSaasExternalReference("saas:cmt1abc:cmc9xyz")).toEqual({ tenantId: "cmt1abc", chargeId: "cmc9xyz" });
    for (const bad of [null, undefined, "", "saas:", "saas::c", "saas:t:", "saas:t:c:d", "booking:abc", "SAAS:t", "saas:t c", 42]) {
      expect(parseSaasExternalReference(bad as never)).toBeNull();
    }
    expect(() => saasExternalReference("a:b")).toThrow();
  });

  it("[MPS-1a] mapMpPaymentStatus: charged_back → refunded, cancelled → rejected, pendientes → null", () => {
    expect(mapMpPaymentStatus("approved")).toBe("APPROVED");
    expect(mapMpPaymentStatus("rejected")).toBe("REJECTED");
    expect(mapMpPaymentStatus("cancelled")).toBe("REJECTED");
    expect(mapMpPaymentStatus("refunded")).toBe("REFUNDED");
    expect(mapMpPaymentStatus("charged_back")).toBe("REFUNDED");
    for (const s of ["pending", "in_process", "authorized", "in_mediation", "", null, undefined, "otro"]) expect(mapMpPaymentStatus(s)).toBeNull();
  });

  it("[MPS-1a] nextSaasPaymentStatus: APPROVED → solo REFUNDED; REJECTED → APPROVED; pendiente o replay → null", () => {
    expect(nextSaasPaymentStatus(null, "APPROVED")).toBe("APPROVED");
    expect(nextSaasPaymentStatus(null, "REJECTED")).toBe("REJECTED");
    expect(nextSaasPaymentStatus(null, null)).toBeNull();
    expect(nextSaasPaymentStatus("APPROVED", "REFUNDED")).toBe("REFUNDED");
    expect(nextSaasPaymentStatus("APPROVED", "REJECTED")).toBeNull();
    expect(nextSaasPaymentStatus("APPROVED", "APPROVED")).toBeNull();
    expect(nextSaasPaymentStatus("APPROVED", null)).toBeNull();
    expect(nextSaasPaymentStatus("REJECTED", "APPROVED")).toBe("APPROVED");
    expect(nextSaasPaymentStatus("REJECTED", "REFUNDED")).toBeNull();
    expect(nextSaasPaymentStatus("REFUNDED", "APPROVED")).toBeNull();
    expect(nextSaasPaymentStatus("REFUNDED", "REFUNDED")).toBeNull();
  });

  it("[MPS-1a] periodStartForDebit: el período del 4; un débito adelantado el 2-3 va al que arranca", () => {
    expect(periodStartForDebit(new Date("2026-11-04T08:00:00-03:00"))).toBe("2026-11-04");
    expect(periodStartForDebit(new Date("2026-11-04T02:59:59Z"))).toBe("2026-11-04"); // 23:59 AR del 3
    expect(periodStartForDebit("2026-11-09")).toBe("2026-11-04"); // reintento
    expect(periodStartForDebit("2026-11-30")).toBe("2026-11-04");
    expect(periodStartForDebit("2026-12-02")).toBe("2026-12-04");
    expect(periodStartForDebit("2026-12-01")).toBe("2026-11-04");
    expect(periodStartForDebit("2027-01-03")).toBe("2027-01-04");
  });
});

describe("[MPS-1a] redactMpSaas: allow-list del recurso de MP (mpPayload)", () => {
  it("[MPS-1a] se queda con lo que sirve y saca los datos del pagador", () => {
    const r = redactMpSaas({
      id: 123,
      status: "approved",
      status_detail: "accredited",
      transaction_amount: 15000,
      currency_id: "ARS",
      external_reference: "saas:t1:c1",
      collector_id: 900000100,
      date_approved: "2026-11-04T08:01:00.000-03:00",
      payer: { email: "pagador@example.com", identification: { number: "20123456789" } },
      card: { last_four_digits: "1234", cardholder: { name: "Juan Perez" } },
      additional_info: { ip_address: "1.2.3.4" },
      auto_recurring: { transaction_amount: 15000, currency_id: "ARS", frequency: 1, frequency_type: "months", start_date: "x" },
      payment: { id: 55, status: "approved", status_detail: "accredited" },
    });
    expect(r).toMatchObject({ id: 123, status: "approved", external_reference: "saas:t1:c1", collector_id: 900000100 });
    expect(r.auto_recurring).toEqual({ transaction_amount: 15000, currency_id: "ARS", frequency: 1, frequency_type: "months", start_date: "x" });
    expect(r.payment).toEqual({ id: 55, status: "approved", status_detail: "accredited" });
    const json = JSON.stringify(r);
    expect(json).not.toContain("pagador@");
    expect(json).not.toContain("20123456789");
    expect(json).not.toContain("1234");
    expect(json).not.toContain("Juan");
    expect(json).not.toContain("1.2.3.4");
  });

  it("[MPS-1a] siempre un objeto chico (CHECK ≤ 16 KB), aunque llegue basura", () => {
    expect(redactMpSaas(null)).toEqual({});
    expect(redactMpSaas("x")).toEqual({});
    expect(redactMpSaas([1, 2])).toEqual({});
    const r = redactMpSaas({ id: 1, status: "x".repeat(100_000), reason: { nested: "obj" } });
    expect(JSON.stringify(r).length).toBeLessThan(16_384);
    expect((r.status as string).length).toBeLessThanOrEqual(256);
    expect(r.reason).toBeUndefined(); // un string esperado que llega como objeto no se guarda
  });
});
