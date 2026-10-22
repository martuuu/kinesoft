/**
 * [TP-2d] Reglas puras de los links de pago (C-TP9, plan §25.7) y el mail `payment_link` (TP-D27: sin concepto ni
 * datos clínicos). Lo que el drawer ofrece y lo que la action acepta salen de estas mismas funciones.
 */
import { describe, it, expect } from "vitest";
import {
  bookingLinkBlock,
  linkAccountGate,
  linkAmountFor,
  linkExpiresAt,
  paymentLinkShareText,
  publicLinkStatus,
  PAYMENT_LINK_EXTRA_COPY as X,
  type LinkBookingFacts,
} from "@/lib/payment-links-logic";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import { paymentLinkEmail } from "@/lib/email/templates-payments";

const facts = (o: Partial<LinkBookingFacts> = {}): LinkBookingFacts => ({
  status: "CONFIRMED",
  paymentStatus: "UNPAID",
  publicHold: false,
  legacyPaid: false,
  charges: [],
  ...o,
});

describe("[TP-2d] bookingLinkBlock: turno cobrado, cancelado o en hold → rechazo; un link vivo por turno", () => {
  it("turno confirmado, pendiente (no del turnero) o atendido, sin cobros → se puede", () => {
    expect(bookingLinkBlock(facts())).toBeNull();
    expect(bookingLinkBlock(facts({ status: "PENDING" }))).toBeNull();
    expect(bookingLinkBlock(facts({ status: "COMPLETED", paymentStatus: "FAILED" }))).toBeNull();
    // Una seña PAID no bloquea: se genera el link por lo que falta.
    expect(bookingLinkBlock(facts({ charges: [{ origin: "LINK", kind: "DEPOSIT", status: "PAID" }] }))).toBeNull();
  });
  it("cancelado o ausente", () => {
    expect(bookingLinkBlock(facts({ status: "CANCELLED" }))).toBe(X.bookingInactive);
    expect(bookingLinkBlock(facts({ status: "NO_SHOW" }))).toBe(X.bookingInactive);
  });
  it("cobrado: a mano, por el checkout legado o por un FULL online", () => {
    expect(bookingLinkBlock(facts({ paymentStatus: "PAID" }))).toBe(PAYMENT_LINK_COPY.alreadyPaid);
    expect(bookingLinkBlock(facts({ legacyPaid: true }))).toBe(PAYMENT_LINK_COPY.alreadyPaid);
    expect(bookingLinkBlock(facts({ charges: [{ origin: "TURNERO", kind: "FULL", status: "PAID" }] }))).toBe(PAYMENT_LINK_COPY.alreadyPaid);
  });
  it("hold público, pago en proceso o cobro del turnero abierto", () => {
    expect(bookingLinkBlock(facts({ status: "PENDING", publicHold: true }))).toBe(X.publicHold);
    expect(bookingLinkBlock(facts({ paymentStatus: "AUTHORIZED" }))).toBe(PAYMENT_LINK_COPY.inFlight);
    expect(bookingLinkBlock(facts({ charges: [{ origin: "LINK", kind: "FULL", status: "AUTHORIZED" }] }))).toBe(PAYMENT_LINK_COPY.inFlight);
    expect(bookingLinkBlock(facts({ charges: [{ origin: "TURNERO", kind: "DEPOSIT", status: "ACTIVE" }] }))).toBe(PAYMENT_LINK_COPY.inFlight);
  });
  it("un link vivo por turno", () => {
    expect(bookingLinkBlock(facts({ charges: [{ origin: "LINK", kind: "DEPOSIT", status: "ACTIVE" }] }))).toBe(PAYMENT_LINK_COPY.liveLinkExists);
  });
});

describe("[TP-2d] linkAmountFor: montos por purpose, $1..$1.000.000", () => {
  const base = { resolvedCopagoCents: 20_000_00, onlineDepositCents: 0 };
  it("REST = copago − señas, FULL con la base del copago", () => {
    expect(linkAmountFor("REST", base)).toEqual({ ok: true, amountCents: 20_000_00, kind: "FULL", copagoBasisCents: 20_000_00 });
    expect(linkAmountFor("REST", { ...base, onlineDepositCents: 5_000_00 })).toEqual({
      ok: true,
      amountCents: 15_000_00,
      kind: "FULL",
      copagoBasisCents: 20_000_00,
    });
  });
  it("TOTAL sin seña = el copago; con seña → rechazo", () => {
    expect(linkAmountFor("TOTAL", base)).toMatchObject({ ok: true, amountCents: 20_000_00, kind: "FULL" });
    expect(linkAmountFor("TOTAL", { ...base, onlineDepositCents: 100 })).toEqual({ ok: false, error: PAYMENT_LINK_COPY.depositAlreadyPaid });
  });
  it("DEPOSIT < lo que falta; ≥ → rechazo; fuera de rango → rechazo", () => {
    expect(linkAmountFor("DEPOSIT", { ...base, amountCents: 5_000_00 })).toEqual({ ok: true, amountCents: 5_000_00, kind: "DEPOSIT", copagoBasisCents: null });
    expect(linkAmountFor("DEPOSIT", { ...base, amountCents: 20_000_00 })).toEqual({ ok: false, error: PAYMENT_LINK_COPY.depositTooHigh });
    expect(linkAmountFor("DEPOSIT", { ...base, amountCents: 99 })).toEqual({ ok: false, error: PAYMENT_LINK_COPY.amountRange });
  });
  it("FREE: el monto escrito, $1..$1.000.000 exactos en los bordes", () => {
    expect(linkAmountFor("FREE", { resolvedCopagoCents: null, onlineDepositCents: 0, amountCents: 100 })).toMatchObject({ ok: true, kind: "FREE" });
    expect(linkAmountFor("FREE", { resolvedCopagoCents: null, onlineDepositCents: 0, amountCents: 100_000_000 })).toMatchObject({ ok: true });
    expect(linkAmountFor("FREE", { resolvedCopagoCents: null, onlineDepositCents: 0, amountCents: 100_000_001 }).ok).toBe(false);
    expect(linkAmountFor("FREE", { resolvedCopagoCents: null, onlineDepositCents: 0, amountCents: 99 }).ok).toBe(false);
    expect(linkAmountFor("FREE", { resolvedCopagoCents: null, onlineDepositCents: 0 }).ok).toBe(false);
  });
  it("copago 0 o todo señado → nada para cobrar; resto < $1 → fuera de rango", () => {
    expect(linkAmountFor("REST", { resolvedCopagoCents: 0, onlineDepositCents: 0 })).toEqual({ ok: false, error: X.nothingToCharge });
    expect(linkAmountFor("REST", { resolvedCopagoCents: 1000, onlineDepositCents: 1000 })).toEqual({ ok: false, error: X.nothingToCharge });
    expect(linkAmountFor("REST", { resolvedCopagoCents: 1050, onlineDepositCents: 1000 })).toEqual({ ok: false, error: PAYMENT_LINK_COPY.amountRange });
  });
});

describe("[TP-2d] linkAccountGate: delegación salvo el dueño (también el Titular, TP-D12)", () => {
  const acc = (o: { kind?: "PRACTITIONER" | "CLINIC"; linksDelegated?: boolean } = {}) => ({
    kind: o.kind ?? ("PRACTITIONER" as const),
    practitionerId: o.kind === "CLINIC" ? null : "p1",
    linksDelegated: o.linksDelegated ?? false,
  });
  it("sin cuenta → «no tiene Mercado Pago conectado»", () => {
    expect(linkAccountGate(null, { practitionerId: null, isAccountOwner: false }, "Ana")).toEqual({ ok: false, error: PAYMENT_LINK_COPY.noAccount("Ana") });
  });
  it("el profesional dueño sin delegación sí; el Titular u otro sin delegación no", () => {
    expect(linkAccountGate(acc(), { practitionerId: "p1", isAccountOwner: false }, "Ana").ok).toBe(true);
    expect(linkAccountGate(acc(), { practitionerId: "p0", isAccountOwner: true }, "Ana")).toEqual({ ok: false, error: PAYMENT_LINK_COPY.notDelegated("Ana") });
    expect(linkAccountGate(acc(), { practitionerId: null, isAccountOwner: false }, "Ana").ok).toBe(false);
  });
  it("con delegación, cualquiera que cobre", () => {
    expect(linkAccountGate(acc({ linksDelegated: true }), { practitionerId: null, isAccountOwner: false }, "Ana").ok).toBe(true);
  });
  it("cuenta del consultorio: su dueño es el Titular (`account.owner`)", () => {
    expect(linkAccountGate(acc({ kind: "CLINIC" }), { practitionerId: "p1", isAccountOwner: true }, "C").ok).toBe(true);
    expect(linkAccountGate(acc({ kind: "CLINIC" }), { practitionerId: "p1", isAccountOwner: false }, "C").ok).toBe(false);
  });
});

describe("[TP-2d] vencimiento y estado de /pagar", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  it("default 7 días, máximo 30", () => {
    expect(linkExpiresAt(now, undefined).toISOString()).toBe("2026-10-29T12:00:00.000Z");
    expect(linkExpiresAt(now, 30).getTime() - now.getTime()).toBe(30 * 86_400_000);
  });
  const live = {
    status: "ACTIVE",
    expiresAt: new Date("2026-10-29T12:00:00.000Z"),
    checkoutUrl: "https://x/checkout/1",
    kind: "FULL" as const,
    booking: { status: "CONFIRMED", paymentStatus: "UNPAID" },
  };
  it("ACTIVE con checkout → payable; vencido por reloj → expired (sin escribir)", () => {
    expect(publicLinkStatus(live, true, now)).toBe("payable");
    expect(publicLinkStatus(live, true, new Date("2026-10-29T12:00:00.000Z"))).toBe("expired");
  });
  it("turno cancelado o cobrado → sin checkout; sin preferencia → unavailable", () => {
    expect(publicLinkStatus({ ...live, booking: { status: "CANCELLED", paymentStatus: "UNPAID" } }, true, now)).toBe("cancelled");
    expect(publicLinkStatus({ ...live, booking: { status: "CONFIRMED", paymentStatus: "PAID" } }, true, now)).toBe("cancelled");
    expect(publicLinkStatus({ ...live, checkoutUrl: null }, true, now)).toBe("unavailable");
  });
  it("estados del cobro y consultorio suspendido (TP-D23)", () => {
    expect(publicLinkStatus({ ...live, status: "AUTHORIZED" }, true, now)).toBe("processing");
    expect(publicLinkStatus({ ...live, status: "PAID" }, true, now)).toBe("paid");
    expect(publicLinkStatus({ ...live, status: "REFUNDED" }, true, now)).toBe("refunded");
    expect(publicLinkStatus({ ...live, status: "EXPIRED" }, true, now)).toBe("expired");
    expect(publicLinkStatus({ ...live, status: "CANCELLED" }, true, now)).toBe("cancelled");
    expect(publicLinkStatus(live, false, now)).toBe("unavailable");
  });
});

describe("[TP-2d] compartir: el WhatsApp lleva el concepto; el mail no (TP-D27)", () => {
  const expiresAt = new Date("2026-10-23T02:30:00.000Z"); // 22/10 23:30 AR
  it("texto con monto, concepto, URL y vencimiento en hora AR", () => {
    const t = paymentLinkShareText({
      patientFirstName: "Juana",
      clinicName: "Consultorio Ramos",
      amountCents: 20_000_00,
      concept: "Turno del jue 22/10 a las 10:00",
      url: "https://app/pagar/abc",
      expiresAt,
    });
    expect(t).toContain("Hola Juana");
    expect(t).toContain("Turno del jue 22/10 a las 10:00");
    expect(t).toContain("https://app/pagar/abc");
    expect(t).toContain("22/10/2026, 23:30");
    expect(t).toMatch(/\$\s?20\.000/);
  });
  it("mail: asunto y textos del contrato, CTA con el monto, sin concepto", () => {
    const m = paymentLinkEmail({
      tenantName: "Consultorio Ramos",
      practitionerName: "Laura Ramos",
      amountCents: 20_000_00,
      url: "https://app.kinesoft.com.ar/pagar/AAAAAAAAAAAAAAAAAAAAAA",
      expiresAt,
    });
    expect(m.subject).toBe("Consultorio Ramos: tu link de pago");
    expect(m.text).toMatch(/Consultorio Ramos te mandó un link para pagar \$\s?20\.000(,00)? con Mercado Pago\./);
    expect(m.text).toContain("Es a nombre de Laura Ramos.");
    expect(m.text).toContain("El pago lo procesa Mercado Pago: nunca te vamos a pedir los datos de tu tarjeta por mail ni por WhatsApp.");
    expect(m.text).toMatch(/Pagar \$\s?20\.000/);
    expect(m.text).toContain("El link vence el 22 de octubre de 2026, 23:30 (hora de Argentina).");
    expect(m.text).toContain("Si no esperabas este mail, no pagues y avisale al consultorio.");
    expect(m.html).toContain("https://app.kinesoft.com.ar/pagar/AAAAAAAAAAAAAAAAAAAAAA");
    // Cuenta del consultorio: sin «a nombre de».
    expect(paymentLinkEmail({ tenantName: "C", practitionerName: null, amountCents: 100, url: "https://x/pagar/a", expiresAt }).text).not.toContain("a nombre de");
  });
  it("la firma del mail no admite el concepto (no se puede colar por descuido)", () => {
    // @ts-expect-error — el concepto puede ser clínico: no es parte de la plantilla, a propósito.
    paymentLinkEmail({ tenantName: "C", practitionerName: null, amountCents: 100, url: "https://x", expiresAt, concept: "Rodilla" });
  });
});
