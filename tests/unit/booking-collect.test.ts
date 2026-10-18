/**
 * [AS-1k1] C-AS2 · `lib/booking-collect.ts`: lo puro del cobro del copago de un turno.
 *
 * `copagoRemainingCents` es lo que muestra «Marcar pagado · $ 6.000» en el modal de /sala (§23.4): el copago menos
 * lo que ya entró como seña. En T3 no hay señas (llega `deposits: []` y es el copago entero); T5 enchufa los
 * `Payment.kind = DEPOSIT` de Mercado Pago. Solo resta una seña COBRADA (`PAID`): una FAILED nunca entró y una
 * REFUNDED se devolvió, así que restarlas le haría cobrar de menos a la recepción.
 */
import { describe, expect, it } from "vitest";
import { COLLECT_COPY, copagoRemainingCents, type CopagoMarkInput } from "@/lib/booking-collect";

describe("[AS-1k1] copagoRemainingCents", () => {
  it("[AS-1k1] sin señas: el copago entero", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [] })).toBe(600_000);
  });

  it("[AS-1k1] con seña PAID: el copago menos la seña", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [{ amountCents: 200_000, status: "PAID" }] })).toBe(400_000);
    expect(
      copagoRemainingCents({
        resolvedCopagoCents: 600_000,
        deposits: [
          { amountCents: 100_000, status: "PAID" },
          { amountCents: 150_050, status: "PAID" },
        ],
      })
    ).toBe(349_950);
  });

  it("[AS-1k1] FAILED, REFUNDED y pendientes no restan", () => {
    expect(
      copagoRemainingCents({
        resolvedCopagoCents: 600_000,
        deposits: [
          { amountCents: 200_000, status: "FAILED" },
          { amountCents: 200_000, status: "REFUNDED" },
          { amountCents: 200_000, status: "PENDING" },
          { amountCents: 50_000, status: "PAID" },
        ],
      })
    ).toBe(550_000);
  });

  it("[AS-1k1] nunca < 0: una seña mayor al copago (el copago bajó después) deja 0", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 300_000, deposits: [{ amountCents: 500_000, status: "PAID" }] })).toBe(0);
    expect(copagoRemainingCents({ resolvedCopagoCents: 0, deposits: [] })).toBe(0);
  });

  it("[AS-1k1] una seña PAID con monto negativo o no entero no suma al restante (dato corrupto: falla del lado seguro)", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [{ amountCents: -100_000, status: "PAID" }] })).toBe(600_000);
  });
});

describe("[AS-1k1] CopagoMarkInput y copy", () => {
  it("[AS-1k1] la union discrimina por `paid` (marcar exige medio; desmarcar no lleva)", () => {
    const mark: CopagoMarkInput = { paid: true, method: "CASH" };
    const unmark: CopagoMarkInput = { paid: false };
    // @ts-expect-error marcar sin medio no compila
    const bad: CopagoMarkInput = { paid: true };
    expect([mark.paid, unmark.paid, bad.paid]).toEqual([true, false, true]);
  });

  it("[AS-1k1] mensajes literales de C-AS2", () => {
    expect(COLLECT_COPY).toEqual({
      ownOnly: "Solo podés registrar el cobro de tus propios turnos.",
      roleCannotCollect: "Tu rol no registra cobros.",
      insurerOnly: "Solo Facturación, el titular o el administrador/a confirman pagos de obra social.",
      mercadoPagoLocked: "Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.",
      methodRequired: "Elegí cómo pagó.",
    });
  });
});
