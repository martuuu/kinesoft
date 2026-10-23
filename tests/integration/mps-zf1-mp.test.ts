/**
 * [ZF1] Fixer de cobros del cierre de T6+T7 (revisor ZA): la suscripción contra el Mercado Pago FALSO.
 *  - Promoción del preapproval pendiente con el débito BLOQUEADO o la suscripción dada de baja: no se promueve ni se
 *    avisa «débito activado»; se limpia el pendiente y se cancela en MP (si no, quedaba autorizado debitando).
 *  - Abandonar el pendiente: `syncSaasMpAfterCommit(tenantId, { abandonPending: true })` (lo pide `setCollectionMethod`)
 *    y `cancelPendingPreapproval` (el «Cancelar» de la banda «Falta autorizar…») lo cancelan en MP y lo limpian; el
 *    sync común NO lo toca (el primer débito se autoriza con el método todavía en TRANSFER o sin elegir).
 *  - Monto deseado: días 5-10 con el cargo del 4 OPEN → lo que falta (los reintentos de MP cobran eso, no la base del
 *    mes siguiente); la proyección del día 3 descuenta el saldo a cuenta solo por lo que sobra después de la deuda vieja.
 *  - Mail `billing_debit_failed`: uno por preapproval y período (no uno por intento de MP) y con fecha de vencimiento.
 *
 * Símbolos reales (`lib/saas-mp-sync-internal.ts`, `lib/saas-billing-mp-internal.ts`, el puerto) contra Postgres y el MP
 * falso (`installSaasFakeMp`, sin webhook cableado: lo que promueve o apaga lo hace la llamada del test). Lo único
 * reemplazado es la red y el transporte de mails. Fechas fijas en 2030 donde el código recibe `now`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { cancelPendingPreapproval, runSaasMpReconcile, startPreapprovalFlow, syncSaasMpAfterCommit } from "@/lib/saas-mp-sync-internal";
import { consumeSaasAuthorizedPayment, consumeSaasPreapproval } from "@/lib/saas-billing-mp-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __resetSaasMpMemoForTests } from "@/lib/mercadopago-saas";
import { arMidnight, dbDateFromKey, periodFor } from "@/lib/saas-billing-logic";
import { periodStartForDebit } from "@/lib/saas-mp-logic";
import { authorizeFakePreapproval, fakeMpGetPreapproval, installSaasFakeMp, simulateFakeDebit, type InstalledSaasFakeMp } from "@/tests/helpers/mp-saas-fake";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** 20/3/2030 12:00 AR. */
const MID = new Date("2030-03-20T15:00:00Z");
const DAY3 = new Date("2030-04-03T15:00:00Z");
const DAY6 = new Date("2030-04-06T15:00:00Z");
const DAY11 = new Date("2030-04-11T15:00:00Z");
const BASE = 2_000_000;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[ZF1] suscripción con Mercado Pago (fake)", () => {
  let db: PrismaClient;
  let mp: InstalledSaasFakeMp | null = null;
  const tenants: EphemeralTenant[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  beforeEach(() => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __resetSaasMpMemoForTests();
    mp = installSaasFakeMp();
  });
  afterEach(() => {
    mp?.uninstall();
    mp = null;
  });
  afterAll(async () => {
    __setEmailTransportForTests(null);
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  async function subscribed() {
    const t = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL" });
    tenants.push(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    await db.saasSubscription.create({
      data: { tenantId: t.tenantId, anchorDay: 4, nextChargeAt: arMidnight("2030-04-04"), customPriceCents: BASE, customPricePlan: "INDIVIDUAL" },
    });
    return t;
  }
  const sub = (t: EphemeralTenant) => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });

  async function pending(t: EphemeralTenant) {
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "titular@test.local", actorUserId: t.userId, now: MID });
    if (!r.ok) throw new Error(`startPreapprovalFlow: ${r.reason}`);
    return r.preapprovalId;
  }

  /** Débito activo: pendiente → autorizado en el fake → promovido por el consumidor real. */
  async function active(t: EphemeralTenant) {
    const id = await pending(t);
    await authorizeFakePreapproval(id);
    expect(await consumeSaasPreapproval(id, { now: MID, source: "reconcile" })).toMatchObject({ ok: true, result: "applied" });
    expect(await sub(t)).toMatchObject({ mpPreapprovalId: id, collectionMethod: "AUTO_DEBIT" });
    mail.sent.length = 0;
    return id;
  }

  async function charge(t: EphemeralTenant, periodStart: string, amountCents: number, status: "OPEN" | "PAID" = "OPEN") {
    const p = periodFor(periodStart as Parameters<typeof periodFor>[0]);
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "INDIVIDUAL",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents,
        baseAmountCents: amountCents,
        status,
        paidAt: status === "PAID" ? new Date() : null,
      },
    });
  }

  // ── 5. Promoción bloqueada ────────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] pendiente autorizado con el débito BLOQUEADO → no se promueve, no hay mail, se limpia y se cancela en MP", async () => {
    const t = await subscribed();
    const id = await pending(t);
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { autoDebitAllowed: false } });
    await authorizeFakePreapproval(id);
    const r = await consumeSaasPreapproval(id, { now: MID, source: "webhook" });
    expect(r.ok).toBe(true);
    const s = await sub(t);
    expect(s).toMatchObject({ mpPendingPreapprovalId: null, mpPreapprovalId: null, autoDebitEnabled: false });
    expect(s.collectionMethod).not.toBe("AUTO_DEBIT");
    expect(mail.sent).toHaveLength(0);
    expect(fakeMpGetPreapproval(id)!.status).toBe("cancelled");
  });

  it("[ZF1] pendiente autorizado con la suscripción dada de baja → tampoco se promueve (y el vigente sigue como estaba)", async () => {
    const t = await subscribed();
    const current = await active(t);
    const next = await pending(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    await authorizeFakePreapproval(next);
    expect((await consumeSaasPreapproval(next, { now: MID, source: "webhook" })).ok).toBe(true);
    const s = await sub(t);
    expect(s).toMatchObject({ mpPendingPreapprovalId: null, mpPreapprovalId: current });
    expect(mail.sent).toHaveLength(0);
    expect(fakeMpGetPreapproval(next)!.status).toBe("cancelled");
  });

  // ── 6. Abandonar el pendiente ─────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] el sync común NO cancela el pendiente del primer débito (método todavía sin AUTO_DEBIT)", async () => {
    const t = await subscribed();
    const id = await pending(t);
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { collectionMethod: "TRANSFER" } });
    await syncSaasMpAfterCommit(t.tenantId);
    expect((await sub(t)).mpPendingPreapprovalId).toBe(id);
    expect(fakeMpGetPreapproval(id)!.status).toBe("pending");
  });

  it("[ZF1] elegir otro método (abandonPending) → el pendiente se cancela en MP y se limpia", async () => {
    const t = await subscribed();
    const id = await pending(t);
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { collectionMethod: "TRANSFER" } });
    await syncSaasMpAfterCommit(t.tenantId, { abandonPending: true });
    expect(await sub(t)).toMatchObject({ mpPendingPreapprovalId: null, mpPendingInitPoint: null, mpPendingCreatedAt: null });
    expect(fakeMpGetPreapproval(id)!.status).toBe("cancelled");
  });

  it("[ZF1] cancelPendingPreapproval («Cancelar» de la banda) → cancela, limpia y el estado deja de ser pending_authorization", async () => {
    const t = await subscribed();
    const id = await pending(t);
    const r = await cancelPendingPreapproval({ tenantId: t.tenantId, now: MID });
    expect(r).toEqual({ ok: true, status: "none" });
    expect((await sub(t)).mpPendingPreapprovalId).toBeNull();
    expect(fakeMpGetPreapproval(id)!.status).toBe("cancelled");
    // Sin pendiente: idempotente.
    expect(await cancelPendingPreapproval({ tenantId: t.tenantId, now: MID })).toEqual({ ok: true, status: "none" });
  });

  it("[ZF1] cancelPendingPreapproval con un débito vigente → solo el pendiente; el vigente sigue activo", async () => {
    const t = await subscribed();
    const current = await active(t);
    const next = await pending(t);
    const r = await cancelPendingPreapproval({ tenantId: t.tenantId, now: MID });
    expect(r).toEqual({ ok: true, status: "active" });
    expect(await sub(t)).toMatchObject({ mpPendingPreapprovalId: null, mpPreapprovalId: current });
    expect(fakeMpGetPreapproval(next)!.status).toBe("cancelled");
    expect(fakeMpGetPreapproval(current)!.status).toBe("authorized");
  });

  // ── 7. Monto deseado ──────────────────────────────────────────────────────────────────────────────────────────

  it("[ZF1] días 5-10 con el cargo del 4 OPEN → el débito queda en lo que falta pagar; el 11 vuelve a la base", async () => {
    const t = await subscribed();
    const id = await active(t);
    const c = await charge(t, "2030-04-04", 2_700_000);
    await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: c.id, amountCents: 600_000, status: "APPROVED", source: "MANUAL", method: "TRANSFER", paidAt: DAY3 },
    });
    await runSaasMpReconcile(DAY6, 10_000, { tenantIds: [t.tenantId] });
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(2_100_000 /* 2.700.000 − 600.000 */);
    // Otro pago parcial: el débito sigue al faltante.
    await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: c.id, amountCents: 500_000, status: "APPROVED", source: "MANUAL", method: "TRANSFER", paidAt: DAY6 },
    });
    await runSaasMpReconcile(new Date("2030-04-07T15:00:00Z"), 10_000, { tenantIds: [t.tenantId] });
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(1_600_000);
    await runSaasMpReconcile(DAY11, 10_000, { tenantIds: [t.tenantId] });
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(BASE);
  });

  it("[ZF1] proyección del día 3: el saldo a cuenta se descuenta solo por lo que sobra después de la deuda vieja", async () => {
    const t = await subscribed();
    const id = await active(t);
    // Deuda vieja: el cargo del 4/3 sin pagar (10.000). Saldo a cuenta: 15.000 → para el cargo del 4/4 quedan 5.000.
    await charge(t, "2030-03-04", 1_000_000);
    await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: null, amountCents: 1_500_000, status: "APPROVED", source: "MANUAL", method: "TRANSFER", paidAt: MID },
    });
    await runSaasMpReconcile(DAY3, 10_000, { tenantIds: [t.tenantId] });
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(BASE - 500_000);
  });

  // ── 8. Mail de débito rechazado ───────────────────────────────────────────────────────────────────────────────

  it("[ZF1] dos débitos rechazados del mismo período → UN mail «No pudimos debitar», con vencimiento", async () => {
    const t = await subscribed();
    const id = await active(t);
    const d1 = await simulateFakeDebit({ preapprovalId: id, outcome: "rejected" });
    expect(await consumeSaasAuthorizedPayment(d1.authorizedPaymentId, { source: "webhook" })).toMatchObject({ ok: true, result: "applied" });
    const d2 = await simulateFakeDebit({ preapprovalId: id, outcome: "rejected" });
    expect(await consumeSaasAuthorizedPayment(d2.authorizedPaymentId, { source: "webhook" })).toMatchObject({ ok: true, result: "applied" });
    const failed = mail.sent.filter((m) => /No pudimos debitar/.test(m.text ?? ""));
    expect(failed).toHaveLength(1);
    const due = periodFor(periodStartForDebit(new Date())).dueDate;
    const claims = await db.platformAuditEvent.findMany({ where: { tenantId: t.tenantId, action: "platform.mail.billing_debit_failed" } });
    expect(claims.map((c) => c.idempotencyKey)).toEqual([`billing_debit_failed:${id}:${periodStartForDebit(new Date())}`]);
    expect(due).toMatch(/^\d{4}-\d{2}-09$/);
  });
});
