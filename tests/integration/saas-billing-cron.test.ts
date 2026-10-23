/**
 * [PL-2b] Cron diario único (`/api/cron/daily` → `runDaily` → `runSaasBilling`) contra Postgres en los dos roles.
 * Símbolos REALES; se reemplaza solo el despacho del mail (`__setEmailTransportForTests`).
 *
 * La base es compartida (otras sesiones corren sus tests a la vez): las corridas de cobro de este archivo van
 * ACOTADAS a sus consultorios (`scope.tenantIds`), y la de la ruta corre con `SAAS_BILLING_MODE=off` (solo afirma que
 * los cobros no hacen nada y que los jobs viejos siguen corriendo adentro).
 *
 * Se fija: `off` no crea ni cambia nada; un cargo por período (también con dos corridas a la vez); vencido →
 * PAST_DUE con `subscriptionStatusChangedAt`, y una segunda corrida no lo mueve (la gracia no se estira); pagar →
 * ACTIVE; sin precio no hay cargo pero el cursor avanza; prueba en curso → no se cobra y el anclaje es el día siguiente
 * al fin de la prueba; mails una sola vez; un precio con vigencia lo aplica el cron (historial + config + tag).
 *
 * [MPS-2a] Etapas nuevas: 2b (bajadas y bajas que vencen hoy, ANTES del cargo del día) y 4b (conciliación con MP, solo
 * en modo `mp`). `runSaasMpReconcile` se reemplaza por un espía: es red (Mercado Pago) y su núcleo lo prueba
 * `mps-2b-sync.test.ts`; acá solo se fija que la etapa lo llama, cuándo y con qué presupuesto.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Prisma, Role } from "@prisma/client";
import { GET as daily } from "@/app/api/cron/daily/route";
import { runSaasBilling, recordPaymentInTx, schedulePlanPriceInTx } from "@/lib/saas-billing-internal";
import { prismaService } from "@/lib/db";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { SAAS_PLANS_TAG } from "@/lib/cache-tags";
import { addDaysKey, arMidnight, chargeCreatedMailKey, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const reconcile = vi.hoisted(() => ({
  spy: vi.fn(async (_now: Date, _budgetMs: number, _scope?: { tenantIds?: string[] }) => ({ scanned: 1, updated: 0, failed: 0, timedOut: false })),
}));
vi.mock("@/lib/saas-mp-sync-internal", async (orig) => ({
  ...(await orig<typeof import("@/lib/saas-mp-sync-internal")>()),
  runSaasMpReconcile: reconcile.spy,
}));

const RUN = process.env.INTEGRATION === "1";
const SECRET = `cron-daily-${randomBytes(12).toString("hex")}`;
const DAY = 86_400_000;
const BUDGET = 30_000;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
  kinds(tenantId: string) {
    return mail.sent.filter((m) => m.tenantId === tenantId).map((m) => m.kind);
  },
};

describe.skipIf(!RUN)("[PL-2b] cron diario: cobros", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const priceChangeIds: string[] = [];
  const users: string[] = [];

  async function tenant(o: Parameters<typeof createEphemeralTenant>[1] = {}) {
    const t = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", ...o });
    tenants.push(t);
    return t;
  }
  /**
   * Suscripción con el próximo cobro hace `daysAgo` días (cargo ya vencido si daysAgo > 5). [MPS-2a] Modela una
   * suscripción LEGADA (previa a M16, sin re-anclar): ancla en cualquier día y `billableFrom` NULL (sin stub). Se deja
   * así a propósito: estos tests fijan el cursor y el estado con fechas relativas a hoy, y lo que cambia con el ancla
   * en 4 (stub del primer período) lo prueba `mps-2a-writer.test.ts` con fechas fijas.
   */
  async function subscribed(
    t: EphemeralTenant,
    o: { daysAgo: number; customPriceCents: number | null; extra?: Partial<Prisma.SaasSubscriptionUncheckedCreateInput> }
  ) {
    const start = addDaysKey(toARDateKey(new Date()), -o.daysAgo);
    await db.saasSubscription.create({
      data: {
        ...(o.extra ?? {}),
        tenantId: t.tenantId,
        anchorDay: Math.min(Number(start.slice(8)), 28),
        nextChargeAt: arMidnight(start),
        customPriceCents: o.customPriceCents,
      },
    });
    return start;
  }
  async function member(t: EphemeralTenant, role: Role = "PRACTITIONER") {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Miembro ${role}` } });
    return db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, clinical: role !== "ASSISTANT" && role !== "BILLING", acceptedAt: new Date() },
    });
  }
  const run = (ids: string[], now = new Date()) => runSaasBilling(now, BUDGET, { tenantIds: ids });

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db && priceChangeIds.length) {
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "SaasPlanPriceChange" WHERE "id" = ANY(${priceChangeIds})`,
      ]);
    }
    for (const t of tenants) await t.cleanup();
    if (db && users.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
      await db.userProfile.deleteMany({ where: { id: { in: users }, practitioners: { none: {} } } });
    }
    await db?.$disconnect();
  });
  beforeEach(() => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    vi.stubEnv("CRON_SECRET", SECRET);
    revalidateTagSpy.mockClear();
    reconcile.spy.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("SAAS_BILLING_MODE=off: no crea suscripciones, ni cargos, ni cambia estados", async () => {
    vi.stubEnv("SAAS_BILLING_MODE", "off");
    const t = await tenant();
    await subscribed(t, { daysAgo: 10, customPriceCents: 100_000 });
    const t2 = await tenant();
    const r = await run([t.tenantId, t2.tenantId]);
    expect(r).toMatchObject({ mode: "off", skipped: true, chargesCreated: 0, statusChanged: 0 });
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);
    expect(await db.saasSubscription.count({ where: { tenantId: t2.tenantId } })).toBe(0);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("ACTIVE");
    expect(mail.sent).toHaveLength(0);
  });

  it("un cargo por período; vencido → PAST_DUE con fecha; la segunda corrida no duplica ni estira la gracia", async () => {
    const t = await tenant();
    const start = await subscribed(t, { daysAgo: 10, customPriceCents: 1_234_500 });
    const r1 = await run([t.tenantId]);
    expect(r1).toMatchObject({ mode: "manual", skipped: false, chargesCreated: 1, statusChanged: 1, errors: 0 });

    const charges = await db.saasCharge.findMany({ where: { tenantId: t.tenantId } });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ status: "OPEN", amountCents: 1_234_500, plan: "CONSULTORIO" });
    expect(keyFromDbDate(charges[0].periodStart)).toBe(start);
    expect(keyFromDbDate(charges[0].dueDate)).toBe(addDaysKey(start, 5));
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(toARDateKey(sub.nextChargeAt!)).toBe(keyFromDbDate(charges[0].periodEnd));

    const t1 = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(t1.subscriptionStatus).toBe("PAST_DUE");
    expect(t1.subscriptionStatusChangedAt).not.toBeNull();
    expect(mail.kinds(t.tenantId).sort()).toEqual(["billing_charge_created", "billing_past_due"]);
    const claim = await db.platformAuditEvent.findUniqueOrThrow({ where: { idempotencyKey: chargeCreatedMailKey(charges[0].id) } });
    expect(claim).toMatchObject({ action: "platform.cron.billing_charge_created", tenantId: t.tenantId, actorId: null });

    mail.sent.length = 0;
    const r2 = await run([t.tenantId]);
    expect(r2).toMatchObject({ chargesCreated: 0, statusChanged: 0, mailsClaimed: 0 });
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(1);
    const t2 = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(t2.subscriptionStatusChangedAt!.getTime()).toBe(t1.subscriptionStatusChangedAt!.getTime());
    expect(mail.sent).toHaveLength(0);

    // Pagar (Plataforma aprueba) → ACTIVE en la misma tx.
    await prismaService.$transaction((tx) =>
      recordPaymentInTx(tx, {
        tenantId: t.tenantId,
        chargeId: charges[0].id,
        amountCents: 1_234_500,
        status: "APPROVED",
        paidAt: null,
        receipt: null,
        note: null,
        method: "TRANSFER",
        submittedById: null,
        now: new Date(),
      })
    );
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: charges[0].id } })).status).toBe("PAID");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("ACTIVE");
  });

  it("dos corridas a la vez → un solo cargo (UNIQUE tenant+período)", async () => {
    const t = await tenant();
    await subscribed(t, { daysAgo: 1, customPriceCents: 50_000 });
    const [a, b] = await Promise.all([run([t.tenantId]), run([t.tenantId])]);
    expect(a.chargesCreated + b.chargesCreated).toBe(1);
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(1);
    expect(mail.kinds(t.tenantId).filter((k) => k === "billing_charge_created")).toHaveLength(1);
    // Vence en 4 días: todavía al día.
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("ACTIVE");
  });

  it("sin precio (plan en «Consultá», sin precio a medida) → no hay cargo, el cursor avanza un mes", async () => {
    const t = await tenant({ saasPlan: "CLINICA" });
    const cfg = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "CLINICA" } });
    expect(cfg.priceCents).toBeNull(); // M8 sembró los precios en NULL (PL-D19)
    const start = await subscribed(t, { daysAgo: 2, customPriceCents: null });
    const r = await run([t.tenantId]);
    expect(r.chargesCreated).toBe(0);
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(toARDateKey(sub.nextChargeAt!)).not.toBe(start);
    expect(sub.nextChargeAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("prueba en curso: la suscripción se ancla al día siguiente del fin de prueba y no se cobra antes", async () => {
    const t = await tenant();
    const trialEndsAt = new Date(Date.now() + 5 * DAY);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "TRIALING", trialEndsAt } });
    const r = await run([t.tenantId]);
    expect(r.subscriptionsCreated).toBe(1);
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    const startKey = addDaysKey(toARDateKey(trialEndsAt), 1);
    expect(sub.anchorDay).toBe(4);
    expect(toARDateKey(sub.nextChargeAt!) >= startKey).toBe(true);
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);

    // Plataforma extiende la prueba: sin cargos todavía, el primer cobro se corre con ella. Cuando llega la fecha
    // vieja del primer cobro, el cron re-ancla en vez de cobrar.
    const extended = new Date(Date.now() + 20 * DAY);
    await db.tenant.update({ where: { id: t.tenantId }, data: { trialEndsAt: extended } });
    const r2 = await run([t.tenantId], new Date(sub.nextChargeAt!.getTime() + DAY / 2));
    expect(r2.chargesCreated).toBe(0);
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);
    const sub2 = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(toARDateKey(sub2.nextChargeAt!) >= addDaysKey(toARDateKey(extended), 1)).toBe(true);
  });

  it("precio con vigencia: el cron lo aplica (config + appliedAt + tag del catálogo)", async () => {
    const before = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } });
    try {
      const now = new Date();
      const ch = await prismaService.$transaction((tx) =>
        schedulePlanPriceInTx(tx, { plan: "LIBRE", priceCents: 4_200_000, effectiveFrom: new Date(now.getTime() + 2 * DAY), note: null, actorId: null, now })
      );
      priceChangeIds.push(ch.changeId);
      expect(ch.appliedNow).toBe(false);
      await run([], now);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(before.priceCents);

      const r = await run([], new Date(now.getTime() + 3 * DAY));
      expect(r.pricesApplied).toBeGreaterThanOrEqual(1);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(4_200_000);
      expect((await db.saasPlanPriceChange.findUniqueOrThrow({ where: { id: ch.changeId } })).appliedAt).not.toBeNull();
      expect(revalidateTagSpy).toHaveBeenCalledWith(SAAS_PLANS_TAG);
      // Idempotente: otra corrida no lo vuelve a aplicar.
      const again = await run([], new Date(now.getTime() + 3 * DAY));
      expect(again.pricesApplied).toBe(0);
    } finally {
      await db.saasPlanConfig.update({ where: { plan: "LIBRE" }, data: { priceCents: before.priceCents, updatedById: before.updatedById } });
    }
  });

  it("/api/cron/daily: sin secreto 401; con secreto corre todas las etapas (cobros en off: no hacen nada)", async () => {
    vi.stubEnv("SAAS_BILLING_MODE", "off");
    const unauth = await daily(new Request("http://localhost:3000/api/cron/daily"));
    expect(unauth.status).toBe(401);
    const res = await daily(new Request("http://localhost:3000/api/cron/daily", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      job: "daily",
      billing: { ok: true, result: { mode: "off", skipped: true } },
      invitations: { ok: true },
      trialReminders: { ok: true },
      healthDigest: { ok: true },
      // [FC-2i] la etapa del Storage corre última; sin Storage configurado (Docker local/CI) se saltea sin fallar.
      storagePending: { ok: true, result: { skipped: true, reason: "unconfigured" } },
    });
  });

  // ── [MPS-2a] etapa 2b: bajadas y bajas que vencen ────────────────────────────────────────────────────────────

  it("[MPS-2a] etapa 2b: la bajada que vence hoy se aplica ANTES del cargo del día (el cargo sale con el plan nuevo)", async () => {
    const t = await tenant();
    const today = toARDateKey(new Date());
    await subscribed(t, {
      daysAgo: 0,
      customPriceCents: 100_000,
      extra: { pendingPlan: "INDIVIDUAL", pendingPlanEffectiveOn: dbDateFromKey(today), pendingPlanRequestedById: t.userId, pendingPlanRequestedAt: new Date() },
    });
    const r = await run([t.tenantId]);
    expect(r).toMatchObject({ plansApplied: 1, plansAborted: 0, cancelsApplied: 0, chargesCreated: 1, errors: 0 });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("INDIVIDUAL");
    const [charge] = await db.saasCharge.findMany({ where: { tenantId: t.tenantId } });
    expect(charge).toMatchObject({ plan: "INDIVIDUAL", amountCents: 100_000, baseAmountCents: 100_000 });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).pendingPlan).toBeNull();
    expect(mail.kinds(t.tenantId)).not.toContain("billing_plan_change");
  });

  it("[MPS-2a] etapa 2b: la bajada que ya no entra se anula, se cobra el plan actual y avisa (billing_plan_change)", async () => {
    const t = await tenant();
    await member(t);
    const today = toARDateKey(new Date());
    await subscribed(t, {
      daysAgo: 0,
      customPriceCents: 100_000,
      extra: { pendingPlan: "INDIVIDUAL", pendingPlanEffectiveOn: dbDateFromKey(today), pendingPlanRequestedById: t.userId, pendingPlanRequestedAt: new Date() },
    });
    const r = await run([t.tenantId]);
    expect(r).toMatchObject({ plansApplied: 0, plansAborted: 1, chargesCreated: 1, errors: 0 });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("CONSULTORIO");
    expect((await db.saasCharge.findFirstOrThrow({ where: { tenantId: t.tenantId } })).plan).toBe("CONSULTORIO");
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).pendingPlan).toBeNull();
    expect(mail.kinds(t.tenantId)).toContain("billing_plan_change");
    // Otra corrida no vuelve a avisar (ya no hay nada programado).
    mail.sent.length = 0;
    expect(await run([t.tenantId])).toMatchObject({ plansAborted: 0 });
    expect(mail.kinds(t.tenantId)).not.toContain("billing_plan_change");
  });

  it("[MPS-2a] etapa 2b: la baja que vence hoy pasa a CANCELLED y no se cobra el período", async () => {
    const t = await tenant();
    const today = toARDateKey(new Date());
    await subscribed(t, {
      daysAgo: 0,
      customPriceCents: 100_000,
      extra: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey(today), cancelRequestedAt: new Date(), cancelRequestedById: t.userId },
    });
    const r = await run([t.tenantId]);
    expect(r).toMatchObject({ cancelsApplied: 1, chargesCreated: 0, errors: 0 });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("CANCELLED");
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.cancelAtPeriodEnd).toBe(false);
    // El cursor avanzó como «cancelled» (no se acumulan períodos para cuando se reactive).
    expect(sub.nextChargeAt!.getTime()).toBeGreaterThan(Date.now());
    expect(mail.kinds(t.tenantId)).toContain("billing_cancelled");
  });

  // ── [MPS-2a] etapa 4b: conciliación con MP ──────────────────────────────────────────────────────────────────

  it("[MPS-2a] etapa 4b: la conciliación con MP corre solo en modo mp, acotada y con ≤ 10 s", async () => {
    const t = await tenant();
    const manual = await run([t.tenantId]);
    expect(manual.mp).toBeNull();
    expect(reconcile.spy).not.toHaveBeenCalled();

    vi.stubEnv("SAAS_BILLING_MODE", "mp");
    const now = new Date();
    const r = await runSaasBilling(now, BUDGET, { tenantIds: [t.tenantId] });
    expect(r.mode).toBe("mp");
    expect(reconcile.spy).toHaveBeenCalledTimes(1);
    const [calledNow, budget, scope] = reconcile.spy.mock.calls[0];
    expect(calledNow).toBe(now);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(10_000);
    expect(scope).toEqual({ tenantIds: [t.tenantId] });
    expect(r.mp).toEqual({ scanned: 1, updated: 0, failed: 0, timedOut: false });
  });
});
