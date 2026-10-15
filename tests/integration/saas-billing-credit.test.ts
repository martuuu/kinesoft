/**
 * [PL-Z] Plata a cuenta, excedentes, precios con vigencia y mails de cobro (hallazgos a1 de la revisión de PL-Z,
 * `wip-20/plz-findings.md`), contra Postgres en los dos roles. Símbolos REALES del núcleo
 * (`lib/saas-billing-internal.ts`) y del cron (`runSaasBilling`); se reemplaza solo el despacho del mail.
 *
 * Se fija:
 *  - a1#1: un pago a cuenta se aplica al cargo nuevo del cron (el consultorio no cae en PAST_DUE con saldo a favor) y
 *    al imputar cuando hay cargos abiertos; un pago que cubre varios cargos los salda a todos, partiendo el pago;
 *  - a1#2: el excedente sobre un cargo no se pierde: queda como pago hermano APROBADO a cuenta (misma plata total);
 *  - a1#4: un precio inmediato no lo pisa después uno viejo pendiente; el cron saltea uno pisado por otro más nuevo;
 *  - a1#5: dos cambios con vigencias distintas se avisan los dos (solo se descarta el de la MISMA vigencia, más viejo);
 *  - a1#7: `pendingReviewCount` cuenta todos los comprobantes a revisar, no solo los 60 que lista el ledger;
 *  - A2: los mails de cuota y de vencida llevan «Datos para transferir» (escapado) solo si está configurado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  readLedger,
  recordPaymentInTx,
  reviewPaymentInTx,
  runSaasBilling,
  schedulePlanPriceInTx,
} from "@/lib/saas-billing-internal";
import { prismaService } from "@/lib/db";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { addDaysKey, arMidnight, dbDateFromKey, periodFor } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;
const BUDGET = 30_000;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[PL-Z] cobros: saldo a cuenta, excedentes, precios y mails", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const priceChangeIds: string[] = [];

  async function tenant(o: Parameters<typeof createEphemeralTenant>[1] = {}) {
    const t = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", ...o });
    tenants.push(t);
    return t;
  }
  async function subscribed(t: EphemeralTenant, o: { daysAgo: number; customPriceCents: number | null }) {
    const start = addDaysKey(toARDateKey(new Date()), -o.daysAgo);
    await db.saasSubscription.create({
      data: { tenantId: t.tenantId, anchorDay: Math.min(Number(start.slice(8)), 28), nextChargeAt: arMidnight(start), customPriceCents: o.customPriceCents },
    });
    return start;
  }
  /** Cargo abierto que empezó hace `-offsetDays` días (vencido si empezó hace más de 5). */
  async function openCharge(t: EphemeralTenant, amountCents: number, offsetDays: number) {
    const p = periodFor(addDaysKey(toARDateKey(new Date()), offsetDays));
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents,
      },
    });
  }
  const approved = (t: EphemeralTenant, amountCents: number, chargeId: string | null = null) =>
    prismaService.$transaction((tx) =>
      recordPaymentInTx(tx, {
        tenantId: t.tenantId,
        chargeId,
        amountCents,
        status: "APPROVED",
        paidAt: null,
        receipt: { path: `${t.tenantId}/r-${amountCents}.pdf`, mimeType: "application/pdf", sizeBytes: 10 },
        note: null,
        submittedById: null,
        now: new Date(),
      })
    );
  const payments = (t: EphemeralTenant) =>
    db.saasPayment.findMany({ where: { tenantId: t.tenantId }, orderBy: [{ createdAt: "asc" }, { amountCents: "desc" }] });
  const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);
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
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "entityId" = ANY(${priceChangeIds})`,
      ]);
    }
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
  });
  afterEach(() => vi.unstubAllEnvs());

  // ── a1#1 / a1#2: plata a cuenta ───────────────────────────────────────────────────────────────────────────────

  it("[PL-Z] a1#1: un pago a cuenta salda el cargo nuevo del cron (no cae en PAST_DUE con saldo a favor)", async () => {
    const t = await tenant();
    // Pagó por adelantado (sin cargos abiertos): queda a cuenta.
    const pre = await approved(t, 250_000);
    expect(pre).toMatchObject({ ok: true, chargeId: null });
    await subscribed(t, { daysAgo: 10, customPriceCents: 100_000 });

    const r = await run([t.tenantId]);
    expect(r).toMatchObject({ chargesCreated: 1, errors: 0 });
    const [charge] = await db.saasCharge.findMany({ where: { tenantId: t.tenantId } });
    expect(charge).toMatchObject({ status: "PAID", amountCents: 100_000 });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("ACTIVE");

    // El pago se partió: 100.000 al cargo, 150.000 siguen a cuenta. La plata total no cambia.
    const ps = await payments(t);
    expect(sum(ps)).toBe(250_000);
    expect(ps.filter((p) => p.chargeId === charge.id).map((p) => p.amountCents)).toEqual([100_000]);
    expect(ps.filter((p) => p.chargeId === null).map((p) => p.amountCents)).toEqual([150_000]);
    expect(ps.every((p) => p.status === "APPROVED")).toBe(true);
    const ledger = await readLedger(prismaService, t.tenantId, new Date());
    expect(ledger).toMatchObject({ creditCents: 150_000, balanceCents: -150_000, overdueCount: 0 });
    // Un cargo que nació saldado no manda «ya está tu cuota».
    expect(mail.sent.filter((m) => m.tenantId === t.tenantId && m.kind === "billing_charge_created")).toHaveLength(0);
  });

  it("[PL-Z] a1#1: un pago sin cargo que cubre dos cargos abiertos salda los dos (del más viejo)", async () => {
    const t = await tenant();
    const c1 = await openCharge(t, 100_000, -40);
    const c2 = await openCharge(t, 100_000, -10);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "PAST_DUE", subscriptionStatusChangedAt: new Date() } });

    const r = await approved(t, 230_000);
    expect(r).toMatchObject({ ok: true, chargeId: c1.id, chargePaid: true, statusChanged: "ACTIVE" });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c1.id } })).status).toBe("PAID");
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe("PAID");
    const ps = await payments(t);
    expect(sum(ps)).toBe(230_000);
    expect(sum(ps.filter((p) => p.chargeId === c1.id))).toBe(100_000);
    expect(sum(ps.filter((p) => p.chargeId === c2.id))).toBe(100_000);
    expect(sum(ps.filter((p) => p.chargeId === null))).toBe(30_000);
    // El comprobante es el mismo en las partes (los tres datos juntos: CHECK de la tabla).
    expect(new Set(ps.map((p) => p.receiptPath))).toEqual(new Set([`${t.tenantId}/r-230000.pdf`]));
  });

  it("[PL-Z] a1#1: aprobar un comprobante cuyo cargo ya no está abierto lo aplica al otro cargo abierto", async () => {
    const t = await tenant();
    const gone = await openCharge(t, 80_000, -40);
    const open = await openCharge(t, 80_000, -10);
    const pay = await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: gone.id, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 80_000 },
    });
    await db.saasCharge.update({ where: { id: gone.id }, data: { status: "WAIVED", statusChangedAt: new Date() } });

    const r = await prismaService.$transaction((tx) =>
      reviewPaymentInTx(tx, { tenantId: t.tenantId, paymentId: pay.id, decision: "approve", reviewNote: null, reviewerId: null, now: new Date() })
    );
    expect(r).toMatchObject({ ok: true, decision: "approve", amountCents: 80_000, chargePaid: true });
    expect(await db.saasPayment.findUniqueOrThrow({ where: { id: pay.id } })).toMatchObject({ status: "APPROVED", chargeId: open.id });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("PAID");
  });

  it("[PL-Z] a1#2: el excedente sobre un cargo queda como pago hermano APROBADO a cuenta", async () => {
    const t = await tenant();
    const c = await openCharge(t, 100_000, -10);
    // Ya tenía 30.000 aprobados: le faltan 70.000.
    await approved(t, 30_000, c.id);
    const r = await approved(t, 150_000, c.id);
    expect(r).toMatchObject({ ok: true, chargeId: c.id, chargePaid: true });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
    const ps = await payments(t);
    expect(sum(ps)).toBe(180_000);
    expect(sum(ps.filter((p) => p.chargeId === c.id))).toBe(100_000);
    const rest = ps.filter((p) => p.chargeId === null);
    expect(rest.map((p) => p.amountCents)).toEqual([80_000]);
    expect(rest[0]).toMatchObject({ status: "APPROVED", source: "MANUAL", receiptPath: `${t.tenantId}/r-150000.pdf` });
    expect((await readLedger(prismaService, t.tenantId, new Date()))?.creditCents).toBe(80_000);
  });

  it("[PL-Z] a1#2: aprobar un comprobante por más de lo que falta deja el resto a cuenta", async () => {
    const t = await tenant();
    const c = await openCharge(t, 100_000, -10);
    const pay = await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: c.id, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 120_000 },
    });
    const r = await prismaService.$transaction((tx) =>
      reviewPaymentInTx(tx, { tenantId: t.tenantId, paymentId: pay.id, decision: "approve", reviewNote: null, reviewerId: null, now: new Date() })
    );
    // El monto informado (para el mail) es el del comprobante entero.
    expect(r).toMatchObject({ ok: true, amountCents: 120_000, chargeId: c.id, chargePaid: true });
    const ps = await payments(t);
    expect(sum(ps)).toBe(120_000);
    expect(ps.find((p) => p.id === pay.id)).toMatchObject({ chargeId: c.id, amountCents: 100_000, status: "APPROVED" });
    expect(ps.filter((p) => p.chargeId === null).map((p) => [p.amountCents, p.status])).toEqual([[20_000, "APPROVED"]]);
  });

  // ── a1#7 ────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[PL-Z] a1#7: pendingReviewCount cuenta todos los comprobantes a revisar (más de 60)", async () => {
    const t = await tenant();
    await db.saasPayment.createMany({
      data: Array.from({ length: 65 }, () => ({ tenantId: t.tenantId, source: "MANUAL" as const, status: "PENDING_REVIEW" as const, amountCents: 1_000 })),
    });
    const ledger = await readLedger(prismaService, t.tenantId, new Date());
    expect(ledger?.payments).toHaveLength(60);
    expect(ledger?.pendingReviewCount).toBe(65);
  });

  // ── a1#4 / a1#5: precios con vigencia ─────────────────────────────────────────────────────────────────────────

  it("[PL-Z] a1#4: un precio inmediato marca aplicados los pendientes ya vencidos (el viejo no lo pisa después)", async () => {
    const before = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } });
    try {
      const now = new Date();
      // Programado hace 3 días para ayer; el cron todavía no corrió.
      const old = await prismaService.$transaction((tx) =>
        schedulePlanPriceInTx(tx, { plan: "LIBRE", priceCents: 1_111_100, effectiveFrom: new Date(now.getTime() - DAY), note: null, actorId: null, now: new Date(now.getTime() - 3 * DAY) })
      );
      priceChangeIds.push(old.changeId);
      expect(old.appliedNow).toBe(false);
      const fresh = await prismaService.$transaction((tx) =>
        schedulePlanPriceInTx(tx, { plan: "LIBRE", priceCents: 2_222_200, effectiveFrom: now, note: null, actorId: null, now })
      );
      priceChangeIds.push(fresh.changeId);
      expect(fresh.appliedNow).toBe(true);
      expect((await db.saasPlanPriceChange.findUniqueOrThrow({ where: { id: old.changeId } })).appliedAt).not.toBeNull();
      await run([], now);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(2_222_200);
    } finally {
      await db.saasPlanConfig.update({ where: { plan: "LIBRE" }, data: { priceCents: before.priceCents, updatedById: before.updatedById } });
    }
  });

  it("[PL-Z] a1#4: el cron saltea un cambio pendiente si ya rige otro más nuevo con vigencia igual o posterior", async () => {
    const before = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } });
    try {
      const now = new Date();
      const oldRow = await db.saasPlanPriceChange.create({
        data: { plan: "LIBRE", priceCents: 3_333_300, previousPriceCents: before.priceCents, effectiveFrom: new Date(now.getTime() - 2 * DAY), createdAt: new Date(now.getTime() - 5 * DAY) },
      });
      priceChangeIds.push(oldRow.id);
      const newer = await db.saasPlanPriceChange.create({
        data: { plan: "LIBRE", priceCents: 4_444_400, previousPriceCents: before.priceCents, effectiveFrom: new Date(now.getTime() - DAY), appliedAt: new Date(now.getTime() - DAY), createdAt: new Date(now.getTime() - 4 * DAY) },
      });
      priceChangeIds.push(newer.id);
      await db.saasPlanConfig.update({ where: { plan: "LIBRE" }, data: { priceCents: 4_444_400 } });

      await run([], now);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(4_444_400);
      // Queda marcado (no se reintenta cada día).
      expect((await db.saasPlanPriceChange.findUniqueOrThrow({ where: { id: oldRow.id } })).appliedAt).not.toBeNull();
    } finally {
      await db.saasPlanConfig.update({ where: { plan: "LIBRE" }, data: { priceCents: before.priceCents, updatedById: before.updatedById } });
    }
  });

  it("[PL-Z] a1#5: dos cambios futuros con vigencias distintas se avisan los dos; el de la misma vigencia más viejo no", async () => {
    const t = await tenant({ saasPlan: "LIBRE" });
    const now = new Date();
    const mk = (priceCents: number, days: number, createdAgo: number) =>
      db.saasPlanPriceChange.create({
        data: { plan: "LIBRE", priceCents, previousPriceCents: 1, effectiveFrom: new Date(now.getTime() + days * DAY), createdAt: new Date(now.getTime() - createdAgo * DAY) },
      });
    const first = await mk(5_000_000, 10, 3);
    const second = await mk(6_000_000, 20, 2);
    const replaced = await mk(7_000_000, 30, 2);
    const replacement = await mk(7_500_000, 30, 1);
    priceChangeIds.push(first.id, second.id, replaced.id, replacement.id);

    await run([t.tenantId], now);
    // Otros cambios de LIBRE de la ventana (de otros tests) también avisan: se miran solo los de este test.
    const mine = new Set([first.id, second.id, replaced.id, replacement.id]);
    const ids = mail.sent
      .filter((m) => m.tenantId === t.tenantId && m.kind === "billing_price_change" && mine.has(m.entityId ?? ""))
      .map((m) => m.entityId);
    expect(new Set(ids)).toEqual(new Set([first.id, second.id, replacement.id]));
  });

  // ── A2: datos para transferir en los mails ────────────────────────────────────────────────────────────────────

  it("[PL-Z] A2: cuota nueva y vencida llevan «Datos para transferir» escapado si está configurado", async () => {
    vi.stubEnv("SAAS_BILLING_TRANSFER_INFO", "Alias kine.soft <b>CBU</b> 0000");
    const t = await tenant();
    await subscribed(t, { daysAgo: 10, customPriceCents: 90_000 });
    await run([t.tenantId]);
    const mine = mail.sent.filter((m) => m.tenantId === t.tenantId);
    expect(mine.map((m) => m.kind).sort()).toEqual(["billing_charge_created", "billing_past_due"]);
    for (const m of mine) {
      expect(m.text).toContain("Datos para transferir: Alias kine.soft <b>CBU</b> 0000");
      expect(m.html).toContain("Datos para transferir: Alias kine.soft &lt;b&gt;CBU&lt;/b&gt; 0000");
      expect(m.html).not.toContain("<b>CBU</b>");
      expect(m.text).toContain("o tenés permiso para ver y cambiar el plan y los pagos.");
    }
  });

  it("[PL-Z] A2: sin datos para transferir, los mails no muestran el párrafo", async () => {
    vi.stubEnv("SAAS_BILLING_TRANSFER_INFO", "");
    const t = await tenant();
    await subscribed(t, { daysAgo: 10, customPriceCents: 90_000 });
    await run([t.tenantId]);
    const mine = mail.sent.filter((m) => m.tenantId === t.tenantId);
    expect(mine).toHaveLength(2);
    for (const m of mine) expect(m.text).not.toContain("Datos para transferir");
  });
});
