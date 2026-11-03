/**
 * [CF2-TP8..TP12] `sendPushToUser` (lib/web-push-internal.ts, CF2 §29, D-CF2-12) contra la base real.
 * Se mockea SOLO `web-push` (es la red: el POST cifrado al push service); el sender, `prismaService` y la tabla
 * `PushSubscription` (M21, SERVICE_ONLY) son los reales. Corre igual en `test:integration` y en `:owner`: el sender
 * escribe por el canal service en los dos.
 *   [CF2-TP8]  Con VAPID y sin dispositivos: 0/0/0 y `web-push` ni se carga.
 *   [CF2-TP9]  Éxito: TTL 3600, urgencia high, timeout, VAPID y payload recortado; `lastSuccessAt` y `failureCount=0`;
 *              los dispositivos de otro usuario ni se miran.
 *   [CF2-TP10] 404/410 borran; otro error suma `failureCount`; la 5.ª falla seguida borra.
 *   [CF2-TP11] Push service colgado: corta en el timeout, cuenta como falla y no tira.
 *   [CF2-TP12] Sin VAPID: 0/0/0 y las filas quedan como estaban.
 */
import { createECDH } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { sendPushToUser } from "@/lib/web-push-internal";
import {
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

type Behaviour = { kind: "ok" } | { kind: "status"; code: number } | { kind: "hang" };
const net = vi.hoisted(() => ({
  loads: 0,
  calls: [] as { endpoint: string; body: string; options: Record<string, unknown> }[],
  byEndpoint: new Map<string, Behaviour>(),
}));
vi.mock("web-push", () => {
  net.loads += 1;
  const sendNotification = (sub: { endpoint: string }, body: string, options: Record<string, unknown>) => {
    net.calls.push({ endpoint: sub.endpoint, body, options });
    const b = net.byEndpoint.get(sub.endpoint) ?? { kind: "ok" };
    if (b.kind === "hang") return new Promise(() => {});
    if (b.kind === "status") {
      // Forma de WebPushError: `statusCode` es lo único que mira el sender.
      return Promise.reject(Object.assign(new Error(`Received unexpected response code`), { statusCode: b.code }));
    }
    return Promise.resolve({ statusCode: 201, body: "", headers: {} });
  };
  return { default: { sendNotification }, sendNotification };
});

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()), subject: "mailto:avisos@consultorio.online" };
function stubVapid(on: boolean) {
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", on ? VAPID.publicKey : undefined);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", on ? VAPID.privateKey : undefined);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", on ? VAPID.subject : undefined);
}

const P256DH = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]));
const AUTH = b64url(Buffer.alloc(16, 3));
const PAYLOAD = { title: "Nuevo turno online", body: "lun 3/11 10:30 · Ana P.", url: "/agenda?date=2026-11-03&view=timeline", tag: "booking-1" };

async function addDevice(userId: string, over: { behaviour?: Behaviour; failureCount?: number } = {}) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/cf2tp-${uniqueSuffix()}`;
  const row = await prismaService.pushSubscription.create({
    data: { userId, endpoint, p256dh: P256DH, auth: AUTH, label: "Chrome en Android", failureCount: over.failureCount ?? 0 },
    select: { id: true, endpoint: true },
  });
  if (over.behaviour) net.byEndpoint.set(endpoint, over.behaviour);
  return row;
}
const rowOf = (id: string) =>
  prismaService.pushSubscription.findUnique({ where: { id }, select: { failureCount: true, lastSuccessAt: true } });

describe.skipIf(!RUN)("[CF2-TP] sendPushToUser contra la base real", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [A?.userId, B?.userId].filter(Boolean) } } });
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    net.calls.length = 0;
    net.byEndpoint.clear();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [A.userId, B.userId] } } });
  });

  // Primero a propósito: después de cualquier envío el módulo ya quedó en el cache de imports.
  it("[CF2-TP8] con VAPID y sin dispositivos: 0/0/0 y web-push ni se carga", async () => {
    stubVapid(true);
    await expect(sendPushToUser(A.userId, PAYLOAD)).resolves.toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(net.loads).toBe(0);
  });

  it("[CF2-TP9] éxito: opciones del envío, payload y lastSuccessAt/failureCount; otro usuario intacto", async () => {
    stubVapid(true);
    const d1 = await addDevice(A.userId, { failureCount: 3 });
    const d2 = await addDevice(A.userId);
    const other = await addDevice(B.userId, { failureCount: 2 });
    const before = Date.now();

    await expect(sendPushToUser(A.userId, { ...PAYLOAD, body: "x".repeat(1000) })).resolves.toEqual({ sent: 2, removed: 0, failed: 0 });

    expect(net.calls.map((c) => c.endpoint).sort()).toEqual([d1.endpoint, d2.endpoint].sort());
    for (const c of net.calls) {
      expect(c.options).toEqual({
        vapidDetails: { subject: VAPID.subject, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
        TTL: 3600,
        urgency: "high",
        timeout: 2500,
      });
      const body = JSON.parse(c.body);
      expect(body).toMatchObject({ title: PAYLOAD.title, url: PAYLOAD.url, tag: PAYLOAD.tag });
      expect(body.body.length).toBeLessThanOrEqual(240);
    }
    for (const d of [d1, d2]) {
      const r = await rowOf(d.id);
      expect(r?.failureCount).toBe(0);
      expect(r?.lastSuccessAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(await rowOf(other.id)).toEqual({ failureCount: 2, lastSuccessAt: null });
  });

  it("[CF2-TP10] 404/410 borran; 500 suma una falla; la 5.ª falla seguida borra", async () => {
    stubVapid(true);
    const gone404 = await addDevice(A.userId, { behaviour: { kind: "status", code: 404 } });
    const gone410 = await addDevice(A.userId, { behaviour: { kind: "status", code: 410 }, failureCount: 1 });
    const flaky = await addDevice(A.userId, { behaviour: { kind: "status", code: 500 }, failureCount: 1 });
    const fifth = await addDevice(A.userId, { behaviour: { kind: "status", code: 429 }, failureCount: 4 });
    const ok = await addDevice(A.userId);

    const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const res = await sendPushToUser(A.userId, PAYLOAD);
    log.mockRestore();
    // removed = 404 + 410 + la 5.ª falla; failed = 500 + la 5.ª falla (las dos se cuentan).
    expect(res).toEqual({ sent: 1, removed: 3, failed: 2 });

    expect(await rowOf(gone404.id)).toBeNull();
    expect(await rowOf(gone410.id)).toBeNull();
    expect(await rowOf(fifth.id)).toBeNull();
    expect(await rowOf(flaky.id)).toEqual({ failureCount: 2, lastSuccessAt: null });
    expect((await rowOf(ok.id))?.lastSuccessAt).not.toBeNull();
    // Un éxito después reinicia la cuenta (las fallas tienen que ser SEGUIDAS).
    net.byEndpoint.delete(flaky.endpoint);
    await expect(sendPushToUser(A.userId, PAYLOAD)).resolves.toEqual({ sent: 2, removed: 0, failed: 0 });
    expect((await rowOf(flaky.id))?.failureCount).toBe(0);
  });

  it("[CF2-TP11] push service colgado: corta en el timeout, cuenta la falla y no tira", async () => {
    stubVapid(true);
    const hung = await addDevice(A.userId, { behaviour: { kind: "hang" } });
    const ok = await addDevice(A.userId);
    const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const t0 = Date.now();
    const res = await sendPushToUser(A.userId, PAYLOAD, { timeoutMs: 80 });
    log.mockRestore();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res).toEqual({ sent: 1, removed: 0, failed: 1 });
    expect((await rowOf(hung.id))?.failureCount).toBe(1);
    expect(net.calls.find((c) => c.endpoint === hung.endpoint)?.options.timeout).toBe(80);
    expect((await rowOf(ok.id))?.lastSuccessAt).not.toBeNull();
  });

  it("[CF2-TP12] sin VAPID: 0/0/0, ningún envío y las filas como estaban", async () => {
    stubVapid(false);
    const d = await addDevice(A.userId, { failureCount: 2 });
    await expect(sendPushToUser(A.userId, PAYLOAD)).resolves.toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(net.calls).toHaveLength(0);
    expect(await rowOf(d.id)).toEqual({ failureCount: 2, lastSuccessAt: null });
  });
});
