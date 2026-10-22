/**
 * [TP-2w] Webhook de Mercado Pago, rama `?acct=` (cobros con la cuenta del vendedor; C-TP6/C-TP7, plan §25.6), de punta
 * a punta por la RUTA REAL: `POST` de `app/api/webhooks/mercadopago/route.ts` → `handleConnectWebhook` (firma) →
 * `consumeConnectWebhook` → `withAccountToken` + GET del pago contra el MP FALSO (C-TP12) → Postgres (guard y trigger de
 * M18 reales) → avisos y realtime.
 *
 * Lo único reemplazado es lo externo: la red (`installFakeMp` enruta `fetch` al fake; algunos tests reescriben la
 * respuesta del GET del pago para simular un MP que devuelve otra cosa o está caído), el SDK de MP de la rama legada y el
 * rate limit in-memory. Nunca MP real ni el sandbox (regla de T5: producción inadmisible).
 *
 * `tests/integration/mp-webhook.test.ts` (rama legada, AUDIT §5.4) no se toca y tiene que seguir verde: sin `?acct=` la
 * ruta sigue igual. El último bloque cubre el único cambio de la legada (`alsoAgendaOperators`).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const LEGACY_SECRET = "test-webhook-secret-tp2w";
vi.hoisted(() => {
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.MP_WEBHOOK_SECRET = "test-webhook-secret-tp2w";
});

/** SDK de MP de la rama LEGADA (solo el último bloque): el detalle del pago por id. */
const legacyPayments = vi.hoisted(() => new Map<string, Record<string, unknown>>());
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

import crypto, { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { formatARS } from "@/lib/format";
import { mpFetch } from "@/lib/mp-connect/http";
import { buildChargePreference, connectNotificationUrl } from "@/lib/mp-connect/preference";
import { signMpNotification } from "@/lib/mp-connect/signature";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import {
  connectFakeAccount,
  fakeMpForceReauth,
  fakeMpGetPayment,
  fakeMpGetPreference,
  FAKE_APP_URL,
  FAKE_HOOK_SECRET,
  installFakeMp,
  payFake,
  resetFakeMp,
  type FakeAccount,
  type InstalledFakeMp,
} from "@/tests/helpers/mp-connect-fake";
import {
  addPatient,
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const HOOK_URL = `${FAKE_APP_URL}/api/webhooks/mercadopago`;

describe.skipIf(!RUN)("[TP-2w] webhook de cobros online (rama ?acct=)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let acc: FakeAccount;
  let fake: InstalledFakeMp | null = null;
  let slot = 0;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  // Consultorio nuevo por test: las parciales «una cuenta viva por profesional» y «un cobro del turnero por turno».
  beforeEach(async () => {
    resetFakeMp();
    T = await createEphemeralTenant(db);
  });
  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    await T?.cleanup();
  });

  /** Conecta la cuenta y DESPUÉS instala la red sin vaciar el store (si no, se pierden los tokens). */
  async function setup(o: { signature?: "required" | "fetch-only"; account?: Parameters<typeof connectFakeAccount>[2] } = {}) {
    acc = await connectFakeAccount(db, T, o.account ?? {});
    fake = installFakeMp({ webhook: POST, reset: false, signature: o.signature });
  }

  type ChargeOpts = {
    origin?: "TURNERO" | "LINK";
    kind?: "FULL" | "DEPOSIT" | "FREE";
    amountCents?: number;
    bookingStatus?: "PENDING" | "CONFIRMED" | "CANCELLED";
    bookingPatch?: Record<string, unknown>;
    createdByUserId?: string;
    tenant?: EphemeralTenant;
    account?: FakeAccount;
  };

  /** Turno + cobro ACTIVE + preferencia en el fake (lo que dejan el turnero o el link). */
  async function makeCharge(o: ChargeOpts = {}) {
    const t = o.tenant ?? T;
    const a = o.account ?? acc;
    const origin = o.origin ?? "TURNERO";
    const kind = o.kind ?? "FULL";
    const amountCents = o.amountCents ?? 5000;
    const patientId = await addPatient(db, t, { firstName: "Ana", lastName: "Pérez" });
    slot += 1;
    let bookingId: string | null = null;
    if (kind !== "FREE") {
      const b = await db.booking.create({
        data: {
          tenantId: t.tenantId,
          practitionerId: t.practitionerId,
          serviceId: t.serviceId,
          patientId,
          scheduledFor: new Date(Date.now() + (2 + slot) * 86_400_000),
          durationMin: 45,
          status: o.bookingStatus ?? (origin === "TURNERO" ? "PENDING" : "CONFIRMED"),
          idempotencyKey: origin === "TURNERO" ? `pub:${t.practitionerId}:${randomUUID()}` : `test-${randomUUID()}`,
          ...(o.bookingPatch ?? {}),
        },
      });
      bookingId = b.id;
    }
    const link = origin === "LINK";
    const charge = await db.onlineCharge.create({
      data: {
        tenantId: t.tenantId,
        origin,
        kind,
        mpAccountId: a.accountId,
        practitionerId: t.practitionerId,
        patientId,
        bookingId,
        amountCents,
        copagoBasisCents: kind === "FULL" && bookingId ? amountCents : null,
        concept: link ? "Sesión de kinesiología" : null,
        publicToken: link ? randomBytes(16).toString("base64url") : null,
        createdByUserId: link ? (o.createdByUserId ?? t.userId) : null,
        expiresAt: new Date(Date.now() + 86_400_000),
        idempotencyKey: link ? `link:${randomUUID()}` : `turnero:${bookingId}`,
      },
    });
    const prefId = await makePreference(charge.id, amountCents, a, link ? "LINK" : "REQUIRED");
    return { chargeId: charge.id, bookingId, patientId, prefId };
  }

  async function makePreference(chargeId: string, amountCents: number, a: FakeAccount, mode: "LINK" | "REQUIRED" | "OPTIONAL", setOnCharge = true) {
    const body = buildChargePreference({
      charge: { id: chargeId, amountCents, scheduledFor: new Date() },
      tenantName: "Consultorio de prueba",
      mode,
      notificationUrl: connectNotificationUrl(FAKE_APP_URL, a.webhookRef),
      backUrls: { success: `${FAKE_APP_URL}/ok`, failure: `${FAKE_APP_URL}/ko`, pending: `${FAKE_APP_URL}/pend` },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const r = await mpFetch("/checkout/preferences", { token: a.accessToken, method: "POST", body });
    if (!r.ok) throw new Error("no se creó la preferencia en el fake");
    const pref = r.json as { id: string; init_point: string };
    if (setOnCharge) {
      await db.onlineCharge.update({ where: { id: chargeId }, data: { preferenceId: pref.id, checkoutUrl: pref.init_point } });
    }
    return pref.id;
  }

  /** POST a la ruta real con `?acct=` (para reenvíos, firmas malas o un `data.id` a mano). */
  async function hook(acct: string, paymentId: string, sign: "ok" | "none" | "bad" | "stale" = "ok") {
    const requestId = randomUUID();
    const ts = Math.floor(Date.now() / 1000) - (sign === "stale" ? 600 : 0);
    const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": requestId };
    if (sign !== "none") {
      headers["x-signature"] = signMpNotification({ dataId: paymentId, secret: sign === "bad" ? "otro-secreto" : FAKE_HOOK_SECRET, ts, requestId });
    }
    const res = await POST(
      new Request(`${HOOK_URL}?acct=${encodeURIComponent(acct)}&data.id=${paymentId}&type=payment`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "payment", data: { id: paymentId } }),
      })
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; result: string } };
  }

  /** Reescribe la respuesta del GET del pago (red): otro collector, live_mode, moneda, o MP caído. */
  function tamperPaymentGet(patch: Record<string, unknown> | "down") {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/mp/fake/v1/payments/")) {
        if (patch === "down") throw new TypeError("fetch failed");
        const res = await inner(input, init);
        if (!res.ok) return res;
        const j = (await res.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...j, ...patch }), { status: res.status, headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    }) as typeof fetch;
  }

  const paymentGets = () => (fake?.calls ?? []).filter((u) => u.includes("/v1/payments/")).length;
  const notifs = () =>
    db.notification.findMany({ where: { tenantId: T.tenantId, kind: "PAYMENT_RECEIVED" }, select: { userId: true, title: true, body: true } });

  // ── Ruta y firma ────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2w] firma required: sin firma, mala o vieja → 401 sin llamar a MP; acct desconocido → 200 ignorado", async () => {
    await setup();
    const c = await makeCharge();
    // Un pago real en el fake, sin notificar (para que el GET tenga algo que encontrar si la ruta llegara a llamarlo).
    fake!.uninstall();
    fake = installFakeMp({ reset: false, webhook: async () => new Response("{}", { status: 200 }) });
    const pay = await payFake(c.prefId, "approved");
    fake.uninstall();
    fake = installFakeMp({ webhook: POST, reset: false });

    for (const sign of ["none", "bad", "stale"] as const) {
      const r = await hook(acc.webhookRef, pay.paymentId, sign);
      expect(r.status, sign).toBe(401);
    }
    expect(paymentGets()).toBe(0);
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).toMatchObject({ status: "ACTIVE", mpPaymentId: null });

    const unknown = await hook(randomBytes(16).toString("base64url"), pay.paymentId);
    expect(unknown).toMatchObject({ status: 200, body: { result: "ignored" } });
    const malformed = await hook("no-es-un-ref", pay.paymentId);
    expect(malformed).toMatchObject({ status: 200, body: { result: "ignored" } });
    expect(paymentGets()).toBe(0);
  });

  it("[TP-2w] fetch-only procesa sin firma (la autenticidad la da el GET con el token de la cuenta)", async () => {
    await setup({ signature: "fetch-only" });
    const c = await makeCharge();
    fake!.uninstall();
    fake = installFakeMp({ reset: false, signature: "fetch-only", webhook: async () => new Response("{}", { status: 200 }) });
    const pay = await payFake(c.prefId, "approved");
    fake.uninstall();
    fake = installFakeMp({ webhook: POST, reset: false, signature: "fetch-only" });

    const r = await hook(acc.webhookRef, pay.paymentId, "none");
    expect(r).toMatchObject({ status: 200, body: { result: "applied" } });
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("PAID");
  });

  // ── Validaciones que ignoran ────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2w] pago invisible para el token (404, de otro vendedor) → ignorado", async () => {
    await setup();
    const other = await createEphemeralTenant(db);
    try {
      const acc2 = await connectFakeAccount(db, other, { seller: 2 });
      const c2 = await makeCharge({ tenant: other, account: acc2 });
      const p2 = await payFake(c2.prefId, "approved");
      expect(p2.webhookResult).toBe("applied");
      // El mismo pago (del vendedor 2) notificado con el acct de la cuenta del vendedor 1.
      const r = await hook(acc.webhookRef, p2.paymentId);
      expect(r).toMatchObject({ status: 200, body: { result: "ignored" } });
    } finally {
      await other.cleanup();
    }
  });

  it("[TP-2w] collector distinto, live_mode o moneda que no corresponden → ignorado sin tocar el cobro", async () => {
    await setup();
    for (const patch of [{ collector_id: 123456789 }, { live_mode: true }, { currency_id: "USD" }]) {
      const c = await makeCharge();
      tamperPaymentGet(patch);
      const p = await payFake(c.prefId, "approved");
      expect(p, JSON.stringify(patch)).toMatchObject({ webhookStatus: 200, webhookResult: "ignored" });
      const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
      expect(row).toMatchObject({ status: "ACTIVE", mpPaymentId: null });
      const b = await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } });
      expect(b).toMatchObject({ status: "PENDING", paymentStatus: "UNPAID" });
      fake!.uninstall();
      fake = installFakeMp({ webhook: POST, reset: false });
    }
  });

  it("[TP-2w] oc: de otro consultorio o de otra cuenta → ignorado", async () => {
    await setup();
    const other = await createEphemeralTenant(db);
    try {
      const accB = await connectFakeAccount(db, other, { seller: 1 });
      const cB = await makeCharge({ tenant: other, account: accB });
      // Preferencia con el `oc:` del cobro de B pero la notification_url de la cuenta de A (mismo vendedor de MP).
      const prefA = await makePreference(cB.chargeId, 5000, acc, "REQUIRED", false);
      const p = await payFake(prefA, "approved");
      expect(p).toMatchObject({ webhookStatus: 200, webhookResult: "ignored" });
      expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: cB.chargeId } })).status).toBe("ACTIVE");
    } finally {
      await other.cleanup();
    }
  });

  // ── Efectos ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2w] FULL REQUIRED → cobro PAID + PENDING→CONFIRMED + copago PAID MERCADO_PAGO sin quién cobró ni copagoPaidAt, congelado; nunca Payment", async () => {
    await setup();
    const sec = await addStaff(db, T, "ASSISTANT");
    const c = await makeCharge();
    const p = await payFake(c.prefId, "approved");
    expect(p).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });

    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
    expect(row).toMatchObject({
      status: "PAID",
      mpPaymentId: p.paymentId,
      paidAmountCents: 5000,
      mpStatus: "approved",
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      installments: 1,
    });
    expect(row.approvedAt).not.toBeNull();
    expect(row.settledAt).not.toBeNull();
    const b = await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } });
    expect(b).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "PAID",
      copagoPaymentMethod: "MERCADO_PAGO",
      copagoCollectedById: null,
      copagoPaidAt: null,
      copagoCents: 5000,
      onlineDepositCents: 0,
    });
    expect(await db.payment.count({ where: { bookingId: c.bookingId! } })).toBe(0);
    // Avisos: titular + profesional + Secretaria; realtime una vez.
    const n = await notifs();
    expect(n.map((x) => x.userId).sort()).toEqual([T.userId, sec.userId].sort());
    expect(n[0].title).toBe(`Pago recibido · ${formatARS(5000)}`);
    expect(realtimeFake.calls.filter((x) => x.refs?.some((r) => r.bookingId === c.bookingId))).toHaveLength(1);
  });

  it("[TP-2w] DEPOSIT → turno CONFIRMED, copago UNPAID y onlineDepositCents; el reintegro de la seña lo baja", async () => {
    await setup();
    const c = await makeCharge({ kind: "DEPOSIT", amountCents: 2000 });
    const before = await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } });
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    const b = await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } });
    expect(b).toMatchObject({ status: "CONFIRMED", paymentStatus: "UNPAID", copagoPaymentMethod: null, onlineDepositCents: 2000 });
    expect(b.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await notifs()).map((x) => x.title)).toContain(`Seña recibida · ${formatARS(2000)}`);

    const r = await payFake(c.prefId, "refunded");
    expect(r.webhookResult).toBe("applied");
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).toMatchObject({ status: "REFUNDED", mpStatus: "refunded" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).onlineDepositCents).toBe(0);
    expect((await notifs()).map((x) => x.title)).toContain(`Reintegro registrado · ${formatARS(2000)}`);
  });

  it("[TP-2w] link del resto con el turno ya cobrado a mano → cobro PAID, el turno no se pisa, aviso «Pago duplicado» (también al creador)", async () => {
    await setup();
    const kine2 = await addPractitioner(db, T);
    const c = await makeCharge({
      origin: "LINK",
      bookingPatch: { paymentStatus: "PAID", copagoPaymentMethod: "CASH", copagoCollectedById: T.userId, copagoPaidAt: new Date() },
      createdByUserId: kine2.userId,
    });
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("PAID");
    expect(await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).toMatchObject({
      paymentStatus: "PAID",
      copagoPaymentMethod: "CASH",
      copagoCollectedById: T.userId,
    });
    const n = await notifs();
    expect(n.every((x) => x.title === `Pago duplicado · ${formatARS(5000)}`)).toBe(true);
    expect(n[0].body).toContain("El turno ya estaba cobrado: revisá el reintegro en Mercado Pago.");
    expect(n.map((x) => x.userId)).toContain(kine2.userId);
  });

  it("[TP-2w] reintegro de un FULL → turno REFUNDED con el medio puesto", async () => {
    await setup();
    const c = await makeCharge({ origin: "LINK" });
    await payFake(c.prefId, "approved");
    const r = await payFake(c.prefId, "refunded");
    expect(r.webhookResult).toBe("applied");
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).toMatchObject({ status: "REFUNDED", paidAmountCents: 5000 });
    expect(await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).toMatchObject({
      paymentStatus: "REFUNDED",
      copagoPaymentMethod: "MERCADO_PAGO",
      copagoCollectedById: null,
    });
  });

  it("[TP-2w] turno CANCELLED → el pago se registra, el turno no revive y se avisa reintegrar", async () => {
    await setup();
    const c = await makeCharge({ bookingStatus: "CANCELLED" });
    await payFake(c.prefId, "approved");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("PAID");
    expect(await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).toMatchObject({ status: "CANCELLED", paymentStatus: "UNPAID" });
    const n = await notifs();
    expect(n[0].title).toBe(`Pago de un turno cancelado · ${formatARS(5000)}`);
    expect(n[0].body).toContain("si corresponde, reintegralo desde Mercado Pago.");
  });

  it("[TP-2w] link anulado o vencido que igual se paga → PAID + aviso", async () => {
    await setup();
    const anulado = await makeCharge({ origin: "LINK" });
    await db.onlineCharge.update({
      where: { id: anulado.chargeId },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: T.userId, cancelReason: "manual" },
    });
    await payFake(anulado.prefId, "approved");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: anulado.chargeId } })).status).toBe("PAID");

    const vencido = await makeCharge({ origin: "LINK", kind: "FREE" });
    await db.onlineCharge.update({ where: { id: vencido.chargeId }, data: { status: "EXPIRED" } });
    await payFake(vencido.prefId, "approved");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: vencido.chargeId } })).status).toBe("PAID");

    const titles = (await notifs()).map((x) => x.title);
    expect(titles).toContain(`Pago de un link anulado · ${formatARS(5000)}`);
    expect(titles).toContain(`Pago de un link vencido · ${formatARS(5000)}`);
  });

  // ── Robustez ────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2w] reenvío → replay sin escribir, avisar ni emitir", async () => {
    await setup();
    const c = await makeCharge();
    const p = await payFake(c.prefId, "approved");
    const row1 = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
    const n1 = (await notifs()).length;
    const rt1 = realtimeFake.calls.length;

    const again = await hook(acc.webhookRef, p.paymentId);
    expect(again).toMatchObject({ status: 200, body: { result: "replay" } });
    const row2 = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
    expect(row2.updatedAt).toEqual(row1.updatedAt);
    expect((await notifs()).length).toBe(n1);
    expect(realtimeFake.calls.length).toBe(rt1);
  });

  it("[TP-2w] fuera de orden: un pending tardío del mismo pago no baja el PAID", async () => {
    await setup();
    const c = await makeCharge({ origin: "LINK" });
    const p = await payFake(c.prefId, "approved");
    const rec = fakeMpGetPayment(p.paymentId)!;
    rec.status = "pending";
    rec.statusDetail = "pending_waiting_payment";
    const r = await hook(acc.webhookRef, p.paymentId);
    expect(r.status).toBe(200);
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).toMatchObject({ status: "PAID", mpStatus: "approved" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).paymentStatus).toBe("PAID");
  });

  it("[TP-2w] dos notificaciones concurrentes del mismo pago → un efecto, sin 500 ni deadlock", async () => {
    await setup();
    const c = await makeCharge();
    fake!.uninstall();
    fake = installFakeMp({ reset: false, webhook: async () => new Response("{}", { status: 200 }) });
    const p = await payFake(c.prefId, "approved");
    fake.uninstall();
    fake = installFakeMp({ webhook: POST, reset: false });

    const rs = await Promise.all([hook(acc.webhookRef, p.paymentId), hook(acc.webhookRef, p.paymentId), hook(acc.webhookRef, p.paymentId)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.map((r) => r.body.result).sort()).toEqual(["applied", "replay", "replay"]);
    // Un solo aviso por destinatario (el titular es también el profesional del turno).
    expect((await notifs()).length).toBe(1);
    expect(new Set((await notifs()).map((x) => x.userId)).size).toBe((await notifs()).length);
    expect(realtimeFake.calls.filter((x) => x.refs?.some((r) => r.bookingId === c.bookingId))).toHaveLength(1);
  });

  it("[TP-2w] monto distinto → no PAID + aviso; segundo pago de otro checkout → «Pago duplicado»", async () => {
    await setup();
    const c = await makeCharge({ origin: "LINK" });
    const cheap = await payFake(c.prefId, "approved", { amountCents: 100 });
    expect(cheap).toMatchObject({ webhookStatus: 200, webhookResult: "mismatch" });
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).toMatchObject({ status: "ACTIVE", mpPaymentId: null });
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId! } })).paymentStatus).toBe("UNPAID");
    const n = await notifs();
    expect(n[0].title).toBe(`Pago con monto distinto · ${formatARS(100)}`);
    expect(n[0].body).toContain(`Esperábamos ${formatARS(5000)}. Revisalo en Mercado Pago.`);

    const ok = await payFake(c.prefId, "approved");
    expect(ok.webhookResult).toBe("applied");
    // Un segundo checkout del mismo cobro (otra preferencia con el mismo `oc:`) pagado después.
    const pref2 = await makePreference(c.chargeId, 5000, acc, "LINK", false);
    const dup = await payFake(pref2, "approved");
    expect(dup.webhookResult).toBe("applied");
    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
    expect(row).toMatchObject({ status: "PAID", mpPaymentId: ok.paymentId });
    expect((await notifs()).map((x) => x.title)).toContain(`Pago duplicado · ${formatARS(5000)}`);
    // Y el reintegro del duplicado no reintegra el cobro.
    await payFake(pref2, "refunded");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("PAID");
  });

  it("[TP-2w] al pasar a PAID vence la preferencia (evita un segundo pago)", async () => {
    await setup();
    const c = await makeCharge({ origin: "LINK" });
    await payFake(c.prefId, "approved");
    expect(fakeMpGetPreference(c.prefId)?.expired).toBe(true);
  });

  // ── Tokens y errores ────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2w] token vencido → refresca con CAS y procesa", async () => {
    await setup({ account: { accessExpiresAt: new Date(Date.now() + 60_000) } });
    const c = await makeCharge();
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    const cred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.accountId } });
    expect(cred.version).toBe(2);
    expect(cred.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 86_400_000);
  });

  it("[TP-2w] invalid_grant al refrescar → cuenta REAUTH_REQUIRED + 503 (MP reintenta); nada se marca", async () => {
    await setup({ account: { accessExpiresAt: new Date(Date.now() + 60_000) } });
    const c = await makeCharge();
    fakeMpForceReauth(acc.mpUserId);
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookStatus).toBe(503);
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId } })).status).toBe("REAUTH_REQUIRED");
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("ACTIVE");
  });

  it("[TP-2w] MP caído → 503 sin tocar nada", async () => {
    await setup();
    const c = await makeCharge();
    tamperPaymentGet("down");
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookStatus).toBe(503);
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } })).status).toBe("ACTIVE");
    expect((await notifs()).length).toBe(0);
  });

  it("[TP-2w] rawPayload sin payer, tarjeta ni identificación; intentos ≤20", async () => {
    await setup();
    const c = await makeCharge({ origin: "LINK" });
    const old = Array.from({ length: 20 }, (_, i) => ({ id: `9${i}`, status: "rejected", refundedCents: 0, receivedAt: new Date().toISOString(), applied: false }));
    await db.onlineCharge.update({ where: { id: c.chargeId }, data: { rawPayload: { attempts: old } } });
    await payFake(c.prefId, "approved");
    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: c.chargeId } });
    const raw = JSON.stringify(row.rawPayload);
    expect(raw).not.toMatch(/"payer"|comprador@|"card"|last_four|identification|"metadata"/);
    const attempts = (row.rawPayload as { attempts: unknown[] }).attempts;
    expect(attempts).toHaveLength(20);
    expect(attempts[19]).toMatchObject({ status: "approved", applied: true });
    expect(raw).not.toContain(acc.accessToken);
  });
});

// ── Rama legada: el único cambio (aviso a la Secretaria) ──────────────────────────────────────────────────────────

describe.skipIf(!RUN)("[TP-2w] rama legada (sin ?acct=) avisa también a la Secretaria", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[TP-2w] approved legado → aviso al titular, al profesional y a la Secretaria (agenda.operateAll)", async () => {
    const sec = await addStaff(db, T, "ASSISTANT");
    const patientId = await addPatient(db, T);
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: new Date(Date.now() + 5 * 86_400_000),
        durationMin: 45,
        status: "PENDING",
        idempotencyKey: `test-${randomUUID()}`,
      },
    });
    await db.payment.create({ data: { bookingId: b.id, provider: "mercadopago", status: "UNPAID", expectedAmountCents: 5000, amountCents: 0 } });
    const payId = `LEG-${randomUUID().slice(0, 8)}`;
    legacyPayments.set(payId, { id: payId, status: "approved", transaction_amount: 50, currency_id: "ARS", external_reference: b.id });

    const requestId = randomUUID();
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = crypto.createHmac("sha256", LEGACY_SECRET).update(`id:${payId};request-id:${requestId};ts:${ts};`).digest("hex");
    const res = await POST(
      new Request(`http://localhost/api/webhooks/mercadopago?data.id=${payId}&type=payment`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
        body: JSON.stringify({ type: "payment", data: { id: payId } }),
      })
    );
    expect(res.status).toBe(200);
    const users = (await db.notification.findMany({ where: { tenantId: T.tenantId, kind: "PAYMENT_RECEIVED" }, select: { userId: true } })).map(
      (n) => n.userId
    );
    expect(users).toContain(sec.userId);
    expect(users).toContain(T.userId);
  });
});
