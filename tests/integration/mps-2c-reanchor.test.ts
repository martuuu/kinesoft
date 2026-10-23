/**
 * [MPS-2c] Re-anclaje al día 4 (MPS-D7, §22.6; núcleo de `scripts/saas-reanchor.ts` y de «Re-anclar al 4» de
 * Plataforma) contra Postgres en los dos roles. Símbolos REALES de `lib/saas-reanchor-internal.ts`: `runSaasReanchor`
 * (lo que corre el script, con la conexión owner como DIRECT_URL) y `applyReanchorInTx` sobre el canal service.
 * El SCRIPT no se corre (lo corre Martin): se prueba su núcleo, acotado a los consultorios de este archivo.
 *
 * Se fija: sin cargos → billableFrom = max(inicio, hoy) y el primer 4; con cargos → billableFrom = el próximo cobro
 * viejo y el primer 4 ≥ eso, con el stub proyectado; en prueba → el día siguiente al fin; débito permitido siempre;
 * dry-run no escribe; idempotente (la segunda corrida saltea); sin BYPASSRLS aborta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient, SubscriptionStatus } from "@prisma/client";
import { prisma, prismaService } from "@/lib/db";
import { applyReanchorInTx, runSaasReanchor } from "@/lib/saas-reanchor-internal";
import { arMidnight, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
/** 10/3/2030 12:00 AR. */
const NOW = new Date("2030-03-10T15:00:00Z");

describe.skipIf(!RUN)("[MPS-2c] re-anclaje al 4", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  /** Suscripción legada anclada al 21, con el débito NO permitido (default viejo). */
  async function legacy(o: { charges?: boolean; status?: SubscriptionStatus; trialEndsAt?: Date } = {}) {
    const t = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    tenants.push(t);
    if (o.status) {
      await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: o.status, trialEndsAt: o.trialEndsAt ?? null } });
    }
    await db.saasSubscription.create({
      data: {
        tenantId: t.tenantId,
        anchorDay: 21,
        nextChargeAt: arMidnight("2030-03-21"),
        autoDebitAllowed: false,
        // Precio a medida legado (customPricePlan NULL = vale para cualquier plan, MPS-D14).
        customPriceCents: 3_100_000,
      },
    });
    if (o.charges) {
      await db.saasCharge.create({
        data: {
          tenantId: t.tenantId,
          plan: "CONSULTORIO",
          periodStart: dbDateFromKey("2030-02-21"),
          periodEnd: dbDateFromKey("2030-03-21"),
          dueDate: dbDateFromKey("2030-02-26"),
          amountCents: 3_100_000,
          status: "PAID",
          paidAt: new Date("2030-02-22T12:00:00Z"),
        },
      });
    }
    return t;
  }
  const sub = (t: EphemeralTenant) => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
  const run = (ids: string[], apply: boolean) => runSaasReanchor({ db, tenantIds: ids, apply, now: NOW });

  it("[MPS-2c] reanclaje sin cargos: billableFrom = hoy, primer 4, débito permitido; dry-run no escribe; idempotente", async () => {
    const t = await legacy();
    const before = await sub(t);

    const dry = await run([t.tenantId], false);
    expect(dry.applied).toBe(false);
    expect(dry.rows).toHaveLength(1);
    expect(dry.rows[0]).toMatchObject({
      tenantId: t.tenantId,
      hasCharges: false,
      oldAnchorDay: 21,
      newAnchorDay: 4,
      oldNextChargeOn: "2030-03-21",
      newNextChargeOn: "2030-04-04",
      billableFrom: "2030-03-10",
      oldAutoDebitAllowed: false,
      // 10/3 → 4/4 = 25 días del período 4/3 → 4/4 (31): 3.100.000 · 25 / 31 = 2.500.000.
      stub: { amountCents: 2_500_000, days: 25, periodDays: 31 },
      action: "update",
    });
    expect(await sub(t)).toEqual(before);

    const r = await run([t.tenantId], true);
    expect(r).toMatchObject({ applied: true, updated: 1 });
    const s = await sub(t);
    expect(s.anchorDay).toBe(4);
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-04-04");
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-03-10");
    expect(s.autoDebitAllowed).toBe(true);

    const again = await run([t.tenantId], true);
    expect(again.updated).toBe(0);
    expect(again.rows[0]).toMatchObject({ action: "skip", billableFrom: "2030-03-10", newNextChargeOn: "2030-04-04" });
    expect(await sub(t)).toEqual(s);
  });

  it("[MPS-2c] reanclaje con cargos: billableFrom = el próximo cobro viejo, primer 4 ≥ eso, stub proyectado; idempotente", async () => {
    const t = await legacy({ charges: true });
    const r = await run([t.tenantId], true);
    expect(r.updated).toBe(1);
    expect(r.rows[0]).toMatchObject({
      hasCharges: true,
      billableFrom: "2030-03-21",
      newNextChargeOn: "2030-04-04",
      // 21/3 → 4/4 = 14 de 31: 3.100.000 · 14 / 31 = 1.400.000.
      stub: { amountCents: 1_400_000, days: 14, periodDays: 31 },
    });
    const s = await sub(t);
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-03-21");
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-04-04");
    expect(s.autoDebitAllowed).toBe(true);
    // El cargo cobrado no se toca.
    const [c] = await db.saasCharge.findMany({ where: { tenantId: t.tenantId } });
    expect(c).toMatchObject({ amountCents: 3_100_000, status: "PAID" });

    const again = await run([t.tenantId], true);
    expect(again.updated).toBe(0);
    expect(await sub(t)).toEqual(s);
  });

  it("[MPS-2c] reanclaje en prueba: billableFrom = el día siguiente al fin de la prueba; por el canal service (Plataforma)", async () => {
    // Último día de prueba 15/3 AR.
    const t = await legacy({ status: "TRIALING", trialEndsAt: new Date("2030-03-16T02:59:59Z") });
    const r = await prismaService.$transaction((tx) => applyReanchorInTx(tx, { now: NOW, tenantIds: [t.tenantId] }));
    expect(r.updated).toBe(1);
    expect(r.rows[0]).toMatchObject({ billableFrom: "2030-03-16", newNextChargeOn: "2030-04-04" });
    const s = await sub(t);
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-03-16");
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-04-04");
  });

  it("[MPS-2c] reanclaje: sin BYPASSRLS aborta y un alcance vacío no corre", async () => {
    await expect(runSaasReanchor({ db, tenantIds: [], apply: false, now: NOW })).rejects.toThrow(/alcance/);
    const [role] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (role.bypass) return; // corrida owner: `prisma` ya es el owner.
    await expect(runSaasReanchor({ db: prisma, tenantIds: "all", apply: false, now: NOW })).rejects.toThrow(/BYPASSRLS/);
  });
});
