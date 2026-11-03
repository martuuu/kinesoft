/**
 * [CF2-PD] Tarjeta «Cobrado hoy» del Inicio de la Secretaria (CF2 · P.2, sesión P-D; plan §29 D-CF2-16/17). Corre en
 * los 2 roles (`test:integration` = `kinesoft_app` con RLS; `test:integration:owner` = BYPASSRLS, como prod), TZ=UTC.
 *
 * Símbolo REAL: `getDashboardPageData` (lo que llama `/dashboard`) contra el fixture a mano de P-X
 * (`tests/helpers/caja-fixture.ts`). Se mockean solo la sesión, `next/cache` (setup) y el reloj (`Date`); el query
 * counter instrumenta `@/lib/db`.
 *
 *   [CF2-PD-1] Secretaria (`desk`): `cashToday` = lo esperado a mano del día (copagos + online, sin OS, con lo que
 *              destina y recibe); `revenue`/`monthRevenue` siguen null (SR-D5I) y la SQL de Ingresos no corre.
 *   [CF2-PD-2] Titular, Facturación y profesional: `cashToday` null (y la SQL de caja no corre).
 *   [CF2-PD-3] Presupuesto C-PF8: ≤ 2 tx en frío y ≤ 1 en caliente; la caja es UNA sentencia más, ninguna tx.
 *   [CF2-PD-4] Cache: la caja va fuera de `dashboard:counts`. La Secretaria y Facturación comparten la clave de los
 *              counts (`no-practitioner`): con el cache real, Facturación no hereda la tarjeta, y un cobro nuevo se ve
 *              en la carga siguiente aunque los counts vengan del cache.
 *   [CF2-PD-5] Otro consultorio con la MISMA caja: nunca se suma (una fuga se ve como el doble).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getDashboardPageData } from "@/lib/dashboard";
import type { DashboardCashToday } from "@/lib/dashboard";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import { seedCajaFixture, type CajaFixture } from "@/tests/helpers/caja-fixture";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { usePassthroughUnstableCache, useRealUnstableCache } from "@/tests/helpers/integration-setup";
import { addStaff, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ar = (s: string) => new Date(`${s}-03:00`);
const NOW = ar("2026-10-20T18:00:00");

function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
/** La sentencia de `collectedGroupsInTx` (CTE `items`). */
const cajaStatements = () => recorded().filter((e) => e.query.includes("WITH items AS"));
/** Las de `revenueAmountsInTx` (widget de Ingresos). */
const revenueStatements = () => recorded().filter((e) => e.query.includes('"legacyMp"'));

/** Lo que tiene que dar la tarjeta, armado desde la liquidación `desk` a mano del fixture (no con el código bajo test). */
function expectedCard(fx: CajaFixture): DashboardCashToday {
  const desk = fx.expected.day[fx.dayKey].desk;
  return {
    rows: desk.rows
      .filter((r) => r.gross !== 0 || r.given !== 0 || r.received !== 0)
      .map((r) => ({
        practitionerId: r.practitionerId,
        practitionerName: r.practitionerName,
        grossCents: r.gross,
        givenCents: r.given,
        receivedCents: r.received,
        netCents: r.net,
        givenTo: r.givenTo
          .filter((f) => f.cents !== 0)
          .map((f) => ({ practitionerId: f.practitionerId, practitionerName: f.practitionerName, cents: f.cents })),
      })),
    totalCents: desk.totals.gross,
    computedAt: NOW.toISOString(),
  };
}

describe.skipIf(!RUN)("[CF2-PD] «Cobrado hoy» en el Inicio de la Secretaria", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let O: EphemeralTenant;
  let fx: CajaFixture;
  let secretaria: string;
  let facturacion: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    O = await createEphemeralTenant(db);
    fx = await seedCajaFixture(T, { now: NOW, db });
    // Misma caja en otro consultorio: cualquier fuga duplica los montos.
    await seedCajaFixture(O, { now: NOW, db });
    secretaria = (await addStaff(db, T, "ASSISTANT")).userId;
    facturacion = (await addStaff(db, T, "BILLING")).userId;
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

  it("[CF2-PD-1] Secretaria: cashToday = esperado a mano (sin OS); revenue/monthRevenue null y sin la SQL de Ingresos", async () => {
    asUser(secretaria);
    const { result } = await measure(() => getDashboardPageData());
    const { data } = result;
    expect(data.cashToday).toEqual(expectedCard(fx));
    // Literales de la cuenta a mano (cabecera del fixture): copagos + online de D, sin OS.
    expect(data.cashToday?.totalCents).toBe(3_250_005);
    // Bruno destina $5.775,02 a Ana (20 % de copagos + online hasta las 13:00, 25 % después; sin OS).
    const junior = data.cashToday?.rows.find((r) => r.practitionerId === fx.practitioners.junior.practitionerId);
    expect(junior?.givenTo).toEqual([
      { practitionerId: fx.practitioners.principal.practitionerId, practitionerName: fx.practitioners.principal.name, cents: 577_502 },
    ]);
    expect(data.revenueScope).toBe("none");
    expect(data.revenue).toBeNull();
    expect(data.monthRevenue).toBeNull();
    expect(revenueStatements()).toEqual([]);
    expect(cajaStatements()).toHaveLength(1);
  });

  it("[CF2-PD-2] Titular, Facturación y profesional: sin cashToday y sin la SQL de caja", async () => {
    for (const [label, userId] of [
      ["titular", T.userId],
      ["facturación", facturacion],
      ["profesional", fx.practitioners.junior.userId],
    ] as const) {
      asUser(userId);
      const { result } = await measure(() => getDashboardPageData());
      expect([label, result.data.cashToday ?? null]).toEqual([label, null]);
      expect([label, cajaStatements().length]).toEqual([label, 0]);
    }
  });

  it("[CF2-PD-3] presupuesto: Secretaria ≤ 2 tx en frío, ≤ 1 en caliente; la caja suma 1 sentencia y 0 tx", async () => {
    asUser(secretaria);
    const cold = await measure(() => getDashboardPageData());
    expect(cold.m.transactions, `${cold.m.transactions} tx / ${cold.m.statements} sentencias`).toBeLessThanOrEqual(2);

    useRealUnstableCache();
    await getDashboardPageData();
    const warm = await measure(() => getDashboardPageData());
    expect(warm.m.transactions, `${warm.m.transactions} tx / ${warm.m.statements} sentencias`).toBeLessThanOrEqual(1);
    expect(cajaStatements()).toHaveLength(1);
    expect(warm.result.data.cashToday).toEqual(expectedCard(fx));
  });

  it("[CF2-PD-4] fuera del cache de counts: Facturación no hereda la tarjeta y un cobro nuevo se ve en la carga siguiente", async () => {
    useRealUnstableCache();
    asUser(secretaria);
    expect((await getDashboardPageData()).data.cashToday?.totalCents).toBe(3_250_005);
    // Misma clave de counts (`no-practitioner`) que la Secretaria.
    asUser(facturacion);
    expect((await getDashboardPageData()).data.cashToday ?? null).toBeNull();

    // Copago en efectivo de Carla (sin regla) hace media hora: no pasa por ninguna mutación que revalide el tag.
    const other = fx.practitioners.other;
    const booking = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: fx.patientId,
        practitionerId: other.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(NOW.getTime() - 3_600_000),
        durationMin: 45,
        status: "COMPLETED",
        paymentStatus: "PAID",
        copagoCents: 100_000,
        copagoPaidAt: new Date(NOW.getTime() - 1_800_000),
        copagoPaymentMethod: "CASH",
        idempotencyKey: randomUUID(),
      },
    });
    try {
      asUser(secretaria);
      const { result, m } = await measure(() => getDashboardPageData());
      expect(m.transactions).toBeLessThanOrEqual(1); // counts del cache
      expect(result.data.cashToday?.totalCents).toBe(3_250_005 + 100_000);
      expect(result.data.cashToday?.rows.find((r) => r.practitionerId === other.practitionerId)).toMatchObject({
        grossCents: 600_000 + 100_000,
        netCents: 600_000 + 100_000,
      });
    } finally {
      await db.booking.delete({ where: { id: booking.id } });
    }
  });

  it("[CF2-PD-5] otro consultorio con la misma caja nunca se suma", async () => {
    asUser(secretaria);
    const card = (await getDashboardPageData()).data.cashToday;
    expect(card?.totalCents).toBe(3_250_005);
    const ids = new Set(Object.values(fx.practitioners).map((p) => p.practitionerId));
    expect(card?.rows.every((r) => ids.has(r.practitionerId))).toBe(true);
  });
});
