/**
 * [CF2-TS4-1..8] Dispositivos de push del profesional (lib/web-push-actions.ts, CF2 §29, D-CF2-12) contra la base real.
 *
 * Se mockea SOLO lo externo: `next/headers` (un jar que además registra las opciones del `set`, para afirmar
 * httpOnly/lax/path, y el user-agent del request), `web-push` (la red: el POST cifrado al push service), el ENV de
 * Upstash (rate limit en memoria, reseteable) y el step-up de 2FA para abrir la sesión de soporte (se prueba en
 * two-factor.test.ts). `getActor`, las actions, `sendPushToUser`, `prismaService` y la tabla `PushSubscription` (M21,
 * SERVICE_ONLY) son los reales. Corre igual en `test:integration` y en `:owner`: todo escribe por el canal service.
 *
 *   [CF2-TS4-1] Alta: fila con label del UA, cookie `ks_push_sub` httpOnly/lax/path=/ con el id; re-guardar el mismo
 *               endpoint actualiza la misma fila (claves nuevas, sin duplicar).
 *   [CF2-TS4-2] Upsert reasigna: el endpoint que tenía otro usuario en ese navegador pasa al actual y arranca limpio.
 *   [CF2-TS4-3] Rechaza endpoint no-https, de host no permitido o con claves inválidas; un `userId` en el input se ignora.
 *   [CF2-TS4-4] Tope 10 por usuario: el 11.º borra el visto hace más tiempo; los de otro usuario no se tocan.
 *   [CF2-TS4-5] Borrar: solo las propias (la ajena queda); borrar el de este navegador limpia la cookie.
 *   [CF2-TS4-6] Listar: solo las propias, `current` = la de la cookie, fechas ISO, sin endpoint ni claves.
 *   [CF2-TS4-7] Prueba: sin VAPID no sale nada; con VAPID payload genérico sin PHI a los dispositivos propios; 3 cada
 *               5 min por usuario (el 4.º no llega a la red).
 *   [CF2-TS4-9] Quitar por id: el propio sí (y si es el de la cookie, la limpia); el ajeno no, con la misma respuesta
 *               que uno inexistente.
 *   [CF2-TS4-8] Gates: Secretaria (sin profesional), sesión de soporte y sin sesión → rechazo en las 5 actions, sin
 *               filas ni red.
 */
import { createECDH } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const hdr = vi.hoisted(() => ({
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  jar: new Map<string, { value: string; opts?: Record<string, unknown> }>(),
}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (n: string) => (hdr.jar.has(n) ? { name: n, value: hdr.jar.get(n)!.value } : undefined),
    getAll: () => [...hdr.jar.entries()].map(([name, e]) => ({ name, value: e.value })),
    set: (n: string, v: string, opts?: Record<string, unknown>) => void hdr.jar.set(n, { value: v, opts }),
    delete: (n: string) => void hdr.jar.delete(n),
    has: (n: string) => hdr.jar.has(n),
  }),
  headers: () => new Headers({ "x-request-id": "integration-test", "user-agent": hdr.ua }),
}));

const net = vi.hoisted(() => ({ calls: [] as { endpoint: string; body: string }[] }));
vi.mock("web-push", () => {
  const sendNotification = (sub: { endpoint: string }, body: string) => {
    net.calls.push({ endpoint: sub.endpoint, body });
    return Promise.resolve({ statusCode: 201, body: "", headers: {} });
  };
  return { default: { sendNotification }, sendNotification };
});

// Upstash apagado: el rate limit es el de memoria y `__rateLimitInternals.reset()` lo vacía entre tests.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) =>
      k === "UPSTASH_REDIS_REST_URL" || k === "UPSTASH_REDIS_REST_TOKEN" ? undefined : (t as Record<string, unknown>)[k],
  });
  return { ...actual, env };
});

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

import { prismaService } from "@/lib/db";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import {
  deleteMyPushDevice,
  deletePushSubscription,
  listMyPushDevices,
  savePushSubscription,
  sendTestPush,
} from "@/lib/web-push-actions";
import { PUSH_SUB_COOKIE, pushDeviceLabel } from "@/lib/web-push-types";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

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
const P256DH_2 = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]));
const AUTH = b64url(Buffer.alloc(16, 3));
const AUTH_2 = b64url(Buffer.alloc(16, 5));
const endpointOf = (tag = "") => `https://fcm.googleapis.com/fcm/send/cf2ts4-${tag}${uniqueSuffix()}`;
const sub = (endpoint: string, keys = { p256dh: P256DH, auth: AUTH }) => ({ endpoint, keys });
const cookieValue = () => hdr.jar.get(PUSH_SUB_COOKIE)?.value;

describe.skipIf(!RUN)("[CF2-TS4] dispositivos de push del profesional", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let S: EphemeralTenant;
  let P2: { userId: string };
  let SEC: { userId: string };
  let users: string[] = [];

  const rowsOf = (userId: string) =>
    prismaService.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    S = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    P2 = await addPractitioner(db, A);
    SEC = await addStaff(db, A, "ASSISTANT");
    users = [A.userId, S.userId, P2.userId, SEC.userId];
  });
  afterAll(async () => {
    await prismaService.pushSubscription.deleteMany({ where: { endpoint: { contains: "/cf2ts4-" } } });
    if (users.length) await prismaService.pushSubscription.deleteMany({ where: { userId: { in: users } } });
    await A?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    hdr.jar.clear();
    net.calls.length = 0;
    __rateLimitInternals.reset();
    asUser(A.userId);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: users } } });
  });

  it("[CF2-TS4-1] alta: fila con label del UA, cookie httpOnly con el id; re-guardar actualiza la misma fila", async () => {
    const endpoint = endpointOf();
    const r = await savePushSubscription(sub(endpoint));
    if (!r.ok) throw new Error(r.error);

    const rows = await rowsOf(A.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.data.deviceId, endpoint, p256dh: P256DH, auth: AUTH, label: "Chrome en Android" });
    expect(rows[0].label).toBe(pushDeviceLabel(hdr.ua));

    const c = hdr.jar.get(PUSH_SUB_COOKIE);
    expect(c?.value).toBe(r.data.deviceId);
    expect(c?.opts).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });

    // El navegador rota las claves (o la página re-sincroniza): misma fila, sin duplicar.
    const again = await savePushSubscription(sub(endpoint, { p256dh: P256DH_2, auth: AUTH_2 }));
    if (!again.ok) throw new Error(again.error);
    expect(again.data.deviceId).toBe(r.data.deviceId);
    const after = await rowsOf(A.userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ p256dh: P256DH_2, auth: AUTH_2 });
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(rows[0].lastSeenAt.getTime());
  });

  it("[CF2-TS4-2] upsert reasigna: el endpoint de otro usuario en este navegador pasa al actual y arranca limpio", async () => {
    const endpoint = endpointOf("shared-");
    const first = await savePushSubscription(sub(endpoint));
    if (!first.ok) throw new Error(first.error);
    await prismaService.pushSubscription.update({
      where: { id: first.data.deviceId },
      data: { failureCount: 3, lastSuccessAt: new Date() },
    });

    // Otro profesional entra en el MISMO navegador (mismo endpoint): los avisos de A no le pueden llegar a P2.
    asUser(P2.userId);
    const second = await savePushSubscription(sub(endpoint, { p256dh: P256DH_2, auth: AUTH_2 }));
    if (!second.ok) throw new Error(second.error);

    expect(await rowsOf(A.userId)).toHaveLength(0);
    const rows = await rowsOf(P2.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint, p256dh: P256DH_2, auth: AUTH_2, failureCount: 0, lastSuccessAt: null });
    expect(cookieValue()).toBe(second.data.deviceId);
  });

  it("[CF2-TS4-3] rechaza endpoint no-https, host no permitido o claves inválidas; el userId del input se ignora", async () => {
    const bad = [
      sub("http://fcm.googleapis.com/fcm/send/x"),
      sub("https://evil.example.com/push/x"),
      sub("https://10.0.0.5/push/x"),
      sub("https://fcm.googleapis.com:8443/fcm/send/x"),
      sub("https://user:pw@fcm.googleapis.com/fcm/send/x"),
      sub(`https://fcm.googleapis.com/fcm/send/${"x".repeat(1100)}`),
      sub(endpointOf(), { p256dh: "corta", auth: AUTH }),
      sub(endpointOf(), { p256dh: P256DH, auth: "x" }),
      { endpoint: 42, keys: {} },
      null,
    ];
    for (const input of bad) {
      const r = await savePushSubscription(input as never);
      expect(r.ok, JSON.stringify(input)?.slice(0, 80)).toBe(false);
    }
    expect(await rowsOf(A.userId)).toHaveLength(0);
    expect(cookieValue()).toBeUndefined();

    // Un `userId` colado en el objeto no está en el tipo y no se lee: la fila es del usuario de la sesión.
    const endpoint = endpointOf();
    const r = await savePushSubscription({ ...sub(endpoint), userId: P2.userId } as never);
    expect(r.ok).toBe(true);
    expect(await rowsOf(P2.userId)).toHaveLength(0);
    expect((await rowsOf(A.userId)).map((x) => x.endpoint)).toEqual([endpoint]);
  });

  it("[CF2-TS4-4] tope 10 por usuario: el 11.º borra el visto hace más tiempo; otro usuario intacto", async () => {
    const base = Date.now() - 60 * 60_000;
    const seeded: string[] = [];
    for (let i = 0; i < 10; i++) {
      const row = await prismaService.pushSubscription.create({
        data: { userId: A.userId, endpoint: endpointOf(`old${i}-`), p256dh: P256DH, auth: AUTH, lastSeenAt: new Date(base + i * 60_000) },
        select: { id: true },
      });
      seeded.push(row.id);
    }
    const otherRow = await prismaService.pushSubscription.create({
      data: { userId: P2.userId, endpoint: endpointOf("p2-"), p256dh: P256DH, auth: AUTH, lastSeenAt: new Date(base - 60_000) },
      select: { id: true },
    });

    const r = await savePushSubscription(sub(endpointOf("new-")));
    if (!r.ok) throw new Error(r.error);

    const ids = (await rowsOf(A.userId)).map((x) => x.id).sort();
    expect(ids).toHaveLength(10);
    expect(ids).toEqual([...seeded.slice(1), r.data.deviceId].sort());
    expect(await prismaService.pushSubscription.count({ where: { id: otherRow.id } })).toBe(1);
  });

  it("[CF2-TS4-5] borrar: solo las propias; la de este navegador limpia la cookie", async () => {
    const mine = endpointOf("mine-");
    const saved = await savePushSubscription(sub(mine));
    if (!saved.ok) throw new Error(saved.error);
    const theirs = endpointOf("theirs-");
    await prismaService.pushSubscription.create({ data: { userId: P2.userId, endpoint: theirs, p256dh: P256DH, auth: AUTH } });

    // La ajena: misma respuesta que una inexistente (no confirma que el endpoint existe) y la fila queda.
    expect(await deletePushSubscription(theirs)).toEqual({ ok: true, data: { removed: false } });
    expect(await prismaService.pushSubscription.count({ where: { endpoint: theirs, userId: P2.userId } })).toBe(1);
    expect(cookieValue()).toBe(saved.data.deviceId);

    expect(await deletePushSubscription(mine)).toEqual({ ok: true, data: { removed: true } });
    expect(await rowsOf(A.userId)).toHaveLength(0);
    expect(cookieValue()).toBeUndefined();

    expect((await deletePushSubscription("x".repeat(2000))).ok).toBe(false);
    expect((await deletePushSubscription(42 as never)).ok).toBe(false);
  });

  it("[CF2-TS4-9] quitar por id: el propio sí (limpia la cookie si es este navegador); el ajeno no", async () => {
    const saved = await savePushSubscription(sub(endpointOf("here-")));
    if (!saved.ok) throw new Error(saved.error);
    const otherMine = await prismaService.pushSubscription.create({
      data: { userId: A.userId, endpoint: endpointOf("pc-"), p256dh: P256DH, auth: AUTH },
      select: { id: true },
    });
    const theirs = await prismaService.pushSubscription.create({
      data: { userId: P2.userId, endpoint: endpointOf("theirs-"), p256dh: P256DH, auth: AUTH },
      select: { id: true },
    });

    // Ajeno: misma respuesta que un id inexistente y la fila queda.
    expect(await deleteMyPushDevice(theirs.id)).toEqual({ ok: true, data: { removed: false } });
    expect(await deleteMyPushDevice("no-existe")).toEqual({ ok: true, data: { removed: false } });
    expect(await prismaService.pushSubscription.count({ where: { id: theirs.id } })).toBe(1);

    // Otro dispositivo propio: se borra y la cookie de este navegador sigue.
    expect(await deleteMyPushDevice(otherMine.id)).toEqual({ ok: true, data: { removed: true } });
    expect(await prismaService.pushSubscription.count({ where: { id: otherMine.id } })).toBe(0);
    expect(cookieValue()).toBe(saved.data.deviceId);

    // El de este navegador: se borra y limpia la cookie.
    expect(await deleteMyPushDevice(saved.data.deviceId)).toEqual({ ok: true, data: { removed: true } });
    expect(await rowsOf(A.userId)).toHaveLength(0);
    expect(cookieValue()).toBeUndefined();

    expect((await deleteMyPushDevice("x".repeat(200))).ok).toBe(false);
    expect((await deleteMyPushDevice(42 as never)).ok).toBe(false);
  });

  it("[CF2-TS4-6] listar: solo las propias, current = la de la cookie, sin endpoint ni claves", async () => {
    const other = await prismaService.pushSubscription.create({
      data: { userId: A.userId, endpoint: endpointOf("pc-"), p256dh: P256DH, auth: AUTH, label: "Firefox en Windows", lastSuccessAt: new Date() },
      select: { id: true },
    });
    await prismaService.pushSubscription.create({ data: { userId: P2.userId, endpoint: endpointOf("p2-"), p256dh: P256DH, auth: AUTH } });
    const saved = await savePushSubscription(sub(endpointOf("phone-")));
    if (!saved.ok) throw new Error(saved.error);

    const r = await listMyPushDevices();
    if (!r.ok) throw new Error(r.error);
    expect(r.data.map((d) => d.id).sort()).toEqual([other.id, saved.data.deviceId].sort());
    const current = r.data.find((d) => d.current);
    expect(current?.id).toBe(saved.data.deviceId);
    expect(r.data.filter((d) => d.current)).toHaveLength(1);
    for (const d of r.data) {
      expect(Object.keys(d).sort()).toEqual(["createdAt", "current", "id", "label", "lastSuccessAt"]);
      expect(new Date(d.createdAt).toISOString()).toBe(d.createdAt);
    }
    expect(r.data.find((d) => d.id === other.id)?.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("[CF2-TS4-7] prueba: sin VAPID no sale; con VAPID payload genérico a los propios; 3 cada 5 min", async () => {
    const mine = endpointOf("mine-");
    const saved = await savePushSubscription(sub(mine));
    if (!saved.ok) throw new Error(saved.error);
    await prismaService.pushSubscription.create({ data: { userId: P2.userId, endpoint: endpointOf("p2-"), p256dh: P256DH, auth: AUTH } });

    stubVapid(false);
    expect((await sendTestPush()).ok).toBe(false);
    expect(net.calls).toHaveLength(0);

    stubVapid(true);
    for (let i = 0; i < 3; i++) {
      expect(await sendTestPush()).toEqual({ ok: true, data: { sent: 1, removed: 0, failed: 0 } });
    }
    expect(net.calls.map((c) => c.endpoint)).toEqual([mine, mine, mine]);
    const body = JSON.parse(net.calls[0].body);
    expect(body.title).toBe("Probando avisos de turnos");
    expect(body.url.startsWith("/")).toBe(true);
    // Sin PHI ni datos de la sesión: el consultorio y el usuario de la factory se llaman «Test <sufijo>».
    expect(net.calls[0].body).not.toContain("Test ");
    expect(net.calls[0].body).not.toContain(A.userId);
    expect(net.calls[0].body).not.toContain(A.slug);

    const limited = await sendTestPush();
    expect(limited.ok).toBe(false);
    expect(net.calls).toHaveLength(3);

    // El cupo es por usuario: P2 todavía puede probar.
    asUser(P2.userId);
    expect((await sendTestPush()).ok).toBe(true);
  });

  it("[CF2-TS4-8] Secretaria, soporte y sin sesión: rechazo en las 4 actions, sin filas ni red", async () => {
    stubVapid(true);
    const endpoint = endpointOf("gate-");

    const expectAllRejected = async (who: string) => {
      const results = [
        await savePushSubscription(sub(endpoint)),
        await deletePushSubscription(endpoint),
        await deleteMyPushDevice("cualquiera"),
        await listMyPushDevices(),
        await sendTestPush(),
      ];
      for (const r of results) expect(r.ok, who).toBe(false);
      expect(await prismaService.pushSubscription.count({ where: { endpoint } }), who).toBe(0);
      expect(cookieValue(), who).toBeUndefined();
      expect(net.calls, who).toHaveLength(0);
    };

    asUser(SEC.userId);
    await expectAllRejected("secretaria");

    // Soporte: sesión real; el superadmin tiene su propio profesional en S, pero en soporte no es él.
    asUser(S.userId);
    const s = await startSupport(A.tenantId, "Ayuda con los avisos de turnos");
    if (!s.ok) throw new Error(s.error);
    try {
      await expectAllRejected("soporte");
    } finally {
      hdr.jar.delete(SUPPORT_COOKIE);
      await db.supportSession.update({ where: { id: s.data.sessionId }, data: { endedAt: new Date(), endedReason: "test" } });
    }

    // Sin sesión: solo si el entorno no cae al actor demo de dev (`KINESOFT_ALLOW_DEMO_ACTOR=1` en `.env.local`
    // resuelve el primer profesional del consultorio demo; en prod `DEMO_ALLOWED` es false siempre).
    if (process.env.KINESOFT_ALLOW_DEMO_ACTOR !== "1") {
      asAnonymous();
      await expectAllRejected("sin sesión");
    }
  });
});
