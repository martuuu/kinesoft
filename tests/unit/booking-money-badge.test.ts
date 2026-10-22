/**
 * [TP-3e] `cardMoneyBadge` (`lib/booking-money-badge.ts`): el badge mínimo que la card de la agenda mete al first load
 * de `/agenda` (≤ 0,3 kB, §25.11). Existe aparte de `bookingMoneyBadge` (`lib/booking-money-view.ts`) solo por peso, así
 * que la regla tiene que ser LA MISMA: la paridad se afirma acá contra el símbolo real de TP-P5, no contra una copia.
 */
import { describe, expect, it } from "vitest";
import { cardMoneyBadge } from "@/lib/booking-money-badge";
import { bookingMoneyBadge } from "@/lib/booking-money-view";
import { formatARS } from "@/lib/format";
import { MONEY_BADGE_COPY } from "@/lib/online-payments-copy";

const CASES: { onlineDepositCents?: number | null; paidOnline?: boolean | null }[] = [
  {},
  { onlineDepositCents: 0, paidOnline: false },
  { onlineDepositCents: null, paidOnline: null },
  { onlineDepositCents: 600_000 },
  { onlineDepositCents: 1 },
  { onlineDepositCents: 600_000.7 },
  { onlineDepositCents: 600_000, paidOnline: true },
  { paidOnline: true },
  { onlineDepositCents: -5 },
  { onlineDepositCents: Number.NaN },
  { onlineDepositCents: Number.POSITIVE_INFINITY },
  { onlineDepositCents: Number.NEGATIVE_INFINITY },
];

describe("[TP-3e] cardMoneyBadge", () => {
  it("seña → «Seña» con data-badge «sena» y el monto en el nombre accesible", () => {
    expect(cardMoneyBadge({ onlineDepositCents: 600_000 })).toEqual(["sena", "Seña", `Seña pagada por Mercado Pago: ${formatARS(600_000)}`]);
  });

  it("pagado entero por Mercado Pago gana sobre la seña → «Pagado MP»", () => {
    expect(cardMoneyBadge({ onlineDepositCents: 600_000, paidOnline: true })).toEqual(["mp", "Pagado MP", "Pagado por Mercado Pago"]);
  });

  it("sin od/po, o con basura del cable (≤ 0, NaN, ±Infinity) → null", () => {
    for (const c of [{}, { onlineDepositCents: 0 }, { onlineDepositCents: -5 }, { onlineDepositCents: Number.NaN }, { onlineDepositCents: Infinity }]) {
      expect(cardMoneyBadge(c), JSON.stringify(c)).toBeNull();
    }
  });

  it("paridad con bookingMoneyBadge (TP-P5) y MONEY_BADGE_COPY en texto, nombre accesible y data-badge", () => {
    for (const c of CASES) {
      const ref = bookingMoneyBadge(c);
      const mini = cardMoneyBadge(c);
      expect(mini, String(c.onlineDepositCents)).toEqual(ref && [ref.dataBadge, ref.label, ref.ariaLabel]);
    }
    // Los textos están copiados en línea por peso: si cambia la fuente del vocabulario, esto frena.
    expect(cardMoneyBadge({ paidOnline: true })?.slice(1)).toEqual([MONEY_BADGE_COPY.paidMp.label, MONEY_BADGE_COPY.paidMp.aria]);
    expect(cardMoneyBadge({ onlineDepositCents: 100 })?.slice(1)).toEqual([MONEY_BADGE_COPY.deposit.label, MONEY_BADGE_COPY.deposit.aria(formatARS(100))]);
  });
});
