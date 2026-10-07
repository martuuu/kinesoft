/**
 * S14r (ES3) · parte pura de los ingresos del dashboard (`lib/dashboard-revenue.ts`)
 * y del blob `dashboardPrefs` (`lib/preferences-constants.ts`).
 *
 * Corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`): los bordes se
 * escriben como instantes con offset explícito, así que un `getDay()` del host
 * que se colara daría distinto en los dos husos.
 */
import { describe, expect, it } from "vitest";
import { revenuePeriod, summarizeRevenue, revenueTitle } from "@/lib/dashboard-revenue";
import {
  DashboardPrefsPatchSchema,
  DEFAULT_DASHBOARD_PREFS,
  DEFAULT_PREFERENCES,
  sanitizeDashboardPrefs,
} from "@/lib/preferences-constants";

const ar = (s: string) => new Date(`${s}-03:00`);

describe("revenuePeriod · semana lunes→domingo AR", () => {
  it("domingo 23:30 AR (= lunes 02:30 UTC) sigue en la semana que empezó el lunes anterior", () => {
    // 2026-10-11 es domingo.
    const p = revenuePeriod("week", ar("2026-10-11T23:30:00"));
    expect(p.start.toISOString()).toBe(ar("2026-10-05T00:00:00").toISOString());
    expect(p.end.toISOString()).toBe(ar("2026-10-12T00:00:00").toISOString());
    expect(p.prevStart.toISOString()).toBe(ar("2026-09-28T00:00:00").toISOString());
    expect(p.prevEnd.toISOString()).toBe(p.start.toISOString());
  });

  it("lunes 00:00 AR abre la semana nueva", () => {
    const p = revenuePeriod("week", ar("2026-10-12T00:00:00"));
    expect(p.start.toISOString()).toBe(ar("2026-10-12T00:00:00").toISOString());
  });
});

describe("revenuePeriod · mes AR", () => {
  it("el 31 a las 23:30 AR (ya es día 1 en UTC) sigue en su mes", () => {
    const p = revenuePeriod("month", ar("2026-10-31T23:30:00"));
    expect(p.start.toISOString()).toBe(ar("2026-10-01T00:00:00").toISOString());
    expect(p.end.toISOString()).toBe(ar("2026-11-01T00:00:00").toISOString());
    expect(p.prevStart.toISOString()).toBe(ar("2026-09-01T00:00:00").toISOString());
  });

  it("enero compara contra diciembre del año anterior", () => {
    const p = revenuePeriod("month", ar("2027-01-15T10:00:00"));
    expect(p.prevStart.toISOString()).toBe(ar("2026-12-01T00:00:00").toISOString());
    expect(p.end.toISOString()).toBe(ar("2027-02-01T00:00:00").toISOString());
  });
});

describe("summarizeRevenue", () => {
  it("ingresos = MP + copagos; la OS va aparte y no suma; delta vs el anterior", () => {
    const s = summarizeRevenue(
      "week",
      { mpCents: 1_000_000, manualCents: 500_000, insurerCents: 500_000 },
      { mpCents: 1_000_000, manualCents: 0 }
    );
    expect(s).toMatchObject({
      range: "week",
      totalCents: 1_500_000,
      insurerCents: 500_000,
      prevTotalCents: 1_000_000,
      deltaPct: 50,
      privateShare: 75,
      insurerShare: 25,
    });
  });

  it("sin base anterior → delta null; sin nada → reparto 0/0", () => {
    const s = summarizeRevenue("month", { mpCents: 0, manualCents: 0, insurerCents: 0 }, { mpCents: 0, manualCents: 0 });
    expect(s).toMatchObject({ totalCents: 0, deltaPct: null, privateShare: 0, insurerShare: 0 });
  });

  it("el reparto siempre suma 100 (redondeo)", () => {
    const s = summarizeRevenue("month", { mpCents: 1, manualCents: 0, insurerCents: 2 }, { mpCents: 0, manualCents: 0 });
    expect(s.privateShare + s.insurerShare).toBe(100);
  });

  it("títulos literales del plan", () => {
    expect(revenueTitle("week")).toBe("Ingresos de la semana");
    expect(revenueTitle("month")).toBe("Ingresos del mes");
  });
});

describe("dashboardPrefs", () => {
  it("lectura total: NULL, basura o rango inválido → default (mes)", () => {
    expect(DEFAULT_PREFERENCES.dashboard).toEqual(DEFAULT_DASHBOARD_PREFS);
    expect(sanitizeDashboardPrefs(null)).toEqual({ revenueRange: "month" });
    expect(sanitizeDashboardPrefs([1, 2])).toEqual({ revenueRange: "month" });
    expect(sanitizeDashboardPrefs({ revenueRange: "3m" })).toEqual({ revenueRange: "month" });
    expect(sanitizeDashboardPrefs({ revenueRange: "week", extra: 1 })).toEqual({ revenueRange: "week" });
  });

  it("escritura estricta: rango fuera de dominio o campo desconocido → rechazo", () => {
    expect(DashboardPrefsPatchSchema.safeParse({ revenueRange: "week" }).success).toBe(true);
    expect(DashboardPrefsPatchSchema.safeParse({ revenueRange: "year" }).success).toBe(false);
    expect(DashboardPrefsPatchSchema.safeParse({ revenueRange: "week", x: 1 }).success).toBe(false);
  });
});
