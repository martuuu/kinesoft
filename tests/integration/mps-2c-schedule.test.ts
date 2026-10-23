/**
 * [MPS-2c] Programación de la suscripción (C-MPS9, plan §26.6; MPS-D11/D12/D13/D18/D19): bajada programada al próximo
 * 4 (se aplica ese día o se anula si la selección ya no entra), proporcional de la subida (días AR, half-up), baja a
 * fin de período (en prueba: el día siguiente al fin), deshacer, aplicar la baja (CANCELLED → solo lectura) y
 * reactivar (solo si la baja fue propia y no hay deuda).
 *
 * Símbolos REALES (`lib/saas-billing-schedule-internal.ts` sobre `prismaService.$transaction`, el canal service que
 * abren las actions, Plataforma y la etapa 2b del cron; el escritor único de entitlements; `applyPlanChangeInTx`)
 * contra Postgres en los dos roles. No se mockea nada: estos núcleos no tocan sesión, red ni cache.
 *
 * Fechas FIJAS en 2030 (todas las funciones reciben `now`): el período 4/3 → 4/4 tiene 31 días. Los consultorios se
 * crean «hoy» (createdAt real), siempre antes de esas fechas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Role, SaasPlan, SubscriptionStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import {
  addUpgradeProrationInTx,
  applyDueCancelInTx,
  applyDuePlanChangeInTx,
  reactivateInTx,
  scheduleCancelInTx,
  scheduleDowngradeInTx,
  undoCancelInTx,
} from "@/lib/saas-billing-schedule-internal";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { arMidnight, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { tenantAccessFor } from "@/lib/tenant-access";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** 20/3/2030 12:00 AR. */
const MID = new Date("2030-03-20T15:00:00Z");

describe.skipIf(!RUN)("[MPS-2c] programación de la suscripción", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  const svc = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prismaService.$transaction(fn);

  async function tenant(saasPlan: SaasPlan, o: { subscriptionStatus?: SubscriptionStatus; trialEndsAt?: Date } = {}) {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    if (o.subscriptionStatus || o.trialEndsAt) {
      await db.tenant.update({
        where: { id: t.tenantId },
        data: { subscriptionStatus: o.subscriptionStatus, trialEndsAt: o.trialEndsAt ?? null },
      });
    }
    return t;
  }

  async function member(t: EphemeralTenant, role: Role = "PRACTITIONER") {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Miembro ${role}` } });
    return db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, clinical: role !== "ASSISTANT" && role !== "BILLING", acceptedAt: new Date() },
    });
  }

  /** Suscripción anclada al 4 con el próximo cobro el 4/4/2030 (y opcionalmente el cargo del período 4/3 → 4/4). */
  async function subscribed(
    t: EphemeralTenant,
    o: {
      charge?: { plan: SaasPlan; baseCents: number; status?: "OPEN" | "PAID" };
      customPriceCents?: number;
      customPricePlan?: SaasPlan;
      nextChargeKey?: string;
    } = {}
  ) {
    await db.saasSubscription.create({
      data: {
        tenantId: t.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(o.nextChargeKey ?? "2030-04-04"),
        customPriceCents: o.customPriceCents ?? null,
        customPricePlan: o.customPricePlan ?? null,
      },
    });
    if (o.charge) {
      const paid = o.charge.status === "PAID";
      await db.saasCharge.create({
        data: {
          tenantId: t.tenantId,
          plan: o.charge.plan,
          periodStart: dbDateFromKey("2030-03-04"),
          periodEnd: dbDateFromKey("2030-04-04"),
          dueDate: dbDateFromKey("2030-03-09"),
          amountCents: o.charge.baseCents,
          baseAmountCents: o.charge.baseCents,
          adjustmentsCents: 0,
          status: o.charge.status ?? "PAID",
          paidAt: paid || o.charge.status === undefined ? new Date("2030-03-05T12:00:00Z") : null,
        },
      });
    }
  }

  const sub = (t: EphemeralTenant) => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
  const row = (t: EphemeralTenant) => db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
  const tenantActor = (t: EphemeralTenant) => ({ userId: t.userId, homeTenantId: t.tenantId });

  // ── Bajada programada ─────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2c] bajada programada: queda para el próximo 4 y se aplica ese día con la selección", async () => {
    const t = await tenant("CONSULTORIO");
    const m = await member(t);
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });

    const r = await svc((tx) =>
      scheduleDowngradeInTx(tx, { tenantId: t.tenantId, to: "INDIVIDUAL", disableMembershipIds: [m.id], requestedById: t.userId, now: MID })
    );
    expect(r).toEqual({ ok: true, effectiveOn: "2030-04-04" });
    const s = await sub(t);
    expect(s.pendingPlan).toBe("INDIVIDUAL");
    expect(keyFromDbDate(s.pendingPlanEffectiveOn!)).toBe("2030-04-04");
    expect(s.pendingPlanDisableIds).toEqual([m.id]);
    expect(s.pendingPlanRequestedById).toBe(t.userId);
    expect(s.pendingPlanRequestedAt).not.toBeNull();
    // El plan pagado se respeta hasta el 4.
    expect((await row(t)).saasPlan).toBe("CONSULTORIO");

    // El 3 a la noche (AR) todavía no vence.
    const before = await svc((tx) => applyDuePlanChangeInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T02:30:00Z") }));
    expect(before).toMatchObject({ outcome: "none" });
    expect((await row(t)).saasPlan).toBe("CONSULTORIO");

    const due = await svc((tx) => applyDuePlanChangeInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T11:00:00Z") }));
    expect(due).toMatchObject({ outcome: "applied", plan: "INDIVIDUAL" });
    const after = await row(t);
    expect(after.saasPlan).toBe("INDIVIDUAL");
    expect(after.plan).toBe(LEGACY_PLAN_OF.INDIVIDUAL);
    const disabled = await db.membership.findUniqueOrThrow({ where: { id: m.id } });
    expect(disabled.disabledReason).toBe("PLAN_DOWNGRADE");
    expect(disabled.disabledAt).not.toBeNull();
    const s2 = await sub(t);
    expect(s2.pendingPlan).toBeNull();
    expect(s2.pendingPlanEffectiveOn).toBeNull();
    expect(s2.pendingPlanDisableIds).toEqual([]);
    // Audit del cambio en el consultorio, a nombre de quien lo pidió.
    const audit = await db.auditEvent.findFirst({ where: { tenantId: t.tenantId, action: "tenant.plan.change" } });
    expect(audit).toMatchObject({ actorId: t.userId });
    // Repetir es un no-op.
    const again = await svc((tx) => applyDuePlanChangeInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T12:00:00Z") }));
    expect(again).toMatchObject({ outcome: "none" });
  });

  it("[MPS-2c] bajada programada: se anula si se agregaron usuarios y queda el plan actual (MPS-D12)", async () => {
    const t = await tenant("CONSULTORIO");
    const m = await member(t);
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });
    const r = await svc((tx) =>
      scheduleDowngradeInTx(tx, { tenantId: t.tenantId, to: "INDIVIDUAL", disableMembershipIds: [m.id], requestedById: t.userId, now: MID })
    );
    expect(r.ok).toBe(true);
    // Después de programar, entra otra persona: con la selección guardada ya no entra en Individual.
    const extra = await member(t, "ASSISTANT");

    const due = await svc((tx) => applyDuePlanChangeInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T11:00:00Z") }));
    expect(due).toMatchObject({ outcome: "annulled", plan: "CONSULTORIO", pendingPlan: "INDIVIDUAL", reason: "does_not_fit", requestedById: t.userId });
    expect((await row(t)).saasPlan).toBe("CONSULTORIO");
    for (const id of [m.id, extra.id]) {
      expect((await db.membership.findUniqueOrThrow({ where: { id } })).disabledAt).toBeNull();
    }
    const s = await sub(t);
    expect(s.pendingPlan).toBeNull();
    expect(s.pendingPlanDisableIds).toEqual([]);
  });

  it("[MPS-2c] programar valida la selección con el preview real: no entra, Titular, no es bajada, baja pendiente", async () => {
    const t = await tenant("CONSULTORIO");
    const m = await member(t);
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });
    const schedule = (to: SaasPlan, ids: string[]) =>
      svc((tx) => scheduleDowngradeInTx(tx, { tenantId: t.tenantId, to, disableMembershipIds: ids, requestedById: t.userId, now: MID }));

    expect(await schedule("INDIVIDUAL", [])).toMatchObject({ ok: false, reason: "does_not_fit" });
    const owner = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
    expect(await schedule("INDIVIDUAL", [owner.id])).toMatchObject({ ok: false, reason: "invalid_selection" });
    expect(await schedule("INDIVIDUAL", [m.id, m.id])).toMatchObject({ ok: false, reason: "invalid_selection" });
    expect(await schedule("CLINICA", [])).toMatchObject({ ok: false, reason: "not_downgrade" });
    expect((await sub(t)).pendingPlan).toBeNull();

    const c = await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));
    expect(c.ok).toBe(true);
    expect(await schedule("INDIVIDUAL", [m.id])).toMatchObject({ ok: false, reason: "cancel_pending" });
    expect((await sub(t)).pendingPlan).toBeNull();
  });

  // ── Subida con proporcional ───────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2c] subida con proporcional exacto: días AR, half-up, clave upgrade:<uuid>, idempotente", async () => {
    const t = await tenant("INDIVIDUAL");
    // Cargo del período por 10.000,00 (Individual); Consultorio a medida en 30.000,00 → diferencia 20.000,00/mes.
    await subscribed(t, { charge: { plan: "INDIVIDUAL", baseCents: 1_000_000 }, customPriceCents: 3_000_000, customPricePlan: "CONSULTORIO" });
    const key = randomUUID();
    // 02:30Z del 20/3 = 23:30 AR del 19/3: cuentan 16 días (19/3..3/4), no los 15 del día UTC.
    const now = new Date("2030-03-20T02:30:00Z");
    const r = await svc((tx) =>
      addUpgradeProrationInTx(tx, { tenantId: t.tenantId, from: "INDIVIDUAL", to: "CONSULTORIO", createdById: t.userId, idempotencyKey: key, now })
    );
    // 2.000.000 · 16 / 31 = 1.032.258,06 → 1.032.258.
    expect(r).toMatchObject({ prorationCents: 1_032_258, days: 16, periodDays: 31 });
    expect(r.adjustmentId).toBeTruthy();
    const adj = await db.saasAdjustment.findUniqueOrThrow({ where: { id: r.adjustmentId! } });
    expect(adj).toMatchObject({
      tenantId: t.tenantId,
      kind: "PRORATION",
      amountCents: 1_032_258,
      planFrom: "INDIVIDUAL",
      planTo: "CONSULTORIO",
      days: 16,
      periodDays: 31,
      idempotencyKey: `upgrade:${key}`,
      createdById: t.userId,
      appliedChargeId: null,
    });
    // Se imputa al PRÓXIMO cargo (periodStart ≥ 4/4); la fecha de la subida va en la descripción.
    expect(keyFromDbDate(adj.effectiveOn)).toBe("2030-04-04");
    expect(adj.description).toContain("19/3");

    const again = await svc((tx) =>
      addUpgradeProrationInTx(tx, { tenantId: t.tenantId, from: "INDIVIDUAL", to: "CONSULTORIO", createdById: t.userId, idempotencyKey: key, now })
    );
    expect(again.adjustmentId).toBe(r.adjustmentId);
    expect(await db.saasAdjustment.count({ where: { tenantId: t.tenantId } })).toBe(1);
  });

  it("[MPS-2c] subida sin cargo del período o con el plan nuevo en «Consultá»: sin proporcional (MPS-D11)", async () => {
    const t = await tenant("INDIVIDUAL");
    await subscribed(t, { customPriceCents: 3_000_000, customPricePlan: "CONSULTORIO" });
    const r = await svc((tx) =>
      addUpgradeProrationInTx(tx, { tenantId: t.tenantId, from: "INDIVIDUAL", to: "CONSULTORIO", createdById: null, idempotencyKey: randomUUID(), now: MID })
    );
    expect(r).toEqual({ adjustmentId: null, prorationCents: 0, days: 0, periodDays: 0 });

    const t2 = await tenant("INDIVIDUAL");
    await subscribed(t2, { charge: { plan: "INDIVIDUAL", baseCents: 1_000_000 } });
    // Sin precio a medida para Clínica y la lista local en «Consultá» (null): no hay diferencia que cobrar.
    const cfg = await db.saasPlanConfig.findUnique({ where: { plan: "CLINICA" } });
    if (cfg?.priceCents == null) {
      const r2 = await svc((tx) =>
        addUpgradeProrationInTx(tx, { tenantId: t2.tenantId, from: "INDIVIDUAL", to: "CLINICA", createdById: null, idempotencyKey: randomUUID(), now: MID })
      );
      expect(r2.adjustmentId).toBeNull();
    }
    expect(await db.saasAdjustment.count({ where: { tenantId: { in: [t.tenantId, t2.tenantId] } } })).toBe(0);
  });

  // ── Baja ──────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2c] baja en prueba → rige el día siguiente al fin de la prueba (MPS-D18)", async () => {
    // Último día de prueba: 25/3 AR (fin del día = 26/3 02:59Z).
    const t = await tenant("INDIVIDUAL", { subscriptionStatus: "TRIALING", trialEndsAt: new Date("2030-03-26T02:59:59Z") });
    await subscribed(t);
    const r = await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));
    expect(r).toMatchObject({ ok: true, effectiveOn: "2030-03-26" });
    const s = await sub(t);
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(keyFromDbDate(s.cancelEffectiveOn!)).toBe("2030-03-26");
    expect(s.cancelRequestedById).toBe(t.userId);
    expect(s.cancelRequestedAt).not.toBeNull();
  });

  it("[MPS-2c] baja al fin del período; no se programa dos veces; deshacer la limpia", async () => {
    const t = await tenant("CONSULTORIO");
    const m = await member(t);
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });
    // Una bajada ya programada se cae con la baja (no hay plan que bajar si se va).
    const d = await svc((tx) =>
      scheduleDowngradeInTx(tx, { tenantId: t.tenantId, to: "INDIVIDUAL", disableMembershipIds: [m.id], requestedById: t.userId, now: MID })
    );
    expect(d.ok).toBe(true);

    const r = await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));
    expect(r).toMatchObject({ ok: true, effectiveOn: "2030-04-04" });
    const s = await sub(t);
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(keyFromDbDate(s.cancelEffectiveOn!)).toBe("2030-04-04");
    expect(s.pendingPlan).toBeNull();
    expect(await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }))).toMatchObject({
      ok: false,
      reason: "already_cancel_pending",
    });

    const u = await svc((tx) => undoCancelInTx(tx, { tenantId: t.tenantId, actorUserId: t.userId, now: MID }));
    expect(u).toEqual({ ok: true });
    const s2 = await sub(t);
    expect(s2.cancelAtPeriodEnd).toBe(false);
    expect(s2.cancelEffectiveOn).toBeNull();
    expect(s2.cancelRequestedAt).toBeNull();
    expect(await svc((tx) => undoCancelInTx(tx, { tenantId: t.tenantId, actorUserId: t.userId, now: MID }))).toMatchObject({
      ok: false,
      reason: "not_cancel_pending",
    });
    // Ya vencida no se deshace (la aplica el cron ese día).
    await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));
    expect(
      await svc((tx) => undoCancelInTx(tx, { tenantId: t.tenantId, actorUserId: t.userId, now: new Date("2030-04-04T11:00:00Z") }))
    ).toMatchObject({ ok: false, reason: "stale" });
  });

  it("[MPS-2c] aplicar la baja que vence → CANCELLED por el escritor único y read_only", async () => {
    const t = await tenant("CONSULTORIO");
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });
    await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));

    const early = await svc((tx) => applyDueCancelInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T02:30:00Z") }));
    expect(early).toEqual({ cancelled: false });
    expect((await row(t)).subscriptionStatus).toBe("ACTIVE");

    const now = new Date("2030-04-04T11:00:00Z");
    const r = await svc((tx) => applyDueCancelInTx(tx, { tenantId: t.tenantId, actor: null, now }));
    expect(r).toEqual({ cancelled: true });
    const after = await row(t);
    expect(after.subscriptionStatus).toBe("CANCELLED");
    expect(after.subscriptionStatusChangedAt).not.toBeNull();
    expect(tenantAccessFor(after, now)).toMatchObject({ mode: "read_only", reason: "cancelled" });
    const s = await sub(t);
    expect(s.cancelAtPeriodEnd).toBe(false);
    // La fecha queda de historia (la usa `reactivateInTx` y la UI: «Se dio de baja el 4/4»).
    expect(keyFromDbDate(s.cancelEffectiveOn!)).toBe("2030-04-04");
    const audit = await db.auditEvent.findFirst({ where: { tenantId: t.tenantId, action: "tenant.entitlements" }, orderBy: { createdAt: "desc" } });
    expect(audit?.payload).toMatchObject({ source: "billing", after: { subscriptionStatus: "CANCELLED" } });
    // Repetir no hace nada.
    expect(await svc((tx) => applyDueCancelInTx(tx, { tenantId: t.tenantId, actor: null, now }))).toEqual({ cancelled: false });
  });

  // ── Reactivar ─────────────────────────────────────────────────────────────────────────────────────────────────

  async function ownCancelled(o: { debt?: boolean } = {}) {
    const t = await tenant("CONSULTORIO");
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000, status: o.debt ? "OPEN" : "PAID" } });
    await svc((tx) => scheduleCancelInTx(tx, { tenantId: t.tenantId, requestedById: t.userId, now: MID }));
    await svc((tx) => applyDueCancelInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date("2030-04-04T11:00:00Z") }));
    expect((await row(t)).subscriptionStatus).toBe("CANCELLED");
    return t;
  }

  it("[MPS-2c] reactivar una baja propia sin deuda: ACTIVE, billableFrom = hoy, próximo cobro el 4", async () => {
    const t = await ownCancelled();
    const now = new Date("2030-04-10T15:00:00Z");
    const r = await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: tenantActor(t), now }));
    expect(r).toEqual({ ok: true, status: "ACTIVE" });
    const after = await row(t);
    expect(after.subscriptionStatus).toBe("ACTIVE");
    expect(tenantAccessFor(after, now)).toMatchObject({ mode: "full" });
    const s = await sub(t);
    expect(keyFromDbDate(s.billableFrom!)).toBe("2030-04-10");
    expect(s.anchorDay).toBe(4);
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-05-04");
    expect(s.cancelAtPeriodEnd).toBe(false);
    expect(s.cancelEffectiveOn).toBeNull();
    // Ya no está cancelada.
    expect(await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: tenantActor(t), now }))).toMatchObject({
      ok: false,
      reason: "not_cancelled",
    });
  });

  it("[MPS-2c] reactivar: con deuda no; una baja de Plataforma solo la reactiva Plataforma (MPS-D19)", async () => {
    const owed = await ownCancelled({ debt: true });
    const now = new Date("2030-04-10T15:00:00Z");
    expect(await svc((tx) => reactivateInTx(tx, { tenantId: owed.tenantId, actor: tenantActor(owed), now }))).toMatchObject({
      ok: false,
      reason: "has_debt",
    });
    expect((await row(owed)).subscriptionStatus).toBe("CANCELLED");

    const t = await tenant("CONSULTORIO");
    await subscribed(t, { charge: { plan: "CONSULTORIO", baseCents: 3_000_000 } });
    const platform = { userId: null, email: null, homeTenantId: null };
    const w = await svc((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId: t.tenantId, source: "platform", patch: { subscriptionStatus: "CANCELLED" }, actor: platform })
    );
    expect(w.ok).toBe(true);
    expect(await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: tenantActor(t), now }))).toMatchObject({
      ok: false,
      reason: "not_cancelled",
      detail: "not_own",
    });
    expect((await row(t)).subscriptionStatus).toBe("CANCELLED");
    const p = await svc((tx) => reactivateInTx(tx, { tenantId: t.tenantId, actor: platform, now }));
    expect(p).toEqual({ ok: true, status: "ACTIVE" });
    expect((await row(t)).subscriptionStatus).toBe("ACTIVE");
  });
});
