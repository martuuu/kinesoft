/**
 * [TP-P5] `bookingMoneyBadge` y las líneas de plata del turno (`lib/booking-money-view.ts`, §25.10 «Agenda» y «Drawer»).
 *
 * Contrato de UI (TP-UI-D4): la card de la agenda muestra SOLO «Seña» o «Pagado MP», como mini-badge con borde; el fondo
 * sigue siendo el estado (AGENTS §5), así que la vista no devuelve colores, solo texto, nombre accesible y la clave de
 * `data-badge`. Entrada = lo que trae el cable de la agenda (`od` → `onlineDepositCents`, `po` → `paidOnline`, que se
 * omiten cuando son 0/false): un turno sin plata online tiene que dar `null` y la card queda con los mismos nodos.
 */
import { describe, expect, it } from "vitest";
import { bookingMoneyBadge, bookingMoneyLines, remainingAfterDepositCents } from "@/lib/booking-money-view";
import { formatARS } from "@/lib/format";

describe("[TP-P5] bookingMoneyBadge", () => {
  it("sin od/po (campos omitidos del cable) → null", () => {
    expect(bookingMoneyBadge({})).toBeNull();
    expect(bookingMoneyBadge({ onlineDepositCents: 0, paidOnline: false })).toBeNull();
    expect(bookingMoneyBadge({ onlineDepositCents: null, paidOnline: null })).toBeNull();
  });

  it("seña pagada → «Seña» con el monto en el nombre accesible", () => {
    const b = bookingMoneyBadge({ onlineDepositCents: 600_000 })!;
    expect(b.kind).toBe("deposit");
    expect(b.dataBadge).toBe("sena");
    expect(b.label).toBe("Seña");
    expect(b.ariaLabel).toBe(`Seña pagada por Mercado Pago: ${formatARS(600_000)}`);
  });

  it("pagado por Mercado Pago gana sobre la seña", () => {
    const b = bookingMoneyBadge({ onlineDepositCents: 600_000, paidOnline: true })!;
    expect(b.kind).toBe("paid-mp");
    expect(b.dataBadge).toBe("mp");
    expect(b.label).toBe("Pagado MP");
    expect(b.ariaLabel).toBe("Pagado por Mercado Pago");
  });

  it("valores basura del cable (negativo, NaN) no inventan una seña", () => {
    expect(bookingMoneyBadge({ onlineDepositCents: -5 })).toBeNull();
    expect(bookingMoneyBadge({ onlineDepositCents: Number.NaN })).toBeNull();
  });
});

describe("[TP-P5] lo que falta cobrar", () => {
  it("remainingAfterDepositCents = max(0, copago − seña)", () => {
    expect(remainingAfterDepositCents(2_000_000, 600_000)).toBe(1_400_000);
    expect(remainingAfterDepositCents(500_000, 600_000)).toBe(0);
    expect(remainingAfterDepositCents(null, 600_000)).toBe(0);
    expect(remainingAfterDepositCents(2_000_000, null)).toBe(2_000_000);
  });

  it("con seña e impago: «Seña pagada · $X» y «Por cobrar · $Y»", () => {
    const l = bookingMoneyLines({ copagoCents: 2_000_000, onlineDepositCents: 600_000, paymentStatus: "UNPAID" });
    expect(l.depositLine).toBe(`Seña pagada · ${formatARS(600_000)}`);
    expect(l.remainingCents).toBe(1_400_000);
    expect(l.remainingLine).toBe(`Por cobrar · ${formatARS(1_400_000)}`);
    expect(l.onlineLine).toBeNull();
  });

  it("nunca «Por cobrar · $ 0»", () => {
    const l = bookingMoneyLines({ copagoCents: 600_000, onlineDepositCents: 600_000, paymentStatus: "UNPAID" });
    expect(l.remainingCents).toBe(0);
    expect(l.remainingLine).toBeNull();
  });

  it("resto cobrado a mano: queda la seña, sin «Por cobrar»", () => {
    const l = bookingMoneyLines({ copagoCents: 2_000_000, onlineDepositCents: 600_000, paymentStatus: "PAID" });
    expect(l.depositLine).toBe(`Seña pagada · ${formatARS(600_000)}`);
    expect(l.remainingLine).toBeNull();
  });

  it("pagado por Mercado Pago y reintegrado", () => {
    expect(bookingMoneyLines({ copagoCents: 2_000_000, paidOnline: true }).onlineLine).toBe("Pagado por Mercado Pago");
    expect(bookingMoneyLines({ copagoCents: 2_000_000, paidOnline: true }).remainingLine).toBeNull();
    expect(bookingMoneyLines({ copagoCents: 2_000_000, refundedOnline: true }).onlineLine).toBe(
      "Reintegrado por Mercado Pago",
    );
  });

  it("sin copago resuelto no hay «Por cobrar» (lo decide el modal, no la vista)", () => {
    const l = bookingMoneyLines({ copagoCents: null, onlineDepositCents: 600_000 });
    expect(l.remainingCents).toBeNull();
    expect(l.remainingLine).toBeNull();
  });
});
