/**
 * [CF2-PS2] Caja por profesional, server (CF2 · P.2, sesión P-S2; plan §29 D-CF2-16..19). Corre en los 2 roles
 * (`test:integration` = `kinesoft_app` con RLS; `test:integration:owner` = BYPASSRLS, como prod) y con TZ=UTC.
 *
 * Símbolos REALES: `collectedGroupsInTx`, `revenueSharesForPeriodInTx` y `loadCajaPage` (`lib/caja-internal.ts`) contra
 * el fixture a mano de P-X (`tests/helpers/caja-fixture.ts`); la paridad, contra `getRevenue` → `revenueAmountsInTx`
 * (`lib/dashboard.ts`, la SQL del widget de Ingresos que NO se toca). Se mockean solo la sesión de Supabase y
 * `next/cache` (setup) y se cuenta con el query counter (`@/lib/db` instrumentado, nada más).
 *
 *   [CF2-PS2-1]  Grupos = esperados a mano (día D, día Y y mes), con y sin OS.
 *   [CF2-PS2-2]  Paridad Σ con `revenueAmountsInTx` (tenant y por profesional).
 *   [CF2-PS2-3]  Cobro de las 23:30 AR en SU día con el host en UTC.
 *   [CF2-PS2-4]  Cambio de regla a las 13:00: antes la vieja, desde 13:00:00.000 la nueva.
 *   [CF2-PS2-5]  Titular / Facturación (`tenant`): día y mes = esperados (+ roster en $0, medios, reglas).
 *   [CF2-PS2-6]  Secretaria (`desk`): solo hoy, sin OS en el payload aunque pida el mes.
 *   [CF2-PS2-7]  Profesional (`own`): su fila; nunca el bruto ajeno en el JSON (el que destina y el que recibe).
 *   [CF2-PS2-8]  Soporte → `null` sin consultar nada.
 *   [CF2-PS2-9]  Otro consultorio nunca (ni con BYPASSRLS: el `tenantId` a mano es la barrera).
 *   [CF2-PS2-10] Presupuesto: 1 transacción y ≤ 2 sentencias con el roster cacheado.
 *   [CF2-PS2-11] `projectCajaForScope` desk no conserva el `count` de la OS (hallazgo de P-X).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { getRevenue } from "@/lib/dashboard";
import { runWithRls } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { SUPPORT_CAPS, capabilitiesFor, type Capability } from "@/lib/capabilities";
import { dayWindow } from "@/lib/availability/day";
import { revenuePeriod } from "@/lib/dashboard-revenue";
import { projectCajaForScope, settleRevenueShares } from "@/lib/caja-logic";
import type { CajaPageData, CollectedGroup, PractitionerSettlement } from "@/lib/caja-types";
import { collectedGroupsInTx, loadCajaPage, revenueSharesForPeriodInTx } from "@/lib/caja-internal";
import { normalizeCajaGroups, seedCajaFixture, INSURER_FEE_CENTS, type CajaFixture } from "@/tests/helpers/caja-fixture";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { usePassthroughUnstableCache, useRealUnstableCache } from "@/tests/helpers/integration-setup";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { addStaff, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ar = (s: string) => new Date(`${s}-03:00`);
const NOW = ar("2026-10-20T18:00:00");
const MONTH = "2026-10";

/** Todos los números del payload (lo que viaja al cliente), para buscar montos ajenos sin falsos por substring. */
function numbersIn(v: unknown, out = new Set<number>()): Set<number> {
  if (typeof v === "number") out.add(v);
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) numbersIn(x, out);
  return out;
}

const monthRange = () => revenuePeriod("month", ar(`${MONTH}-01T12:00:00`));
const moving = (r: PractitionerSettlement) => r.gross !== 0 || r.given !== 0 || r.received !== 0;

describe.skipIf(!RUN)("[CF2-PS2] caja por profesional (server)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let O: EphemeralTenant;
  let fx: CajaFixture;
  let ox: CajaFixture;
  let secretaria: { userId: string };
  let facturacion: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    O = await createEphemeralTenant(db);
    fx = await seedCajaFixture(T, { now: NOW, db });
    // El otro consultorio tiene LA MISMA caja (mismos montos, otras filas): cualquier fuga se ve como el doble.
    ox = await seedCajaFixture(O, { now: NOW, db });
    secretaria = await addStaff(db, T, "ASSISTANT");
    facturacion = await addStaff(db, T, "BILLING");
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    usePassthroughUnstableCache();
    asAnonymous();
  });

  afterAll(async () => {
    await T?.cleanup();
    await O?.cleanup();
    await db?.$disconnect();
  });

  async function actorOf(userId: string): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
    asUser(userId);
    const actor = await getActor();
    return { actor, caps: await memberCapabilitiesForActor(actor) };
  }

  async function pageAs(userId: string, sp: Record<string, string>, caps?: ReadonlySet<Capability>): Promise<CajaPageData | null> {
    const a = await actorOf(userId);
    return loadCajaPage(a.actor, caps ?? a.caps, sp);
  }

  function groups(tenantId: string, range: { start: Date; end: Date }, opts: Parameters<typeof collectedGroupsInTx>[3]) {
    return runWithRls(tenantId, (tx) => collectedGroupsInTx(tx, tenantId, range, opts));
  }

  it("[CF2-PS2-1] los grupos de la SQL = los esperados a mano (día D, día Y, mes; con y sin OS)", async () => {
    for (const k of [fx.dayKey, fx.prevDayKey]) {
      const got = await groups(T.tenantId, dayWindow(k), { includeInsurer: true });
      expect([k, normalizeCajaGroups(got)]).toEqual([k, fx.expected.day[k].groups]);
      const desk = await groups(T.tenantId, dayWindow(k), { includeInsurer: false });
      expect([k, normalizeCajaGroups(desk)]).toEqual([k, fx.expected.day[k].groups.filter((g) => g.source !== "insurer")]);
    }
    const month = await groups(T.tenantId, monthRange(), { includeInsurer: true });
    expect(normalizeCajaGroups(month)).toEqual(fx.expected.month[MONTH].groups);
    // Tipos de verdad (no BigInt ni string): el cliente suma estos números.
    for (const g of month) {
      expect(typeof g.amountCents).toBe("number");
      expect(typeof g.count).toBe("number");
    }
  });

  it("[CF2-PS2-2] paridad Σ con revenueAmountsInTx (getRevenue del mes): tenant y por profesional", async () => {
    const all = await groups(T.tenantId, monthRange(), { includeInsurer: true });
    const sumOf = (gs: readonly CollectedGroup[], s: CollectedGroup["source"]) =>
      gs.filter((g) => g.source === s).reduce((a, g) => a + g.amountCents, 0);

    asUser(T.userId);
    const rev = await getRevenue("month");
    if (!rev.ok) throw new Error(rev.error);
    expect({ manual: sumOf(all, "manual"), online: sumOf(all, "online"), insurer: sumOf(all, "insurer") }).toEqual({
      manual: rev.data.manualCents,
      online: rev.data.mpCents,
      insurer: rev.data.insurerCents,
    });
    expect(rev.data.manualCents).toBeGreaterThan(0);
    expect(rev.data.insurerCents).toBeGreaterThan(0);

    for (const who of ["junior", "other"] as const) {
      const p = fx.practitioners[who];
      asUser(p.userId);
      const own = await getRevenue("month");
      if (!own.ok) throw new Error(own.error);
      const mine = all.filter((g) => g.practitionerId === p.practitionerId);
      expect([who, sumOf(mine, "manual"), sumOf(mine, "online")]).toEqual([who, own.data.manualCents, own.data.mpCents]);
    }
  });

  it("[CF2-PS2-3] el cobro de las 23:30 AR cae en SU día con el host en UTC", async () => {
    expect(new Date().getTimezoneOffset()).toBe(0); // el script fija TZ=UTC: el borde solo se ve así
    const { junior: J } = fx.practitioners;
    const y = await groups(T.tenantId, dayWindow(fx.prevDayKey), { includeInsurer: true });
    expect(y.find((g) => g.practitionerId === J.practitionerId && g.method === "TRANSFER")).toMatchObject({
      dayKey: fx.prevDayKey,
      amountCents: 800_001,
      count: 1,
    });
    const d = await groups(T.tenantId, dayWindow(fx.dayKey), { includeInsurer: true });
    expect(d.some((g) => g.amountCents === 800_001)).toBe(false);
    // Y en la página del Titular: Y lo trae, D no.
    const pY = await pageAs(T.userId, { vista: "dia", fecha: fx.prevDayKey });
    expect(pY!.settlement.rows.find((r) => r.practitionerId === J.practitionerId)!.bySource.manual).toBe(2_034_568);
    const pD = await pageAs(T.userId, { vista: "dia", fecha: fx.dayKey });
    expect(pD!.settlement.rows.find((r) => r.practitionerId === J.practitionerId)!.bySource.manual).toBe(1_750_006);
  });

  it("[CF2-PS2-4] cambio de regla a las 13:00: antes la vieja (20 %), desde 13:00:00.000 la nueva (25 %)", async () => {
    const { junior: J } = fx.practitioners;
    const d = await groups(T.tenantId, dayWindow(fx.dayKey), { includeInsurer: true });
    const ofJ = (source: string, ruleId: string) =>
      d.filter((g) => g.practitionerId === J.practitionerId && g.source === source && g.ruleId === ruleId).reduce((a, g) => a + g.amountCents, 0);
    expect(ofJ("manual", fx.rules.first.id)).toBe(1_000_002 + 350_002); // 09:00 y 10:00
    expect(ofJ("manual", fx.rules.second.id)).toBe(400_002); //           13:00:00.000 exacto
    expect(ofJ("online", fx.rules.first.id)).toBe(349_999); //            08:00, 08:30, 11:00
    expect(ofJ("online", fx.rules.second.id)).toBe(550_000); //           14:00 y 16:00
    expect(ofJ("insurer", fx.rules.first.id)).toBe(INSURER_FEE_CENTS); // 11:30 (R1 no aplica a OS)
    expect(ofJ("insurer", fx.rules.second.id)).toBe(INSURER_FEE_CENTS); // 15:00
    for (const g of d.filter((x) => x.ruleId === fx.rules.second.id)) expect(g).toMatchObject({ shareBps: 2500, appliesInsurer: true });
    for (const g of d.filter((x) => x.ruleId === fx.rules.first.id)) expect(g).toMatchObject({ shareBps: 2000, appliesInsurer: false });

    // «Reparto vigente» del día: las dos (R1 hasta las 13:00, R2 desde ahí); el día anterior, solo R1.
    const rulesD = await runWithRls(T.tenantId, (tx) => revenueSharesForPeriodInTx(tx, T.tenantId, dayWindow(fx.dayKey)));
    expect(rulesD.map((r) => [r.id, r.effectiveFrom, r.effectiveTo])).toEqual([
      [fx.rules.second.id, fx.rules.changeAt.toISOString(), null],
      [fx.rules.first.id, fx.rules.first.effectiveFrom.toISOString(), fx.rules.changeAt.toISOString()],
    ]);
    expect(rulesD[0]).toMatchObject({
      giverPractitionerId: J.practitionerId,
      giverName: J.name,
      receiverPractitionerId: fx.practitioners.principal.practitionerId,
      receiverName: fx.practitioners.principal.name,
      shareBps: 2500,
      sources: { manual: true, online: true, insurer: true },
      closedByName: null,
    });
    expect(rulesD[1].closedByName).toBe(fx.practitioners.principal.name);
    const rulesY = await runWithRls(T.tenantId, (tx) => revenueSharesForPeriodInTx(tx, T.tenantId, dayWindow(fx.prevDayKey)));
    expect(rulesY.map((r) => r.id)).toEqual([fx.rules.first.id]);
  });

  it("[CF2-PS2-5] Titular y Facturación (tenant): día y mes = esperados, roster en $0, medios y reglas", async () => {
    for (const userId of [T.userId, facturacion.userId]) {
      const d = await pageAs(userId, { vista: "dia", fecha: fx.dayKey });
      expect(d).not.toBeNull();
      expect(d!.scope).toBe("tenant");
      expect(d!.sources).toEqual(["manual", "online", "insurer"]);
      expect(d!.settlement).toEqual(fx.expected.day[fx.dayKey].tenant);
      expect(d!.methods).toEqual(fx.expected.day[fx.dayKey].methods);
      expect(d!.rules.map((r) => r.id)).toEqual([fx.rules.second.id, fx.rules.first.id]);
      expect(d!.period).toMatchObject({ view: "dia", dayKey: fx.dayKey, isCurrent: true, canNavigate: true });

      // Y: C no cobró nada y aparece en $0 (roster); el resto, el esperado.
      const y = await pageAs(userId, { vista: "dia", fecha: fx.prevDayKey });
      expect(y!.settlement.rows.filter(moving)).toEqual(fx.expected.day[fx.prevDayKey].tenant.rows);
      expect(y!.settlement.totals).toEqual(fx.expected.day[fx.prevDayKey].tenant.totals);
      expect(y!.settlement.rows.find((r) => r.practitionerId === fx.practitioners.other.practitionerId)).toMatchObject({ gross: 0, net: 0, count: 0 });
      expect(y!.methods).toEqual(fx.expected.day[fx.prevDayKey].methods);

      const m = await pageAs(userId, { vista: "mes", mes: MONTH });
      expect(m!.period).toMatchObject({ view: "mes", monthKey: MONTH, isCurrent: true });
      expect(m!.settlement).toEqual(fx.expected.month[MONTH].tenant);
      expect(m!.settlement.totals.net).toBe(m!.settlement.totals.gross);
      expect(m!.methods).toEqual([]);
    }
  });

  it("[CF2-PS2-6] Secretaria (desk): solo hoy, sin OS ni mes en el payload aunque los pida", async () => {
    const asks: Record<string, string>[] = [{}, { vista: "mes", mes: "2026-09" }, { vista: "dia", fecha: fx.prevDayKey }];
    for (const sp of asks) {
      const p = await pageAs(secretaria.userId, sp);
      expect(p).not.toBeNull();
      expect(p!.scope).toBe("desk");
      expect(p!.period).toMatchObject({ view: "dia", dayKey: fx.dayKey, canNavigate: false, prev: null, next: null });
      expect(p!.sources).toEqual(["manual", "online"]);
      expect(p!.settlement).toEqual(fx.expected.day[fx.dayKey].desk);
      expect(p!.methods).toEqual(fx.expected.day[fx.dayKey].methods);
      // Ningún monto de OS viaja: ni el arancel, ni el bruto de OS de B, ni lo que B destina de OS.
      const nums = numbersIn(p);
      for (const n of [INSURER_FEE_CENTS, 900_000, 112_500, 690_002]) expect([n, nums.has(n)]).toEqual([n, false]);
      expect(p!.settlement.totals.bySource.insurer).toBe(0);
    }
  });

  it("[CF2-PS2-7] profesional (own): su fila y lo que recibe; nunca el bruto ajeno en el JSON", async () => {
    const { principal: P, junior: J, other: C } = fx.practitioners;
    const expectedD = fx.expected.day[fx.dayKey].tenant;
    const rowOf = (id: string) => expectedD.rows.find((r) => r.practitionerId === id)!;

    // El que DESTINA (B, Profesional de verdad): su fila completa; ni A ni C como filas.
    const j = await pageAs(J.userId, { vista: "dia", fecha: fx.dayKey });
    expect(j!.scope).toBe("own");
    expect(j!.settlement.rows).toEqual([rowOf(J.practitionerId)]);
    expect(j!.methods).toEqual([
      { method: "CASH", cents: 1_400_004, count: 2 }, // 1.000.002 + 400.002 (el de C ya no es suyo)
      { method: "TRANSFER", cents: 350_002, count: 1 },
      { method: "MERCADO_PAGO", cents: 899_999, count: 5 },
    ]);
    expect(numbersIn(j).has(600_000)).toBe(false); // el bruto de C
    const jm = await pageAs(J.userId, { vista: "mes", mes: MONTH });
    expect(jm!.settlement.rows).toEqual(fx.expected.month[MONTH].tenant.rows.filter((r) => r.practitionerId === J.practitionerId));

    // El que RECIBE (A con caps de Profesional): lo recibido de B por fuente, sin un solo monto bruto de B ni de C.
    const a = await pageAs(T.userId, { vista: "dia", fecha: fx.dayKey }, capabilitiesFor("PRACTITIONER"));
    expect(a!.scope).toBe("own");
    expect(a!.settlement.rows).toEqual([rowOf(P.practitionerId)]);
    expect(a!.methods).toEqual([]); // A solo tiene OS (sin medio)
    expect(a!.rules.map((r) => r.id)).toEqual([fx.rules.second.id, fx.rules.first.id]);
    const nums = numbersIn(a);
    for (const n of [3_550_005, 1_750_006, 899_999, 900_000, 1_000_002, 350_002, 400_002, 349_999, 550_000, 600_000]) {
      expect([n, nums.has(n)]).toEqual([n, false]);
    }
    expect(JSON.stringify(a)).not.toContain(C.practitionerId);

    // La SQL de `own` ya trae solo lo necesario: lo propio y, del que destina, lo que le aplica a A.
    const sql = await groups(T.tenantId, dayWindow(fx.dayKey), { includeInsurer: true, practitionerId: P.practitionerId });
    for (const g of sql.filter((x) => x.practitionerId !== P.practitionerId)) {
      expect(g.practitionerId).toBe(J.practitionerId);
      expect(g.receiverPractitionerId).toBe(P.practitionerId);
      expect(g.source === "insurer" ? g.appliesInsurer : g.source === "online" ? g.appliesOnline : g.appliesManual).toBe(true);
    }
    expect(sql.some((g) => g.practitionerId === J.practitionerId && g.source === "insurer" && g.ruleId === fx.rules.first.id)).toBe(false);
  });

  it("[CF2-PS2-8] soporte → null, sin consultar la base", async () => {
    const { actor, caps } = await actorOf(T.userId);
    const support: Actor = { ...actor, support: { sessionId: "cf2-ps2", superadminEmail: "root@test.local" } };
    const { result, m } = await measure(async () => [
      await loadCajaPage(actor, SUPPORT_CAPS, {}),
      await loadCajaPage(support, caps, {}), // aunque el caller le pase caps de Titular
      await loadCajaPage(support, await memberCapabilitiesForActor(support), {}),
    ]);
    expect(result).toEqual([null, null, null]);
    expect(m.byClient.app).toBe(0);
    expect(m.transactions).toBe(0);
  });

  it("[CF2-PS2-9] otro consultorio nunca (los dos roles)", async () => {
    const tIds = new Set(Object.values(fx.practitioners).map((p) => p.practitionerId));
    const oIds = new Set(Object.values(ox.practitioners).map((p) => p.practitionerId));
    const t = await pageAs(T.userId, { vista: "mes", mes: MONTH });
    const o = await pageAs(O.userId, { vista: "mes", mes: MONTH });
    // Misma caja en los dos: si se mezclaran, los totales darían el doble.
    expect(t!.settlement.totals).toEqual(fx.expected.month[MONTH].tenant.totals);
    expect(o!.settlement.totals).toEqual(ox.expected.month[MONTH].tenant.totals);
    for (const id of oIds) expect(JSON.stringify(t)).not.toContain(id);
    for (const id of tIds) expect(JSON.stringify(o)).not.toContain(id);
    expect(t!.rules.every((r) => tIds.has(r.giverPractitionerId))).toBe(true);

    // La tx de O pidiendo la caja de O no ve nada de T; la tx de O con el tenantId de T: RLS la vacía con el rol de la
    // app, y con BYPASSRLS (prod) el `tenantId` a mano es lo único que acota (trae T, no O).
    const own = await groups(O.tenantId, monthRange(), { includeInsurer: true });
    expect(own.every((g) => oIds.has(g.practitionerId))).toBe(true);
    const cross = await runWithRls(O.tenantId, (tx) => collectedGroupsInTx(tx, T.tenantId, monthRange(), { includeInsurer: true }));
    if (await appRoleBypassesRls()) expect(cross.every((g) => tIds.has(g.practitionerId))).toBe(true);
    else expect(cross).toEqual([]);
  });

  it("[CF2-PS2-10] presupuesto: 1 transacción y ≤ 2 sentencias de la app con el roster cacheado", async () => {
    useRealUnstableCache();
    for (const [userId, sp] of [
      [T.userId, { vista: "dia", fecha: fx.dayKey }],
      [T.userId, { vista: "mes", mes: MONTH }],
      [secretaria.userId, {}],
      [fx.practitioners.junior.userId, { vista: "mes" }],
    ] as const) {
      const { actor, caps } = await actorOf(userId);
      await loadCajaPage(actor, caps, sp); // calienta el roster (unstable_cache real del setup)
      const { result, m } = await measure(() => loadCajaPage(actor, caps, sp));
      expect(result).not.toBeNull();
      expect([userId, m.transactions, m.byClient.app]).toEqual([userId, 1, 2]);
    }
  });

  it("[CF2-PS2-11] projectCajaForScope desk no conserva el count de la OS", () => {
    const full = settleRevenueShares(fx.expected.day[fx.dayKey].groups);
    const desk = projectCajaForScope(full, { kind: "desk" });
    expect(desk).toEqual(fx.expected.day[fx.dayKey].desk); // B 10 cobros − 2 de OS = 8; A 0
    expect(desk.totals.count).toBe(9);
  });
});
