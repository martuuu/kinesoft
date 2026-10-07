/**
 * S14r (ES3, plan §16.2) · `planBalance`: el pactado de un plan CANCELLED es el
 * devengado. Antes seguía siendo el paquete entero (o precio × vivas) y un plan
 * cancelado a mitad mostraba como pactadas las sesiones que ya no se hacen.
 */
import { describe, expect, it } from "vitest";
import { planBalance } from "@/lib/plan-pricing";

const sessions = [
  { priceCents: 400_000, completed: true },
  { priceCents: 400_000, completed: false },
  { priceCents: 400_000, completed: false },
];

describe("planBalance · pactado de un plan CANCELLED", () => {
  it("PACKAGE cancelado: pactado = devengado; pendiente y a favor no cambian", () => {
    const pricing = { mode: "PACKAGE" as const, totalPriceCents: 1_200_000 };
    const bookings = [{ status: "COMPLETED" as const, paymentStatus: "PAID" as const, copagoCents: 400_000 }];
    const active = planBalance({ pricing, sessions, bookings, programStatus: "ACTIVE" });
    const cancelled = planBalance({ pricing, sessions, bookings, programStatus: "CANCELLED" });
    expect(active.agreedCents).toBe(1_200_000);
    expect(cancelled).toEqual({ ...active, agreedCents: 400_000 });
  });

  it("PER_SESSION cancelado: pactado = devengado (no precio × vivas)", () => {
    const r = planBalance({
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 400_000 },
      sessions,
      bookings: [],
      programStatus: "CANCELLED",
    });
    expect(r).toMatchObject({ agreedCents: 400_000, accruedCents: 400_000, pendingCents: 400_000 });
  });

  it("cancelado con un cobro de más: a favor sale del devengado", () => {
    const r = planBalance({
      pricing: { mode: "PACKAGE", totalPriceCents: 1_200_000 },
      sessions,
      bookings: [{ status: "CANCELLED", paymentStatus: "PAID", copagoCents: 800_000 }],
      programStatus: "CANCELLED",
    });
    expect(r).toMatchObject({ agreedCents: 400_000, collectedCents: 800_000, creditCents: 400_000, pendingCents: 0 });
  });

  it("sin precio sigue en null aunque esté cancelado", () => {
    const r = planBalance({ pricing: null, sessions, bookings: [], programStatus: "CANCELLED" });
    expect(r.agreedCents).toBeNull();
  });

  it("COMPLETED / PAUSED / sin status: el pactado de siempre", () => {
    const pricing = { mode: "PACKAGE" as const, totalPriceCents: 1_200_000 };
    for (const programStatus of ["COMPLETED", "PAUSED", undefined] as const) {
      expect(planBalance({ pricing, sessions, bookings: [], programStatus }).agreedCents).toBe(1_200_000);
    }
  });
});
