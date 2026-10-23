/**
 * [MPS-2b1] Webhook de Mercado Pago de la SUSCRIPCIÓN (C-MPS6 ruteo, C-MPS7 consumidores; brief §26.6), de punta a
 * punta por la RUTA REAL: `POST` de `app/api/webhooks/mercadopago/route.ts` → `handleSaasWebhook` (firma con
 * `MP_WEBHOOK_SECRET`) → consumidores de `lib/saas-billing-mp-internal.ts` → re-fetch por el puerto
 * `lib/mercadopago-saas.ts` contra el MP FALSO (C-MPS4) → Postgres (CHECKs de M16 reales) → núcleo de cobros.
 *
 * Lo único reemplazado es lo externo: la red (`installSaasFakeMp` enruta `fetch` al fake y tira ante cualquier otro
 * host), el transporte de mails, el rate limit in-memory y, SOLO para el bloque de la delegación legada (`saas:` por
 * el camino sin `?scope=`, con el fake apagado), el SDK de MP. Nunca MP real ni el sandbox.
 *
 * `tests/integration/mp-webhook.test.ts` (rama legada, AUDIT §5.4) no se toca y tiene que seguir verde.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  // La ruta legada congela `env.MP_WEBHOOK_SECRET` al importar: es el MISMO literal con que firma el fake lo de la
  // plataforma (`FAKE_SAAS_HOOK_SECRET`), así el `payment` de un débito (que llega sin `?scope=`) pasa la firma legada.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token-mps2b";
  process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook-de-la-plataforma";
});

/** SDK de MP de la rama LEGADA (solo el bloque de la delegación): el detalle del pago por id. */
const legacyPayments = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const sdkCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create() {
      throw new Error("no usado en este archivo");
    }
  }
  class Payment {
    async get({ id }: { id: string }) {
      sdkCalls.n += 1;
      const d = legacyPayments.get(String(id));
      if (!d) throw new Error(`payment ${id} desconocido`);
      return d;
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __resetSaasMpMemoForTests, createChargeCheckout, createPreapproval } from "@/lib/mercadopago-saas";
import { cancelFakePreapprovalFromMp } from "@/lib/mp-connect/fake-mp-saas";
import { signMpNotification } from "@/lib/mp-connect/signature";
import { dbDateFromKey, periodFor } from "@/lib/saas-billing-logic";
import { periodStartForDebit } from "@/lib/saas-mp-logic";
import { FAKE_APP_URL, payFake } from "@/tests/helpers/mp-connect-fake";
import {
  FAKE_MP_PLATFORM,
  FAKE_SAAS_HOOK_SECRET,
  authorizeFakePreapproval,
  installSaasFakeMp,
  simulateFakeDebit,
  type InstalledSaasFakeMp,
} from "@/tests/helpers/mp-saas-fake";
import { createEphemeralTenant, ownerClient, sweepOrphanTestTenants, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const HOOK_URL = `${FAKE_APP_URL}/api/webhooks/mercadopago`;
/**
 * Precio a medida = el monto del preapproval: CONSULTORIO no tiene precio por default («Consultá») y la sync posterior
 * al commit (MPS-2b2) pausaría el débito (`desiredDebit` → no_price) y el fake ya no lo dejaría debitar.
 */
let T_ID = "";
const SUB = () => ({ tenantId: T_ID, anchorDay: 4, customPriceCents: 2_500_000, customPricePlan: "CONSULTORIO" as const });

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

/** POST firmado a la ruta real (como lo manda MP). `secret` null = sin firma. */
function signedPost(o: { query: string; dataId: string; secret?: string | null; body?: Record<string, unknown> }) {
  const requestId = randomUUID();
  const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": requestId };
  const secret = o.secret === undefined ? FAKE_SAAS_HOOK_SECRET : o.secret;
  if (secret) headers["x-signature"] = signMpNotification({ dataId: o.dataId, secret, ts: Math.floor(Date.now() / 1000), requestId });
  return POST(
    new Request(`${HOOK_URL}?${o.query}`, { method: "POST", headers, body: JSON.stringify(o.body ?? { data: { id: o.dataId } }) })
  );
}

/** Reenvía tal cual una notificación que ya mandó el fake (MP reintenta con la misma firma). */
function replayHook(h: { url: string; headers: Record<string, string>; body: Record<string, unknown> }) {
  return POST(new Request(h.url, { method: "POST", headers: h.headers, body: JSON.stringify(h.body) }));
}

describe.skipIf(!RUN)("[MPS-2b1] webhook de la suscripción (C-MPS6/C-MPS7)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledSaasFakeMp | null = null;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
  });
  afterAll(async () => {
    __setEmailTransportForTests(null);
    await db?.$disconnect();
  });
  beforeEach(async () => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __resetSaasMpMemoForTests();
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    T_ID = T.tenantId;
    await db.saasSubscription.create({ data: SUB() });
    fake = installSaasFakeMp({ webhook: POST });
  });
  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    await T?.cleanup();
  });

  /** Cargo OPEN del período `periodStart` (un 4). */
  async function openCharge(periodStart: string, amountCents: number) {
    const p = periodFor(periodStart as Parameters<typeof periodFor>[0]);
    return db.saasCharge.create({
      data: {
        tenantId: T.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents,
        baseAmountCents: amountCents,
      },
    });
  }

  /** Link de pago del cargo creado por el puerto real (con `?scope=saas`) y anclado en el cargo como lo hace la sync. */
  async function chargeCheckout(chargeId: string, amountCents: number) {
    const r = await createChargeCheckout({
      tenantId: T.tenantId,
      chargeId,
      title: "Suscripción · Consultorio",
      amountCents,
      payerEmail: "titular@example.com",
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`checkout: ${r.kind}`);
    await db.saasCharge.update({
      where: { id: chargeId },
      data: { mpCheckoutPreferenceId: r.data.preferenceId, mpCheckoutExpectedCents: amountCents, mpCheckoutCreatedAt: new Date() },
    });
    return r.data.preferenceId;
  }

  /** Preapproval PENDIENTE creado por el puerto real y guardado como pendiente de la suscripción. */
  async function pendingPreapproval(amountCents = 2_500_000) {
    const r = await createPreapproval({
      reason: "Suscripción · Consultorio",
      externalReference: `saas:${T.tenantId}`,
      payerEmail: "titular@example.com",
      amountCents,
      startDate: new Date(Date.now() + 10 * 86_400_000),
      backUrl: `${FAKE_APP_URL}/configuracion?tab=plan`,
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`preapproval: ${r.kind}`);
    await db.saasSubscription.update({
      where: { tenantId: T.tenantId },
      data: { mpPendingPreapprovalId: r.data.id, mpPendingInitPoint: r.data.initPoint, mpPendingCreatedAt: new Date() },
    });
    return r.data.id;
  }

  /** Preapproval autorizado y promovido por el webhook real. */
  async function activeDebit() {
    const id = await pendingPreapproval();
    const hook = await authorizeFakePreapproval(id);
    expect(hook.webhookStatus).toBe(200);
    return id;
  }

  const payments = () => db.saasPayment.findMany({ where: { tenantId: T.tenantId }, orderBy: { createdAt: "asc" } });
  const sub = () => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: T.tenantId } });

  // ── Firma y ruteo ─────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b1] firma inválida → 401 sin llamar a MP (topic de preapproval y ?scope=saas)", async () => {
    const pre = randomBytes(16).toString("hex");
    const r1 = await signedPost({ query: `data.id=${pre}&type=subscription_preapproval`, dataId: pre, secret: "otro-secreto" });
    expect(r1.status).toBe(401);
    const r2 = await signedPost({ query: `scope=saas&data.id=123456&type=payment`, dataId: "123456", secret: null });
    expect(r2.status).toBe(401);
    const r3 = await signedPost({ query: `data.id=987&type=subscription_authorized_payment`, dataId: "987", secret: "otro-secreto" });
    expect(r3.status).toBe(401);
    expect(fake!.calls).toHaveLength(0);
  });

  it("[MPS-2b1] sin MP_WEBHOOK_SECRET → 503 (MP reintenta) y 0 llamadas a MP", async () => {
    delete process.env.MP_WEBHOOK_SECRET;
    const pre = randomBytes(16).toString("hex");
    const r = await signedPost({ query: `data.id=${pre}&type=preapproval`, dataId: pre });
    expect(r.status).toBe(503);
    expect(fake!.calls).toHaveLength(0);
  });

  it("[MPS-2b1] data.id fuera de la regex del topic → 200 ignorado sin llamar a MP; topic ajeno con ?scope=saas → ignorado", async () => {
    const upper = randomBytes(16).toString("hex").toUpperCase();
    const r1 = await signedPost({ query: `data.id=${upper}&type=subscription_preapproval`, dataId: upper });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ result: "ignored", reason: "bad_data_id" });
    const r2 = await signedPost({ query: `data.id=12ab&type=authorized_payment`, dataId: "12ab" });
    expect(await r2.json()).toMatchObject({ result: "ignored", reason: "bad_data_id" });
    const r3 = await signedPost({ query: `scope=saas&data.id=55&type=merchant_order`, dataId: "55" });
    expect(r3.status).toBe(200);
    expect(await r3.json()).toMatchObject({ result: "ignored", reason: "topic" });
    expect(fake!.calls).toHaveLength(0);
  });

  // ── Link de pago de un cargo (?scope=saas) ────────────────────────────────────────────────────────────────────

  it("[MPS-2b1] link de pago aprobado (?scope=saas) → MP_CHECKOUT imputado al cargo, que pasa a PAID; el replay no hace nada", async () => {
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const pref = await chargeCheckout(c.id, 2_500_000);
    const r = await payFake(pref, "approved");
    expect(r.webhookStatus).toBe(200);
    expect(r.webhookResult).toBe("applied");
    expect(fake!.hooks[0].url).toContain("scope=saas");

    const [p] = await payments();
    expect(p).toMatchObject({ source: "MP_CHECKOUT", status: "APPROVED", chargeId: c.id, amountCents: 2_500_000, mpPaymentId: r.paymentId });
    expect(p.method).toBe("MERCADO_PAGO");
    expect(JSON.stringify(p.mpPayload)).not.toMatch(/payer|titular@|card/);
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
    expect(mail.sent.some((m) => m.kind === "billing_payment_received")).toBe(true);

    const again = await replayHook(fake!.hooks[0]);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ result: "replay" });
    expect(await payments()).toHaveLength(1);
  });

  it("[MPS-2b1] monto distinto al del link → se registra APROBADO con el monto real, nota y audit de Plataforma", async () => {
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const pref = await chargeCheckout(c.id, 2_500_000);
    const r = await payFake(pref, "approved", { amountCents: 2_000_000 });
    expect(r.webhookStatus).toBe(200);
    const [p] = await payments();
    expect(p).toMatchObject({ status: "APPROVED", amountCents: 2_000_000, chargeId: c.id });
    expect(p.note).toMatch(/Monto distinto/);
    // Faltan $5.000: el cargo sigue abierto.
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN");
    const audit = await db.platformAuditEvent.findMany({ where: { tenantId: T.tenantId, action: "platform.billing.mp_amount_mismatch" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(p.id);
  });

  it("[MPS-2b1] sobrepago por el link → el cargo se salda y el resto queda a cuenta en un hermano con splitFromId (hallazgo 1)", async () => {
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const pref = await chargeCheckout(c.id, 2_500_000);
    const r = await payFake(pref, "approved", { amountCents: 3_000_000 });
    expect(r.webhookResult).toBe("applied");
    const ps = await payments();
    const root = ps.find((p) => p.mpPaymentId === r.paymentId)!;
    const sibling = ps.find((p) => p.id !== root.id)!;
    expect(root).toMatchObject({ chargeId: c.id, amountCents: 2_500_000, status: "APPROVED" });
    expect(sibling).toMatchObject({ chargeId: null, amountCents: 500_000, status: "APPROVED", splitFromId: root.id, mpPaymentId: null });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
  });

  it("[MPS-2b1] pago de otro collector con referencia saas: → mismatch, sin filas", async () => {
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const pref = await chargeCheckout(c.id, 2_500_000);
    // MP devuelve el pago de otra cuenta (el resto igual): no se imputa.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!/\/v1\/payments\/\d+$/.test(url)) return res;
      const j = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...j, collector_id: 123 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const r = await payFake(pref, "approved");
      expect(r.webhookStatus).toBe(200);
      expect(r.webhookResult).toBe("mismatch");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(await payments()).toHaveLength(0);
  });

  // ── Preapproval ───────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b1] preapproval autorizado → promueve el pendiente (el viejo a retirado, AUTO_DEBIT); replay sin efecto", async () => {
    const old = randomBytes(16).toString("hex");
    await db.saasSubscription.update({ where: { tenantId: T.tenantId }, data: { mpPreapprovalId: old, mpPreapprovalStatus: "authorized" } });
    const id = await pendingPreapproval();
    const hook = await authorizeFakePreapproval(id);
    expect(hook).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    const s = await sub();
    expect(s).toMatchObject({
      mpPreapprovalId: id,
      mpRetiredPreapprovalId: old,
      mpPreapprovalStatus: "authorized",
      collectionMethod: "AUTO_DEBIT",
      autoDebitEnabled: true,
      mpPendingPreapprovalId: null,
      mpPendingCreatedAt: null,
      mpPayerEmail: "titular@example.com",
      mpPreapprovalAmountCents: 2_500_000,
    });
    const before = s.updatedAt.getTime();
    const again = await replayHook(fake!.hooks.at(-1)!);
    expect(await again.json()).toMatchObject({ result: "replay" });
    expect((await sub()).updatedAt.getTime()).toBe(before);
  });

  it("[MPS-2b1] cancelado desde MP → apaga el débito y el método queda sin elegir; propio (método ya cambiado) → solo se refleja", async () => {
    const id = await activeDebit();
    const r = await cancelFakePreapprovalFromMp(id);
    expect(r).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    expect(await sub()).toMatchObject({ mpPreapprovalStatus: "cancelled", autoDebitEnabled: false, collectionMethod: null });
    const again = await replayHook(fake!.hooks.at(-1)!);
    expect(await again.json()).toMatchObject({ result: "replay" });

    // Propio: el consultorio ya pasó a transferencia (la sync cancela en MP y llega el aviso).
    const T2 = T;
    await T2.cleanup();
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    T_ID = T.tenantId;
    await db.saasSubscription.create({ data: SUB() });
    const id2 = await activeDebit();
    await db.saasSubscription.update({ where: { tenantId: T.tenantId }, data: { collectionMethod: "TRANSFER" } });
    await cancelFakePreapprovalFromMp(id2);
    expect(await sub()).toMatchObject({ mpPreapprovalStatus: "cancelled", autoDebitEnabled: false, collectionMethod: "TRANSFER" });
  });

  // ── Débitos (authorized_payment) ──────────────────────────────────────────────────────────────────────────────

  it("[MPS-2b1] débito aprobado antes de que exista el cargo → MP_AUTO a cuenta; el topic payment del mismo débito (camino legado) es replay", async () => {
    const id = await activeDebit();
    const d = await simulateFakeDebit({ preapprovalId: id, outcome: "approved", alsoPaymentTopic: true });
    expect(d.webhookStatus).toBe(200);
    expect(d.webhookResult).toBe("applied");
    expect(d.paymentWebhookStatus).toBe(200);
    const ps = await payments();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      source: "MP_AUTO",
      status: "APPROVED",
      chargeId: null,
      mpAuthorizedPaymentId: d.authorizedPaymentId,
      mpPaymentId: d.paymentId,
      mpPreapprovalId: id,
    });
    // El `payment` del débito llegó sin `?scope=` por el camino legado: con el fake, nunca al SDK.
    expect(sdkCalls.n).toBe(0);
    const legacyHook = fake!.hooks.find((h) => h.url.includes("type=payment"))!;
    expect(legacyHook.url).not.toContain("scope=");
  });

  it("[MPS-2b1] débito con cargo del período → se imputa y lo salda", async () => {
    const id = await activeDebit();
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const d = await simulateFakeDebit({ preapprovalId: id, outcome: "approved" });
    expect(d.webhookResult).toBe("applied");
    const [p] = await payments();
    expect(p).toMatchObject({ source: "MP_AUTO", chargeId: c.id, status: "APPROVED" });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
  });

  it("[MPS-2b1] débito rechazado → REJECTED + mail; el reintento aprobado reusa la fila; replays sin efecto", async () => {
    const id = await activeDebit();
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    const d1 = await simulateFakeDebit({ preapprovalId: id, outcome: "rejected" });
    expect(d1.webhookResult).toBe("applied");
    let ps = await payments();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ status: "REJECTED", mpAuthorizedPaymentId: d1.authorizedPaymentId, mpPaymentId: d1.paymentId });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN");

    const rejectedHook = fake!.hooks.at(-1)!;
    expect(await (await replayHook(rejectedHook)).json()).toMatchObject({ result: "replay" });

    const d2 = await simulateFakeDebit({ preapprovalId: id, outcome: "retry_approved" });
    expect(d2.webhookResult).toBe("applied");
    ps = await payments();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ status: "APPROVED", mpAuthorizedPaymentId: d1.authorizedPaymentId, mpPaymentId: d2.paymentId, chargeId: c.id });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
    // Un rechazo tardío del débito ya aprobado no lo «des-aprueba».
    expect(await (await replayHook(rejectedHook)).json()).toMatchObject({ result: "replay" });
    expect((await payments())[0].status).toBe("APPROVED");
  });

  it("[MPS-2b1] reintegro del débito (solo topic payment, camino legado) → REFUNDED y el cargo se reabre", async () => {
    const id = await activeDebit();
    const c = await openCharge(periodStartForDebit(new Date()), 2_500_000);
    await simulateFakeDebit({ preapprovalId: id, outcome: "approved" });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
    const r = await simulateFakeDebit({ preapprovalId: id, outcome: "refunded" });
    expect(r.webhookStatus).toBe(200);
    const [p] = await payments();
    expect(p.status).toBe("REFUNDED");
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN");
    expect(sdkCalls.n).toBe(0);
  });
});

// ── Delegación legada con el SDK (fake apagado) ──────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)("[MPS-2b1] camino legado: referencia saas: → consumeSaasMpPayment (SDK mockeado)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  const KEYS = ["SAAS_BILLING_MODE", "MP_CONNECT_MODE", "MP_WEBHOOK_SECRET", "MP_ACCESS_TOKEN"] as const;
  let prev: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  const mpCalls: string[] = [];
  const mpPayments = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.SAAS_BILLING_MODE = "mp";
    delete process.env.MP_CONNECT_MODE;
    process.env.MP_WEBHOOK_SECRET = FAKE_SAAS_HOOK_SECRET;
    process.env.MP_ACCESS_TOKEN = "TEST-access-token-mps2b";
    __resetSaasMpMemoForTests();
    mpCalls.length = 0;
    sdkCalls.n = 0;
    // La red: solo la API de MP que pide el puerto, respondida acá (nunca sale del proceso).
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      mpCalls.push(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://api.mercadopago.com/users/me") return json({ id: Number(FAKE_MP_PLATFORM.userId) });
      const m = /^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(url);
      if (m && mpPayments.has(m[1])) return json(mpPayments.get(m[1]));
      throw new Error(`[mps-2b] red bloqueada: ${url}`);
    }) as typeof fetch;
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    T_ID = T.tenantId;
    await db.saasSubscription.create({ data: SUB() });
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await T?.cleanup();
  });

  it("[MPS-2b1] pago legado con external_reference saas:t:c → lo re-pide el puerto con el token de la plataforma y lo imputa", async () => {
    const p = periodFor(periodStartForDebit(new Date()));
    const c = await db.saasCharge.create({
      data: {
        tenantId: T.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents: 1_000_000,
        baseAmountCents: 1_000_000,
      },
    });
    const payId = String(7_000_000_000 + Math.floor(Math.random() * 1e6));
    const ref = `saas:${T.tenantId}:${c.id}`;
    legacyPayments.set(payId, { id: Number(payId), status: "approved", transaction_amount: 10_000, currency_id: "ARS", external_reference: ref });
    mpPayments.set(payId, {
      id: Number(payId),
      status: "approved",
      transaction_amount: 10_000,
      currency_id: "ARS",
      collector_id: Number(FAKE_MP_PLATFORM.userId),
      external_reference: ref,
      date_approved: new Date().toISOString(),
    });

    const res = await signedPost({ query: `data.id=${payId}&type=payment`, dataId: payId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: "applied", tenantId: T.tenantId });
    expect(sdkCalls.n).toBe(1);
    expect(mpCalls).toContain(`https://api.mercadopago.com/v1/payments/${payId}`);
    const rows = await db.saasPayment.findMany({ where: { tenantId: T.tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "MP_CHECKOUT", status: "APPROVED", chargeId: c.id, mpPaymentId: payId });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAID");
  });

  it("[MPS-2b1] pago legado de un turno (sin saas:) no se delega: sigue el camino de siempre", async () => {
    const payId = String(8_000_000_000 + Math.floor(Math.random() * 1e6));
    legacyPayments.set(payId, { id: Number(payId), status: "approved", transaction_amount: 50, currency_id: "ARS", external_reference: `bk-${randomUUID()}` });
    const res = await signedPost({ query: `data.id=${payId}&type=payment`, dataId: payId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "booking_missing" });
    expect(mpCalls).toHaveLength(0);
  });
});
