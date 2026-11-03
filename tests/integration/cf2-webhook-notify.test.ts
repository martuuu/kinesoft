/**
 * [CF2-S2X] CF2 (§29, D-CF2-11; brief T.C «Orden»): avisos del webhook de Mercado Pago, rama `?acct=` (cobros con la
 * cuenta del vendedor), por la RUTA REAL: `POST` de `app/api/webhooks/mercadopago/route.ts` → `handleConnectWebhook` →
 * `consumeConnectWebhook` → GET del pago contra el MP FALSO → Postgres (guard y trigger de M18 reales) →
 * `notifyTenantOwners` + `afterBookingsCommitted` + `notifyPractitionerOfOnlineBooking`.
 *
 * Se mockea solo lo externo: la red de MP (`installFakeMp`), `web-push` (el POST cifrado al push service), el despacho
 * del mail (`__setEmailTransportForTests`: validación, sink de EmailLog y log siguen siendo los reales), el rate limit
 * in-memory y el publisher realtime (lo pisa integration-setup). Corre igual en `test:integration` y en `:owner`: el
 * webhook escribe por el canal service.
 *
 *   [CF2-S2X-1] La fila PAYMENT_RECEIVED de la campana ya existe cuando sale el evento realtime del turno. Bug de antes:
 *               el cliente refrescaba la campana por el evento y la fila llegaba después (mismo bug que el submit).
 *   [CF2-S2X-2] REQUIRED (FULL del turnero, PENDING) confirmado por el pago → 1 mail `booking_created_pro` y 1 push al
 *               profesional del turno, ya escritos cuando el webhook responde.
 *   [CF2-S2X-3] Reenvío del mismo evento (replay) → ni mail ni push nuevos.
 *   [CF2-S2X-4] Un pago que NO confirma el turno (link sobre un turno ya CONFIRMED) → ni mail ni push (el turno ya se
 *               avisó cuando se reservó, o lo cargó el staff: D-CF2-20).
 *   [CF2-S2X-5] Seña del turnero (DEPOSIT) que confirma un REQUIRED → también avisa (el efecto `confirm` es el criterio).
 *
 *   [CF2-ZF3-3] (fixer ZF3, ZA-3) La preferencia ya está vencida en MP cuando sale el aviso al profesional: el aviso
 *               espera hasta 3 s y, con el orden de antes, ese era el tiempo en que el mismo link podía cobrarse dos veces.
 *
 * `mp-webhook.test.ts` (rama legada, AUDIT §5.4) no se toca y el camino legado sigue igual: esta sesión solo cambia
 * `lib/mp-connect/consume.ts`.
 */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));
const net = vi.hoisted(() => ({ calls: [] as { endpoint: string; body: string }[] }));
vi.mock("web-push", () => {
  const sendNotification = (sub: { endpoint: string }, body: string) => {
    net.calls.push({ endpoint: sub.endpoint, body });
    return Promise.resolve({ statusCode: 201, body: "", headers: {} });
  };
  return { default: { sendNotification }, sendNotification };
});

import type { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { prismaService } from "@/lib/db";
import { mpFetch } from "@/lib/mp-connect/http";
import { buildChargePreference, connectNotificationUrl } from "@/lib/mp-connect/preference";
import { signMpNotification } from "@/lib/mp-connect/signature";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import {
  connectFakeAccount,
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
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const HOOK_URL = `${FAKE_APP_URL}/api/webhooks/mercadopago`;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()), subject: "mailto:avisos@consultorio.online" };
const P256DH = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]));
const AUTH = b64url(Buffer.alloc(16, 3));

describe.skipIf(!RUN)("[CF2-S2X] avisos del webhook de MP (campana antes del realtime; mail/push al confirmar)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Profesional del turno, con la cuenta de MP y los avisos prendidos. */
  let kine: { userId: string; practitionerId: string };
  let acc: FakeAccount;
  let fake: InstalledFakeMp | null = null;
  let slot = 0;
  const sent: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    resetFakeMp();
    sent.length = 0;
    net.calls.length = 0;
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      sent.push(i);
      return { ok: true, transport: "resend", providerId: `re_${sent.length}` };
    });
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", VAPID.publicKey);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", VAPID.privateKey);
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", VAPID.subject);
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    await db.practitioner.update({ where: { id: kine.practitionerId }, data: { notifyBookingEmail: true, notifyBookingPush: true } });
    acc = await connectFakeAccount(db, T, { practitionerId: kine.practitionerId });
    fake = installFakeMp({ webhook: POST, reset: false });
  });
  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    __setEmailTransportForTests(null);
    vi.unstubAllEnvs();
    await prismaService.pushSubscription.deleteMany({ where: { userId: kine?.userId } });
    await T?.cleanup();
  });

  async function addDevice(userId: string) {
    return prismaService.pushSubscription.create({
      data: { userId, endpoint: `https://fcm.googleapis.com/fcm/send/cf2s2x-${uniqueSuffix()}`, p256dh: P256DH, auth: AUTH },
      select: { id: true, endpoint: true },
    });
  }

  /** Turno del profesional + cobro ACTIVE + preferencia en el fake (lo que dejan el turnero o el link). */
  async function makeCharge(o: { origin?: "TURNERO" | "LINK"; kind?: "FULL" | "DEPOSIT"; amountCents?: number } = {}) {
    const origin = o.origin ?? "TURNERO";
    const kind = o.kind ?? "FULL";
    const amountCents = o.amountCents ?? 5000;
    const link = origin === "LINK";
    const patientId = await addPatient(db, T, { firstName: "Rigoberta", lastName: "Zapiola" });
    slot += 1;
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: kine.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: new Date(Date.now() + (2 + slot) * 86_400_000),
        durationMin: 45,
        status: link ? "CONFIRMED" : "PENDING",
        // La key del turnero (`pub:`): el notificador solo avisa turnos online (D-CF2-20). El del link también la lleva
        // para que el caso [CF2-S2X-4] pruebe el criterio del efecto `confirm` y no el de la key.
        idempotencyKey: `pub:${T.tenantId}:${randomUUID()}`,
      },
    });
    const charge = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin,
        kind,
        mpAccountId: acc.accountId,
        practitionerId: kine.practitionerId,
        patientId,
        bookingId: b.id,
        amountCents,
        copagoBasisCents: kind === "FULL" ? amountCents : null,
        concept: link ? "Sesión de kinesiología" : null,
        publicToken: link ? randomBytes(16).toString("base64url") : null,
        createdByUserId: link ? T.userId : null,
        expiresAt: new Date(Date.now() + 86_400_000),
        idempotencyKey: link ? `link:${randomUUID()}` : `turnero:${b.id}`,
      },
    });
    const body = buildChargePreference({
      charge: { id: charge.id, amountCents, scheduledFor: new Date() },
      tenantName: "Consultorio de prueba",
      mode: link ? "LINK" : "REQUIRED",
      notificationUrl: connectNotificationUrl(FAKE_APP_URL, acc.webhookRef),
      backUrls: { success: `${FAKE_APP_URL}/ok`, failure: `${FAKE_APP_URL}/ko`, pending: `${FAKE_APP_URL}/pend` },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const r = await mpFetch("/checkout/preferences", { token: acc.accessToken, method: "POST", body });
    if (!r.ok) throw new Error("no se creó la preferencia en el fake");
    const pref = r.json as { id: string; init_point: string };
    await db.onlineCharge.update({ where: { id: charge.id }, data: { preferenceId: pref.id, checkoutUrl: pref.init_point } });
    return { chargeId: charge.id, bookingId: b.id, prefId: pref.id };
  }

  /** POST firmado a la ruta real con `?acct=` (reenvío del mismo evento). */
  async function hook(paymentId: string) {
    const requestId = randomUUID();
    const ts = Math.floor(Date.now() / 1000);
    const res = await POST(
      new Request(`${HOOK_URL}?acct=${encodeURIComponent(acc.webhookRef)}&data.id=${paymentId}&type=payment`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-signature": signMpNotification({ dataId: paymentId, secret: FAKE_HOOK_SECRET, ts, requestId }),
        },
        body: JSON.stringify({ type: "payment", data: { id: paymentId } }),
      })
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; result: string } };
  }

  const bell = () => db.notification.count({ where: { tenantId: T.tenantId, kind: "PAYMENT_RECEIVED" } });
  const proMails = (bookingId: string) =>
    db.emailLog.count({ where: { tenantId: T.tenantId, kind: "booking_created_pro", entity: "Booking", entityId: bookingId } });

  it("[CF2-S2X-1] la fila PAYMENT_RECEIVED de la campana ya existe cuando se publica el evento realtime del turno", async () => {
    const c = await makeCharge();
    let atPublish = -1;
    realtimeFake.onCall = async (call) => {
      if (atPublish === -1 && call.refs?.some((x) => x.bookingId === c.bookingId)) atPublish = await bell();
    };
    const p = await payFake(c.prefId, "approved");
    expect(p).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    const after = await bell();
    expect(after).toBeGreaterThan(0);
    expect(atPublish).toBe(after);
  });

  it("[CF2-S2X-2] REQUIRED confirmado por el pago → 1 mail booking_created_pro y 1 push al profesional, antes de responder", async () => {
    const d = await addDevice(kine.userId);
    const c = await makeCharge();
    const p = await payFake(c.prefId, "approved");
    expect(p).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).status).toBe("CONFIRMED");

    // `payFake` vuelve con la respuesta del webhook: si el aviso no se esperara, acá todavía no estaría.
    expect(await proMails(c.bookingId)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "booking_created_pro", entity: "Booking", entityId: c.bookingId, to: `${kine.userId}@test.local` });
    expect(sent[0].text).not.toContain("Zapiola");
    expect(net.calls.map((x) => x.endpoint)).toEqual([d.endpoint]);
    expect(net.calls[0].body).not.toContain("Rigoberta");
  });

  it("[CF2-S2X-3] reenvío del mismo evento (replay) → ni mail ni push nuevos", async () => {
    await addDevice(kine.userId);
    const c = await makeCharge();
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    expect(await proMails(c.bookingId)).toBe(1);
    expect(net.calls).toHaveLength(1);

    const again = await hook(p.paymentId);
    expect(again).toMatchObject({ status: 200, body: { result: "replay" } });
    expect(await proMails(c.bookingId)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
  });

  it("[CF2-S2X-4] pago que no confirma el turno (link sobre un turno ya CONFIRMED) → ni mail ni push", async () => {
    await addDevice(kine.userId);
    const c = await makeCharge({ origin: "LINK" });
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).paymentStatus).toBe("PAID");
    expect(await proMails(c.bookingId)).toBe(0);
    expect(sent).toEqual([]);
    expect(net.calls).toEqual([]);
    // La campana del pago sí (es otra cosa: aviso de plata, no de turno nuevo).
    expect(await bell()).toBeGreaterThan(0);
  });

  it("[CF2-ZF3-3] la preferencia se vence ANTES del aviso al profesional (mail/push)", async () => {
    const c = await makeCharge();
    const expireCalls = () => (fake?.calls ?? []).filter((u) => u.includes(`/checkout/preferences/${encodeURIComponent(c.prefId)}`)).length;
    const atNotify: number[] = [];
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      if (i.kind === "booking_created_pro") atNotify.push(expireCalls());
      sent.push(i);
      return { ok: true, transport: "resend", providerId: `re_${sent.length}` };
    });
    const before = expireCalls();
    const p = await payFake(c.prefId, "approved");
    expect(p).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    const after = expireCalls();
    expect(after).toBeGreaterThan(before);
    // El mail del profesional salió UNA vez y, cuando salió, el PUT de vencimiento ya se había hecho.
    expect(atNotify).toEqual([after]);
  });

  it("[CF2-S2X-5] seña del turnero (DEPOSIT) que confirma el REQUIRED → 1 mail y 1 push", async () => {
    await addDevice(kine.userId);
    const c = await makeCharge({ kind: "DEPOSIT", amountCents: 2000 });
    const p = await payFake(c.prefId, "approved");
    expect(p.webhookResult).toBe("applied");
    expect((await db.booking.findUniqueOrThrow({ where: { id: c.bookingId } })).status).toBe("CONFIRMED");
    expect(await proMails(c.bookingId)).toBe(1);
    expect(net.calls).toHaveLength(1);
  });
});
