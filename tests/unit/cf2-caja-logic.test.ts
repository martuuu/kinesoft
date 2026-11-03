/**
 * CF2 · P-K · caja por profesional (parte pura): `lib/caja-logic.ts`.
 *
 * Contratos que fija (plan §29, D-CF2-16/17/18 + decisión 4):
 *   - conservación: sin proyectar, Σ neto = Σ bruto (lo que uno destina lo recibe otro, al centavo);
 *   - el reparto aplica SOLO a las fuentes marcadas en la regla, con redondeo half-up por grupo (día × fuente ×
 *     regla, después de plegar los medios de pago);
 *   - scopes: Titular/Admin/Facturación `tenant`; Secretaria `desk` (hoy, sin OS); profesional `own` (nunca el bruto
 *     ajeno); soporte y el resto `none`;
 *   - períodos AR en TZ=UTC: el 31-oct 23:30 AR (= 1-nov 02:30 UTC) sigue siendo el 31 y octubre.
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`); los instantes van con offset explícito.
 */
import { describe, expect, it } from "vitest";
import {
  buildCajaPageData,
  cajaHref,
  cajaPeriodFor,
  cajaPeriodWire,
  cajaScopeFor,
  cajaSourcesFor,
  cashTodayFrom,
  methodBreakdown,
  parseCajaSearchParams,
  projectCajaForScope,
  projectRulesForScope,
  settleRevenueShares,
} from "@/lib/caja-logic";
import type { CajaScope, CollectedGroup, SettlementResult } from "@/lib/caja-types";
import { capabilitiesFor, SUPPORT_CAPS, type Capability } from "@/lib/capabilities";
import { toARDateKey } from "@/lib/datetime-ar";
import type { RevenueShareRuleView } from "@/lib/revenue-share-types";

const ar = (s: string) => new Date(`${s}-03:00`);

const NAMES: Record<string, string> = { a: "Ana", b: "Beto", c: "Caro", d: "Dani" };

/** Grupo de la SQL. Por defecto: copago manual en efectivo de Ana, sin regla. */
function g(over: Partial<CollectedGroup> & { rule?: { to: string; bps: number; m?: boolean; o?: boolean; i?: boolean } }): CollectedGroup {
  const { rule, ...rest } = over;
  const pid = rest.practitionerId ?? "a";
  return {
    practitionerId: pid,
    practitionerName: NAMES[pid] ?? pid,
    source: "manual",
    method: "CASH",
    dayKey: "2026-10-31",
    amountCents: 10_000,
    count: 1,
    ruleId: rule ? `rule-${pid}` : null,
    receiverPractitionerId: rule ? rule.to : null,
    receiverName: rule ? (NAMES[rule.to] ?? rule.to) : null,
    shareBps: rule ? rule.bps : null,
    appliesManual: rule ? (rule.m ?? true) : null,
    appliesOnline: rule ? (rule.o ?? true) : null,
    appliesInsurer: rule ? (rule.i ?? true) : null,
    ...rest,
  };
}

const row = (r: SettlementResult, id: string) => r.rows.find((x) => x.practitionerId === id);
const sumNet = (r: SettlementResult) => r.rows.reduce((s, x) => s + x.net, 0);
const sumGross = (r: SettlementResult) => r.rows.reduce((s, x) => s + x.gross, 0);

describe("[CF2-PK7] cajaScopeFor (D-CF2-16)", () => {
  const caps = (...c: Capability[]) => new Set<Capability>(c);

  it("Titular / Admin / Facturación → tenant", () => {
    expect(cajaScopeFor(capabilitiesFor("OWNER"), "p1")).toEqual({ kind: "tenant" });
    expect(cajaScopeFor(capabilitiesFor("ADMIN"), null)).toEqual({ kind: "tenant" });
    expect(cajaScopeFor(capabilitiesFor("BILLING"), null)).toEqual({ kind: "tenant" });
  });
  it("Secretaria (billing.collect sin manage) → desk", () => {
    expect(cajaScopeFor(capabilitiesFor("ASSISTANT"), null)).toEqual({ kind: "desk" });
  });
  it("Profesional con profesional → own; sin profesional → none (nunca own con null)", () => {
    expect(cajaScopeFor(capabilitiesFor("PRACTITIONER"), "p1")).toEqual({ kind: "own", practitionerId: "p1" });
    expect(cajaScopeFor(capabilitiesFor("PRACTITIONER"), null)).toEqual({ kind: "none" });
  });
  it("collectOwn sin clinical.read → none", () => {
    expect(cajaScopeFor(caps("billing.collectOwn"), "p1")).toEqual({ kind: "none" });
  });
  it("soporte (sin billing.*) → none", () => {
    expect(cajaScopeFor(SUPPORT_CAPS, null)).toEqual({ kind: "none" });
    expect(cajaScopeFor(SUPPORT_CAPS, "p1")).toEqual({ kind: "none" });
  });
  it("sin membresía (caps vacías) → none: falla cerrado", () => {
    expect(cajaScopeFor(caps(), "p1")).toEqual({ kind: "none" });
  });
  it("fuentes visibles por scope: desk sin OS", () => {
    expect(cajaSourcesFor({ kind: "tenant" })).toEqual(["manual", "online", "insurer"]);
    expect(cajaSourcesFor({ kind: "own", practitionerId: "p" })).toEqual(["manual", "online", "insurer"]);
    expect(cajaSourcesFor({ kind: "desk" })).toEqual(["manual", "online"]);
    expect(cajaSourcesFor({ kind: "none" })).toEqual([]);
  });
});

describe("[CF2-PK8] settleRevenueShares: conservación y reparto", () => {
  it("sin reglas: neto = bruto por profesional, por fuente", () => {
    const r = settleRevenueShares([
      g({ amountCents: 5000 }),
      g({ amountCents: 3000, method: "TRANSFER" }),
      g({ source: "online", method: "MERCADO_PAGO", amountCents: 2000 }),
      g({ practitionerId: "b", source: "insurer", method: null, amountCents: 7000, count: 2 }),
    ]);
    expect(row(r, "a")).toMatchObject({
      bySource: { manual: 8000, online: 2000, insurer: 0 },
      gross: 10_000,
      count: 3,
      given: 0,
      received: 0,
      net: 10_000,
      givenTo: [],
      receivedFrom: [],
    });
    expect(row(r, "b")).toMatchObject({ gross: 7000, net: 7000, count: 2 });
    expect(r.totals).toEqual({
      bySource: { manual: 8000, online: 2000, insurer: 7000 },
      gross: 17_000,
      count: 5,
      given: 0,
      received: 0,
      net: 17_000,
    });
  });

  it("10 % de Ana a Beto: Ana destina, Beto recibe (aunque Beto no haya cobrado nada)", () => {
    const r = settleRevenueShares([g({ amountCents: 10_000, rule: { to: "b", bps: 1000 } })]);
    expect(row(r, "a")).toMatchObject({ gross: 10_000, given: 1000, net: 9000 });
    expect(row(r, "a")?.givenTo).toEqual([
      { practitionerId: "b", practitionerName: "Beto", cents: 1000, bySource: { manual: 1000, online: 0, insurer: 0 } },
    ]);
    expect(row(r, "b")).toMatchObject({ gross: 0, received: 1000, net: 1000 });
    expect(row(r, "b")?.receivedFrom).toEqual([
      { practitionerId: "a", practitionerName: "Ana", cents: 1000, bySource: { manual: 1000, online: 0, insurer: 0 } },
    ]);
    expect(sumNet(r)).toBe(sumGross(r));
    expect(r.totals.given).toBe(1000);
    expect(r.totals.received).toBe(1000);
  });

  it("[decisión 4] solo las fuentes marcadas: copagos sí, online no, OS sí", () => {
    const rule = { to: "b", bps: 2000, m: true, o: false, i: true };
    const r = settleRevenueShares([
      g({ source: "manual", amountCents: 10_000, rule }),
      g({ source: "online", method: "MERCADO_PAGO", amountCents: 10_000, rule }),
      g({ source: "insurer", method: null, amountCents: 10_000, rule }),
    ]);
    expect(row(r, "a")?.givenTo[0]?.bySource).toEqual({ manual: 2000, online: 0, insurer: 2000 });
    expect(row(r, "a")).toMatchObject({ gross: 30_000, given: 4000, net: 26_000 });
    expect(row(r, "b")).toMatchObject({ received: 4000, net: 4000 });
  });

  it("flags null con regla (no debería pasar): no se destina nada (falla cerrado a favor de quien cobró)", () => {
    const r = settleRevenueShares([
      { ...g({ rule: { to: "b", bps: 5000 } }), appliesManual: null },
    ]);
    expect(row(r, "a")).toMatchObject({ given: 0, net: 10_000 });
    expect(row(r, "b")).toBeUndefined();
  });

  it("regla a sí mismo (el CHECK de M21 lo impide) o bps 0: se ignora", () => {
    const r = settleRevenueShares([g({ rule: { to: "a", bps: 5000 } }), g({ dayKey: "2026-10-30", rule: { to: "b", bps: 0 } })]);
    expect(row(r, "a")).toMatchObject({ gross: 20_000, given: 0, received: 0, net: 20_000 });
  });

  it("redondeo half-up por grupo, DESPUÉS de plegar los medios (no por medio)", () => {
    // 3 medios de 1 centavo cada uno al 50 %: por medio daría 1+1+1 = 3; plegado: 3 × 0,5 = 1,5 → 2.
    const rule = { to: "b", bps: 5000 };
    const r = settleRevenueShares([
      g({ method: "CASH", amountCents: 1, rule }),
      g({ method: "TRANSFER", amountCents: 1, rule }),
      g({ method: "UNKNOWN", amountCents: 1, rule }),
    ]);
    expect(row(r, "a")?.given).toBe(2);
    expect(row(r, "b")?.received).toBe(2);
    expect(sumNet(r)).toBe(3);
  });

  it("redondeo por día: el mes es la suma de los días (misma cuenta en Día y en Mes)", () => {
    const rule = { to: "b", bps: 5000 };
    const days = ["2026-10-01", "2026-10-02", "2026-10-03"].map((dayKey) => g({ dayKey, amountCents: 1, rule }));
    const month = settleRevenueShares(days);
    const perDay = days.map((d) => settleRevenueShares([d]));
    expect(row(month, "a")?.given).toBe(perDay.reduce((s, r) => s + (row(r, "a")?.given ?? 0), 0));
    expect(row(month, "a")?.given).toBe(3);
  });

  it("un cambio de regla a mitad del período: cada grupo con la regla vigente al cobrar (historial)", () => {
    const r = settleRevenueShares([
      { ...g({ dayKey: "2026-10-01", amountCents: 10_000, rule: { to: "b", bps: 1000 } }), ruleId: "old" },
      { ...g({ dayKey: "2026-10-20", amountCents: 10_000, rule: { to: "c", bps: 3000 } }), ruleId: "new" },
    ]);
    expect(row(r, "a")?.givenTo.map((f) => [f.practitionerId, f.cents])).toEqual([
      ["b", 1000],
      ["c", 3000],
    ]);
    expect(row(r, "a")?.net).toBe(16_000);
    expect(sumNet(r)).toBe(20_000);
  });

  it("[propiedad] conservación al centavo con montos y % arbitrarios", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const ids = ["a", "b", "c", "d"];
    const sources = ["manual", "online", "insurer"] as const;
    for (let round = 0; round < 200; round++) {
      const groups: CollectedGroup[] = [];
      for (let k = 0; k < 12; k++) {
        const pid = ids[rnd(2)]; // a y b destinan; c y d reciben (sin cadenas)
        const withRule = rnd(3) > 0;
        groups.push(
          g({
            practitionerId: pid,
            source: sources[rnd(3)],
            method: rnd(2) ? "CASH" : "CARD",
            dayKey: `2026-10-${String(1 + rnd(28)).padStart(2, "0")}`,
            amountCents: rnd(1_000_000),
            count: 1 + rnd(3),
            rule: withRule ? { to: ids[2 + rnd(2)], bps: 1 + rnd(10_000), m: !!rnd(2), o: !!rnd(2), i: !!rnd(2) } : undefined,
          }),
        );
      }
      const r = settleRevenueShares(groups);
      expect(sumNet(r)).toBe(sumGross(r));
      expect(r.totals.net).toBe(r.totals.gross);
      expect(r.totals.given).toBe(r.totals.received);
      for (const x of r.rows) {
        expect(x.net).toBe(x.gross - x.given + x.received);
        expect(x.given).toBe(x.givenTo.reduce((s, f) => s + f.cents, 0));
        expect(x.given).toBeLessThanOrEqual(x.gross);
      }
    }
  });

  it("roster: los profesionales sin cobros aparecen en $0; filas por nombre", () => {
    const r = settleRevenueShares([g({ practitionerId: "c" })], [
      { practitionerId: "d", practitionerName: "Dani" },
      { practitionerId: "a", practitionerName: "Ana" },
      { practitionerId: "c", practitionerName: "Caro" },
    ]);
    expect(r.rows.map((x) => [x.practitionerName, x.gross])).toEqual([
      ["Ana", 0],
      ["Caro", 10_000],
      ["Dani", 0],
    ]);
  });
});

describe("[CF2-PK9] methodBreakdown («Por medio de pago», sin OS)", () => {
  it("suma por medio, online sin medio = Mercado Pago, UNKNOWN al final, sin OS ni ceros", () => {
    const m = methodBreakdown([
      g({ method: "TRANSFER", amountCents: 300 }),
      g({ practitionerId: "b", method: "CASH", amountCents: 100, count: 2 }),
      g({ method: "CASH", amountCents: 200 }),
      g({ method: "UNKNOWN", amountCents: 50 }),
      g({ source: "online", method: null, amountCents: 400 }),
      g({ source: "online", method: "MERCADO_PAGO", amountCents: 100 }),
      g({ source: "insurer", method: null, amountCents: 9999 }),
      g({ method: "CARD", amountCents: 0, count: 0 }),
    ]);
    expect(m).toEqual([
      { method: "CASH", cents: 300, count: 3 },
      { method: "TRANSFER", cents: 300, count: 1 },
      { method: "MERCADO_PAGO", cents: 500, count: 2 },
      { method: "UNKNOWN", cents: 50, count: 1 },
    ]);
  });
});

describe("[CF2-PK10] projectCajaForScope", () => {
  const rule = { to: "b", bps: 1000 };
  const groups = [
    g({ source: "manual", amountCents: 10_000, rule }),
    g({ source: "insurer", method: null, amountCents: 20_000, rule }),
    g({ practitionerId: "c", source: "online", method: "MERCADO_PAGO", amountCents: 5000 }),
    g({ practitionerId: "b", source: "manual", amountCents: 3000 }),
  ];
  const full = settleRevenueShares(groups);

  it("tenant: sin cambios", () => {
    expect(projectCajaForScope(full, { kind: "tenant" })).toEqual(full);
  });

  it("own (Beto): solo su fila; nunca el bruto de Ana aunque Ana le destine", () => {
    const p = projectCajaForScope(full, { kind: "own", practitionerId: "b" });
    expect(p.rows.map((x) => x.practitionerId)).toEqual(["b"]);
    expect(p.rows[0]).toMatchObject({ gross: 3000, received: 3000, net: 6000 });
    // Lo que recibe de Ana sí (es suyo); el bruto de Ana (30 000) no aparece en ningún lado.
    expect(JSON.stringify(p)).not.toContain("30000");
    expect(p.totals).toMatchObject({ gross: 3000, received: 3000, net: 6000, given: 0 });
  });

  it("own de alguien sin movimiento: sin filas ajenas", () => {
    const p = projectCajaForScope(full, { kind: "own", practitionerId: "d" });
    expect(p.rows).toEqual([]);
    expect(p.totals.gross).toBe(0);
  });

  it("desk: sin OS en ninguna parte (bruto, destina, recibe) y la conservación sigue", () => {
    const p = projectCajaForScope(full, { kind: "desk" });
    for (const x of p.rows) {
      expect(x.bySource.insurer).toBe(0);
      for (const f of [...x.givenTo, ...x.receivedFrom]) expect(f.bySource.insurer).toBe(0);
    }
    expect(row(p, "a")).toMatchObject({ gross: 10_000, given: 1000, net: 9000 });
    expect(row(p, "b")).toMatchObject({ gross: 3000, received: 1000, net: 4000 });
    expect(p.totals.bySource.insurer).toBe(0);
    expect(sumNet(p)).toBe(sumGross(p));
  });

  it("desk: un reparto que solo aplica a la OS desaparece (sin flujos en $0)", () => {
    const only = settleRevenueShares([g({ source: "insurer", method: null, rule: { to: "b", bps: 5000, m: false, o: false, i: true } })]);
    const p = projectCajaForScope(only, { kind: "desk" });
    expect(row(p, "a")?.givenTo).toEqual([]);
    expect(row(p, "b")?.receivedFrom).toEqual([]);
  });

  it("none: vacío", () => {
    const p = projectCajaForScope(full, { kind: "none" });
    expect(p.rows).toEqual([]);
    expect(p.totals.gross).toBe(0);
  });
});

describe("[CF2-INTP1] countBySource: el conteo por fuente viaja en la fila (sin WeakMap)", () => {
  const groups = [
    g({ amountCents: 10_000, count: 2 }),
    g({ source: "online", method: "MERCADO_PAGO", amountCents: 2000, count: 1 }),
    g({ source: "insurer", method: null, amountCents: 20_000, count: 3 }),
  ];

  it("settleRevenueShares llena countBySource y count = Σ countBySource", () => {
    const r = settleRevenueShares(groups, [{ practitionerId: "d", practitionerName: "Dani" }]);
    expect(row(r, "a")).toMatchObject({ count: 6, countBySource: { manual: 2, online: 1, insurer: 3 } });
    expect(row(r, "d")).toMatchObject({ count: 0, countBySource: { manual: 0, online: 0, insurer: 0 } });
  });

  it("desk descuenta los cobros de OS aunque la fila haya sido copiada (spread, RSC, structuredClone)", () => {
    const full = settleRevenueShares(groups);
    // Con el WeakMap, una copia de la fila perdía la apertura y la Secretaria veía «6 cobros» con 3 visibles.
    const copied = structuredClone(full);
    const p = projectCajaForScope(copied, { kind: "desk" });
    expect(row(p, "a")).toMatchObject({ count: 3, countBySource: { manual: 2, online: 1, insurer: 0 }, gross: 12_000 });
    expect(p.totals.count).toBe(3);
    // Mismos montos que sin copiar.
    expect(p).toEqual(projectCajaForScope(full, { kind: "desk" }));
  });
});

describe("[CF2-INTP2] cashTodayFrom trae a quién destina cada fila (givenTo, sin ceros)", () => {
  it("givenTo por receptor con su monto; Σ givenTo = givenCents; sin flujos en $0 ni de OS", () => {
    const now = ar("2026-10-31T18:05:00");
    const s = cashTodayFrom(
      [
        g({ amountCents: 10_000, rule: { to: "b", bps: 1000 } }),
        g({ practitionerId: "c", amountCents: 3000, rule: { to: "b", bps: 5000 } }),
        // Regla que solo aplica a la OS: no hay flujo visible (y la OS no entra).
        g({ practitionerId: "d", amountCents: 4000, rule: { to: "a", bps: 5000, m: false, o: false, i: true } }),
        g({ practitionerId: "d", source: "insurer", method: null, amountCents: 9000, rule: { to: "a", bps: 5000, m: false, o: false, i: true } }),
      ],
      now,
    );
    const by = (id: string) => s.rows.find((r) => r.practitionerId === id);
    expect(by("a")?.givenTo).toEqual([{ practitionerId: "b", practitionerName: "Beto", cents: 1000 }]);
    expect(by("c")?.givenTo).toEqual([{ practitionerId: "b", practitionerName: "Beto", cents: 1500 }]);
    expect(by("b")?.givenTo).toEqual([]);
    expect(by("d")).toMatchObject({ givenCents: 0, givenTo: [] });
    for (const r of s.rows) expect(r.givenTo.reduce((a, f) => a + f.cents, 0)).toBe(r.givenCents);
  });
});

describe("[CF2-PK11] cashTodayFrom (tarjeta «Cobrado hoy» de la Secretaria)", () => {
  it("sin OS, con destina/recibe, total = Σ bruto, solo profesionales con movimiento", () => {
    const now = ar("2026-10-31T18:05:00");
    const s = cashTodayFrom(
      [
        g({ amountCents: 10_000, rule: { to: "b", bps: 1000 } }),
        g({ source: "insurer", method: null, amountCents: 50_000, rule: { to: "b", bps: 1000 } }),
        g({ practitionerId: "c", source: "online", method: "MERCADO_PAGO", amountCents: 2500 }),
      ],
      now,
    );
    expect(s).toEqual({
      rows: [
        { practitionerId: "a", practitionerName: "Ana", grossCents: 10_000, givenCents: 1000, givenTo: [{ practitionerId: "b", practitionerName: "Beto", cents: 1000 }], receivedCents: 0, netCents: 9000 },
        { practitionerId: "b", practitionerName: "Beto", grossCents: 0, givenCents: 0, givenTo: [], receivedCents: 1000, netCents: 1000 },
        { practitionerId: "c", practitionerName: "Caro", grossCents: 2500, givenCents: 0, givenTo: [], receivedCents: 0, netCents: 2500 },
      ],
      totalCents: 12_500,
      computedAt: now.toISOString(),
    });
  });
});

describe("[CF2-PK12] parseCajaSearchParams / cajaHref", () => {
  it("defaults: Día, sin fecha ni mes", () => {
    expect(parseCajaSearchParams({})).toEqual({ view: "dia", date: null, month: null });
    expect(parseCajaSearchParams(undefined)).toEqual({ view: "dia", date: null, month: null });
  });
  it("valida fecha y mes de calendario; lo inválido queda null", () => {
    expect(parseCajaSearchParams({ vista: "mes", fecha: "2026-02-29", mes: "2026-13" })).toEqual({ view: "mes", date: null, month: null });
    expect(parseCajaSearchParams({ vista: "otra", fecha: "2028-02-29", mes: "2026-02" })).toEqual({
      view: "dia",
      date: "2028-02-29",
      month: "2026-02",
    });
    expect(parseCajaSearchParams({ fecha: "2026-10-31T00:00", mes: "2026-1" })).toEqual({ view: "dia", date: null, month: null });
  });
  it("valores repetidos (?fecha=a&fecha=b): toma el primero", () => {
    expect(parseCajaSearchParams({ fecha: ["2026-10-31", "2026-11-01"] }).date).toBe("2026-10-31");
  });
  it("URLSearchParams también", () => {
    expect(parseCajaSearchParams(new URLSearchParams("vista=mes&mes=2026-10"))).toEqual({ view: "mes", date: null, month: "2026-10" });
  });
  it("round-trip con cajaHref", () => {
    const day = cajaHref("dia", "2026-10-31");
    const month = cajaHref("mes", "2026-10");
    expect(day).toBe("/caja?vista=dia&fecha=2026-10-31");
    expect(month).toBe("/caja?vista=mes&mes=2026-10");
    expect(parseCajaSearchParams(new URLSearchParams(day.split("?")[1]))).toEqual({ view: "dia", date: "2026-10-31", month: null });
    expect(parseCajaSearchParams(new URLSearchParams(month.split("?")[1]))).toEqual({ view: "mes", date: null, month: "2026-10" });
    expect(cajaHref("dia")).toBe("/caja");
    expect(cajaHref("mes")).toBe("/caja?vista=mes");
  });
});

describe("[CF2-PK13] cajaPeriodFor en TZ=UTC (bordes AR)", () => {
  // 31-oct 23:30 AR = 1-nov 02:30 UTC: un toISOString().slice(0,10) del host diría «1-nov» y «noviembre».
  const now = ar("2026-10-31T23:30:00");
  const todayKey = toARDateKey(now);
  const tenant: CajaScope = { kind: "tenant" };

  it("el día de hoy a las 23:30 AR sigue siendo el 31", () => {
    expect(todayKey).toBe("2026-10-31");
    const p = cajaPeriodFor({ view: "dia", date: null, month: null }, todayKey, tenant)!;
    expect(p.dayKey).toBe("2026-10-31");
    expect(p.monthKey).toBe("2026-10");
    expect(p.start.toISOString()).toBe(ar("2026-10-31T00:00:00").toISOString());
    expect(p.end.toISOString()).toBe(ar("2026-11-01T00:00:00").toISOString());
    expect(now >= p.start && now < p.end).toBe(true);
    expect(p).toMatchObject({ view: "dia", isCurrent: true, canNavigate: true, prev: "2026-10-30", next: "2026-11-01" });
  });

  it("Mes: octubre AR completo, aunque el host ya esté en noviembre", () => {
    const p = cajaPeriodFor({ view: "mes", date: null, month: null }, todayKey, tenant)!;
    expect(p).toMatchObject({ view: "mes", dayKey: null, monthKey: "2026-10", isCurrent: true, prev: "2026-09", next: "2026-11" });
    expect(p.start.toISOString()).toBe(ar("2026-10-01T00:00:00").toISOString());
    expect(p.end.toISOString()).toBe(ar("2026-11-01T00:00:00").toISOString());
  });

  it("Mes elegido; o el mes de la fecha si no hay mes; cruza el año", () => {
    const dec = cajaPeriodFor({ view: "mes", date: null, month: "2026-12" }, todayKey, tenant)!;
    expect(dec).toMatchObject({ monthKey: "2026-12", isCurrent: false, prev: "2026-11", next: "2027-01" });
    expect(dec.end.toISOString()).toBe(ar("2027-01-01T00:00:00").toISOString());
    const fromDate = cajaPeriodFor({ view: "mes", date: "2026-02-10", month: null }, todayKey, tenant)!;
    expect(fromDate.monthKey).toBe("2026-02");
    expect(fromDate.start.toISOString()).toBe(ar("2026-02-01T00:00:00").toISOString());
    expect(fromDate.end.toISOString()).toBe(ar("2026-03-01T00:00:00").toISOString());
  });

  it("own navega como tenant", () => {
    const p = cajaPeriodFor({ view: "dia", date: "2026-09-15", month: null }, todayKey, { kind: "own", practitionerId: "p" })!;
    expect(p).toMatchObject({ dayKey: "2026-09-15", isCurrent: false, canNavigate: true });
  });

  it("Secretaria: siempre hoy (ignora vista, fecha y mes)", () => {
    const p = cajaPeriodFor({ view: "mes", date: "2026-09-15", month: "2026-09" }, todayKey, { kind: "desk" })!;
    expect(p).toMatchObject({ view: "dia", dayKey: "2026-10-31", isCurrent: true, canNavigate: false, prev: null, next: null });
    expect(p.start.toISOString()).toBe(ar("2026-10-31T00:00:00").toISOString());
  });

  it("none → null", () => {
    expect(cajaPeriodFor({ view: "dia", date: null, month: null }, todayKey, { kind: "none" })).toBeNull();
  });

  it("cajaPeriodWire: instantes en ISO", () => {
    const p = cajaPeriodFor({ view: "dia", date: null, month: null }, todayKey, tenant)!;
    const w = cajaPeriodWire(p);
    expect(w.startIso).toBe(p.start.toISOString());
    expect(w.endIso).toBe(p.end.toISOString());
    expect("start" in w).toBe(false);
  });
});

const ruleView = (over: Partial<RevenueShareRuleView>): RevenueShareRuleView => ({
  id: "r",
  giverPractitionerId: "a",
  giverName: "Ana",
  receiverPractitionerId: "b",
  receiverName: "Beto",
  shareBps: 1000,
  sources: { manual: true, online: true, insurer: true },
  effectiveFrom: "2026-10-01T12:00:00.000Z",
  effectiveTo: null,
  createdByName: null,
  closedByName: null,
  ...over,
});

describe("[CF2-PK14] projectRulesForScope + buildCajaPageData", () => {
  const rules = [ruleView({ id: "ab" }), ruleView({ id: "cd", giverPractitionerId: "c", receiverPractitionerId: "d" })];

  it("own: solo las reglas que lo involucran; none: ninguna", () => {
    expect(projectRulesForScope(rules, { kind: "own", practitionerId: "b" }).map((r) => r.id)).toEqual(["ab"]);
    expect(projectRulesForScope(rules, { kind: "own", practitionerId: "c" }).map((r) => r.id)).toEqual(["cd"]);
    expect(projectRulesForScope(rules, { kind: "tenant" })).toHaveLength(2);
    expect(projectRulesForScope(rules, { kind: "desk" })).toHaveLength(2);
    expect(projectRulesForScope(rules, { kind: "none" })).toEqual([]);
  });

  const now = ar("2026-10-31T23:30:00");
  const groups = [
    g({ amountCents: 10_000, rule: { to: "b", bps: 1000 } }),
    g({ source: "insurer", method: null, amountCents: 20_000, rule: { to: "b", bps: 1000 } }),
    g({ practitionerId: "b", method: "TRANSFER", amountCents: 3000 }),
  ];
  const roster = [
    { practitionerId: "a", practitionerName: "Ana" },
    { practitionerId: "b", practitionerName: "Beto" },
    { practitionerId: "c", practitionerName: "Caro" },
  ];
  const period = (scope: CajaScope, view: "dia" | "mes" = "dia") =>
    cajaPeriodFor({ view, date: null, month: null }, toARDateKey(now), scope)!;

  it("desk: sin OS (aunque la SQL la trajera), métodos del día, roster en $0", () => {
    const scope: CajaScope = { kind: "desk" };
    const d = buildCajaPageData({ scope, period: period(scope), groups, roster, rules, now })!;
    expect(d.scope).toBe("desk");
    expect(d.sources).toEqual(["manual", "online"]);
    expect(d.settlement.totals.bySource.insurer).toBe(0);
    expect(d.settlement.rows.map((r) => r.practitionerName)).toEqual(["Ana", "Beto", "Caro"]);
    expect(d.methods).toEqual([
      { method: "CASH", cents: 10_000, count: 1 },
      { method: "TRANSFER", cents: 3000, count: 1 },
    ]);
    expect(d.period.startIso).toBe(ar("2026-10-31T00:00:00").toISOString());
    expect(d.computedAt).toBe(now.toISOString());
  });

  it("own (Beto): su fila, sus métodos (no el efectivo de Ana), sus reglas", () => {
    const scope: CajaScope = { kind: "own", practitionerId: "b" };
    const d = buildCajaPageData({ scope, period: period(scope), groups, roster, rules, now })!;
    expect(d.settlement.rows.map((r) => r.practitionerId)).toEqual(["b"]);
    expect(d.settlement.rows[0]).toMatchObject({ gross: 3000, received: 3000, net: 6000 });
    expect(d.methods).toEqual([{ method: "TRANSFER", cents: 3000, count: 1 }]);
    expect(d.rules.map((r) => r.id)).toEqual(["ab"]);
  });

  it("Mes: sin «Por medio de pago»", () => {
    const scope: CajaScope = { kind: "tenant" };
    const d = buildCajaPageData({ scope, period: period(scope, "mes"), groups, roster, rules, now })!;
    expect(d.methods).toEqual([]);
    expect(d.settlement.totals.gross).toBe(33_000);
    expect(d.settlement.totals.net).toBe(33_000);
  });

  it("none → null", () => {
    expect(
      buildCajaPageData({ scope: { kind: "none" }, period: period({ kind: "tenant" }), groups, roster, rules, now }),
    ).toBeNull();
  });
});
