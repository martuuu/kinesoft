/**
 * [ZF1] Fixer de cobros del cierre de T6+T7 (revisor ZA): núcleo de la suscripción contra Postgres (dos roles), sin MP.
 *  - VOID → WAIVE: las copias que re-penden un cargo anulado conservan la cadena `splitFromId` (CARRYOVER → la copia
 *    del CREDIT), así un WAIVE posterior re-pende el par y la suma no cambia (antes el CARRYOVER copiado quedaba sin
 *    `splitFromId` y el WAIVE devolvía el crédito entero: saldo a favor de más).
 *  - Reactivar: `billableFrom = max(hoy, periodEnd del último cargo no VOID)`; un período ya cobrado no se vuelve a
 *    cobrar como proporcional.
 *  - Re-anclar conserva `autoDebitAllowed` (el bloqueo de Plataforma).
 * Símbolos reales (`lib/saas-billing-internal.ts`, `lib/saas-billing-schedule-internal.ts`, `lib/saas-reanchor-internal.ts`).
 * Fechas fijas en 2030.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { Prisma, PrismaClient, SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { createPeriodChargeInTx, readLedger, voidChargeInTx, waiveChargeInTx } from "@/lib/saas-billing-internal";
import { reactivateInTx } from "@/lib/saas-billing-schedule-internal";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { runSaasReanchor } from "@/lib/saas-reanchor-internal";
import { arMidnight, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const PLATFORM = { userId: null, email: null, homeTenantId: null };

describe.skipIf(!RUN)("[ZF1] núcleo de la suscripción", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => vi.stubEnv("SAAS_BILLING_MODE", "manual"));
  afterEach(() => vi.unstubAllEnvs());

  const svc = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prismaService.$transaction(fn);

  async function tenant(saasPlan: SaasPlan = "CONSULTORIO") {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    return t;
  }
  const adjustments = (t: EphemeralTenant) =>
    db.saasAdjustment.findMany({ where: { tenantId: t.tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const pendingSum = async (t: EphemeralTenant) =>
    (await adjustments(t)).filter((a) => a.appliedChargeId === null).reduce((s, a) => s + a.amountCents, 0);

  // ── VOID → WAIVE ──────────────────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] VOID de un cargo con CREDIT + CARRYOVER → copias encadenadas; el WAIVE siguiente no deja crédito de más", async () => {
    const t = await tenant();
    // Cargo del 4/4 OPEN (base 40.000; el CREDIT −50.000 cruzó el 0 y el CARRYOVER +20.000 lo compensa: neto −30.000 →
    // 10.000). Hoy un cargo con CARRYOVER nace en 0 (PAID); se arma a mano para cubrir el camino si eso cambia (y es
    // el caso que el revisor marcó). La tabla de ajustes es solo inserción: se insertan ya imputados.
    await db.saasSubscription.create({ data: { tenantId: t.tenantId, anchorDay: 4, nextChargeAt: arMidnight("2030-05-04"), customPriceCents: 4_000_000 } });
    const x = await db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey("2030-04-04"),
        periodEnd: dbDateFromKey("2030-05-04"),
        dueDate: dbDateFromKey("2030-04-09"),
        amountCents: 1_000_000,
        baseAmountCents: 4_000_000,
        adjustmentsCents: -3_000_000,
        status: "OPEN",
      },
    });
    const appliedAt = new Date("2030-04-04T12:00:00Z");
    const credit = await db.saasAdjustment.create({
      data: {
        tenantId: t.tenantId,
        kind: "CREDIT",
        amountCents: -5_000_000,
        effectiveOn: dbDateFromKey("2030-04-01"),
        description: "Crédito de prueba",
        idempotencyKey: "zf1-credit",
        appliedChargeId: x.id,
        appliedAt,
      },
    });
    const carry = await db.saasAdjustment.create({
      data: {
        tenantId: t.tenantId,
        kind: "CARRYOVER",
        amountCents: 2_000_000,
        effectiveOn: dbDateFromKey("2030-04-04"),
        description: "Saldo a favor que pasa al próximo cargo",
        idempotencyKey: "zf1-carry",
        splitFromId: credit.id,
        appliedChargeId: x.id,
        appliedAt,
      },
    });

    const now = new Date("2030-04-05T15:00:00Z");
    expect(await svc((tx) => voidChargeInTx(tx, { tenantId: t.tenantId, chargeId: x.id, note: "Error", actorId: null, now }))).toMatchObject({ ok: true });
    const copies = (await adjustments(t)).filter((a) => a.idempotencyKey.startsWith("repend:"));
    const cCopy = copies.find((a) => a.idempotencyKey === `repend:${credit.id}`)!;
    const kCopy = copies.find((a) => a.idempotencyKey === `repend:${carry.id}`)!;
    expect(cCopy).toMatchObject({ kind: "CREDIT", amountCents: -5_000_000, splitFromId: null, appliedChargeId: null });
    // El CARRYOVER copiado apunta a la COPIA del CREDIT (no al original, que quedó en el cargo anulado).
    expect(kCopy).toMatchObject({ kind: "CARRYOVER", amountCents: 2_000_000, splitFromId: cCopy.id, appliedChargeId: null });
    expect(await pendingSum(t)).toBe(-3_000_000);

    // El cargo del 4/5 usa las copias: 40.000 + 20.000 − 50.000 = 10.000 (OPEN).
    const y = await svc((tx) => createPeriodChargeInTx(tx, { tenantId: t.tenantId, now: new Date("2030-05-04T12:00:00Z") }));
    expect(y).toMatchObject({ kind: "created", amountCents: 1_000_000 });
    if (y.kind !== "created") return;
    expect(await pendingSum(t)).toBe(0);

    // WAIVE: re-pende el CREDIT y su CARRYOVER (el par), no solo el crédito.
    expect(
      await svc((tx) => waiveChargeInTx(tx, { tenantId: t.tenantId, chargeId: y.chargeId, note: null, actorId: null, now: new Date("2030-05-05T15:00:00Z") }))
    ).toMatchObject({ ok: true });
    expect(await pendingSum(t)).toBe(-3_000_000);
  });

  it("[ZF1] CREDIT re-pendido conserva su splitFromId (el resto de un crédito sigue siendo de ese crédito)", async () => {
    const t = await tenant();
    await db.saasSubscription.create({ data: { tenantId: t.tenantId, anchorDay: 4, nextChargeAt: arMidnight("2030-05-04"), customPriceCents: 4_000_000 } });
    const root = await db.saasAdjustment.create({
      data: { tenantId: t.tenantId, kind: "CREDIT", amountCents: -100, effectiveOn: dbDateFromKey("2030-03-01"), description: "raíz", idempotencyKey: "zf1-root", appliedChargeId: null, appliedAt: null },
    });
    const x = await db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey("2030-04-04"),
        periodEnd: dbDateFromKey("2030-05-04"),
        dueDate: dbDateFromKey("2030-04-09"),
        amountCents: 3_000_000,
        baseAmountCents: 4_000_000,
        adjustmentsCents: -1_000_000,
        status: "OPEN",
      },
    });
    const rest = await db.saasAdjustment.create({
      data: {
        tenantId: t.tenantId,
        kind: "CREDIT",
        amountCents: -1_000_000,
        effectiveOn: dbDateFromKey("2030-04-04"),
        description: "Saldo a favor del cargo anterior",
        idempotencyKey: "zf1-rest",
        splitFromId: root.id,
        appliedChargeId: x.id,
        appliedAt: new Date("2030-04-04T12:00:00Z"),
      },
    });
    await svc((tx) => waiveChargeInTx(tx, { tenantId: t.tenantId, chargeId: x.id, note: null, actorId: null, now: new Date("2030-04-05T15:00:00Z") }));
    const copy = (await adjustments(t)).find((a) => a.idempotencyKey === `repend:${rest.id}`);
    expect(copy).toMatchObject({ kind: "CREDIT", amountCents: -1_000_000, splitFromId: root.id });
  });

  // ── Reactivar ─────────────────────────────────────────────────────────────────────────────────────────────────

  async function cancelledByPlatform(o: { chargeStatus: "PAID" | "VOID" }) {
    const t = await tenant();
    await db.saasSubscription.create({ data: { tenantId: t.tenantId, anchorDay: 4, nextChargeAt: arMidnight("2030-05-04"), customPriceCents: 3_100_000 } });
    await db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey("2030-04-04"),
        periodEnd: dbDateFromKey("2030-05-04"),
        dueDate: dbDateFromKey("2030-04-09"),
        amountCents: 3_100_000,
        baseAmountCents: 3_100_000,
        adjustmentsCents: 0,
        status: o.chargeStatus,
        paidAt: o.chargeStatus === "PAID" ? new Date("2030-04-05T12:00:00Z") : null,
      },
    });
    const w = await svc((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId: t.tenantId, source: "platform", patch: { subscriptionStatus: "CANCELLED" }, actor: PLATFORM })
    );
    expect(w.ok).toBe(true);
    return t;
  }

  it("[ZF1] reactivar a mitad de un período ya cobrado → billableFrom = fin de ese período (sin proporcional doble)", async () => {
    const t = await cancelledByPlatform({ chargeStatus: "PAID" });
    const now = new Date("2030-04-12T15:00:00Z");
    expect(await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: PLATFORM, now }))).toEqual({ ok: true, status: "ACTIVE" });
    const s = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-05-04");
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-05-04");
    // El cargo del 4/5 sale con la base, sin stub del 12/4 al 3/5 (ese tramo ya estaba pagado).
    const r = await svc((tx) => createPeriodChargeInTx(tx, { tenantId: t.tenantId, now: new Date("2030-05-04T12:00:00Z") }));
    expect(r).toMatchObject({ kind: "created", amountCents: 3_100_000 });
    expect((await adjustments(t)).filter((a) => a.kind === "PRORATION")).toHaveLength(0);
  });

  it("[ZF1] reactivar: un cargo ANULADO no cuenta (billableFrom = hoy)", async () => {
    const t = await cancelledByPlatform({ chargeStatus: "VOID" });
    const now = new Date("2030-04-12T15:00:00Z");
    expect(await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: PLATFORM, now }))).toEqual({ ok: true, status: "ACTIVE" });
    const s = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-04-12");
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-05-04");
  });

  // ── Re-anclar ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] re-anclar conserva autoDebitAllowed (bloqueado sigue bloqueado; permitido sigue permitido) y la 2.ª corrida es skip", async () => {
    const blocked = await tenant();
    const allowed = await tenant();
    for (const [t, v] of [
      [blocked, false],
      [allowed, true],
    ] as const) {
      await db.saasSubscription.create({
        data: { tenantId: t.tenantId, anchorDay: 21, nextChargeAt: arMidnight("2030-03-21"), autoDebitAllowed: v, customPriceCents: 3_100_000 },
      });
    }
    const now = new Date("2030-03-10T15:00:00Z");
    const r = await runSaasReanchor({ db, tenantIds: [blocked.tenantId, allowed.tenantId], apply: true, now });
    expect(r.updated).toBe(2);
    const get = (t: EphemeralTenant) => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(await get(blocked)).toMatchObject({ anchorDay: 4, autoDebitAllowed: false });
    expect(await get(allowed)).toMatchObject({ anchorDay: 4, autoDebitAllowed: true });
    const again = await runSaasReanchor({ db, tenantIds: [blocked.tenantId, allowed.tenantId], apply: true, now });
    expect(again.updated).toBe(0);
    expect(again.rows.map((x) => x.action)).toEqual(["skip", "skip"]);
  });

  // ── Ledger ────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] readLedger devuelve customPricePlan (el plan al que quedó atado el precio a medida)", async () => {
    const t = await tenant("CLINICA");
    await db.saasSubscription.create({
      data: { tenantId: t.tenantId, anchorDay: 4, nextChargeAt: arMidnight("2030-05-04"), customPriceCents: 2_000_000, customPricePlan: "CONSULTORIO" },
    });
    const l = await readLedger(prismaService, t.tenantId, new Date("2030-04-20T15:00:00Z"));
    expect(l).toMatchObject({ plan: "CLINICA", customPriceCents: 2_000_000, customPricePlan: "CONSULTORIO" });
  });
});
