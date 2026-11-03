/**
 * [CF2-PX] Humo del fixture de caja (`tests/helpers/caja-fixture.ts`, CF2 · W2, sesión P-X). Corre en los 2 roles
 * (`test:integration` con `kinesoft_app` + RLS y `:owner` con BYPASSRLS) y se pensó para TZ=UTC.
 *
 *   [CF2-PX1] Se crea: las filas existen y la conexión de la APP las ve por RLS en su consultorio (y no desde otro,
 *             salvo con BYPASSRLS); la regla R1 quedó CERRADA en el instante del cambio y R2 abre ahí; el cobro de las
 *             23:30 AR de Y es de verdad un borde (en UTC ya es D); el reasignado quedó en C con la seña en B.
 *   [CF2-PX2] Los esperados escritos a mano son coherentes con la lógica pura de W1 (`settleRevenueShares`,
 *             `methodBreakdown`, `cashTodayFrom`): si uno de los dos se equivoca, esto no da verde.
 *   [CF2-PX3] Paridad de BRUTOS con la SQL de prod que ya existe (`getRevenue` → `revenueAmountsInTx`): tenant entero
 *             y por profesional. Así los grupos esperados no son una invención del fixture.
 *   [CF2-PX4] Se limpia: `t.cleanup()` no deja nada del tenant (cargas online incluidas) ni los usuarios de test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getRevenue } from "@/lib/dashboard";
import { runWithRls } from "@/lib/rls";
import { cashTodayFrom, methodBreakdown, settleRevenueShares } from "@/lib/caja-logic";
import { CAJA_FIXTURE_NAMES, seedCajaFixture, type CajaFixture } from "@/tests/helpers/caja-fixture";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ar = (s: string) => new Date(`${s}-03:00`);
const NOW = ar("2026-10-20T18:00:00");

describe.skipIf(!RUN)("[CF2-PX] fixture de caja", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let O: EphemeralTenant;
  let fx: CajaFixture;
  let cleaned = false;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    O = await createEphemeralTenant(db);
    fx = await seedCajaFixture(T, { now: NOW, db });
  });

  afterEach(() => {
    vi.useRealTimers();
    asAnonymous();
  });

  afterAll(async () => {
    if (!cleaned) await T?.cleanup();
    await O?.cleanup();
    await db?.$disconnect();
  });

  it("[CF2-PX1] crea las filas, la app las ve por RLS y los casos borde están donde dicen", async () => {
    expect(fx.dayKey).toBe("2026-10-20");
    expect(fx.prevDayKey).toBe("2026-10-19");
    const { principal: P, junior: J, other: C } = fx.practitioners;
    expect([P.name, J.name, C.name]).toEqual([CAJA_FIXTURE_NAMES.principal, CAJA_FIXTURE_NAMES.junior, CAJA_FIXTURE_NAMES.other]);

    const seen = await runWithRls(T.tenantId, async (tx) => ({
      bookings: await tx.booking.count({ where: { tenantId: T.tenantId } }),
      charges: await tx.onlineCharge.groupBy({ by: ["status"], where: { tenantId: T.tenantId }, _count: { _all: true } }),
      shares: await tx.practitionerRevenueShare.findMany({
        where: { tenantId: T.tenantId },
        orderBy: { effectiveFrom: "asc" },
        select: { id: true, shareBps: true, effectiveFrom: true, effectiveTo: true, closedById: true, appliesInsurer: true },
      }),
      payments: await tx.payment.count({ where: { booking: { tenantId: T.tenantId } } }),
    }));
    expect(seen.bookings).toBe(Object.keys(fx.ids.bookings).length);
    expect(Object.fromEntries(seen.charges.map((c) => [c.status, c._count._all]))).toEqual({ PAID: 4, REFUNDED: 1, ACTIVE: 1 });
    expect(seen.payments).toBe(1);
    expect(seen.shares).toEqual([
      { id: fx.rules.first.id, shareBps: 2000, effectiveFrom: fx.rules.first.effectiveFrom, effectiveTo: fx.rules.changeAt, closedById: T.userId, appliesInsurer: false },
      { id: fx.rules.second.id, shareBps: 2500, effectiveFrom: fx.rules.changeAt, effectiveTo: null, closedById: null, appliesInsurer: true },
    ]);
    expect(fx.rules.changeAt.toISOString()).toBe("2026-10-20T16:00:00.000Z"); // 13:00 AR

    // Desde otro consultorio: invisible por RLS (con BYPASSRLS, el owner = prod, solo la cláusula a mano protege).
    const bypass = await appRoleBypassesRls();
    const foreign = await runWithRls(O.tenantId, (tx) => tx.practitionerRevenueShare.count({ where: { tenantId: T.tenantId } }));
    expect(foreign).toBe(bypass ? 2 : 0);

    const b = await db.booking.findMany({
      where: { id: { in: [fx.ids.bookings.prevEdge2330, fx.ids.bookings.reassigned, fx.ids.bookings.transferWithDeposit] } },
      select: { id: true, copagoPaidAt: true, practitionerId: true, onlineDepositCents: true },
    });
    const byId = new Map(b.map((r) => [r.id, r]));
    // 23:30 AR de Y = 02:30 UTC de D: un `toISOString().slice(0,10)` lo mandaría al día equivocado.
    expect(byId.get(fx.ids.bookings.prevEdge2330)!.copagoPaidAt!.toISOString()).toBe("2026-10-20T02:30:00.000Z");
    expect(byId.get(fx.ids.bookings.reassigned)).toMatchObject({ practitionerId: C.practitionerId, onlineDepositCents: 100_000 });
    expect(byId.get(fx.ids.bookings.transferWithDeposit)).toMatchObject({ practitionerId: J.practitionerId, onlineDepositCents: 150_000 });
    const dep = await db.onlineCharge.findUniqueOrThrow({ where: { id: fx.ids.charges.depositReassigned }, select: { practitionerId: true } });
    expect(dep.practitionerId).toBe(J.practitionerId);
  });

  it("[CF2-PX2] los esperados a mano coinciden con la lógica pura de W1 (día, Secretaria, mes, «Cobrado hoy»)", () => {
    const { principal: P, junior: J } = fx.practitioners;
    for (const [dayKey, e] of Object.entries(fx.expected.day)) {
      expect([dayKey, settleRevenueShares(e.groups)]).toEqual([dayKey, e.tenant]);
      expect([dayKey, settleRevenueShares(e.groups.filter((g) => g.source !== "insurer"))]).toEqual([dayKey, e.desk]);
      expect([dayKey, methodBreakdown(e.groups)]).toEqual([dayKey, e.methods]);
      expect(e.tenant.totals.net).toBe(e.tenant.totals.gross);
      expect(e.desk.totals.net).toBe(e.desk.totals.gross);
    }
    const month = fx.expected.month["2026-10"];
    expect(Object.keys(fx.expected.month)).toEqual(["2026-10"]);
    expect(settleRevenueShares(month.groups)).toEqual(month.tenant);
    expect(settleRevenueShares(month.groups.filter((g) => g.source !== "insurer"))).toEqual(month.desk);

    // Literales de la cuenta a mano (cabecera del fixture): un cambio en los montos se nota acá.
    const d = fx.expected.day[fx.dayKey].tenant;
    expect(d.totals).toMatchObject({ gross: 4_600_005, net: 4_600_005, given: 690_002 });
    expect(d.rows.map((r) => [r.practitionerName, r.gross, r.given, r.received, r.net])).toEqual([
      [P.name, 450_000, 0, 690_002, 1_140_002],
      [J.name, 3_550_005, 690_002, 0, 2_860_003],
      [CAJA_FIXTURE_NAMES.other, 600_000, 0, 0, 600_000],
    ]);
    expect(d.rows[1].givenTo[0].bySource).toEqual({ manual: 370_002, online: 207_500, insurer: 112_500 });
    expect(fx.expected.day[fx.prevDayKey].tenant.rows.map((r) => [r.practitionerId, r.net])).toEqual([
      [P.practitionerId, 1_206_914],
      [J.practitionerId, 1_627_654],
    ]);
    expect(month.tenant.rows.map((r) => r.net)).toEqual([2_346_916, 4_487_657, 600_000]);
    expect(month.tenant.totals.gross).toBe(7_434_573);

    // «Cobrado hoy» de la Secretaria sale de los mismos grupos (sin OS).
    const card = cashTodayFrom(fx.expected.day[fx.dayKey].groups, NOW);
    expect(card.totalCents).toBe(3_250_005);
    expect(card.rows.map((r) => [r.practitionerName, r.grossCents, r.givenCents, r.receivedCents, r.netCents])).toEqual([
      [P.name, 0, 0, 577_502, 577_502],
      [J.name, 2_650_005, 577_502, 0, 2_072_503],
      [CAJA_FIXTURE_NAMES.other, 600_000, 0, 0, 600_000],
    ]);
  });

  it("[CF2-PX3] paridad de brutos con getRevenue (la SQL de Ingresos): tenant y por profesional", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const month = fx.expected.month["2026-10"];

    asUser(T.userId);
    const all = await getRevenue("month");
    if (!all.ok) throw new Error(all.error);
    expect(all.data).toMatchObject({
      manualCents: month.revenue.manualCents,
      mpCents: month.revenue.onlineCents,
      insurerCents: month.revenue.insurerCents,
    });
    expect(month.revenue).toEqual({ manualCents: 5_184_574, onlineCents: 899_999, insurerCents: 1_350_000 });

    for (const who of ["junior", "other"] as const) {
      const p = fx.practitioners[who];
      asUser(p.userId);
      const own = await getRevenue("month");
      if (!own.ok) throw new Error(own.error);
      const mine = month.groups.filter((g) => g.practitionerId === p.practitionerId);
      const sumOf = (s: string) => mine.filter((g) => g.source === s).reduce((a, g) => a + g.amountCents, 0);
      expect([who, own.data.manualCents, own.data.mpCents]).toEqual([who, sumOf("manual"), sumOf("online")]);
    }
  });

  it("[CF2-PX4] t.cleanup() no deja nada (cargas online, reparto, cuenta MP, pagos, coberturas, usuarios)", async () => {
    const userIds = Object.values(fx.practitioners).map((p) => p.userId);
    await T.cleanup();
    cleaned = true;
    const t = T.tenantId;
    const [charges] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "OnlineCharge" WHERE "tenantId" = ${t}`;
    expect({
      tenant: await db.tenant.count({ where: { id: t } }),
      bookings: await db.booking.count({ where: { tenantId: t } }),
      charges: charges.n,
      shares: await db.practitionerRevenueShare.count({ where: { tenantId: t } }),
      accounts: await db.mpAccount.count({ where: { tenantId: t } }),
      payments: await db.payment.count({ where: { id: fx.ids.paymentId } }),
      coverages: await db.coverage.count({ where: { patientId: fx.patientId } }),
      users: await db.userProfile.count({ where: { id: { in: userIds } } }),
    }).toEqual({ tenant: 0, bookings: 0, charges: 0, shares: 0, accounts: 0, payments: 0, coverages: 0, users: 0 });
  });
});
