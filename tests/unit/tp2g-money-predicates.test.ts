/**
 * [TP-2r] (T5d, sesión TP-2g; brief T5 §25.8 «Predicados de plata y vistas», C-TP11). Lo PURO que cuenta la seña online:
 *
 *   - `bookingHasMoney` (lib/plan-pricing.ts): un turno con seña cobrada (`Booking.onlineDepositCents > 0`, la escribe
 *     solo el trigger de M18) TIENE plata, aunque el copago siga UNPAID (TP-D7: la seña no marca el copago). Sin esto,
 *     reprecio, «sacar del plan» y cancelar en lote pisaban un turno con plata de MP adentro. La paridad con el `where`
 *     de Prisma y con `cancelBookingsInTx` se prueba contra la base en `tests/integration/tp2r-revenue-online.test.ts`.
 *   - Facturación (`billingSummary`, `isCancelledWithMoney`): la seña es plata percibida y sale de lo pendiente.
 *   - Portal (`loosePendingCents`): el paciente debe copago − seña, nunca < 0.
 *
 * Corre igual en TZ=UTC y TZ=AR (no hay fechas en juego).
 */
import { describe, expect, it, vi } from "vitest";

// `portal-account-internal` arrastra el lector de planes (y por él la sesión) y el cliente service: acá solo se prueba
// su función pura, así que se cortan esas dos importaciones (no es la función bajo test).
vi.mock("@/lib/plans-read-internal", () => ({ balanceOf: vi.fn(), loadPlansInTx: vi.fn() }));
vi.mock("@/lib/db", () => ({ prismaService: {} }));
import { bookingHasMoney } from "@/lib/plan-pricing";
import { billingSummary, isBillingVisible, isCancelledWithMoney } from "@/components/planes/plan-booking-groups";
import { loosePendingCents } from "@/lib/portal-account-internal";

type Row = Parameters<typeof billingSummary>[0][number];
const row = (o: Partial<Row> = {}): Row => ({
  status: "COMPLETED",
  paymentStatus: "UNPAID",
  insurerPaidAt: null,
  programId: null,
  copagoCents: 20_000_00,
  osAmountCents: 0,
  onlineDepositCents: 0,
  ...o,
});

describe("[TP-2r] predicados de plata con seña online", () => {
  it("bookingHasMoney: seña > 0 es plata aunque el copago siga UNPAID; 0 o ausente no", () => {
    expect(bookingHasMoney({ paymentStatus: "UNPAID", insurerPaidAt: null, payment: null, onlineDepositCents: 6_000_00 })).toBe(true);
    expect(bookingHasMoney({ paymentStatus: "UNPAID", insurerPaidAt: null, payment: null, onlineDepositCents: 0 })).toBe(false);
    // Desde TP-2i la columna es requerida en `PricingBooking`: un caller que no la proyecte no compila.
    expect(bookingHasMoney({ paymentStatus: "FAILED", insurerPaidAt: null, payment: null, onlineDepositCents: 100 })).toBe(true);
  });

  it("Facturación: un cancelado con seña se ve (es plata que entró); sin seña no", () => {
    const cancelled = row({ status: "CANCELLED", onlineDepositCents: 6_000_00 });
    expect(isCancelledWithMoney(cancelled)).toBe(true);
    expect(isBillingVisible(cancelled)).toBe(true);
    expect(isBillingVisible(row({ status: "CANCELLED" }))).toBe(false);
  });

  it("billingSummary: seña + resto en efectivo = copago percibido una sola vez; seña sola resta de lo pendiente", () => {
    const bks = [
      row({ onlineDepositCents: 6_000_00 }), // seña, resto sin cobrar
      row({ paymentStatus: "PAID", onlineDepositCents: 6_000_00 }), // seña + resto en efectivo
      row({ status: "CANCELLED", onlineDepositCents: 5_000_00 }), // cancelado con seña: percibido, no pendiente
    ];
    for (const grouped of [false, true]) {
      const s = billingSummary(bks, { grouped });
      expect(s.copagoPaidCents, `grouped=${grouped}`).toBe(6_000_00 + 20_000_00 + 5_000_00);
      expect(s.pendingCents, `grouped=${grouped}`).toBe(14_000_00);
      expect(s.billableCount).toBe(2);
    }
    // Seña mayor que el copago (bajó la cobertura): pendiente 0, nunca negativo.
    expect(billingSummary([row({ copagoCents: 1_000_00, onlineDepositCents: 6_000_00 })], { grouped: false }).pendingCents).toBe(0);
  });

  it("portal: loosePendingCents = max(0, copago − seña)", () => {
    const base = { status: "COMPLETED" as const, paymentStatus: "UNPAID" as const, copagoCents: 20_000_00, payment: null };
    expect(loosePendingCents({ ...base, onlineDepositCents: 6_000_00 })).toBe(14_000_00);
    expect(loosePendingCents({ ...base, onlineDepositCents: 25_000_00 })).toBe(0);
    expect(loosePendingCents({ ...base, onlineDepositCents: 0 })).toBe(20_000_00);
  });
});
