/**
 * [MPS-2b2] Sync de la suscripción con Mercado Pago (C-MPS8, plan §26.6; MPS-D16/D17/D21): inicio del débito
 * (preapproval PENDIENTE sin tarjeta, con `debitStartInstant` y el monto de `desiredDebit`), su reuso, el refresh al
 * volver del checkout, «Pagar con Mercado Pago» por cargo (reusa el link de las últimas 24 h con el mismo monto; si no,
 * lo recrea y vence el viejo), el sync después de un commit y la conciliación diaria (≤ 50, un GET por suscripción, un
 * PUT solo si difiere, corte por presupuesto).
 *
 * Símbolos REALES (`lib/saas-mp-sync-internal.ts`, el puerto `lib/mercadopago-saas.ts`, el consumidor de MPS-2b1)
 * contra Postgres en los dos roles y el Mercado Pago FALSO (`tests/helpers/mp-saas-fake.ts`): lo único reemplazado es
 * la red. El webhook NO se cablea (los avisos del fake se registran y contestan 200): así lo que promueve o apaga lo
 * hace el sync, no un webhook que llegó primero.
 *
 * Fechas FIJAS en 2030 (todo recibe `now`): el fake exige `start_date` futuro con el reloj real, y 2030 lo es.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createOrReuseChargeCheckout,
  refreshPendingPreapproval,
  runSaasMpReconcile,
  startPreapprovalFlow,
  syncSaasMpAfterCommit,
} from "@/lib/saas-mp-sync-internal";
import { arMidnight, dbDateFromKey } from "@/lib/saas-billing-logic";
import { debitStartInstant } from "@/lib/saas-mp-logic";
import { fakeMpGetPreference } from "@/lib/mp-connect/fake-mp";
import { authorizeFakePreapproval, fakeMpGetPreapproval, installSaasFakeMp, type InstalledSaasFakeMp } from "@/tests/helpers/mp-saas-fake";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** 20/3/2030 12:00 AR. */
const MID = new Date("2030-03-20T15:00:00Z");
/** 3/4/2030, 4/4/2030 y 5/4/2030 a las 12:00 AR. */
const DAY3 = new Date("2030-04-03T15:00:00Z");
const DAY4 = new Date("2030-04-04T15:00:00Z");
const DAY5 = new Date("2030-04-05T15:00:00Z");
const BASE = 2_000_000; // $20.000 (precio a medida atado al plan: no depende de SaasPlanConfig)

describe.skipIf(!RUN)("[MPS-2b2] sync de la suscripción con Mercado Pago", () => {
  let db: PrismaClient;
  let mp: InstalledSaasFakeMp | null = null;
  const tenants: EphemeralTenant[] = [];
  /** method + path de cada llamada al fake (los `calls` del helper no tienen el método). */
  let net: string[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterEach(() => {
    mp?.uninstall();
    mp = null;
    delete process.env.SAAS_MP_CHECKOUT_NOTIFY;
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  function install() {
    mp = installSaasFakeMp();
    net = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(url).pathname;
      const i = path.indexOf("/api/mp/fake");
      if (i >= 0) net.push(`${method} ${path.slice(i + "/api/mp/fake".length)}`);
      return inner(input, init);
    }) as typeof fetch;
    const restore = mp.uninstall;
    mp.uninstall = () => {
      globalThis.fetch = inner;
      restore();
    };
    return mp;
  }
  const count = (prefix: string) => net.filter((n) => n.startsWith(prefix)).length;

  async function subscribed(o: { nextChargeKey?: string; cancelAtPeriodEnd?: boolean } = {}) {
    const t = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL" });
    tenants.push(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    await db.saasSubscription.create({
      data: {
        tenantId: t.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(o.nextChargeKey ?? "2030-04-04"),
        customPriceCents: BASE,
        customPricePlan: "INDIVIDUAL",
        cancelAtPeriodEnd: o.cancelAtPeriodEnd ?? false,
        cancelEffectiveOn: o.cancelAtPeriodEnd ? dbDateFromKey(o.nextChargeKey ?? "2030-04-04") : null,
      },
    });
    return t;
  }

  /** Débito ACTIVO: preapproval creado por el flujo, autorizado en el fake y promovido a mano (sin depender del webhook). */
  async function withActiveDebit(t: EphemeralTenant, amountCents = BASE) {
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "titular@test.local", actorUserId: t.userId, now: MID });
    if (!r.ok) throw new Error(`startPreapprovalFlow: ${r.reason}`);
    await authorizeFakePreapproval(r.preapprovalId);
    await db.saasSubscription.update({
      where: { tenantId: t.tenantId },
      data: {
        collectionMethod: "AUTO_DEBIT",
        autoDebitEnabled: true,
        mpPreapprovalId: r.preapprovalId,
        mpPreapprovalStatus: "authorized",
        mpPreapprovalAmountCents: amountCents,
        mpPayerEmail: "titular@test.local",
        mpPendingPreapprovalId: null,
        mpPendingInitPoint: null,
        mpPendingPayerEmail: null,
        mpPendingCreatedAt: null,
        mpPreapprovalSyncedAt: MID,
      },
    });
    return r.preapprovalId;
  }

  async function openCharge(t: EphemeralTenant, amountCents = BASE) {
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "INDIVIDUAL",
        periodStart: dbDateFromKey("2030-03-04"),
        periodEnd: dbDateFromKey("2030-04-04"),
        dueDate: dbDateFromKey("2030-03-09"),
        amountCents,
        status: "OPEN",
      },
    });
  }

  // ── Inicio del débito ──────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b2] inicio del débito: preapproval pendiente sin tarjeta, start_date del 4 a las 08:00 AR, monto deseado; guarda mpPending*", async () => {
    install();
    const t = await subscribed();
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "Titular@Test.local", actorUserId: t.userId, now: MID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(false);
    const pre = fakeMpGetPreapproval(r.preapprovalId)!;
    expect(pre.status).toBe("pending");
    expect(pre.body.card_token_id).toBeUndefined();
    expect((pre.body.auto_recurring as Record<string, unknown>).billing_day).toBeUndefined();
    expect(pre.amountCents).toBe(BASE);
    expect(pre.externalReference).toBe(`saas:${t.tenantId}`);
    expect(new Date(pre.startDate).getTime()).toBe(new Date(debitStartInstant(MID, "2030-04-04")).getTime());
    expect(r.initPoint).toContain(r.preapprovalId);
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.mpPendingPreapprovalId).toBe(r.preapprovalId);
    expect(sub.mpPendingInitPoint).toBe(r.initPoint);
    expect(sub.mpPendingPayerEmail).toBe("titular@test.local");
    expect(sub.mpPendingCreatedAt?.getTime()).toBe(MID.getTime());
    // El vigente (ninguno) no se toca: el pendiente no cobra hasta que MP lo autorice.
    expect(sub.mpPreapprovalId).toBeNull();
  });

  it("[MPS-2b2] reuso: un pendiente vigente con el mismo email se reusa (reused:true, un solo POST); otro email lo reemplaza y cancela el viejo", async () => {
    install();
    const t = await subscribed();
    const a = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "titular@test.local", actorUserId: t.userId, now: MID });
    const b = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "TITULAR@test.local", actorUserId: t.userId, now: new Date(MID.getTime() + 3600_000) });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.reused).toBe(true);
    expect(b.preapprovalId).toBe(a.preapprovalId);
    expect(count("POST /preapproval")).toBe(1);

    const c = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "otra@test.local", actorUserId: t.userId, now: new Date(MID.getTime() + 7200_000) });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.reused).toBe(false);
    expect(c.preapprovalId).not.toBe(a.preapprovalId);
    expect(fakeMpGetPreapproval(a.preapprovalId)!.status).toBe("cancelled");
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.mpPendingPreapprovalId).toBe(c.preapprovalId);
  });

  it("[MPS-2b2] débito bloqueado por Plataforma → not_allowed sin llamar a MP", async () => {
    install();
    const t = await subscribed();
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { autoDebitAllowed: false } });
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "titular@test.local", actorUserId: t.userId, now: MID });
    expect(r).toEqual({ ok: false, reason: "not_allowed" });
    expect(net).toEqual([]);
  });

  // ── Refresh al volver del checkout ─────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b2] refresh al volver: pendiente → pending_authorization; autorizado en MP → lo promueve (AUTO_DEBIT, activo) y es idempotente", async () => {
    install();
    const t = await subscribed();
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: "titular@test.local", actorUserId: t.userId, now: MID });
    if (!r.ok) throw new Error(r.reason);
    expect(await refreshPendingPreapproval({ tenantId: t.tenantId, now: MID })).toEqual({ status: "pending_authorization" });

    await authorizeFakePreapproval(r.preapprovalId); // el webhook no está cableado: lo promueve el refresh
    expect(await refreshPendingPreapproval({ tenantId: t.tenantId, now: MID })).toEqual({ status: "active" });
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.mpPreapprovalId).toBe(r.preapprovalId);
    expect(sub.mpPendingPreapprovalId).toBeNull();
    expect(sub.collectionMethod).toBe("AUTO_DEBIT");
    expect(sub.autoDebitEnabled).toBe(true);

    expect(await refreshPendingPreapproval({ tenantId: t.tenantId, now: MID })).toEqual({ status: "active" });
    const again = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(again.mpPreapprovalId).toBe(r.preapprovalId);
  });

  // ── «Pagar con Mercado Pago» ───────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b2] checkout: crea con ?scope=saas, reusa el de < 24 h con el mismo monto, recrea (y vence el viejo) si cambió el monto o pasó el día", async () => {
    install();
    const t = await subscribed();
    const ch = await openCharge(t);
    const a = await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: MID });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.reused).toBe(false);
    const pa = fakeMpGetPreference(a.preferenceId)!;
    expect(pa.amountCents).toBe(BASE);
    expect(pa.externalReference).toBe(`saas:${t.tenantId}:${ch.id}`);
    expect(pa.notificationUrl).toMatch(/\/api\/webhooks\/mercadopago\?scope=saas$/);
    let row = await db.saasCharge.findUniqueOrThrow({ where: { id: ch.id } });
    expect(row.mpCheckoutPreferenceId).toBe(a.preferenceId);
    expect(row.mpCheckoutExpectedCents).toBe(BASE);

    const b = await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: new Date(MID.getTime() + 23 * 3600_000) });
    expect(b).toEqual({ ok: true, reused: true, preferenceId: a.preferenceId, initPoint: a.initPoint });
    expect(count("POST /checkout/preferences")).toBe(1);

    // Pago parcial a mano: lo que falta cambió → link nuevo y el viejo vencido.
    await db.saasPayment.create({
      data: { tenantId: t.tenantId, chargeId: ch.id, source: "MANUAL", method: "TRANSFER", status: "APPROVED", amountCents: 500_000, paidAt: MID },
    });
    const c = await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: new Date(MID.getTime() + 3600_000) });
    expect(c.ok && !c.reused).toBe(true);
    if (!c.ok) return;
    expect(fakeMpGetPreference(c.preferenceId)!.amountCents).toBe(1_500_000);
    expect(fakeMpGetPreference(a.preferenceId)!.expired).toBe(true);
    row = await db.saasCharge.findUniqueOrThrow({ where: { id: ch.id } });
    expect(row.mpCheckoutExpectedCents).toBe(1_500_000);

    // Mismo monto pero más de 24 h → se recrea.
    const d = await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: new Date(MID.getTime() + 26 * 3600_000) });
    expect(d.ok && !d.reused).toBe(true);
    if (d.ok) expect(d.preferenceId).not.toBe(c.preferenceId);
  });

  it("[MPS-2b2] checkout: SAAS_MP_CHECKOUT_NOTIFY=panel omite la notification_url; un cargo pagado → charge_not_open", async () => {
    install();
    process.env.SAAS_MP_CHECKOUT_NOTIFY = "panel";
    const t = await subscribed();
    const ch = await openCharge(t);
    const a = await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: MID });
    if (!a.ok) throw new Error(a.reason);
    expect(fakeMpGetPreference(a.preferenceId)!.notificationUrl).toBeNull();
    await db.saasCharge.update({ where: { id: ch.id }, data: { status: "PAID", paidAt: MID } });
    expect(await createOrReuseChargeCheckout({ tenantId: t.tenantId, chargeId: ch.id, now: MID })).toEqual({ ok: false, reason: "charge_not_open" });
  });

  // ── Conciliación ───────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b2] reconcile con reloj falso: el 3 PUT del monto proyectado, el 4 nada (un GET), el 5 restaura la base", async () => {
    install();
    const t = await subscribed();
    const id = await withActiveDebit(t);
    await db.saasAdjustment.create({
      data: { tenantId: t.tenantId, kind: "CREDIT", amountCents: -500_000, effectiveOn: dbDateFromKey("2030-04-01"), description: "Bonificación", idempotencyKey: `credit:${t.tenantId}` },
    });
    const scope = { tenantIds: [t.tenantId] };

    net = [];
    const r3 = await runSaasMpReconcile(DAY3, 10_000, scope);
    expect(r3).toMatchObject({ scanned: 1, updated: 1, failed: 0, timedOut: false });
    expect(count("GET /preapproval/")).toBe(1);
    expect(count("PUT /preapproval/")).toBe(1);
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(1_500_000);
    let sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.mpPreapprovalAmountCents).toBe(1_500_000);
    expect(sub.mpPreapprovalSyncedAt?.getTime()).toBe(DAY3.getTime());

    net = [];
    const r4 = await runSaasMpReconcile(DAY4, 10_000, scope);
    expect(r4).toMatchObject({ scanned: 1, updated: 0, failed: 0 });
    expect(count("GET /preapproval/")).toBe(1);
    expect(count("PUT /preapproval/")).toBe(0);

    net = [];
    const r5 = await runSaasMpReconcile(DAY5, 10_000, scope);
    expect(r5).toMatchObject({ scanned: 1, updated: 1 });
    expect(fakeMpGetPreapproval(id)!.amountCents).toBe(BASE);
    sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.mpPreapprovalAmountCents).toBe(BASE);
  });

  it("[MPS-2b2] reconcile: `limit` trunca con prioridad (el desvío va antes que el al día) y el presupuesto corta (timedOut)", async () => {
    install();
    const ok = await subscribed();
    await withActiveDebit(ok);
    const off = await subscribed();
    const offId = await withActiveDebit(off);
    // Desvío: la base cambió (precio a medida nuevo) y la base guarda el monto viejo.
    await db.saasSubscription.update({ where: { tenantId: off.tenantId }, data: { customPriceCents: 2_500_000 } });
    // El al día tiene el sync más viejo: sin prioridad iría primero.
    await db.saasSubscription.update({ where: { tenantId: ok.tenantId }, data: { mpPreapprovalSyncedAt: new Date("2030-01-01T00:00:00Z") } });

    const r = await runSaasMpReconcile(MID, 10_000, { tenantIds: [ok.tenantId, off.tenantId], limit: 1 });
    expect(r).toMatchObject({ scanned: 1, updated: 1 });
    expect(fakeMpGetPreapproval(offId)!.amountCents).toBe(2_500_000);

    net = [];
    const z = await runSaasMpReconcile(MID, 0, { tenantIds: [ok.tenantId, off.tenantId] });
    expect(z).toMatchObject({ scanned: 0, timedOut: true });
    expect(net).toEqual([]);
  });

  it("[MPS-2b2] reconcile: un pendiente de 8 días se cancela en MP y se limpia; uno de 2 días queda", async () => {
    install();
    const old = await subscribed();
    const fresh = await subscribed();
    const a = await startPreapprovalFlow({ tenantId: old.tenantId, payerEmail: "titular@test.local", actorUserId: old.userId, now: MID });
    const b = await startPreapprovalFlow({ tenantId: fresh.tenantId, payerEmail: "titular@test.local", actorUserId: fresh.userId, now: MID });
    if (!a.ok || !b.ok) throw new Error("start");
    const now = new Date(MID.getTime() + 8 * 86_400_000);
    await db.saasSubscription.update({ where: { tenantId: fresh.tenantId }, data: { mpPendingCreatedAt: new Date(now.getTime() - 2 * 86_400_000) } });

    const r = await runSaasMpReconcile(now, 10_000, { tenantIds: [old.tenantId, fresh.tenantId] });
    expect(r.failed).toBe(0);
    expect(fakeMpGetPreapproval(a.preapprovalId)!.status).toBe("cancelled");
    expect(fakeMpGetPreapproval(b.preapprovalId)!.status).toBe("pending");
    const so = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: old.tenantId } });
    expect([so.mpPendingPreapprovalId, so.mpPendingInitPoint, so.mpPendingPayerEmail, so.mpPendingCreatedAt]).toEqual([null, null, null, null]);
    const sf = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: fresh.tenantId } });
    expect(sf.mpPendingPreapprovalId).toBe(b.preapprovalId);
  });

  it("[MPS-2b2] syncSaasMpAfterCommit: baja programada → pausa el débito; deshacerla → lo reanuda; nunca tira", async () => {
    install();
    const t = await subscribed();
    const id = await withActiveDebit(t);
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey("2030-04-04") } });
    await syncSaasMpAfterCommit(t.tenantId);
    expect(fakeMpGetPreapproval(id)!.status).toBe("paused");
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).mpPreapprovalStatus).toBe("paused");

    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { cancelAtPeriodEnd: false, cancelEffectiveOn: null } });
    await syncSaasMpAfterCommit(t.tenantId);
    expect(fakeMpGetPreapproval(id)!.status).toBe("authorized");

    await expect(syncSaasMpAfterCommit("no-existe")).resolves.toBeUndefined();
  });
});
