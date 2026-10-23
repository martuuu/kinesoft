/**
 * [MPS-2a] Escritor de la suscripción con ajustes (C-MPS5, plan §26.6; MPS-D13/D14/D15): ancla 4 con `billableFrom`,
 * stub del primer período, ajustes pendientes que entran en el cargo (base + ajustes, CHECK de desglose), CARRYOVER
 * cuando un crédito cruza el 0, VOID/WAIVE que re-penden, hermano partido de un pago de MP (`splitFromId`, CHECK
 * `SaasPayment_source_mp_check` de M16), reintegro del árbol de un pago y el ledger con los campos nuevos.
 *
 * Símbolos REALES del núcleo (`lib/saas-billing-internal.ts` + `lib/saas-adjustments-internal.ts`) sobre
 * `prismaService.$transaction` (el canal service que abren el cron, el webhook y Plataforma), contra Postgres en los
 * dos roles. No se mockea nada: estos núcleos no tocan sesión, red ni cache (salvo `revalidateTag`, que no se usa acá).
 *
 * Fechas FIJAS en 2030 (todas las funciones reciben `now`): los períodos 4/10 → 4/11 y 4/3 → 4/4 tienen 31 días. Los
 * consultorios se crean «hoy» (createdAt real), siempre antes de esas fechas.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import {
  createPeriodChargeInTx,
  ensureSubscriptionInTx,
  imputeApprovedPaymentInTx,
  readLedger,
  refundPaymentTreeInTx,
  voidChargeInTx,
  waiveChargeInTx,
} from "@/lib/saas-billing-internal";
import { addAdjustmentInTx, listPendingAdjustmentsForUpdateInTx, markAdjustmentsAppliedInTx } from "@/lib/saas-adjustments-internal";
import { arMidnight, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[MPS-2a] escritor de la suscripción", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });
  // El recálculo de estado no escribe con el cobro apagado (`billingActive`).
  beforeEach(() => vi.stubEnv("SAAS_BILLING_MODE", "manual"));
  afterEach(() => vi.unstubAllEnvs());

  const svc = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prismaService.$transaction(fn);

  async function tenant(saasPlan: SaasPlan = "CONSULTORIO") {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    return t;
  }

  /** Suscripción anclada al 4 (precio a medida para no depender del precio de lista de la base local). */
  async function subscribed(
    t: EphemeralTenant,
    o: { next: string; billableFrom?: string | null; priceCents?: number; pricePlan?: SaasPlan | null; extra?: Partial<Prisma.SaasSubscriptionUncheckedCreateInput> }
  ) {
    await db.saasSubscription.create({
      data: {
        ...(o.extra ?? {}),
        tenantId: t.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(o.next),
        billableFrom: o.billableFrom ? dbDateFromKey(o.billableFrom) : null,
        customPriceCents: o.priceCents ?? 100_000,
        customPricePlan: o.pricePlan === undefined ? null : o.pricePlan,
      },
    });
  }

  const adj = (t: EphemeralTenant, kind: "DEBIT" | "CREDIT" | "PRORATION", amountCents: number, effectiveOn: string, key: string) =>
    svc((tx) =>
      addAdjustmentInTx(tx, {
        tenantId: t.tenantId,
        kind,
        amountCents,
        effectiveOn,
        description: `${kind} de prueba`,
        idempotencyKey: key,
        ...(kind === "PRORATION" ? { days: 10, periodDays: 31 } : {}),
      })
    );
  const charge = (t: EphemeralTenant, now: Date) => svc((tx) => createPeriodChargeInTx(tx, { tenantId: t.tenantId, now }));
  const adjustments = (t: EphemeralTenant) =>
    db.saasAdjustment.findMany({ where: { tenantId: t.tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const chargeOf = (t: EphemeralTenant, periodStart: string) =>
    db.saasCharge.findUniqueOrThrow({ where: { tenantId_periodStart: { tenantId: t.tenantId, periodStart: dbDateFromKey(periodStart) } } });

  // ── Ancla y billableFrom ──────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2a] ensureSubscriptionInTx: ancla 4 y billableFrom = el inicio del cobro (alta a mitad de mes)", async () => {
    const t = await tenant();
    const s = await svc((tx) => ensureSubscriptionInTx(tx, t.tenantId, new Date("2030-10-21T15:00:00Z")));
    expect(s).not.toBeNull();
    const row = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(row.anchorDay).toBe(4);
    expect(toARDateKey(row.nextChargeAt!)).toBe("2030-11-04");
    expect(keyFromDbDate(row.billableFrom!)).toBe("2030-10-21");
  });

  it("[MPS-2a] ensureSubscriptionInTx: re-anclar por una prueba extendida actualiza billableFrom", async () => {
    const t = await tenant();
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date("2030-10-10T23:59:59-03:00") },
    });
    await svc((tx) => ensureSubscriptionInTx(tx, t.tenantId, new Date("2030-10-01T15:00:00Z")));
    const a = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(keyFromDbDate(a.billableFrom!)).toBe("2030-10-11");
    expect(toARDateKey(a.nextChargeAt!)).toBe("2030-11-04");

    await db.tenant.update({ where: { id: t.tenantId }, data: { trialEndsAt: new Date("2030-11-20T23:59:59-03:00") } });
    await svc((tx) => ensureSubscriptionInTx(tx, t.tenantId, new Date("2030-10-02T15:00:00Z")));
    const b = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(keyFromDbDate(b.billableFrom!)).toBe("2030-11-21");
    expect(toARDateKey(b.nextChargeAt!)).toBe("2030-12-04");
    expect(b.anchorDay).toBe(4);
  });

  // ── Stub del primer período ───────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2a] stub del primer período: alta el 21/10 → el cargo del 4/11 suma 14/31 del precio", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-11-04", billableFrom: "2030-10-21", priceCents: 3_100_000, pricePlan: "CONSULTORIO" });
    const r = await charge(t, new Date("2030-11-04T12:00:00Z"));
    expect(r).toMatchObject({ kind: "created", periodStart: "2030-11-04", amountCents: 4_500_000 });
    const c = await chargeOf(t, "2030-11-04");
    expect(c).toMatchObject({ amountCents: 4_500_000, baseAmountCents: 3_100_000, adjustmentsCents: 1_400_000, status: "OPEN" });
    const [stub] = await adjustments(t);
    expect(stub).toMatchObject({
      kind: "PRORATION",
      amountCents: 1_400_000,
      days: 14,
      periodDays: 31,
      idempotencyKey: "stub:2030-10-21",
      appliedChargeId: c.id,
    });
    expect(keyFromDbDate(stub.effectiveOn)).toBe("2030-10-21");
    expect(stub.appliedAt).not.toBeNull();

    // El período siguiente ya no lleva stub (billableFrom quedó dos períodos atrás) ni lo duplica.
    const r2 = await charge(t, new Date("2030-12-04T12:00:00Z"));
    expect(r2).toMatchObject({ kind: "created", amountCents: 3_100_000 });
    expect(await chargeOf(t, "2030-12-04")).toMatchObject({ baseAmountCents: 3_100_000, adjustmentsCents: 0 });
    expect(await adjustments(t)).toHaveLength(1);
  });

  it("[MPS-2a] stub: alta justo el 4 no suma nada; un cargo que ya existe no deja un stub colgado", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-11-04", billableFrom: "2030-11-04", priceCents: 3_100_000 });
    expect(await charge(t, new Date("2030-11-04T12:00:00Z"))).toMatchObject({ kind: "created", amountCents: 3_100_000 });
    expect(await adjustments(t)).toHaveLength(0);

    const t2 = await tenant();
    await subscribed(t2, { next: "2030-11-04", billableFrom: "2030-10-21", priceCents: 3_100_000 });
    await db.saasCharge.create({
      data: {
        tenantId: t2.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey("2030-11-04"),
        periodEnd: dbDateFromKey("2030-12-04"),
        dueDate: dbDateFromKey("2030-11-09"),
        amountCents: 3_100_000,
      },
    });
    expect(await charge(t2, new Date("2030-11-04T12:00:00Z"))).toMatchObject({ kind: "exists" });
    expect(await adjustments(t2)).toHaveLength(0);
    const s = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t2.tenantId } });
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-12-04");
  });

  // ── Ajustes en el cargo ───────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2a] ajustes pendientes: los vencidos entran en el cargo (base + ajustes) y quedan imputados; el futuro sigue pendiente", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-04-04", priceCents: 100_000 });
    const debit = await adj(t, "DEBIT", 50_000, "2030-03-20", "d1");
    const credit = await adj(t, "CREDIT", -30_000, "2030-04-04", "c1");
    const future = await adj(t, "DEBIT", 10_000, "2030-04-05", "d2");

    const pending = await svc((tx) => listPendingAdjustmentsForUpdateInTx(tx, { tenantId: t.tenantId, upTo: "2030-04-04" }));
    expect(pending.map((p) => p.id)).toEqual([debit.adjustmentId, credit.adjustmentId]);

    const r = await charge(t, new Date("2030-04-04T12:00:00Z"));
    expect(r).toMatchObject({ kind: "created", amountCents: 120_000 });
    const c = await chargeOf(t, "2030-04-04");
    expect(c).toMatchObject({ amountCents: 120_000, baseAmountCents: 100_000, adjustmentsCents: 20_000 });
    const rows = new Map((await adjustments(t)).map((a) => [a.id, a]));
    expect(rows.get(debit.adjustmentId)?.appliedChargeId).toBe(c.id);
    expect(rows.get(credit.adjustmentId)?.appliedChargeId).toBe(c.id);
    expect(rows.get(future.adjustmentId)?.appliedChargeId).toBeNull();

    // Marcar dos veces no hace nada (el trigger solo deja NULL → valor; el filtro lo evita antes).
    const again = await svc((tx) =>
      markAdjustmentsAppliedInTx(tx, { tenantId: t.tenantId, adjustmentIds: [debit.adjustmentId], chargeId: c.id, now: new Date("2030-04-05T12:00:00Z") })
    );
    expect(again).toBe(0);
  });

  it("[MPS-2a] CARRYOVER: un crédito mayor que el cargo lo deja en 0 (PAID) y el resto pasa al próximo", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-04-04", priceCents: 100_000 });
    const credit = await adj(t, "CREDIT", -150_000, "2030-04-01", "big");

    const r = await charge(t, new Date("2030-04-04T12:00:00Z"));
    expect(r).toMatchObject({ kind: "created", amountCents: 0 });
    const c = await chargeOf(t, "2030-04-04");
    expect(c).toMatchObject({ amountCents: 0, baseAmountCents: 100_000, adjustmentsCents: -100_000, status: "PAID" });
    expect(c.paidAt).not.toBeNull();

    const rows = await adjustments(t);
    const carry = rows.find((a) => a.kind === "CARRYOVER");
    const rest = rows.find((a) => a.kind === "CREDIT" && a.id !== credit.adjustmentId);
    expect(rows.find((a) => a.id === credit.adjustmentId)?.appliedChargeId).toBe(c.id);
    expect(carry).toMatchObject({ amountCents: 50_000, splitFromId: credit.adjustmentId, appliedChargeId: c.id });
    expect(rest).toMatchObject({ amountCents: -50_000, splitFromId: credit.adjustmentId, appliedChargeId: null });
    expect(keyFromDbDate(rest!.effectiveOn)).toBe("2030-05-04");

    // El próximo cargo usa el resto del crédito.
    expect(await charge(t, new Date("2030-05-04T12:00:00Z"))).toMatchObject({ kind: "created", amountCents: 50_000 });
    expect((await adjustments(t)).find((a) => a.id === rest!.id)?.appliedChargeId).not.toBeNull();
  });

  it("[MPS-2a] VOID re-pende TODOS los ajustes del cargo; WAIVE solo los CREDIT", async () => {
    const now = new Date("2030-04-04T12:00:00Z");
    const setup = async () => {
      const t = await tenant();
      await subscribed(t, { next: "2030-04-04", priceCents: 100_000 });
      const d = await adj(t, "DEBIT", 20_000, "2030-04-01", "d");
      const c = await adj(t, "CREDIT", -5_000, "2030-04-01", "c");
      await charge(t, now);
      return { t, d: d.adjustmentId, c: c.adjustmentId, ch: await chargeOf(t, "2030-04-04") };
    };

    const v = await setup();
    expect(v.ch.amountCents).toBe(115_000);
    const rv = await svc((tx) => voidChargeInTx(tx, { tenantId: v.t.tenantId, chargeId: v.ch.id, note: "Error", actorId: null, now }));
    expect(rv).toMatchObject({ ok: true });
    const vr = await adjustments(v.t);
    const vCopies = vr.filter((a) => a.idempotencyKey.startsWith("repend:"));
    expect(vCopies.map((a) => a.idempotencyKey).sort()).toEqual([`repend:${v.c}`, `repend:${v.d}`].sort());
    expect(vCopies.every((a) => a.appliedChargeId === null)).toBe(true);
    expect(vCopies.find((a) => a.idempotencyKey === `repend:${v.d}`)).toMatchObject({ kind: "DEBIT", amountCents: 20_000 });
    expect(vCopies.find((a) => a.idempotencyKey === `repend:${v.c}`)).toMatchObject({ kind: "CREDIT", amountCents: -5_000 });
    // Los originales siguen imputados al cargo anulado (historia; la tabla es solo inserción).
    expect(vr.filter((a) => a.appliedChargeId === v.ch.id)).toHaveLength(2);

    const w = await setup();
    const rw = await svc((tx) => waiveChargeInTx(tx, { tenantId: w.t.tenantId, chargeId: w.ch.id, note: null, actorId: null, now }));
    expect(rw).toMatchObject({ ok: true });
    const wCopies = (await adjustments(w.t)).filter((a) => a.idempotencyKey.startsWith("repend:"));
    expect(wCopies.map((a) => [a.idempotencyKey, a.kind, a.amountCents])).toEqual([[`repend:${w.c}`, "CREDIT", -5_000]]);
  });

  it("[MPS-2a] cancel_due: con la baja vencida no se genera el cargo ni se mueve el cursor", async () => {
    const t = await tenant();
    await subscribed(t, {
      next: "2030-04-04",
      extra: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey("2030-04-04"), cancelRequestedAt: new Date("2030-03-10T12:00:00Z") },
    });
    const r = await charge(t, new Date("2030-04-04T12:00:00Z"));
    expect(r).toMatchObject({ kind: "cancel_due", periodStart: "2030-04-04" });
    expect(await db.saasCharge.count({ where: { tenantId: t.tenantId } })).toBe(0);
    const s = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(toARDateKey(s.nextChargeAt!)).toBe("2030-04-04");
  });

  it("[MPS-2a] precio a medida atado al plan (MPS-D14): el de Consultorio no viaja a Clínica", async () => {
    const t = await tenant("CLINICA");
    const cfg = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "CLINICA" } });
    await subscribed(t, { next: "2030-04-04", priceCents: 77_000, pricePlan: "CONSULTORIO" });
    const r = await charge(t, new Date("2030-04-04T12:00:00Z"));
    if (cfg.priceCents === null) expect(r).toMatchObject({ kind: "no_price" });
    else expect(r).toMatchObject({ kind: "created", amountCents: cfg.priceCents });

    const t2 = await tenant("CLINICA");
    await subscribed(t2, { next: "2030-04-04", priceCents: 77_000, pricePlan: "CLINICA" });
    expect(await charge(t2, new Date("2030-04-04T12:00:00Z"))).toMatchObject({ kind: "created", amountCents: 77_000 });
  });

  // ── Pagos de MP: hermano partido y reintegro ──────────────────────────────────────────────────────────────────

  async function openCharge(t: EphemeralTenant, periodStart: string, amountCents: number) {
    const [y, m] = periodStart.split("-").map(Number);
    const end = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-04`;
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(periodStart),
        periodEnd: dbDateFromKey(end),
        dueDate: dbDateFromKey(periodStart.slice(0, 8) + "09"),
        amountCents,
      },
    });
  }
  const mpPayment = (t: EphemeralTenant, amountCents: number) =>
    db.saasPayment.create({
      data: {
        tenantId: t.tenantId,
        source: "MP_CHECKOUT",
        method: "MERCADO_PAGO",
        status: "APPROVED",
        amountCents,
        paidAt: new Date("2030-03-05T12:00:00Z"),
        mpPaymentId: `mp-${randomBytes(8).toString("hex")}`,
        mpStatus: "approved",
        mpPayload: { id: 1, status: "approved" },
      },
    });

  it("[MPS-2a] el hermano partido de un pago de MP lleva splitFromId = la raíz (acepta el CHECK de M16)", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-04-04" });
    const c1 = await openCharge(t, "2030-03-04", 100_000);
    const root = await mpPayment(t, 150_000);
    const now = new Date("2030-03-05T12:00:00Z");
    const r = await svc((tx) => imputeApprovedPaymentInTx(tx, t.tenantId, root.id, c1.id, now));
    expect(r).toEqual({ chargeId: c1.id, chargePaid: true });
    const ps = await db.saasPayment.findMany({ where: { tenantId: t.tenantId } });
    expect(ps).toHaveLength(2);
    const sib = ps.find((p) => p.id !== root.id)!;
    expect(ps.find((p) => p.id === root.id)).toMatchObject({ chargeId: c1.id, amountCents: 100_000, mpPaymentId: root.mpPaymentId });
    expect(sib).toMatchObject({
      chargeId: null,
      amountCents: 50_000,
      source: "MP_CHECKOUT",
      status: "APPROVED",
      splitFromId: root.id,
      mpPaymentId: null,
      mpAuthorizedPaymentId: null,
      mpPreapprovalId: null,
      mpPayload: null,
    });

    // Partir el hermano otra vez (otro cargo de 30.000) sigue apuntando a la raíz, no al hermano.
    await openCharge(t, "2030-04-04", 30_000);
    await svc((tx) => imputeApprovedPaymentInTx(tx, t.tenantId, sib.id, null, now));
    const after = await db.saasPayment.findMany({ where: { tenantId: t.tenantId } });
    expect(after).toHaveLength(3);
    expect(after.filter((p) => p.id !== root.id).every((p) => p.splitFromId === root.id)).toBe(true);
    expect(after.reduce((s, p) => s + p.amountCents, 0)).toBe(150_000);
  });

  it("[MPS-2a] reintegro del árbol: raíz y hermanos REFUNDED, el cargo vuelve a OPEN sin paidAt y el consultorio pasa a PAST_DUE", async () => {
    const t = await tenant();
    await subscribed(t, { next: "2030-04-04" });
    const c1 = await openCharge(t, "2030-03-04", 100_000);
    const root = await mpPayment(t, 150_000);
    await svc((tx) => imputeApprovedPaymentInTx(tx, t.tenantId, root.id, c1.id, new Date("2030-03-05T12:00:00Z")));
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c1.id } })).status).toBe("PAID");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("ACTIVE");

    const r = await svc((tx) => refundPaymentTreeInTx(tx, { tenantId: t.tenantId, rootId: root.id, now: new Date("2030-03-20T12:00:00Z") }));
    expect(r.refundedIds.sort()).toEqual((await db.saasPayment.findMany({ where: { tenantId: t.tenantId } })).map((p) => p.id).sort());
    expect(r.reopenedChargeIds).toEqual([c1.id]);
    const ps = await db.saasPayment.findMany({ where: { tenantId: t.tenantId } });
    expect(ps.every((p) => p.status === "REFUNDED")).toBe(true);
    const c = await db.saasCharge.findUniqueOrThrow({ where: { id: c1.id } });
    expect(c).toMatchObject({ status: "OPEN", paidAt: null });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("PAST_DUE");

    // Repetir el reintegro no hace nada.
    const again = await svc((tx) => refundPaymentTreeInTx(tx, { tenantId: t.tenantId, rootId: root.id, now: new Date("2030-03-20T12:00:00Z") }));
    expect(again).toMatchObject({ refundedIds: [], reopenedChargeIds: [] });
  });

  // ── Ledger ───────────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2a] readLedger: desglose, ajustes, proyección del próximo cargo, método, débito enmascarado, baja y plan pendiente", async () => {
    const t = await tenant();
    await subscribed(t, {
      next: "2030-11-04",
      billableFrom: "2030-10-21",
      priceCents: 3_100_000,
      // Legado (sin plan): el precio a medida vale para la bajada también; el caso «atado al plan» va abajo (t3).
      pricePlan: null,
      extra: {
        collectionMethod: "AUTO_DEBIT",
        autoDebitEnabled: true,
        mpPreapprovalId: `pre${randomBytes(8).toString("hex")}`,
        mpPreapprovalStatus: "authorized",
        mpPayerEmail: "martina.lopez@gmail.com",
        mpPreapprovalAmountCents: 3_100_000,
        mpPreapprovalNextAt: new Date("2030-11-04T11:00:00Z"),
        pendingPlan: "INDIVIDUAL",
        pendingPlanEffectiveOn: dbDateFromKey("2030-11-04"),
        pendingPlanDisableIds: ["m1", "m2"],
      },
    });
    await adj(t, "CREDIT", -100_000, "2030-10-25", "ledger-credit");
    const now = new Date("2030-10-25T15:00:00Z");
    const l = await readLedger(prismaService, t.tenantId, now);
    expect(l).not.toBeNull();
    expect(l!.collectionMethod).toBe("AUTO_DEBIT");
    expect(l!.billableFrom).toBe("2030-10-21");
    expect(l!.pendingAdjustments?.map((a) => [a.kind, a.amountCents])).toEqual([["CREDIT", -100_000]]);
    expect(l!.appliedAdjustments).toEqual([]);
    expect(l!.autoDebit).toMatchObject({ status: "active", allowed: true, payerEmailMasked: "m***@gmail.com", nextDebitOn: "2030-11-04" });
    expect(JSON.stringify(l)).not.toContain("martina.lopez");
    expect(l!.pendingPlan).toMatchObject({ plan: "INDIVIDUAL", effectiveOn: "2030-11-04", disableCount: 2 });
    expect(l!.cancel).toBeNull();
    // Proyección del cargo del 4/11 (la misma cuenta que hará el cron): base + stub de 14/31 + el crédito.
    expect(l!.nextCharge).toMatchObject({
      periodStart: "2030-11-04",
      amountCents: 3_100_000,
      breakdown: { baseCents: 3_100_000, adjustmentsCents: 1_300_000, creditCents: 0, amountCents: 4_400_000 },
    });

    // Precio a medida atado a Consultorio + bajada a Individual que vence ese día: la proyección usa el precio de
    // lista de Individual (MPS-D14), no el pactado.
    const t3 = await tenant();
    await subscribed(t3, {
      next: "2030-11-04",
      priceCents: 3_100_000,
      pricePlan: "CONSULTORIO",
      extra: { pendingPlan: "INDIVIDUAL", pendingPlanEffectiveOn: dbDateFromKey("2030-11-04") },
    });
    const indiv = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "INDIVIDUAL" } });
    const l3 = await readLedger(prismaService, t3.tenantId, now);
    expect(l3!.nextCharge?.breakdown?.baseCents).toBe(indiv.priceCents);
    expect(l3!.effectivePriceCents).toBe(3_100_000);

    // Con un cargo: el desglose por cargo lista los ajustes imputados.
    const t2 = await tenant();
    await subscribed(t2, { next: "2030-04-04", priceCents: 100_000, extra: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey("2030-05-04"), cancelRequestedAt: new Date("2030-04-10T12:00:00Z") } });
    await adj(t2, "DEBIT", 20_000, "2030-04-01", "l2");
    await charge(t2, new Date("2030-04-04T12:00:00Z"));
    const c = await chargeOf(t2, "2030-04-04");
    const l2 = await readLedger(prismaService, t2.tenantId, new Date("2030-04-10T15:00:00Z"));
    expect(l2!.chargeBreakdown?.[c.id]).toMatchObject({ baseAmountCents: 100_000, adjustmentsCents: 20_000, hasCheckout: false });
    expect(l2!.chargeBreakdown?.[c.id].adjustments.map((a) => a.kind)).toEqual(["DEBIT"]);
    expect(l2!.appliedAdjustments?.map((a) => a.appliedChargeId)).toEqual([c.id]);
    expect(l2!.cancel).toMatchObject({ effectiveOn: "2030-05-04" });
    expect(l2!.collectionMethod).toBeNull();
    expect(l2!.autoDebit).toMatchObject({ status: "none", payerEmailMasked: null });
    // La baja rige el 4/5, el mismo día del próximo cobro: no hay próximo cargo.
    expect(l2!.nextCharge).toBeNull();
  });
});
