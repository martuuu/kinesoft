/**
 * [TP-3d] Lógica pura del `PaymentLinkDrawer` (lib/payment-link-form.ts), anexo C del brief de T5 «3d PaymentLinkDrawer»:
 *   - opciones deduplicadas; sin turno, monto obligatorio;
 *   - vence 7 por default; concepto sin servicio; dirty-guard;
 *   - doble click = una llamada; `wa.me` sin datos clínicos; email deshabilitado con motivo.
 * Lo que se ve en el DOM (aviso con `aria-describedby`, 7 por default seleccionado, «Link listo») lo fija el render test
 * `tests/unit/render/tp3d-payment-link-drawer.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildPaymentLinkInput,
  createSingleFlight,
  emailButtonState,
  isNoEmailError,
  isPaymentLinkFormDirty,
  linkAccountLabel,
  linkAmountOptions,
  newIdempotencyKey,
  PAYMENT_LINK_FORM_COPY,
  type PaymentLinkFormState,
} from "@/lib/payment-link-form";
import { PAYMENT_LINK_COPY, defaultLinkConcept } from "@/lib/online-payments-copy";
import { PAYMENT_LINK_EXTRA_COPY, paymentLinkShareText } from "@/lib/payment-links-logic";
import { PAYMENT_LINK_DEFAULT_EXPIRY_DAYS, type PaymentLinkSuggestions } from "@/lib/payment-links-types";
import { whatsAppShareUrl } from "@/lib/booking-share";
import { formatARS } from "@/lib/format";

const sug = (o: Partial<PaymentLinkSuggestions> = {}): PaymentLinkSuggestions => ({
  remainingCents: 2_000_000,
  totalCents: 2_000_000,
  depositPaidCents: 0,
  canTotal: true,
  accountKind: "PRACTITIONER",
  blocked: null,
  ...o,
});

const state = (o: Partial<PaymentLinkFormState> = {}): PaymentLinkFormState => ({
  optionKey: null,
  amountCents: null,
  concept: "Turno del lun 19/10 a las 10:00",
  expiresInDays: PAYMENT_LINK_DEFAULT_EXPIRY_DAYS,
  practitionerId: "pr1",
  ...o,
});

describe("[TP-3d] opciones de «¿Cuánto?» deduplicadas", () => {
  it("sin seña pagada lo que falta ES el total: un solo radio con ese monto (El total) + otro monto", () => {
    const opts = linkAmountOptions(sug());
    expect(opts.map((o) => o.key)).toEqual(["TOTAL", "OTHER"]);
    expect(opts.filter((o) => o.amountCents === 2_000_000)).toHaveLength(1);
    expect(opts[0]).toMatchObject({ purpose: "TOTAL", label: "El total", amountCents: 2_000_000 });
    expect(opts[1]).toMatchObject({ purpose: "DEPOSIT", amountCents: null });
  });

  it("con seña pagada: lo que falta (con la seña en la pista) y otro monto; nunca el total", () => {
    const opts = linkAmountOptions(sug({ remainingCents: 1_400_000, depositPaidCents: 600_000, canTotal: false }));
    expect(opts.map((o) => o.key)).toEqual(["REST", "OTHER"]);
    expect(opts[0]).toMatchObject({ purpose: "REST", amountCents: 1_400_000 });
    expect(opts[0].hint).toBe(`Ya pagó una seña de ${formatARS(600_000)}.`);
    expect(opts[1].hint).toContain(formatARS(1_400_000));
  });

  it("bloqueado (sin cuenta, sin delegación, link vivo…) o sin nada para cobrar → ninguna opción", () => {
    expect(linkAmountOptions(sug({ blocked: PAYMENT_LINK_COPY.liveLinkExists }))).toEqual([]);
    expect(linkAmountOptions(sug({ remainingCents: 0, totalCents: 0, canTotal: false }))).toEqual([]);
  });

  it("si lo que falta es $ 1 no hay lugar para una seña menor: no se ofrece «Otro monto»", () => {
    const opts = linkAmountOptions(sug({ remainingCents: 100, totalCents: 100 }));
    expect(opts.map((o) => o.key)).toEqual(["TOTAL"]);
  });

  it("la cuenta se nombra igual que «Acreditado en» del comprobante", () => {
    expect(linkAccountLabel("PRACTITIONER", "Ana Pérez")).toBe("Mercado Pago de Ana Pérez");
    expect(linkAccountLabel("CLINIC", "Ana Pérez")).toBe("Mercado Pago del consultorio");
    expect(linkAccountLabel(null, "Ana")).toBeNull();
  });
});

describe("[TP-3d] lo que se manda a createPaymentLink", () => {
  const ctxFree = { patientId: "pa1", bookingId: null, options: [], remainingCents: null, idempotencyKey: "key-12345678" };

  it("sin turno, monto obligatorio (FREE, sin bookingId)", () => {
    const bad = buildPaymentLinkInput(state({ concept: "Sesión de octubre" }), ctxFree);
    expect(bad).toEqual({ ok: false, field: "amount", error: PAYMENT_LINK_COPY.amountRange });
    const ok = buildPaymentLinkInput(state({ concept: "  Sesión de octubre ", amountCents: 500_000 }), ctxFree);
    expect(ok).toEqual({
      ok: true,
      input: {
        patientId: "pa1",
        practitionerId: "pr1",
        purpose: "FREE",
        amountCents: 500_000,
        concept: "Sesión de octubre",
        expiresInDays: 7,
        idempotencyKey: "key-12345678",
      },
    });
  });

  it("sin turno y sin profesional elegido → error en el campo", () => {
    const r = buildPaymentLinkInput(state({ practitionerId: "", amountCents: 500_000 }), ctxFree);
    expect(r).toEqual({ ok: false, field: "practitioner", error: PAYMENT_LINK_FORM_COPY.practitionerRequired });
  });

  it("monto fuera de $ 1..$ 1.000.000 → el copy literal de C-TP9", () => {
    for (const amountCents of [99, 100_000_001]) {
      expect(buildPaymentLinkInput(state({ amountCents }), ctxFree)).toMatchObject({ ok: false, field: "amount" });
    }
  });

  it("con turno: TOTAL/REST NO mandan monto (lo calcula el server); DEPOSIT sí y menor que lo que falta", () => {
    const s = sug({ remainingCents: 1_400_000, depositPaidCents: 600_000, canTotal: false });
    const ctx = { patientId: "pa1", bookingId: "b1", options: linkAmountOptions(s), remainingCents: 1_400_000, idempotencyKey: "key-12345678" };
    const rest = buildPaymentLinkInput(state({ optionKey: "REST", amountCents: 999 }), ctx);
    expect(rest.ok && rest.input).toMatchObject({ purpose: "REST", bookingId: "b1" });
    expect(rest.ok && "amountCents" in rest.input).toBe(false);

    const tooHigh = buildPaymentLinkInput(state({ optionKey: "OTHER", amountCents: 1_400_000 }), ctx);
    expect(tooHigh).toEqual({ ok: false, field: "amount", error: PAYMENT_LINK_COPY.depositTooHigh });
    const dep = buildPaymentLinkInput(state({ optionKey: "OTHER", amountCents: 500_000 }), ctx);
    expect(dep.ok && dep.input).toMatchObject({ purpose: "DEPOSIT", amountCents: 500_000, bookingId: "b1" });
  });

  it("con turno sin opción elegida (bloqueado o sin cargar) → no se manda nada", () => {
    const ctx = { patientId: "pa1", bookingId: "b1", options: [], remainingCents: 0, idempotencyKey: "key-12345678" };
    expect(buildPaymentLinkInput(state({ optionKey: "TOTAL" }), ctx)).toEqual({
      ok: false,
      field: "option",
      error: PAYMENT_LINK_EXTRA_COPY.invalid,
    });
  });

  it("concepto de 3 a 120 caracteres recortados", () => {
    expect(buildPaymentLinkInput(state({ amountCents: 500_000, concept: "  ab  " }), ctxFree)).toEqual({
      ok: false,
      field: "concept",
      error: PAYMENT_LINK_FORM_COPY.conceptLength,
    });
    expect(buildPaymentLinkInput(state({ amountCents: 500_000, concept: "x".repeat(121) }), ctxFree)).toMatchObject({
      ok: false,
      field: "concept",
    });
  });

  it("vence 7 por default", () => {
    expect(PAYMENT_LINK_DEFAULT_EXPIRY_DAYS).toBe(7);
    const r = buildPaymentLinkInput(state({ amountCents: 500_000 }), ctxFree);
    expect(r.ok && r.input.expiresInDays).toBe(7);
  });

  it("idempotencyKey: UUID por instancia (pasa el schema de la action)", () => {
    const a = newIdempotencyKey();
    expect(a).not.toBe(newIdempotencyKey());
    expect(a.length).toBeGreaterThanOrEqual(8);
  });
});

describe("[TP-3d] concepto sin servicio, dirty-guard y doble click", () => {
  it("concepto por default sin el servicio (TP-UI-D12), en hora AR", () => {
    const c = defaultLinkConcept("2026-10-19T13:00:00.000Z");
    expect(c).toBe("Turno del lun 19/10 a las 10:00");
    expect(c).not.toMatch(/kinesio|rehabilit|osteo/i);
  });

  it("dirty-guard: limpio al abrir, sucio con un cambio, limpio otra vez con el link creado", () => {
    const init = state();
    expect(isPaymentLinkFormDirty(init, state(), false)).toBe(false);
    expect(isPaymentLinkFormDirty(init, state({ concept: "Otro" }), false)).toBe(true);
    expect(isPaymentLinkFormDirty(init, state({ amountCents: 100 }), false)).toBe(true);
    expect(isPaymentLinkFormDirty(init, state({ expiresInDays: 30 }), false)).toBe(true);
    expect(isPaymentLinkFormDirty(init, state({ concept: "Otro" }), true)).toBe(false);
  });

  it("doble click = una llamada (el candado es síncrono, no espera el re-render)", async () => {
    let release!: (v: string) => void;
    const call = vi.fn(() => new Promise<string>((r) => (release = r)));
    const flight = createSingleFlight();
    const first = flight.run(call);
    const second = flight.run(call);
    expect(flight.busy).toBe(true);
    release("link");
    expect(await first).toEqual({ ran: true, value: "link" });
    expect(await second).toEqual({ ran: false });
    expect(call).toHaveBeenCalledTimes(1);
    // Terminada la llamada (p. ej. con error), un reintento sí sale.
    const third = flight.run(async () => "retry");
    expect(await third).toEqual({ ran: true, value: "retry" });
    expect(flight.busy).toBe(false);
  });

  it("el candado se libera aunque la llamada tire", async () => {
    const flight = createSingleFlight();
    await expect(flight.run(async () => Promise.reject(new Error("red")))).rejects.toThrow("red");
    expect(flight.busy).toBe(false);
  });
});

describe("[TP-3d] compartir", () => {
  it("wa.me sin datos clínicos: lleva el concepto por default (sin servicio) y no el apellido ni el servicio", () => {
    const text = paymentLinkShareText({
      patientFirstName: "Laura",
      clinicName: "Consultorio Norte",
      amountCents: 1_400_000,
      concept: defaultLinkConcept("2026-10-19T13:00:00.000Z"),
      url: "https://app.example/pagar/AbCdEfGhIjKlMnOpQrStUv",
      expiresAt: new Date("2026-10-26T13:00:00.000Z"),
    });
    const wa = whatsAppShareUrl(text, "+5491155550000");
    expect(wa.startsWith("https://wa.me/5491155550000?text=")).toBe(true);
    const decoded = decodeURIComponent(wa.split("?text=")[1]);
    expect(decoded).toContain("Turno del lun 19/10 a las 10:00");
    expect(decoded).not.toMatch(/Gómez|Rehabilitación|LCA|diagn/i);
  });

  it("email deshabilitado con motivo (sin email cargado); mientras manda, deshabilitado sin motivo", () => {
    const reason = PAYMENT_LINK_COPY.noEmail("Laura Gómez");
    expect(emailButtonState({ sending: false, sentToMasked: null, disabledReason: reason })).toEqual({
      disabled: true,
      label: "Mandar por email",
      reason,
    });
    expect(emailButtonState({ sending: true, sentToMasked: null, disabledReason: null })).toMatchObject({
      disabled: true,
      reason: null,
    });
    expect(emailButtonState({ sending: false, sentToMasked: "l***@x.com", disabledReason: null }).disabled).toBe(false);
  });

  it("solo «no tiene email cargado» deshabilita para siempre; un error de envío se puede reintentar", () => {
    expect(isNoEmailError(PAYMENT_LINK_COPY.noEmail("Laura Gómez"), "Laura Gómez")).toBe(true);
    expect(isNoEmailError(PAYMENT_LINK_COPY.noEmail("Laura"), "Laura Gómez")).toBe(true);
    expect(isNoEmailError(PAYMENT_LINK_EXTRA_COPY.emailFailed, "Laura Gómez")).toBe(false);
  });
});
