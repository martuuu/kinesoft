/**
 * [TP-P3] Reglas de plata de los cobros online (`lib/online-charge-logic.ts`, C-TP7 del plan §25).
 *
 * Se testea el símbolo real (sin mocks): `decideOnlineCharge` decide si el turnero cobra y cuánto; `nextChargeStatus`
 * tiene que ser la misma matriz que el trigger `online_charge_guard()` de M18 (si propusiera una transición que el
 * guard rechaza, el webhook daría 500 y MP reintentaría días); `bookingEffectFor` es lo que el escritor único hace
 * con el turno. Montos en centavos `Int`.
 */
import { describe, expect, it } from "vitest";
import {
  CHARGE_TRANSITIONS,
  MAX_ONLINE_CHARGE_CENTS,
  bookingEffectFor,
  decideOnlineCharge,
  depositRefundNotice,
  mapMpStatus,
  nextChargeStatus,
  quoteOnlineCharge,
  receiptColumnsFrom,
  remainingOf,
  type ChargeStatus,
  type MpPaymentStatus,
  type OnlineChargePolicy,
} from "@/lib/online-charge-logic";
import { copagoRemainingCents } from "@/lib/booking-collect";

const policy = (over: Partial<OnlineChargePolicy> = {}): OnlineChargePolicy => ({
  mode: "REQUIRED",
  chargeKind: "COPAGO",
  fixedCents: null,
  percentBps: null,
  ...over,
});
const ACC = { kind: "PRACTITIONER" as const };
const decide = (over: Partial<Parameters<typeof decideOnlineCharge>[0]> = {}) =>
  decideOnlineCharge({ connectMode: "fake", policy: policy(), account: ACC, payNow: undefined, copagoCents: 600_000, ...over });

describe("[TP-P3] decideOnlineCharge: precedencia y montos", () => {
  it("[TP-P3] off: modo apagado o desconocido, sin política o política OFF", () => {
    expect(decide({ connectMode: "off" })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ connectMode: "Live" })).toEqual({ kind: "none", reason: "off" }); // typo/caso: no habilita
    expect(decide({ policy: null })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ policy: policy({ mode: "OFF" }) })).toEqual({ kind: "none", reason: "off" });
    // off gana sobre sin cuenta
    expect(decide({ connectMode: "off", account: null })).toEqual({ kind: "none", reason: "off" });
  });

  it("[TP-P3] sin cuenta → no-account (TP-D8), antes que el mínimo y la elección", () => {
    expect(decide({ account: null })).toEqual({ kind: "none", reason: "no-account" });
    expect(decide({ account: null, copagoCents: 0 })).toEqual({ kind: "none", reason: "no-account" });
    expect(decide({ account: null, policy: policy({ mode: "OPTIONAL" }), payNow: false })).toEqual({ kind: "none", reason: "no-account" });
  });

  it("[TP-P3] monto < $1 → below-min (copago 0 o porcentaje chico)", () => {
    expect(decide({ copagoCents: 0 })).toEqual({ kind: "none", reason: "below-min" });
    expect(decide({ copagoCents: 99 })).toEqual({ kind: "none", reason: "below-min" });
    expect(decide({ copagoCents: 100 })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 100 });
    // 1 % de $ 40 = $ 0,40 → 0 pesos → below-min
    expect(decide({ policy: policy({ chargeKind: "PERCENT", percentBps: 100 }), copagoCents: 4_000 })).toEqual({ kind: "none", reason: "below-min" });
  });

  it("[TP-P3] OPTIONAL: solo cobra con payNow === true (sin preselección); REQUIRED ignora payNow", () => {
    const opt = policy({ mode: "OPTIONAL" });
    expect(decide({ policy: opt, payNow: undefined })).toEqual({ kind: "none", reason: "patient-chose-later" });
    expect(decide({ policy: opt, payNow: false })).toEqual({ kind: "none", reason: "patient-chose-later" });
    expect(decide({ policy: opt, payNow: true })).toEqual({ kind: "charge", required: false, chargeKind: "FULL", amountCents: 600_000 });
    expect(decide({ payNow: false })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 600_000 });
    // below-min gana sobre la elección
    expect(decide({ policy: opt, payNow: false, copagoCents: 0 })).toEqual({ kind: "none", reason: "below-min" });
  });

  it("[TP-P3] la cuenta del consultorio también cobra; los tres modos de conexión", () => {
    for (const connectMode of ["fake", "sandbox", "live"]) {
      expect(decide({ connectMode, account: { kind: "CLINIC" } }).kind).toBe("charge");
    }
  });

  it("[TP-P3] COPAGO = el copago entero, FULL (con centavos)", () => {
    expect(decide({ copagoCents: 1_234_56 })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 123_456 });
  });

  it("[TP-P3] FIXED con tope: min(seña, copago); seña ≥ copago → FULL por el copago", () => {
    const fixed = (fixedCents: number | null) => policy({ chargeKind: "FIXED", fixedCents });
    expect(decide({ policy: fixed(200_000) })).toEqual({ kind: "charge", required: true, chargeKind: "DEPOSIT", amountCents: 200_000 });
    expect(decide({ policy: fixed(600_000) })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 600_000 });
    expect(decide({ policy: fixed(900_000) })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 600_000 });
    // seña configurada pero el copago del paciente es 0 → nada que cobrar
    expect(decide({ policy: fixed(200_000), copagoCents: 0 })).toEqual({ kind: "none", reason: "below-min" });
    // política mal formada → no se cobra (fail closed)
    expect(decide({ policy: fixed(null) })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ policy: fixed(1.5) })).toEqual({ kind: "none", reason: "off" });
  });

  it("[TP-P3] PERCENT redondeado a pesos enteros (half-up); ≥ copago → FULL", () => {
    const pct = (percentBps: number | null) => policy({ chargeKind: "PERCENT", percentBps });
    // 30 % de $ 6.000 = $ 1.800
    expect(decide({ policy: pct(3_000) })).toEqual({ kind: "charge", required: true, chargeKind: "DEPOSIT", amountCents: 180_000 });
    // 33,33 % de $ 1.234,56 = $ 411,47… → $ 411
    expect(decide({ policy: pct(3_333), copagoCents: 123_456 })).toEqual({ kind: "charge", required: true, chargeKind: "DEPOSIT", amountCents: 41_100 });
    // 50 % de $ 1.001 = $ 500,50 → $ 501 (half-up)
    expect(decide({ policy: pct(5_000), copagoCents: 100_100 })).toEqual({ kind: "charge", required: true, chargeKind: "DEPOSIT", amountCents: 50_100 });
    // 100 % → FULL por el copago exacto (con centavos)
    expect(decide({ policy: pct(10_000), copagoCents: 123_456 })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 123_456 });
    // 99,99 % de $ 1.234,56 redondea a $ 1.234 < copago → DEPOSIT
    expect(decide({ policy: pct(9_999), copagoCents: 123_456 })).toEqual({ kind: "charge", required: true, chargeKind: "DEPOSIT", amountCents: 123_400 });
    // 99,99 % de $ 1.000 = $ 999,90 → $ 1.000 = copago → FULL
    expect(decide({ policy: pct(9_999), copagoCents: 100_000 })).toEqual({ kind: "charge", required: true, chargeKind: "FULL", amountCents: 100_000 });
    expect(decide({ policy: pct(null) })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ policy: pct(10_001) })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ policy: pct(0) })).toEqual({ kind: "none", reason: "off" });
  });

  it("[TP-P3] los montos son siempre centavos enteros dentro del CHECK de M18", () => {
    for (const bps of [1, 7, 333, 1_234, 5_000, 9_999, 10_000]) {
      for (const copagoCents of [100, 12_345, 600_000, 99_999_999, MAX_ONLINE_CHARGE_CENTS]) {
        const d = decide({ policy: policy({ chargeKind: "PERCENT", percentBps: bps }), copagoCents });
        if (d.kind === "charge") {
          expect(Number.isInteger(d.amountCents)).toBe(true);
          expect(d.amountCents).toBeGreaterThanOrEqual(100);
          expect(d.amountCents).toBeLessThanOrEqual(copagoCents);
          if (d.chargeKind === "DEPOSIT") expect(d.amountCents % 100).toBe(0);
        }
      }
    }
    // por encima del tope del CHECK no se cobra (sería un 500 en el turnero)
    expect(decide({ copagoCents: MAX_ONLINE_CHARGE_CENTS + 1 })).toEqual({ kind: "none", reason: "off" });
    // copago inválido
    expect(decide({ copagoCents: 1_000.5 })).toEqual({ kind: "none", reason: "off" });
    expect(decide({ copagoCents: -100 })).toEqual({ kind: "none", reason: "off" });
  });
});

describe("[TP-P3] quoteOnlineCharge = decideOnlineCharge", () => {
  it("[TP-P3] paridad sobre políticas y precios", () => {
    const policies: (OnlineChargePolicy | null)[] = [
      null,
      policy({ mode: "OFF" }),
      policy(),
      policy({ mode: "OPTIONAL" }),
      policy({ chargeKind: "FIXED", fixedCents: 150_000 }),
      policy({ chargeKind: "FIXED", fixedCents: null }),
      policy({ chargeKind: "PERCENT", percentBps: 2_500 }),
      policy({ chargeKind: "PERCENT", percentBps: 10_000 }),
    ];
    for (const p of policies) {
      for (const price of [0, 50, 100, 149_999, 150_000, 600_000, 123_456]) {
        const q = quoteOnlineCharge({ policy: p, servicePriceCents: price });
        const d = decideOnlineCharge({ connectMode: "live", policy: p, account: ACC, payNow: true, copagoCents: price });
        expect(q).toEqual(d.kind === "charge" ? { amountCents: d.amountCents, chargeKind: d.chargeKind } : null);
      }
    }
  });
});

describe("[TP-P3] mapMpStatus", () => {
  it("[TP-P3] estados de MP al vocabulario reducido; en proceso y desconocido → pending", () => {
    expect(mapMpStatus("approved")).toBe("approved");
    expect(mapMpStatus(" APPROVED ")).toBe("approved");
    expect(mapMpStatus("authorized")).toBe("pending");
    expect(mapMpStatus("in_process")).toBe("pending");
    expect(mapMpStatus("pending")).toBe("pending");
    expect(mapMpStatus("rejected")).toBe("rejected");
    expect(mapMpStatus("cancelled")).toBe("cancelled");
    expect(mapMpStatus("refunded")).toBe("refunded");
    expect(mapMpStatus("charged_back")).toBe("charged_back");
    expect(mapMpStatus("in_mediation")).toBe("in_mediation");
    expect(mapMpStatus("lo-que-sea")).toBe("pending");
    expect(mapMpStatus("")).toBe("pending");
  });
});

const STATUSES: ChargeStatus[] = ["ACTIVE", "AUTHORIZED", "PAID", "REFUNDED", "EXPIRED", "CANCELLED"];
const INCOMING: MpPaymentStatus[] = ["approved", "pending", "rejected", "refunded", "charged_back", "cancelled", "in_mediation"];

/** Transiciones del trigger `online_charge_guard()` de M18, copiadas del SQL (Anexo A del brief). */
const GUARD_SQL: Record<ChargeStatus, ChargeStatus[]> = {
  ACTIVE: ["AUTHORIZED", "PAID", "REFUNDED", "EXPIRED", "CANCELLED"],
  AUTHORIZED: ["ACTIVE", "PAID", "REFUNDED"],
  EXPIRED: ["PAID", "REFUNDED"],
  CANCELLED: ["PAID", "REFUNDED"],
  PAID: ["REFUNDED"],
  REFUNDED: [],
};

describe("[TP-P3] nextChargeStatus = matriz del guard SQL", () => {
  it("[TP-P3] CHARGE_TRANSITIONS es literal la del guard", () => {
    expect(CHARGE_TRANSITIONS).toEqual(GUARD_SQL);
  });

  it("[TP-P3] nunca propone una transición que el guard rechaza", () => {
    for (const cur of STATUSES) {
      for (const inc of INCOMING) {
        for (const amountMismatch of [false, true]) {
          const next = nextChargeStatus(cur, inc, { amountMismatch });
          if (next !== cur) expect(GUARD_SQL[cur]).toContain(next);
        }
      }
    }
  });

  it("[TP-P3] matriz completa (sin diferencia de monto)", () => {
    const m = (cur: ChargeStatus) => Object.fromEntries(INCOMING.map((i) => [i, nextChargeStatus(cur, i, { amountMismatch: false })]));
    expect(m("ACTIVE")).toEqual({
      approved: "PAID", pending: "AUTHORIZED", rejected: "ACTIVE", refunded: "REFUNDED",
      charged_back: "REFUNDED", cancelled: "ACTIVE", in_mediation: "AUTHORIZED",
    });
    expect(m("AUTHORIZED")).toEqual({
      approved: "PAID", pending: "AUTHORIZED", rejected: "ACTIVE", refunded: "REFUNDED",
      charged_back: "REFUNDED", cancelled: "ACTIVE", in_mediation: "AUTHORIZED",
    });
    // un pago aprobado SIEMPRE se registra, aunque el link esté vencido o anulado
    for (const cur of ["EXPIRED", "CANCELLED"] as const) {
      expect(m(cur)).toEqual({
        approved: "PAID", pending: cur, rejected: cur, refunded: "REFUNDED",
        charged_back: "REFUNDED", cancelled: cur, in_mediation: cur,
      });
    }
    // nunca baja un PAID salvo reintegro o contracargo
    expect(m("PAID")).toEqual({
      approved: "PAID", pending: "PAID", rejected: "PAID", refunded: "REFUNDED",
      charged_back: "REFUNDED", cancelled: "PAID", in_mediation: "PAID",
    });
    for (const i of INCOMING) expect(nextChargeStatus("REFUNDED", i, { amountMismatch: false })).toBe("REFUNDED");
  });

  it("[TP-P3] monto distinto: approved no pasa a PAID; el reintegro sí se registra", () => {
    for (const cur of STATUSES) {
      expect(nextChargeStatus(cur, "approved", { amountMismatch: true })).toBe(cur);
    }
    expect(nextChargeStatus("ACTIVE", "refunded", { amountMismatch: true })).toBe("REFUNDED");
    expect(nextChargeStatus("ACTIVE", "pending", { amountMismatch: true })).toBe("AUTHORIZED");
  });
});

describe("[TP-P3] bookingEffectFor (matriz)", () => {
  type C = Parameters<typeof bookingEffectFor>[0];
  const c = (over: Partial<C> = {}): C => ({
    origin: "TURNERO",
    kind: "FULL",
    bookingStatus: "CONFIRMED",
    bookingPaymentStatus: "UNPAID",
    paidByMp: false,
    ...over,
  });

  it("[TP-P3] REQUIRED: PENDING → confirm (+ mark-paid si es FULL; la seña no toca el copago)", () => {
    expect(bookingEffectFor(c({ bookingStatus: "PENDING" }), "ACTIVE", "PAID")).toEqual(["confirm", "mark-paid"]);
    expect(bookingEffectFor(c({ bookingStatus: "PENDING", kind: "DEPOSIT" }), "ACTIVE", "PAID")).toEqual(["confirm"]);
    expect(bookingEffectFor(c({ bookingStatus: "PENDING" }), "AUTHORIZED", "PAID")).toEqual(["confirm", "mark-paid"]);
    // pago tardío sobre un hold vencido (cobro EXPIRED): se confirma igual (TP-D24)
    expect(bookingEffectFor(c({ bookingStatus: "PENDING" }), "EXPIRED", "PAID")).toEqual(["confirm", "mark-paid"]);
  });

  it("[TP-P3] FULL confirmado o atendido → mark-paid; DEPOSIT → nada (TP-D7)", () => {
    expect(bookingEffectFor(c(), "ACTIVE", "PAID")).toEqual(["mark-paid"]);
    expect(bookingEffectFor(c({ bookingStatus: "COMPLETED", origin: "LINK" }), "ACTIVE", "PAID")).toEqual(["mark-paid"]);
    expect(bookingEffectFor(c({ kind: "DEPOSIT" }), "ACTIVE", "PAID")).toEqual(["none"]);
    // un link no confirma un PENDING (el hold es del turnero)
    expect(bookingEffectFor(c({ origin: "LINK", bookingStatus: "PENDING" }), "ACTIVE", "PAID")).toEqual(["mark-paid"]);
  });

  it("[TP-P3] copago ya PAID (a mano u otro cobro) → no se pisa (duplicado)", () => {
    expect(bookingEffectFor(c({ bookingPaymentStatus: "PAID" }), "ACTIVE", "PAID")).toEqual(["none"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "PAID", bookingStatus: "PENDING" }), "ACTIVE", "PAID")).toEqual(["confirm"]);
  });

  it("[TP-P3] turno cancelado o ausente: no revive ni marca", () => {
    for (const bookingStatus of ["CANCELLED", "NO_SHOW"]) {
      expect(bookingEffectFor(c({ bookingStatus }), "ACTIVE", "PAID")).toEqual(["none"]);
      expect(bookingEffectFor(c({ bookingStatus }), "CANCELLED", "PAID")).toEqual(["none"]);
      expect(bookingEffectFor(c({ bookingStatus }), "ACTIVE", "AUTHORIZED")).toEqual(["none"]);
    }
    // pero el reintegro de un FULL que había marcado el copago por MP se refleja
    expect(bookingEffectFor(c({ bookingStatus: "CANCELLED", bookingPaymentStatus: "PAID", paidByMp: true }), "PAID", "REFUNDED")).toEqual(["mark-refunded"]);
  });

  it("[TP-P3] en proceso: mark-authorized / revert-authorized solo en FULL", () => {
    expect(bookingEffectFor(c(), "ACTIVE", "AUTHORIZED")).toEqual(["mark-authorized"]);
    expect(bookingEffectFor(c({ kind: "DEPOSIT" }), "ACTIVE", "AUTHORIZED")).toEqual(["none"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "PAID" }), "ACTIVE", "AUTHORIZED")).toEqual(["none"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "AUTHORIZED" }), "AUTHORIZED", "ACTIVE")).toEqual(["revert-authorized"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "UNPAID" }), "AUTHORIZED", "ACTIVE")).toEqual(["none"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "AUTHORIZED" }), "AUTHORIZED", "REFUNDED")).toEqual(["revert-authorized"]);
  });

  // [TP-ZF1] B3 (revisor T5-Z): la seña REQUIRED en proceso (AUTHORIZED: efectivo, en mediación) no tocaba el turno, que
  // seguía PENDING/UNPAID: el hold vencía y el turno se liberaba mientras MP retenía la plata. Ahora `mark-authorized`
  // también para la seña del turnero con el turno PENDING (PENDING + AUTHORIZED sostiene el cupo), y al resolverse
  // (PAID / ACTIVE / REFUNDED) se revierte (la seña no marca el copago: TP-D7).
  it("[TP-ZF1] seña del turnero en proceso con el turno PENDING → mark-authorized; al resolverse, revert", () => {
    const dep = (over: Partial<C> = {}) => c({ kind: "DEPOSIT", bookingStatus: "PENDING", ...over });
    expect(bookingEffectFor(dep(), "ACTIVE", "AUTHORIZED")).toEqual(["mark-authorized"]);
    expect(bookingEffectFor(dep({ bookingPaymentStatus: "AUTHORIZED" }), "AUTHORIZED", "PAID")).toEqual(["confirm", "revert-authorized"]);
    expect(bookingEffectFor(dep({ bookingPaymentStatus: "AUTHORIZED" }), "AUTHORIZED", "ACTIVE")).toEqual(["revert-authorized"]);
    expect(bookingEffectFor(dep({ bookingPaymentStatus: "AUTHORIZED" }), "AUTHORIZED", "REFUNDED")).toEqual(["revert-authorized"]);
    // Sin cambios: seña de un turno ya confirmado, o de un link (el hold es del turnero).
    expect(bookingEffectFor(c({ kind: "DEPOSIT" }), "ACTIVE", "AUTHORIZED")).toEqual(["none"]);
    expect(bookingEffectFor(dep({ origin: "LINK" }), "ACTIVE", "AUTHORIZED")).toEqual(["none"]);
    expect(bookingEffectFor(dep(), "ACTIVE", "PAID")).toEqual(["confirm"]);
  });

  it("[TP-P3] reintegro: mark-refunded solo si el copago lo pagó MP; manual o seña → nada", () => {
    expect(bookingEffectFor(c({ bookingPaymentStatus: "PAID", paidByMp: true }), "PAID", "REFUNDED")).toEqual(["mark-refunded"]);
    expect(bookingEffectFor(c({ bookingPaymentStatus: "PAID", paidByMp: false }), "PAID", "REFUNDED")).toEqual(["none"]);
    expect(bookingEffectFor(c({ kind: "DEPOSIT", bookingPaymentStatus: "PAID", paidByMp: true }), "PAID", "REFUNDED")).toEqual(["none"]);
  });

  it("[TP-P3] sin cambio, link FREE o sin turno → none; vencer/anular no toca el turno", () => {
    expect(bookingEffectFor(c(), "PAID", "PAID")).toEqual(["none"]);
    expect(bookingEffectFor(c({ origin: "LINK", kind: "FREE", bookingStatus: null }), "ACTIVE", "PAID")).toEqual(["none"]);
    expect(bookingEffectFor(c({ bookingStatus: null }), "ACTIVE", "PAID")).toEqual(["none"]);
    expect(bookingEffectFor(c(), "ACTIVE", "EXPIRED")).toEqual(["none"]);
    expect(bookingEffectFor(c(), "ACTIVE", "CANCELLED")).toEqual(["none"]);
  });

  it("[TP-P3] todo efecto sale de una transición que el guard admite", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const eff = bookingEffectFor(c({ bookingStatus: "PENDING" }), from, to);
        if (!eff.includes("none")) expect(GUARD_SQL[from]).toContain(to);
      }
    }
  });
});

describe("[TP-P3] remainingOf y paridad con copagoRemainingCents", () => {
  it("[TP-P3] copago − señas PAID, piso 0, señas inválidas ignoradas", () => {
    expect(remainingOf({ resolvedCopagoCents: 600_000, onlineDepositCents: 0 })).toBe(600_000);
    expect(remainingOf({ resolvedCopagoCents: 600_000, onlineDepositCents: 200_000 })).toBe(400_000);
    expect(remainingOf({ resolvedCopagoCents: 300_000, onlineDepositCents: 500_000 })).toBe(0);
    expect(remainingOf({ resolvedCopagoCents: 600_000, onlineDepositCents: -1 })).toBe(600_000);
    expect(remainingOf({ resolvedCopagoCents: 600_000, onlineDepositCents: 10.5 })).toBe(600_000);
    expect(remainingOf({ resolvedCopagoCents: -5, onlineDepositCents: 0 })).toBe(0);
  });

  it("[TP-P3] copagoRemainingCents({ onlineDepositCents }) = remainingOf", () => {
    for (const resolvedCopagoCents of [0, 100, 123_456, 600_000]) {
      for (const onlineDepositCents of [0, 1, 100_000, 600_000, 900_000, -100, 2.5]) {
        expect(copagoRemainingCents({ resolvedCopagoCents, onlineDepositCents })).toBe(remainingOf({ resolvedCopagoCents, onlineDepositCents }));
      }
    }
  });
});

describe("[TP-P3] receiptColumnsFrom y depositRefundNotice", () => {
  const now = new Date("2026-10-22T15:00:00.000Z");

  it("[TP-P3] sanea a los CHECK de M18", () => {
    const r = receiptColumnsFrom(
      {
        id: 123456789,
        status: "approved",
        status_detail: "x".repeat(100),
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        installments: 3,
        transaction_amount: 1234.56,
        date_approved: "2026-10-22T11:30:00.000-03:00",
      },
      now
    );
    expect(r).toEqual({
      mpPaymentId: "123456789",
      mpStatus: "approved",
      mpStatusDetail: "x".repeat(64),
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      installments: 3,
      paidAmountCents: 123_456,
      approvedAt: new Date("2026-10-22T14:30:00.000Z"),
      settledAt: now,
    });
  });

  it("[TP-P3] basura de MP → null, nunca un valor que rompa un CHECK", () => {
    const r = receiptColumnsFrom(
      { id: "abc", status: "raro", installments: 99, transaction_amount: -5, date_approved: "no-fecha", payment_method_id: {} },
      now
    );
    expect(r.mpPaymentId).toBeNull();
    expect(r.mpStatus).toBeNull();
    expect(r.installments).toBeNull();
    expect(r.paidAmountCents).toBeNull();
    expect(r.paymentMethodId).toBeNull();
    expect(r.approvedAt).toEqual(now);
    expect(r.settledAt).toEqual(now);
  });

  it("[TP-P3] aviso de reintegro con formatARS", () => {
    expect(depositRefundNotice(200_000)).toMatch(/^Este turno tiene una seña de \$\s?2\.000: si corresponde, reintegrala desde Mercado Pago\.$/);
  });
});
