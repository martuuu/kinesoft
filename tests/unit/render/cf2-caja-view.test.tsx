import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-PU2] /caja (CF2 · P.2, sesión P-U2; plan §29 D-CF2-16/17). Se monta la vista REAL (`CajaView`) con un
 * `CajaPageData` armado por el símbolo real de prod (`buildCajaPageData`: liquidación + proyección por scope), así lo que
 * se afirma es lo que vería cada rol con el payload que le llega. La página server se prueba con la sesión y el loader
 * mockeados (la DB es la red; el loader real lo cubren `tests/integration/cf2-caja*.test.ts`).
 *
 *   [CF2-PU2-1] Secretaria (desk): «Cobrado hoy», sin columna Obra social ni Mes ni selector de fecha.
 *   [CF2-PU2-2] Profesional (own): solo su fila y lo que recibe; ni filas ni brutos ajenos.
 *   [CF2-PU2-3] Titular (tenant): las 3 fuentes, filas en $0, totales, Día/Mes por URL, medios y reparto vigente.
 *   [CF2-PU2-4] Mobile (< 768 px): la tabla pasa a tarjeta por profesional, cada monto con su rótulo.
 *   [CF2-PU2-5] Estado vacío: «Todavía no hay cobros registrados hoy» (y en Mes / otro día, su copy).
 *   [CF2-PU2-6] La página: `loadCajaPage(actor, memberCaps, searchParams)`; `null` → /dashboard.
 */
const h = vi.hoisted(() => ({
  actor: { tenantId: "t1", userId: "u1", practitionerId: null as string | null, support: false },
  memberCaps: new Set<string>(["billing.manage"]),
  loadCalls: [] as unknown[][],
  result: null as unknown,
  redirected: null as string | null,
  wall: "ok" as unknown,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    h.redirected = to;
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ getActor: async () => h.actor }));
vi.mock("@/lib/module-wall", () => ({ moduleWall: async () => h.wall }));
vi.mock("@/lib/authz", () => ({ memberCapabilitiesForActor: async () => h.memberCaps }));
vi.mock("@/lib/caja-internal", () => ({
  loadCajaPage: async (...args: unknown[]) => {
    h.loadCalls.push(args);
    return h.result;
  },
}));

import { CajaView } from "@/components/caja/caja-view";
import CajaPage from "@/app/(app)/caja/page";
import { buildCajaPageData, cajaPeriodFor, parseCajaSearchParams } from "@/lib/caja-logic";
import type { CajaPageData, CajaScope, CollectedGroup } from "@/lib/caja-types";
import type { RevenueShareRuleView } from "@/lib/revenue-share-types";
import { formatARS } from "@/lib/format";

const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T18:00:00.000Z"); // 15:00 AR

const ROSTER = [
  { practitionerId: "pr_a", practitionerName: "Ana Paz" },
  { practitionerId: "pr_b", practitionerName: "Beto Ruiz" },
  { practitionerId: "pr_c", practitionerName: "Carla Sosa" },
];

/** Ana destina 20 % a Beto sobre copagos + online (no OS). */
const RULE_FIELDS = {
  ruleId: "r1",
  receiverPractitionerId: "pr_b",
  receiverName: "Beto Ruiz",
  shareBps: 2000,
  appliesManual: true,
  appliesOnline: true,
  appliesInsurer: false,
};
const NO_RULE = {
  ruleId: null,
  receiverPractitionerId: null,
  receiverName: null,
  shareBps: null,
  appliesManual: null,
  appliesOnline: null,
  appliesInsurer: null,
};

function g(p: Partial<CollectedGroup> & Pick<CollectedGroup, "practitionerId" | "source" | "amountCents">): CollectedGroup {
  return {
    practitionerName: ROSTER.find((r) => r.practitionerId === p.practitionerId)!.practitionerName,
    method: null,
    dayKey: TODAY,
    count: 1,
    ...NO_RULE,
    ...p,
  };
}

// Ana: $10.000 efectivo (2 cobros) + $5.000 online, bajo la regla; $4.500 de OS (la regla no aplica a OS).
// Beto: $3.000 transferencia sin regla. Carla: nada (fila en $0).
const GROUPS: CollectedGroup[] = [
  g({ practitionerId: "pr_a", source: "manual", method: "CASH", amountCents: 1_000_000, count: 2, ...RULE_FIELDS }),
  g({ practitionerId: "pr_a", source: "online", method: "MERCADO_PAGO", amountCents: 500_000, ...RULE_FIELDS }),
  g({ practitionerId: "pr_a", source: "insurer", amountCents: 450_000, ...RULE_FIELDS }),
  g({ practitionerId: "pr_b", source: "manual", method: "TRANSFER", amountCents: 300_000 }),
];

const RULE: RevenueShareRuleView = {
  id: "r1",
  giverPractitionerId: "pr_a",
  giverName: "Ana Paz",
  receiverPractitionerId: "pr_b",
  receiverName: "Beto Ruiz",
  shareBps: 2000,
  sources: { manual: true, online: true, insurer: false },
  effectiveFrom: "2026-10-01T03:00:00.000Z",
  effectiveTo: null,
  createdByName: "Ana Paz",
  closedByName: null,
};

function data(scope: CajaScope, sp: Record<string, string> = {}, groups: CollectedGroup[] = GROUPS): CajaPageData {
  const period = cajaPeriodFor(parseCajaSearchParams(sp), TODAY, scope)!;
  const roster = scope.kind === "own" ? ROSTER.filter((r) => r.practitionerId === scope.practitionerId) : ROSTER;
  return buildCajaPageData({ scope, period, groups, roster, rules: [RULE], now: NOW })!;
}

const render = (d: CajaPageData) => renderToStaticMarkup(<CajaView data={d} />);
/** Filas del cuerpo de la tabla (sin la de totales, que va en <tfoot>). */
const bodyRows = (html: string) => (html.split("<tbody")[1] ?? "").split("</tbody>")[0].match(/<tr[\s>]/g) ?? [];
const ars = (c: number) => formatARS(c);

beforeEach(() => {
  h.actor = { tenantId: "t1", userId: "u1", practitionerId: null, support: false };
  h.memberCaps = new Set(["billing.manage"]);
  h.loadCalls = [];
  h.result = null;
  h.redirected = null;
  h.wall = "ok";
});

describe("[CF2-PU2-1] Secretaria (desk)", () => {
  it("«Cobrado hoy», copagos + online sin Obra social, sin Mes ni selector de fecha, con Destina/Recibe", () => {
    const html = render(data({ kind: "desk" }, { vista: "mes", mes: "2026-09" }));
    expect(html).toContain("Caja");
    expect(html).toContain("Cobrado hoy");
    expect(html).toContain(">Copagos<");
    expect(html).toContain(">Online<");
    expect(html).not.toContain("Obra social");
    expect(html).not.toContain(ars(450_000)); // el arancel de OS de Ana
    expect(html).not.toContain("vista=mes");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('type="month"');
    expect(html).toContain(">Destina<");
    expect(html).toContain(">Recibe<");
    // Ana: bruto $15.000 (sin OS), destina $3.000 a Beto, neto $12.000.
    expect(html).toContain(ars(1_500_000));
    expect(html).toContain(ars(300_000));
    expect(html).toContain(ars(1_200_000));
    expect(bodyRows(html)).toHaveLength(3);
    expect(html).toContain("Por medio de pago");
    expect(html).toContain("Reparto vigente");
  });
});

describe("[CF2-PU2-2] Profesional (own)", () => {
  it("solo su fila y lo que recibe (de quién); ninguna fila ni bruto ajeno", () => {
    const html = render(data({ kind: "own", practitionerId: "pr_b" }));
    expect(bodyRows(html)).toHaveLength(1);
    expect(html).toContain("Beto Ruiz");
    expect(html).not.toContain("Carla Sosa");
    // Recibe $3.000 de Ana (20 % de $15.000); su bruto es $3.000 y su neto $6.000.
    expect(html).toContain(ars(600_000));
    expect(html).toMatch(/de Ana Paz/);
    // Nada del bruto de Ana: ni $15.000, ni $19.500, ni su OS.
    for (const c of [1_000_000, 1_500_000, 1_950_000, 450_000, 1_650_000]) expect([c, html.includes(ars(c))]).toEqual([c, false]);
    // Día y Mes: navega (con OS como columna, que es su scope).
    expect(html).toContain("Obra social");
    expect(html).toContain('href="/caja?vista=mes&amp;mes=2026-11"');
  });
});

describe("[CF2-PU2-3] Titular (tenant)", () => {
  it("Día: las 3 fuentes, filas en $0, totales, links Día/Mes, medios de pago y reparto vigente", () => {
    const html = render(data({ kind: "tenant" }));
    for (const col of [">Profesional<", ">Copagos<", ">Online<", ">Obra social<", ">Total<", ">Destina<", ">Recibe<", ">Neto<"]) {
      expect([col, html.includes(col)]).toEqual([col, true]);
    }
    expect(bodyRows(html)).toHaveLength(3);
    expect(html).toContain("Carla Sosa"); // fila en $0
    expect(html).toContain("<tfoot");
    expect(html).toContain(ars(2_250_000)); // total bruto del día
    expect(html).toContain(ars(1_950_000)); // Ana con OS
    // Navegación por URL (sin action).
    expect(html).toContain('href="/caja?vista=mes&amp;mes=2026-11"');
    expect(html).toContain('href="/caja?vista=dia&amp;fecha=2026-11-01"');
    expect(html).not.toContain("fecha=2026-11-03"); // al futuro no se avanza
    expect(html).toContain('type="date"');
    expect(html).toContain('action="/caja"');
    // Medios: efectivo, transferencia, Mercado Pago (sin OS).
    expect(html).toContain("Por medio de pago");
    expect(html).toContain("Efectivo");
    expect(html).toContain("Transferencia");
    // Reparto vigente: quién, cuánto, a quién y sobre qué.
    expect(html).toContain("Reparto vigente");
    expect(html).toMatch(/Ana Paz[^<]*<\/strong>[^]*20%[^]*Beto Ruiz/);
    expect(html).toMatch(/sobre copagos y cobros online/);
  });

  it("otro día: flecha al siguiente y link «Hoy»", () => {
    const html = render(data({ kind: "tenant" }, { fecha: "2026-10-15" }));
    expect(html).toContain('href="/caja?vista=dia&amp;fecha=2026-10-16"');
    expect(html).toContain('href="/caja?vista=dia&amp;fecha=2026-10-14"');
    expect(html).toMatch(/href="\/caja"[^>]*>Hoy</);
  });

  it("Mes: link a Día, selector de mes, sin medios ni reparto (son del día)", () => {
    const html = render(data({ kind: "tenant" }, { vista: "mes", mes: "2026-10" }));
    expect(html).toContain('type="month"');
    expect(html).toContain('href="/caja?vista=mes&amp;mes=2026-09"');
    expect(html).toContain('href="/caja?vista=mes&amp;mes=2026-11"');
    expect(html).toContain('href="/caja"'); // Día = hoy
    expect(html).not.toContain("Por medio de pago");
    expect(html).not.toContain("Reparto vigente");
  });
});

describe("[CF2-PU2-4] mobile (< 768 px)", () => {
  it("cada celda lleva su rótulo y el CSS pasa la tabla a tarjeta por profesional bajo 768 px", () => {
    const html = render(data({ kind: "tenant" }));
    for (const l of ["Copagos", "Online", "Obra social", "Total", "Destina", "Recibe", "Neto"]) {
      expect([l, html.includes(`data-label="${l}"`)]).toEqual([l, true]);
    }
    const css = readFileSync(join(process.cwd(), "components/caja/caja.module.css"), "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 767.98px)"));
    expect(mobile.length).toBeGreaterThan(30);
    expect(mobile).toMatch(/\.table tr\s*\{[^}]*display:\s*grid/);
    expect(mobile).toMatch(/\.table thead\s*\{[^}]*position:\s*absolute/);
    expect(mobile).toMatch(/content:\s*attr\(data-label\)/);
  });
});

describe("[CF2-PU2-5] estado vacío", () => {
  it("hoy sin cobros: lo dice y deja las filas en $0", () => {
    const html = render(data({ kind: "desk" }, {}, []));
    expect(html).toContain("Todavía no hay cobros registrados hoy");
    expect(bodyRows(html)).toHaveLength(3);
  });

  it("otro día y otro mes: su copy", () => {
    expect(render(data({ kind: "tenant" }, { fecha: "2026-10-15" }, []))).toContain("No hay cobros registrados ese día");
    expect(render(data({ kind: "tenant" }, { vista: "mes", mes: "2026-09" }, []))).toContain("No hay cobros registrados en ese mes");
    expect(render(data({ kind: "tenant" }, { vista: "mes" }, []))).toContain("Todavía no hay cobros registrados este mes");
  });
});

describe("[CF2-PU2-6] la página", () => {
  it("llama a loadCajaPage con el actor, las caps del miembro y los searchParams; pinta la vista", async () => {
    h.result = data({ kind: "tenant" });
    const sp = { vista: "dia", fecha: TODAY };
    const html = renderToStaticMarkup(await CajaPage({ searchParams: sp }));
    expect(h.loadCalls).toEqual([[h.actor, h.memberCaps, sp]]);
    expect(html).toContain("Reparto vigente");
  });

  it("scope none (soporte o sin billing.*) → /dashboard", async () => {
    h.result = null;
    await expect(CajaPage({ searchParams: {} })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirected).toBe("/dashboard");
  });

  it("con muro de módulo (facturación deshabilitada) corta antes de leer la caja (VX-Z B1)", async () => {
    h.wall = { disabled: true };
    expect(await CajaPage({ searchParams: {} })).toBeNull();
    expect(h.loadCalls).toEqual([]);
  });
});
