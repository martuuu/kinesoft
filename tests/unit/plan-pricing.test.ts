/**
 * S16p · Plata pura de Planes (PLANES.md C5, P4, P7). Escritos antes de
 * implementar (C14: funcionalidad nueva → `it`, no `it.fails`).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`): nada acá
 * depende del huso del host; los instantes se arman con offset explícito.
 */
import { describe, expect, it } from "vitest";
import {
  bookingHasMoney,
  distributePackage,
  isLockedForReprice,
  planBalance,
  priorPaidStamp,
  repriceLockReason,
  repricePlan,
  type PricingBooking,
  type RepriceSessionRow,
} from "@/lib/plan-pricing";

const NOW = new Date("2026-10-10T15:00:00.000Z"); // sáb 10/10 12:00 AR
const FUTURE = "2026-10-20T12:00:00.000Z";
const PAST = "2026-10-01T12:00:00.000Z";

function booking(over: Partial<PricingBooking> = {}): PricingBooking {
  return {
    id: "b1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    insurerPaidAt: null,
    payment: null,
    copagoCents: null,
    pricedByPlan: false,
    scheduledFor: FUTURE,
    ...over,
  };
}

function session(over: Partial<RepriceSessionRow> = {}): RepriceSessionRow {
  return {
    id: "s1",
    index: 1,
    scheduledFor: FUTURE,
    completedAt: null,
    priceCents: null,
    bookings: [],
    ...over,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("distributePackage (P4)", () => {
  it("100.000 / 3 = 33.334 + 33.333 + 33.333 en pesos enteros, Σ = total", () => {
    const parts = distributePackage(10_000_000, 3);
    expect(parts).toEqual([3_333_400, 3_333_300, 3_333_300]);
    expect(sum(parts)).toBe(10_000_000);
    // Todas las cuotas son pesos enteros.
    expect(parts.every((p) => p % 100 === 0)).toBe(true);
  });

  it("total no redondo → reparto en centavos, resto en las primeras, Σ = total", () => {
    const parts = distributePackage(10_000_001, 3); // $100.000,01
    expect(parts).toEqual([3_333_334, 3_333_334, 3_333_333]);
    expect(sum(parts)).toBe(10_000_001);
  });

  it("Σ = total para una grilla de totales y cantidades", () => {
    for (const total of [0, 1, 99, 100, 101, 12_345_67, 10_000_000, 99_999_99]) {
      for (let n = 1; n <= 60; n += 7) {
        const parts = distributePackage(total, n);
        expect(parts).toHaveLength(n);
        expect(sum(parts)).toBe(total);
        // Diferencia máxima entre cuotas: 1 unidad (peso o centavo).
        const unit = total % 100 === 0 ? 100 : 1;
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(unit);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }
    }
  });

  it("rechaza entradas que no son plata en centavos", () => {
    expect(() => distributePackage(100.5, 2)).toThrow();
    expect(() => distributePackage(-100, 2)).toThrow();
    expect(() => distributePackage(100, 0)).toThrow();
  });
});

describe("bookingHasMoney (criterio canónico de bookings-cancel-internal)", () => {
  it("PAID / AUTHORIZED / REFUNDED, Payment con plata o insurerPaidAt", () => {
    expect(bookingHasMoney(booking())).toBe(false);
    expect(bookingHasMoney(booking({ paymentStatus: "PAID" }))).toBe(true);
    expect(bookingHasMoney(booking({ paymentStatus: "AUTHORIZED" }))).toBe(true);
    expect(bookingHasMoney(booking({ paymentStatus: "REFUNDED" }))).toBe(true);
    expect(bookingHasMoney(booking({ paymentStatus: "FAILED" }))).toBe(false);
    expect(bookingHasMoney(booking({ payment: { status: "PAID" } }))).toBe(true);
    expect(bookingHasMoney(booking({ payment: { status: "FAILED" } }))).toBe(false);
    expect(bookingHasMoney(booking({ insurerPaidAt: PAST }))).toBe(true);
  });
});

describe("isLockedForReprice (C5 · fila bloqueada)", () => {
  it("libre: futura, sin cobro, turno estampado por el plan", () => {
    const s = session({
      priceCents: 500_000,
      bookings: [booking({ pricedByPlan: true, copagoCents: 500_000 })],
    });
    expect(repriceLockReason(s, NOW)).toBeNull();
    expect(isLockedForReprice(s, NOW)).toBe(false);
  });

  it("libre: sesión futura sin turno", () => {
    expect(isLockedForReprice(session({ priceCents: 500_000 }), NOW)).toBe(false);
  });

  it("cobro en el turno activo o en uno previo cancelado → money", () => {
    expect(repriceLockReason(session({ bookings: [booking({ paymentStatus: "PAID" })] }), NOW)).toBe("money");
    expect(
      repriceLockReason(
        session({ bookings: [booking({ id: "old", status: "CANCELLED", payment: { status: "PAID" } })] }),
        NOW
      )
    ).toBe("money");
  });

  it("copago manual → manual-copago", () => {
    // Sin plan pero con copago cargado a mano.
    expect(repriceLockReason(session({ bookings: [booking({ copagoCents: 300_000 })] }), NOW)).toBe(
      "manual-copago"
    );
    // Estampado por el plan pero editado: ya no espeja la cuota.
    expect(
      repriceLockReason(
        session({ priceCents: 500_000, bookings: [booking({ pricedByPlan: true, copagoCents: 450_000 })] }),
        NOW
      )
    ).toBe("manual-copago");
  });

  it("realizada → completed (devengado)", () => {
    expect(repriceLockReason(session({ completedAt: PAST }), NOW)).toBe("completed");
  });

  it("medianoche AR: scheduledFor ≤ now bloquea, aunque el host esté en UTC", () => {
    // 00:00 AR del 11/10 = 03:00Z. En UTC el host ve "11/10 03:00", en AR
    // "11/10 00:00": la comparación es de instantes, no de fechas del host.
    const midnightAR = "2026-10-11T03:00:00.000Z";
    const at = new Date(midnightAR);
    const s = session({
      scheduledFor: midnightAR,
      priceCents: 500_000,
      bookings: [booking({ scheduledFor: midnightAR, pricedByPlan: true, copagoCents: 500_000 })],
    });
    expect(repriceLockReason(s, at)).toBe("past"); // igual → bloqueada
    expect(repriceLockReason(s, new Date(at.getTime() - 1))).toBeNull(); // 1 ms antes → libre
    // 23:59:59.999 AR del 10/10 vs turno 00:00 AR del 11/10 → libre.
    expect(repriceLockReason(s, new Date("2026-10-11T02:59:59.999Z"))).toBeNull();
  });

  it("estado de pago raro (FAILED en la fila) → payment-state, el CAS de re-estampado no lo agarraría", () => {
    expect(
      repriceLockReason(session({ bookings: [booking({ paymentStatus: "FAILED", pricedByPlan: true })] }), NOW)
    ).toBe("payment-state");
  });
});

describe("repricePlan", () => {
  const stamped = (id: string, idx: number, price: number, at = FUTURE): RepriceSessionRow =>
    session({
      id,
      index: idx,
      scheduledFor: at,
      priceCents: price,
      bookings: [booking({ id: `b-${id}`, scheduledFor: at, pricedByPlan: true, copagoCents: price })],
    });

  it("PACKAGE: lo bloqueado queda y el resto se reparte entre las libres (por fecha)", () => {
    const rows = [
      session({ id: "s1", index: 1, scheduledFor: PAST, completedAt: PAST, priceCents: 4_000_000 }),
      stamped("s3", 3, 3_000_000, "2026-10-24T12:00:00.000Z"),
      stamped("s2", 2, 3_000_000, "2026-10-17T12:00:00.000Z"),
    ];
    const r = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 10_000_100 }, sessions: rows, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = new Map(r.sessions.map((s) => [s.sessionId, s]));
    expect(by.get("s1")!.priceCents).toBe(4_000_000);
    expect(by.get("s1")!.locked).toBe("completed");
    // 60.001 en 2 → 30.001 + 30.000; el resto va a la primera POR FECHA (s2).
    expect(by.get("s2")!.priceCents).toBe(3_000_100);
    expect(by.get("s3")!.priceCents).toBe(3_000_000);
    expect(sum(r.sessions.map((s) => s.priceCents ?? 0))).toBe(10_000_100);
    // Solo s2 cambia de cuota → un re-estampado (rama a), con el copago esperado.
    expect(r.stamps).toEqual([
      {
        bookingId: "b-s2",
        sessionId: "s2",
        branch: "restamp",
        expectedCopagoCents: 3_000_000,
        copagoCents: 3_000_100,
        pricedByPlan: true,
      },
    ]);
    expect(r.program).toEqual({ pricingMode: "PACKAGE", totalPriceCents: 10_000_100, pricePerSessionCents: null });
  });

  it("PACKAGE: reparto en centavos cuando la diferencia no es redonda", () => {
    const rows = [stamped("a", 1, 0), stamped("b", 2, 0, "2026-10-21T12:00:00.000Z"), stamped("c", 3, 0, "2026-10-22T12:00:00.000Z")];
    // $1,01: no es un número redondo de pesos → centavos, resto a las primeras.
    const r = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 101 }, sessions: rows, now: NOW });
    expect(r.ok && r.sessions.map((s) => s.priceCents)).toEqual([34, 34, 33]);
    // $1 redondo → en pesos: uno se lleva el peso entero.
    const r2 = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 100 }, sessions: rows, now: NOW });
    expect(r2.ok && r2.sessions.map((s) => s.priceCents)).toEqual([100, 0, 0]);
  });

  it("PACKAGE: total menor que lo bloqueado → error", () => {
    const rows = [
      session({ id: "s1", completedAt: PAST, scheduledFor: PAST, priceCents: 5_000_000 }),
      stamped("s2", 2, 5_000_000),
    ];
    const r = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 4_000_000 }, sessions: rows, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "below-locked" });
  });

  it("PACKAGE sin filas libres y total distinto → error literal", () => {
    const rows = [
      session({ id: "s1", completedAt: PAST, scheduledFor: PAST, priceCents: 5_000_000 }),
      session({ id: "s2", index: 2, priceCents: 5_000_000, bookings: [booking({ paymentStatus: "PAID", copagoCents: 5_000_000, pricedByPlan: true })] }),
    ];
    const r = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 12_000_000 }, sessions: rows, now: NOW });
    expect(r).toEqual({
      ok: false,
      code: "no-free-rows",
      error: "No quedan sesiones sin cobrar para repartir la diferencia",
    });
    // Mismo total que lo bloqueado → OK sin cambios.
    const same = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 10_000_000 }, sessions: rows, now: NOW });
    expect(same.ok && same.stamps).toEqual([]);
  });

  it("[P2-Z] PACKAGE con una fila bloqueada SIN cuota → locked-unpriced (no un I6 al commitear)", () => {
    // "Sin precio" con la sesión 1 realizada: su cuota es null y no se puede
    // re-preciar (devengada). Antes el reparto la contaba como $0 y dejaba una
    // sesión viva sin cuota en un paquete → el verificador tiraba I6 → 500.
    const rows = [
      session({ id: "s1", completedAt: PAST, scheduledFor: PAST, priceCents: null }),
      session({ id: "s2", index: 2, bookings: [booking({ id: "b2" })] }),
    ];
    const r = repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 10_000_000 }, sessions: rows, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "locked-unpriced" });
    expect(!r.ok && r.error).toMatch(/precio por sesión/);
    // PER_SESSION sí se puede: la fila bloqueada queda sin cuota (I6 es solo de paquetes).
    const per = repricePlan({ pricing: { mode: "PER_SESSION", pricePerSessionCents: 300_000 }, sessions: rows, now: NOW });
    expect(per.ok && per.sessions.map((s) => s.priceCents)).toEqual([null, 300_000]);
    // Una fila bloqueada CON cuota sigue funcionando como antes.
    const priced = [{ ...rows[0], priceCents: 0 }, rows[1]];
    expect(repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 10_000_000 }, sessions: priced, now: NOW }).ok).toBe(true);
  });

  it("PER_SESSION: las libres toman el precio nuevo, las bloqueadas quedan", () => {
    const rows = [session({ id: "s1", scheduledFor: PAST, priceCents: 400_000 }), stamped("s2", 2, 400_000)];
    const r = repricePlan({ pricing: { mode: "PER_SESSION", pricePerSessionCents: 450_000 }, sessions: rows, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessions.map((s) => [s.sessionId, s.priceCents, s.locked])).toEqual([
      ["s1", 400_000, "past"],
      ["s2", 450_000, null],
    ]);
    expect(r.stamps).toHaveLength(1);
    expect(r.stamps[0]).toMatchObject({ branch: "restamp", expectedCopagoCents: 400_000, copagoCents: 450_000 });
  });

  it("de 'sin precio' a 'con precio': primer estampado (rama b) sobre turnos sin copago", () => {
    const rows = [session({ id: "s1", bookings: [booking({ id: "b1" })] })];
    const r = repricePlan({ pricing: { mode: "PER_SESSION", pricePerSessionCents: 300_000 }, sessions: rows, now: NOW });
    expect(r.ok && r.stamps).toEqual([
      { bookingId: "b1", sessionId: "s1", branch: "first", expectedCopagoCents: null, copagoCents: 300_000, pricedByPlan: true },
    ]);
  });

  it("a 'sin precio': desestampa los turnos del plan libres", () => {
    const rows = [stamped("s1", 1, 300_000)];
    const r = repricePlan({ pricing: null, sessions: rows, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessions[0].priceCents).toBeNull();
    expect(r.stamps).toEqual([
      { bookingId: "b-s1", sessionId: "s1", branch: "unstamp", expectedCopagoCents: 300_000, copagoCents: null, pricedByPlan: false },
    ]);
    expect(r.program).toEqual({ pricingMode: null, totalPriceCents: null, pricePerSessionCents: null });
  });

  it("cobro previo: la sesión queda bloqueada, su cuota no se toca", () => {
    const rows = [
      session({
        id: "s1",
        priceCents: 500_000,
        bookings: [
          booking({ id: "old", status: "NO_SHOW", scheduledFor: PAST, paymentStatus: "PAID", copagoCents: 500_000, pricedByPlan: true }),
          booking({ id: "new", pricedByPlan: true, copagoCents: 0 }),
        ],
      }),
      stamped("s2", 2, 500_000),
    ];
    const r = repricePlan({ pricing: { mode: "PER_SESSION", pricePerSessionCents: 600_000 }, sessions: rows, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessions[0]).toMatchObject({ sessionId: "s1", priceCents: 500_000, locked: "money" });
    expect(r.stamps.map((s) => s.bookingId)).toEqual(["b-s2"]);
  });

  it("rechaza montos inválidos", () => {
    expect(
      repricePlan({ pricing: { mode: "PER_SESSION", pricePerSessionCents: -1 }, sessions: [], now: NOW })
    ).toMatchObject({ ok: false, code: "invalid-amount" });
    expect(
      repricePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 1.5 }, sessions: [], now: NOW })
    ).toMatchObject({ ok: false, code: "invalid-amount" });
  });
});

describe("priorPaidStamp (C5 · cobro previo)", () => {
  it("sin turno previo cobrado → la cuota de la sesión", () => {
    expect(priorPaidStamp({ priceCents: 500_000 }, [])).toEqual({
      copagoCents: 500_000,
      pricedByPlan: true,
      priorPaid: null,
    });
  });

  it("sin precio → copago null y pricedByPlan=false", () => {
    expect(priorPaidStamp({ priceCents: null }, [])).toEqual({ copagoCents: null, pricedByPlan: false, priorPaid: null });
  });

  it("turno previo cancelado/ausente con cobro → $0 y pricedByPlan=true, con la fecha del turno pagado", () => {
    const r = priorPaidStamp({ priceCents: 500_000 }, [
      booking({ id: "c1", status: "CANCELLED", scheduledFor: "2026-10-02T12:00:00.000Z" }),
      booking({ id: "n1", status: "NO_SHOW", scheduledFor: "2026-10-05T12:00:00.000Z", paymentStatus: "PAID" }),
    ]);
    expect(r).toEqual({
      copagoCents: 0,
      pricedByPlan: true,
      priorPaid: { bookingId: "n1", at: "2026-10-05T12:00:00.000Z" },
    });
  });

  it("aunque la sesión no tenga precio, un cobro previo estampa $0", () => {
    const r = priorPaidStamp({ priceCents: null }, [booking({ status: "CANCELLED", insurerPaidAt: PAST })]);
    expect(r).toMatchObject({ copagoCents: 0, pricedByPlan: true });
  });

  it("un turno activo cobrado NO es 'cobro previo'", () => {
    expect(priorPaidStamp({ priceCents: 100 }, [booking({ paymentStatus: "PAID" })]).priorPaid).toBeNull();
  });

  // PD-08 ("Ausente con pago previo → reemplazo en $0"): "pago previo" es plata
  // cobrada de verdad. Un REFUNDED se devolvió y un AUTHORIZED está retenido
  // (puede caerse): si estampaban $0, el turno nuevo quedaba gratis mientras
  // `planBalance` no los cuenta como cobrados → la cuota no se cobraba nunca.
  it("[P0-Z] previo REFUNDED o AUTHORIZED NO es cobro previo → cuota normal", () => {
    for (const paymentStatus of ["REFUNDED", "AUTHORIZED"] as const) {
      expect(
        priorPaidStamp({ priceCents: 500_000 }, [
          booking({ id: "old", status: "NO_SHOW", scheduledFor: PAST, paymentStatus, copagoCents: 500_000 }),
        ])
      ).toEqual({ copagoCents: 500_000, pricedByPlan: true, priorPaid: null });
      expect(
        priorPaidStamp({ priceCents: 500_000 }, [
          booking({ id: "old", status: "CANCELLED", scheduledFor: PAST, payment: { status: paymentStatus } }),
        ]).priorPaid
      ).toBeNull();
    }
  });

  it("[P0-Z] previo PAID (booking o Payment de MP) u OS pagada → $0", () => {
    for (const over of [
      { paymentStatus: "PAID" as const },
      { payment: { status: "PAID" as const } },
      { insurerPaidAt: PAST },
    ]) {
      expect(
        priorPaidStamp({ priceCents: 500_000 }, [booking({ id: "old", status: "NO_SHOW", scheduledFor: PAST, ...over })])
      ).toEqual({ copagoCents: 0, pricedByPlan: true, priorPaid: { bookingId: "old", at: new Date(PAST).toISOString() } });
    }
  });

  it("[P0-Z] REFUNDED previo: cuota normal y saldo coherente (la sesión se cobra una vez, no cero)", () => {
    const stamp = priorPaidStamp({ priceCents: 500_000 }, [
      booking({ id: "old", status: "NO_SHOW", paymentStatus: "REFUNDED", copagoCents: 500_000, scheduledFor: PAST }),
    ]);
    const r = planBalance({
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
      sessions: [{ priceCents: 500_000, completed: true }],
      bookings: [
        { status: "NO_SHOW", paymentStatus: "REFUNDED", copagoCents: 500_000 },
        { status: "COMPLETED", paymentStatus: "PAID", copagoCents: stamp.copagoCents },
      ],
    });
    expect(r).toMatchObject({ accruedCents: 500_000, collectedCents: 500_000, pendingCents: 0, creditCents: 0 });
  });

  it("[P0-Z] el criterio de bloqueo del reprecio no cambia: REFUNDED/AUTHORIZED siguen bloqueando la fila", () => {
    for (const paymentStatus of ["REFUNDED", "AUTHORIZED"] as const) {
      expect(
        repriceLockReason(session({ bookings: [booking({ id: "old", status: "CANCELLED", paymentStatus })] }), NOW)
      ).toBe("money");
    }
  });
});

describe("planBalance (P7)", () => {
  it("saldo con un cancelado cobrado: cuenta como cobrado; REFUNDED no; AUTHORIZED en proceso", () => {
    const r = planBalance({
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
      sessions: [
        { priceCents: 500_000, completed: true },
        { priceCents: 500_000, completed: true },
        { priceCents: 500_000, completed: false },
      ],
      bookings: [
        { status: "COMPLETED", paymentStatus: "PAID", copagoCents: 500_000 },
        { status: "CANCELLED", paymentStatus: "PAID", copagoCents: 500_000 },
        { status: "COMPLETED", paymentStatus: "REFUNDED", copagoCents: 500_000 },
        { status: "CONFIRMED", paymentStatus: "AUTHORIZED", copagoCents: 500_000 },
        { status: "CONFIRMED", paymentStatus: "UNPAID", copagoCents: 500_000 },
      ],
    });
    expect(r).toEqual({
      agreedCents: 1_500_000,
      accruedCents: 1_000_000,
      collectedCents: 1_000_000,
      inProcessCents: 500_000,
      pendingCents: 0,
      creditCents: 0,
    });
  });

  it("PACKAGE: pactado = paquete; pendiente y a favor nunca negativos a la vez", () => {
    const base = {
      pricing: { mode: "PACKAGE" as const, totalPriceCents: 12_000_000 },
      sessions: [
        { priceCents: 4_000_000, completed: true },
        { priceCents: 4_000_000, completed: false },
        { priceCents: 4_000_000, completed: false },
      ],
    };
    const owes = planBalance({ ...base, bookings: [] });
    expect(owes).toMatchObject({ agreedCents: 12_000_000, accruedCents: 4_000_000, pendingCents: 4_000_000, creditCents: 0 });
    const ahead = planBalance({
      ...base,
      bookings: [{ status: "CONFIRMED", paymentStatus: "PAID", copagoCents: 10_000_000 }],
    });
    expect(ahead).toMatchObject({ collectedCents: 10_000_000, pendingCents: 0, creditCents: 6_000_000 });
  });

  it("cobro previo → cuota 0 en el turno nuevo y saldo coherente (no se cobra dos veces)", () => {
    // Sesión 1 de $5.000: turno ausente cobrado + turno nuevo estampado en $0 y realizado.
    const stamp = priorPaidStamp({ priceCents: 500_000 }, [
      booking({ id: "old", status: "NO_SHOW", paymentStatus: "PAID", copagoCents: 500_000, scheduledFor: PAST }),
    ]);
    expect(stamp.copagoCents).toBe(0);
    const r = planBalance({
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
      sessions: [{ priceCents: 500_000, completed: true }],
      bookings: [
        { status: "NO_SHOW", paymentStatus: "PAID", copagoCents: 500_000 },
        { status: "COMPLETED", paymentStatus: "UNPAID", copagoCents: stamp.copagoCents },
      ],
    });
    expect(r).toMatchObject({ accruedCents: 500_000, collectedCents: 500_000, pendingCents: 0, creditCents: 0 });
  });

  it("sin precio → pactado null; devengado ignora cuotas null", () => {
    const r = planBalance({
      pricing: null,
      sessions: [{ priceCents: null, completed: true }],
      bookings: [],
    });
    expect(r).toMatchObject({ agreedCents: null, accruedCents: 0, collectedCents: 0, pendingCents: 0 });
  });
});
