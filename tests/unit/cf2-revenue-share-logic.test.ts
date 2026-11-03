/**
 * CF2 · P-K · reparto de % (parte pura): `lib/revenue-share-logic.ts` y los zod de `lib/revenue-share-schemas.ts`.
 *
 * Contratos que fija (plan §29, decisión 4 + D-CF2-18):
 *   - el % entra como texto del form («12,5» / «12.5» / «12») y se pasa a bps ENTEROS sin float×100 (0,29 × 100 en
 *     float da 28,999999999999996: un `Math.floor` lo volvería 28 bps);
 *   - `shareOfCents` = half-up entero: floor((cents·bps + 5000) / 10000);
 *   - el grafo: sin auto-reparto, sin mutuos, sin cadenas (quien recibe no destina y viceversa).
 */
import { describe, expect, it } from "vitest";
import {
  formatSharePct,
  formatSharePctInput,
  openRuleForGiver,
  openRulesReceivedBy,
  openShareEdges,
  parseSharePct,
  ruleAppliesTo,
  rulesForGiver,
  shareOfCents,
  validateShareGraph,
} from "@/lib/revenue-share-logic";
import { EndRevenueShareSchema, SetRevenueShareSchema } from "@/lib/revenue-share-schemas";
import type { RevenueShareRuleView } from "@/lib/revenue-share-types";

describe("[CF2-PK1] parseSharePct: texto del form → bps enteros", () => {
  it.each([
    ["12", 1200],
    ["12,5", 1250],
    ["12.5", 1250],
    ["12,50", 1250],
    ["0,01", 1],
    ["0,29", 29],
    ["1,1", 110],
    ["33,33", 3333],
    ["100", 10_000],
    ["100,00", 10_000],
    ["  7,25 ", 725],
    ["15%", 1500],
    ["15 %", 1500],
    ["007", 700],
  ])("%j → %i", (raw, bps) => {
    expect(parseSharePct(raw)).toBe(bps);
  });

  it.each([
    "",
    "   ",
    "0",
    "0,00",
    "-5",
    "+5",
    "100,01",
    "101",
    "12,345",
    "12,",
    ",5",
    "1.000",
    "1,000",
    "1e2",
    "12,5,0",
    "doce",
    "NaN",
    "Infinity",
    "1000",
  ])("rechaza %j", (raw) => {
    expect(parseSharePct(raw)).toBeNull();
  });

  it("rechaza lo que no es string (un número del cliente no entra: el form manda texto)", () => {
    expect(parseSharePct(12)).toBeNull();
    expect(parseSharePct(null)).toBeNull();
    expect(parseSharePct(undefined)).toBeNull();
  });
});

describe("[CF2-PK2] formatSharePct / formatSharePctInput", () => {
  it.each([
    [1200, "12"],
    [1250, "12,5"],
    [1205, "12,05"],
    [1, "0,01"],
    [10_000, "100"],
    [3333, "33,33"],
  ])("%i bps → %j (input) y round-trip con parseSharePct", (bps, text) => {
    expect(formatSharePctInput(bps)).toBe(text);
    expect(formatSharePct(bps)).toBe(`${text}%`);
    expect(parseSharePct(formatSharePctInput(bps))).toBe(bps);
  });

  it("round-trip en todo el rango 1..10000", () => {
    for (let bps = 1; bps <= 10_000; bps++) {
      if (parseSharePct(formatSharePctInput(bps)) !== bps) throw new Error(`round-trip roto en ${bps}`);
    }
  });
});

describe("[CF2-PK3] shareOfCents: half-up entero", () => {
  it.each([
    // cents, bps, esperado
    [10_000, 1000, 1000], // 10 % de $100
    [12_345, 1000, 1235], // 1234,5 → 1235 (half-up)
    [12_344, 1000, 1234], // 1234,4 → 1234
    [1, 5000, 1], // 0,5 → 1
    [1, 4999, 0], // 0,4999 → 0
    [3, 3333, 1], // 0,9999 → 1
    [0, 2500, 0],
    [99_999, 10_000, 99_999], // 100 % = todo, nunca más que el monto
    [99_999, 1, 10], // 9,9999 → 10
  ])("%i × %i bps → %i", (cents, bps, out) => {
    expect(shareOfCents(cents, bps)).toBe(out);
  });

  it("nunca supera el monto ni es negativo para montos ≥ 0", () => {
    for (const cents of [0, 1, 2, 7, 99, 1000, 123_457]) {
      for (const bps of [1, 1, 49, 50, 51, 3333, 5000, 9999, 10_000]) {
        const s = shareOfCents(cents, bps);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(cents);
        expect(Number.isInteger(s)).toBe(true);
      }
    }
  });

  it("montos enormes no pierden precisión (cae a BigInt si cents·bps no es seguro)", () => {
    // 9e14 centavos × 10000 = 9e18 > 2^53: con float daría basura.
    expect(shareOfCents(900_000_000_000_001, 5000)).toBe(450_000_000_000_001);
  });

  it("rechaza entradas que no son plata entera o bps fuera de 0..10000", () => {
    expect(() => shareOfCents(1.5, 100)).toThrow(RangeError);
    expect(() => shareOfCents(100, 10_001)).toThrow(RangeError);
    expect(() => shareOfCents(100, -1)).toThrow(RangeError);
    expect(() => shareOfCents(100, 12.5)).toThrow(RangeError);
  });
});

describe("[CF2-PK4] validateShareGraph (D-CF2-18)", () => {
  const e = (g: string, r: string) => ({ giverPractitionerId: g, receiverPractitionerId: r });

  it("válida sin reglas", () => {
    expect(validateShareGraph([], e("a", "b"))).toBeNull();
  });
  it("self", () => {
    expect(validateShareGraph([], e("a", "a"))).toBe("self");
  });
  it("mutual: b ya le destina a a", () => {
    expect(validateShareGraph([e("b", "a")], e("a", "b"))).toBe("mutual");
  });
  it("receiverGives: b ya destina a c (cadena a→b→c)", () => {
    expect(validateShareGraph([e("b", "c")], e("a", "b"))).toBe("receiverGives");
  });
  it("giverReceives: a ya recibe de c (cadena c→a→b)", () => {
    expect(validateShareGraph([e("c", "a")], e("a", "b"))).toBe("giverReceives");
  });
  it("varios que destinan al mismo que recibe: válido (estrella)", () => {
    expect(validateShareGraph([e("c", "b"), e("d", "b")], e("a", "b"))).toBeNull();
  });
  it("cambiar la regla de a: su vigente se ignora (se cierra al guardar)", () => {
    expect(validateShareGraph([e("a", "b")], e("a", "c"))).toBeNull();
    expect(validateShareGraph([e("a", "b")], e("a", "b"))).toBeNull();
  });
  it("prioridad: self antes que el resto", () => {
    expect(validateShareGraph([e("a", "c"), e("c", "a")], e("a", "a"))).toBe("self");
  });
});

const rule = (over: Partial<RevenueShareRuleView>): RevenueShareRuleView => ({
  id: "r",
  giverPractitionerId: "a",
  giverName: "Ana",
  receiverPractitionerId: "b",
  receiverName: "Beto",
  shareBps: 1000,
  sources: { manual: true, online: true, insurer: false },
  effectiveFrom: "2026-10-01T12:00:00.000Z",
  effectiveTo: null,
  createdByName: null,
  closedByName: null,
  ...over,
});

describe("[CF2-PK5] helpers de la lista del editor", () => {
  const rules = [
    rule({ id: "r3", effectiveFrom: "2026-10-20T12:00:00.000Z" }),
    rule({ id: "r2", effectiveFrom: "2026-10-10T12:00:00.000Z", effectiveTo: "2026-10-20T12:00:00.000Z" }),
    rule({ id: "r1", effectiveFrom: "2026-10-01T12:00:00.000Z", effectiveTo: "2026-10-10T12:00:00.000Z" }),
    rule({ id: "x1", giverPractitionerId: "c", giverName: "Caro" }),
    rule({ id: "x0", giverPractitionerId: "d", receiverPractitionerId: "a", effectiveTo: "2026-10-05T00:00:00.000Z" }),
  ];

  it("rulesForGiver: historial del que destina, effectiveFrom desc", () => {
    expect(rulesForGiver(rules, "a").map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });
  it("openRuleForGiver: la vigente o null", () => {
    expect(openRuleForGiver(rules, "a")?.id).toBe("r3");
    expect(openRuleForGiver(rules, "d")).toBeNull();
    expect(openRuleForGiver(rules, "z")).toBeNull();
  });
  it("openRulesReceivedBy: «Recibe de», solo vigentes", () => {
    expect(openRulesReceivedBy(rules, "b").map((r) => r.id).sort()).toEqual(["r3", "x1"]);
    expect(openRulesReceivedBy(rules, "a")).toEqual([]);
  });
  it("openShareEdges: solo vigentes, listas para validateShareGraph", () => {
    expect(openShareEdges(rules)).toEqual([
      { giverPractitionerId: "a", receiverPractitionerId: "b" },
      { giverPractitionerId: "c", receiverPractitionerId: "b" },
    ]);
  });
  it("ruleAppliesTo por fuente (decisión 4: configurable por regla)", () => {
    const s = { manual: true, online: false, insurer: true };
    expect(ruleAppliesTo(s, "manual")).toBe(true);
    expect(ruleAppliesTo(s, "online")).toBe(false);
    expect(ruleAppliesTo(s, "insurer")).toBe(true);
  });
});

describe("[CF2-PK6] SetRevenueShareSchema / EndRevenueShareSchema", () => {
  const base = {
    giverPractitionerId: "prac_a",
    receiverPractitionerId: "prac_b",
    sharePct: "12,5",
    sources: { manual: true, online: false, insurer: true },
    expectedOpenId: null,
  };

  it("válido → shareBps entero y sin el texto", () => {
    const r = SetRevenueShareSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({
      giverPractitionerId: "prac_a",
      receiverPractitionerId: "prac_b",
      shareBps: 1250,
      sources: { manual: true, online: false, insurer: true },
      expectedOpenId: null,
    });
  });

  it("expectedOpenId con la vigente que vio el editor", () => {
    const r = SetRevenueShareSchema.safeParse({ ...base, expectedOpenId: "rule_1" });
    expect(r.success && r.data.expectedOpenId).toBe("rule_1");
  });

  it.each([
    ["% inválido", { sharePct: "0" }, "sharePct"],
    ["% con 3 decimales", { sharePct: "1,234" }, "sharePct"],
    ["% > 100", { sharePct: "100,5" }, "sharePct"],
    ["sin fuentes", { sources: { manual: false, online: false, insurer: false } }, "sources"],
    ["a sí mismo", { receiverPractitionerId: "prac_a" }, "receiverPractitionerId"],
    ["id con caracteres raros", { giverPractitionerId: "a' OR 1=1" }, "giverPractitionerId"],
    ["fuente faltante", { sources: { manual: true, online: true } }, "sources"],
  ])("rechaza: %s", (_label, patch, path) => {
    const r = SetRevenueShareSchema.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path[0] === path)).toBe(true);
  });

  it("rechaza claves de más (strict)", () => {
    expect(SetRevenueShareSchema.safeParse({ ...base, shareBps: 10_000 }).success).toBe(false);
    expect(SetRevenueShareSchema.safeParse({ ...base, tenantId: "otro" }).success).toBe(false);
  });

  it("EndRevenueShareSchema: giver + la vigente que se cierra", () => {
    expect(EndRevenueShareSchema.safeParse({ giverPractitionerId: "prac_a", expectedOpenId: "rule_1" }).success).toBe(true);
    expect(EndRevenueShareSchema.safeParse({ giverPractitionerId: "prac_a", expectedOpenId: null }).success).toBe(false);
    expect(EndRevenueShareSchema.safeParse({ giverPractitionerId: "prac_a" }).success).toBe(false);
  });
});
