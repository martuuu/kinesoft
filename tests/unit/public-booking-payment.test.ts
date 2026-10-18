import { describe, expect, it } from "vitest";
import {
  MIN_ONLINE_CHARGE_CENTS,
  decidePublicCheckout,
  isOnlineCheckoutAvailable,
  publicStatusAmountCents,
} from "@/lib/public-booking-payment";

// TP-0 (H-TP0 / H-TP2, plan §22.5): la regla del checkout del turnero y el monto de la pantalla de estado. Lo que pasa
// con el turno (CONFIRMED/UNPAID, promoción, degradado) se prueba contra Postgres en
// tests/integration/tp0-turnero-sin-cobro.test.ts.

describe("decidePublicCheckout", () => {
  it("[TP-0] decidePublicCheckout (tabla)", () => {
    expect(MIN_ONLINE_CHARGE_CENTS).toBe(100);
    const table: Array<[Parameters<typeof decidePublicCheckout>[0], ReturnType<typeof decidePublicCheckout>]> = [
      // Las tres condiciones → checkout con el monto.
      [{ amountCents: 8000, mode: "platform", mpConfigured: true }, { kind: "checkout", amountCents: 8000 }],
      [{ amountCents: 100, mode: "platform", mpConfigured: true }, { kind: "checkout", amountCents: 100 }],
      // Monto de menos de $1: los servicios de arranque valen $0 (H-TP0) y MP rechaza un ítem de $0.
      [{ amountCents: 0, mode: "platform", mpConfigured: true }, { kind: "none", reason: "zero-amount" }],
      [{ amountCents: 99, mode: "platform", mpConfigured: true }, { kind: "none", reason: "zero-amount" }],
      [{ amountCents: -500, mode: "platform", mpConfigured: true }, { kind: "none", reason: "zero-amount" }],
      [{ amountCents: Number.NaN, mode: "platform", mpConfigured: true }, { kind: "none", reason: "zero-amount" }],
      [{ amountCents: 150.5, mode: "platform", mpConfigured: true }, { kind: "none", reason: "zero-amount" }],
      // Default `off` (la única cuenta MP de hoy es la de la plataforma, H-TP1): nunca checkout, aunque haya monto y token.
      [{ amountCents: 8000, mode: "off", mpConfigured: true }, { kind: "none", reason: "checkout-off" }],
      [{ amountCents: 8000, mode: undefined, mpConfigured: true }, { kind: "none", reason: "checkout-off" }],
      [{ amountCents: 8000, mode: "PLATFORM", mpConfigured: true }, { kind: "none", reason: "checkout-off" }],
      // Sin token de MP: la preferencia tiraría siempre.
      [{ amountCents: 8000, mode: "platform", mpConfigured: false }, { kind: "none", reason: "mp-missing" }],
      // Precedencia: switch → MP → monto (el motivo más estructural primero, para el log).
      [{ amountCents: 0, mode: "off", mpConfigured: false }, { kind: "none", reason: "checkout-off" }],
      [{ amountCents: 0, mode: "platform", mpConfigured: false }, { kind: "none", reason: "mp-missing" }],
    ];
    for (const [input, expected] of table) expect(decidePublicCheckout(input), JSON.stringify(input)).toEqual(expected);
  });

  it("[TP-0] isOnlineCheckoutAvailable = switch platform + MP configurado (sin mirar el monto)", () => {
    expect(isOnlineCheckoutAvailable({ mode: "platform", mpConfigured: true })).toBe(true);
    expect(isOnlineCheckoutAvailable({ mode: "platform", mpConfigured: false })).toBe(false);
    expect(isOnlineCheckoutAvailable({ mode: "off", mpConfigured: true })).toBe(false);
    expect(isOnlineCheckoutAvailable({ mode: undefined, mpConfigured: true })).toBe(false);
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
