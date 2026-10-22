/**
 * T5 · [TP-2k] Cron diario, etapa `mp_connect` (plan §25.4, contrato C-TP13: `lib/mp-connect/cron-internal.ts`).
 *
 * Contra Postgres en los dos roles y con el Mercado Pago FALSO (`installFakeMp`: solo se reemplaza la red; el refresh
 * pega en el `fakeMpHandle` real con PKCE/refresh rotativo de verdad). Nunca MP real (regla de T5).
 *
 * Cada corrida va acotada al consultorio del test (`tenantIds`): la base local la comparten otras sesiones y el MP falso
 * es por proceso, así que un cron sin acotar marcaría REAUTH las cuentas de los fixtures ajenos. La única corrida sin
 * acotar es la de `runDaily` (modo off: no llama a MP).
 *
 * Las carreras se arman en la RED (un `fetch` que, justo antes de que el cron canjee el refresh, hace lo que haría el
 * otro escritor): así se prueba el CAS real sin mockear la función bajo test.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { runMpConnectMaintenance, markMpAccountReauthRequired } from "@/lib/mp-connect/cron-internal";
import { runDaily } from "@/lib/cron-jobs-internal";
import { refreshTokens } from "@/lib/mp-connect/oauth-client";
import { fakeMpHandle } from "@/lib/mp-connect/fake-mp";
import { prismaService } from "@/lib/db";
import { mpCredentialAad, openSecret, sealSecret } from "@/lib/secret-box";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { connectFakeAccount, fakeMpForceReauth, installFakeMp, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("[TP-2k] cron diario · etapa mp_connect", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let pat: string;
  let fake: InstalledFakeMp | null = null;
  /** El consultorio del test en curso (cada test arma el suyo; `afterEach` lo borra). */
  let current: EphemeralTenant | null = null;
  const scope = () => ({ tenantIds: [T.tenantId] });

  beforeAll(async () => {
    db = ownerClient();
  });

  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await current?.cleanup();
    current = null;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function freshTenant() {
    T = await createEphemeralTenant(db);
    current = T;
    pat = await addPatient(db, T);
  }

  async function cred(accountId: string) {
    return db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: accountId } });
  }

  /** Envuelve la red del fake: `onToken` corre justo antes de que el POST /oauth/token llegue al MP falso (una vez). */
  function beforeTokenOnce(onToken: () => Promise<void>) {
    const inner = globalThis.fetch;
    let done = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!done && url.endsWith("/oauth/token")) {
        done = true;
        await onToken();
      }
      return inner(input, init);
    }) as typeof fetch;
  }

  async function liveFreeLink(accountId: string, o: { createdAt?: Date; expiresAt?: Date; bookingId?: string } = {}) {
    const createdAt = o.createdAt ?? new Date();
    const c = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: o.bookingId ? "FULL" : "FREE",
        mpAccountId: accountId,
        practitionerId: T.practitionerId,
        patientId: pat,
        bookingId: o.bookingId ?? null,
        amountCents: 5_000_00,
        concept: "Sesión suelta",
        publicToken: randomBytes(16).toString("base64url"),
        createdByUserId: T.userId,
        createdAt,
        expiresAt: o.expiresAt ?? new Date(createdAt.getTime() + 7 * DAY),
        idempotencyKey: `link:${randomUUID()}`,
      },
      select: { id: true },
    });
    return c.id;
  }

  it("[TP-2k] Refresca a < 30 d con CAS y rotación", async () => {
    await freshTenant();
    fake = installFakeMp();
    const due = await connectFakeAccount(db, T, { seller: 1, accessExpiresAt: new Date(Date.now() + 10 * DAY) });
    const before = await cred(due.accountId);
    const now = new Date();

    const r = await runMpConnectMaintenance(now, 8_000, scope());
    expect(r).toMatchObject({ refreshed: 1, reauth: 0, errors: 0, truncated: false });

    const after = await cred(due.accountId);
    expect(after.version).toBe(before.version + 1);
    expect(after.lastRefreshedAt?.getTime()).toBe(now.getTime());
    expect(after.refreshFailures).toBe(0);
    expect(after.accessExpiresAt.getTime()).toBe(now.getTime() + 180 * DAY);
    expect(after.accessTokenBox).not.toBe(before.accessTokenBox);
    const newRefresh = openSecret(after.refreshTokenBox, mpCredentialAad(due.accountId, "refreshToken"));
    expect(newRefresh).not.toBe(due.refreshToken);
    // Rotación: el refresh viejo ya no sirve en el MP falso (como en MP).
    expect(await refreshTokens(due.refreshToken)).toEqual({ error: "invalid_grant" });
    // Los sobres nunca guardan el token en claro.
    expect(after.accessTokenBox).not.toContain("FAKE-");

    // Una cuenta con 60 días por delante no se toca.
    const later = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", accessExpiresAt: new Date(Date.now() + 60 * DAY) });
    const r2 = await runMpConnectMaintenance(new Date(), 8_000, scope());
    expect(r2.refreshed).toBe(0);
    expect((await cred(later.accountId)).version).toBe(1);
  });

  it("[TP-2k] refresh con CAS: si la rotación de claves re-selló la fila en el medio, reintenta y guarda (sin perder el token nuevo)", async () => {
    await freshTenant();
    fake = installFakeMp();
    const acc = await connectFakeAccount(db, T, { seller: 1, accessExpiresAt: new Date(Date.now() + DAY) });
    beforeTokenOnce(async () => {
      // `resealMpCredentials`: mismo texto, sobre nuevo y `version + 1`.
      const c = await cred(acc.accountId);
      await db.mpCredential.update({
        where: { id: c.id },
        data: {
          refreshTokenBox: sealSecret(acc.refreshToken, mpCredentialAad(acc.accountId, "refreshToken")),
          accessTokenBox: sealSecret(acc.accessToken, mpCredentialAad(acc.accountId, "accessToken")),
          version: c.version + 1,
        },
      });
    });
    const r = await runMpConnectMaintenance(new Date(), 8_000, scope());
    expect(r).toMatchObject({ refreshed: 1, reauth: 0, errors: 0 });
    const c = await cred(acc.accountId);
    expect(c.version).toBe(3);
    const access = openSecret(c.accessTokenBox, mpCredentialAad(acc.accountId, "accessToken"));
    expect(access).not.toBe(acc.accessToken);
  });

  it("[TP-2k] `invalid_grant` → REAUTH + aviso una vez + audit; carrera ganada por otro no marca REAUTH", async () => {
    await freshTenant();
    fake = installFakeMp();
    const acc = await connectFakeAccount(db, T, { seller: 1, accessExpiresAt: new Date(Date.now() + 5 * DAY) });
    fakeMpForceReauth(acc.mpUserId);
    const now = new Date();

    const r1 = await runMpConnectMaintenance(now, 8_000, scope());
    const r2 = await runMpConnectMaintenance(new Date(), 8_000, scope());
    expect(r1).toMatchObject({ refreshed: 0, reauth: 1, errors: 0 });
    expect(r2).toMatchObject({ refreshed: 0, reauth: 0 });

    const a = await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId } });
    expect(a.status).toBe("REAUTH_REQUIRED");
    expect(a.reauthRequiredAt?.getTime()).toBe(now.getTime());
    const notes = await db.notification.findMany({ where: { tenantId: T.tenantId, userId: T.userId, kind: "SYSTEM" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: "Reconectá tu Mercado Pago",
      body: "El acceso de la app a tu cuenta venció: hasta que lo reconectes, el turnero reserva sin cobro online.",
      link: "/configuracion?tab=mercado-pago",
    });
    const audits = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, action: "mpAccount.reauth_required" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: null, entity: "MpAccount", entityId: acc.accountId });
    expect(JSON.stringify(audits[0].payload)).not.toMatch(/FAKE|v1\./);
    expect((await cred(acc.accountId)).refreshFailures).toBe(1);

    // Carrera: OTRO refresca (webhook) justo antes que el cron; el cron recibe invalid_grant con su refresh viejo y NO
    // marca la cuenta (la credencial ya cambió de versión).
    const other = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", accessExpiresAt: new Date(Date.now() + 5 * DAY) });
    beforeTokenOnce(async () => {
      const res = await fakeMpHandle(
        new Request("http://localhost:3000/api/mp/fake/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: other.refreshToken,
            client_id: "kinesoft-fake-app",
            client_secret: "kinesoft-fake-secret",
          }),
        })
      );
      const t = (await res.json()) as { access_token: string; refresh_token: string };
      const c = await cred(other.accountId);
      await db.mpCredential.update({
        where: { id: c.id },
        data: {
          accessTokenBox: sealSecret(t.access_token, mpCredentialAad(other.accountId, "accessToken")),
          refreshTokenBox: sealSecret(t.refresh_token, mpCredentialAad(other.accountId, "refreshToken")),
          accessExpiresAt: new Date(Date.now() + 180 * DAY),
          version: c.version + 1,
        },
      });
    });
    const r3 = await runMpConnectMaintenance(new Date(), 8_000, scope());
    expect(r3).toMatchObject({ refreshed: 0, reauth: 0, errors: 0 });
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: other.accountId } })).status).toBe("ACTIVE");
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "mpAccount.reauth_required", entityId: other.accountId } })).toBe(0);

    // El CAS suelto: con una versión vieja no marca.
    const c = await cred(other.accountId);
    expect(
      await markMpAccountReauthRequired({ tenantId: T.tenantId, accountId: other.accountId, credentialVersion: c.version - 1, now: new Date(), source: "cron" })
    ).toBe(false);
  });

  it("[TP-2k] la cuenta del consultorio en REAUTH avisa al Titular con el link a «Cobros online»", async () => {
    await freshTenant();
    fake = installFakeMp();
    const acc = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", accessExpiresAt: new Date(Date.now() + DAY) });
    fakeMpForceReauth(acc.mpUserId);
    expect((await runMpConnectMaintenance(new Date(), 8_000, scope())).reauth).toBe(1);
    const notes = await db.notification.findMany({ where: { tenantId: T.tenantId, kind: "SYSTEM" } });
    expect(notes.map((n) => [n.userId, n.link])).toEqual([[T.userId, "/configuracion?tab=cobros-online"]]);
  });

  it("[TP-2k] Purga a 7 días sin cobros vivos; con link vivo conserva", async () => {
    await freshTenant();
    const now = new Date();
    const gone = await connectFakeAccount(db, T, { seller: 1, status: "DISCONNECTED", purgeAfter: new Date(now.getTime() - 60_000) });
    const notYet = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", status: "DISCONNECTED", purgeAfter: new Date(now.getTime() + 3 * DAY) });
    // Con un link vivo: la cuenta estaba ACTIVE al crearlo (guard de M18) y después se desconectó sin anularlo.
    const P2 = await addPractitioner(db, T, "PRACTITIONER");
    const busy = await connectFakeAccount(db, T, { seller: 1, practitionerId: P2.practitionerId });
    const link = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: "FREE",
        mpAccountId: busy.accountId,
        practitionerId: P2.practitionerId,
        patientId: pat,
        amountCents: 1_000_00,
        concept: "Sesión suelta",
        publicToken: randomBytes(16).toString("base64url"),
        createdByUserId: T.userId,
        expiresAt: new Date(now.getTime() + 3 * DAY),
        idempotencyKey: `link:${randomUUID()}`,
      },
      select: { id: true },
    });
    await db.mpAccount.update({ where: { id: busy.accountId }, data: { status: "DISCONNECTED", disconnectedAt: now, disconnectedByUserId: T.userId, linksDelegated: false } });
    await db.mpCredential.update({ where: { mpAccountId: busy.accountId }, data: { purgeAfter: new Date(now.getTime() - 60_000) } });

    const r = await runMpConnectMaintenance(now, 8_000, scope());
    expect(r.purged).toBe(1);
    expect(await db.mpCredential.findUnique({ where: { mpAccountId: gone.accountId } })).toBeNull();
    expect(await db.mpCredential.findUnique({ where: { mpAccountId: notYet.accountId } })).not.toBeNull();
    expect(await db.mpCredential.findUnique({ where: { mpAccountId: busy.accountId } })).not.toBeNull();
    // La cuenta queda (es la cuenta de los cobros viejos); solo se va el secreto.
    expect(await db.mpAccount.findUnique({ where: { id: gone.accountId } })).not.toBeNull();
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("ACTIVE");
  });

  it("[TP-2k] Vence ACTIVE pasados y anula links de turnos cancelados", async () => {
    await freshTenant();
    const acc = await connectFakeAccount(db, T, { seller: 1 });
    const now = new Date();
    const stale = await liveFreeLink(acc.accountId, { createdAt: new Date(now.getTime() - 3 * DAY), expiresAt: new Date(now.getTime() - 3_600_000) });
    // Dentro de la gracia de 5 min: todavía no (un pago del último segundo puede estar viajando).
    const grace = await liveFreeLink(acc.accountId, { createdAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() - 120_000) });
    const fresh = await liveFreeLink(acc.accountId);
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(now.getTime() + DAY),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        copagoCents: 5_000_00,
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    const orphan = await liveFreeLink(acc.accountId, { bookingId: b.id });
    await db.booking.update({ where: { id: b.id }, data: { status: "CANCELLED" } });

    const r = await runMpConnectMaintenance(now, 8_000, scope());
    expect(r).toMatchObject({ expired: 1, linksCancelled: 1, errors: 0 });
    const by = async (id: string) => db.onlineCharge.findUniqueOrThrow({ where: { id } });
    expect((await by(stale)).status).toBe("EXPIRED");
    expect((await by(grace)).status).toBe("ACTIVE");
    expect((await by(fresh)).status).toBe("ACTIVE");
    expect(await by(orphan)).toMatchObject({ status: "CANCELLED", cancelReason: "booking_cancelled", cancelledByUserId: null });
    expect((await by(orphan)).cancelledAt?.getTime()).toBe(now.getTime());
  });

  it("[TP-2k] Presupuesto → `truncated`; dos corridas = una; modo off no llama a MP pero purga", async () => {
    await freshTenant();
    fake = installFakeMp();
    const due = await connectFakeAccount(db, T, { seller: 1, accessExpiresAt: new Date(Date.now() + DAY) });
    const old = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", status: "DISCONNECTED", purgeAfter: new Date(Date.now() - 60_000) });
    await liveFreeLink(due.accountId, { createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - 3_600_000) });

    // Sin presupuesto: no hace nada y avisa que quedó trabajo.
    const cut = await runMpConnectMaintenance(new Date(), -1, scope());
    expect(cut).toEqual({ refreshed: 0, reauth: 0, purged: 0, expired: 0, linksCancelled: 0, errors: 0, truncated: true });
    expect((await cred(due.accountId)).version).toBe(1);

    const first = await runMpConnectMaintenance(new Date(), 8_000, scope());
    const second = await runMpConnectMaintenance(new Date(), 8_000, scope());
    expect(first).toMatchObject({ refreshed: 1, purged: 1, expired: 1, errors: 0, truncated: false });
    expect(second).toEqual({ refreshed: 0, reauth: 0, purged: 0, expired: 0, linksCancelled: 0, errors: 0, truncated: false });
    void old;

    // Modo off: una credencial que vence y una para purgar; la red no se toca.
    fake.uninstall();
    fake = null;
    vi.stubEnv("MP_CONNECT_MODE", "off");
    const calls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error("red bloqueada");
    }) as typeof fetch;
    try {
      const P2 = await addPractitioner(db, T, "PRACTITIONER");
      const due2 = await connectFakeAccount(db, T, { seller: 1, practitionerId: P2.practitionerId, accessExpiresAt: new Date(Date.now() + DAY) });
      const old2 = await connectFakeAccount(db, T, { seller: 2, kind: "CLINIC", status: "DISCONNECTED", purgeAfter: new Date(Date.now() - 60_000) });
      const off = await runMpConnectMaintenance(new Date(), 8_000, scope());
      expect(off).toMatchObject({ refreshed: 0, reauth: 0, purged: 1, errors: 0 });
      expect(calls).toEqual([]);
      expect((await cred(due2.accountId)).version).toBe(1);
      expect(await db.mpCredential.findUnique({ where: { mpAccountId: old2.accountId } })).toBeNull();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("[TP-2k] `runDaily` suma la etapa sin frenar otras", async () => {
    vi.stubEnv("SAAS_BILLING_MODE", "off");
    // Modo off (sin fake): la etapa corre (vencidos/purga) sin hablar con MP.
    const ok = await runDaily(new Date());
    expect(ok.mpConnect).toMatchObject({ ok: true, result: { refreshed: 0, reauth: 0 } });
    expect(ok.storagePending.ok).toBe(true);

    // Una falla de la etapa no frena la siguiente (el barrido del Storage corre igual).
    fake = installFakeMp();
    vi.spyOn(prismaService.mpCredential, "findMany").mockRejectedValueOnce(new Error("boom"));
    const failed = await runDaily(new Date());
    expect(failed.mpConnect).toEqual({ ok: false, error: "Error" });
    expect(failed.healthDigest.ok).toBe(true);
    expect(failed.storagePending.ok).toBe(true);
  });
});
