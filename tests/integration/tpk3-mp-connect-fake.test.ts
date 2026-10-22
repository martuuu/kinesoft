/**
 * [TP-K3] El helper del MP falso (`tests/helpers/mp-connect-fake.ts`) contra la base real, en los dos roles
 * (`test:integration` = kinesoft_app con RLS; `test:integration:owner` = BYPASSRLS como prod hoy).
 *
 * Por qué: todos los tests de T5d se paran sobre `connectFakeAccount`. Si la credencial que deja no abre con la AAD del
 * código, o el token no es del fake, cada test de webhook/refresh fallaría por el helper y no por lo que mide.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMe, refreshTokens } from "@/lib/mp-connect/oauth-client";
import { mpFetch } from "@/lib/mp-connect/http";
import { mpCredentialAad, openSecret, SecretBoxError } from "@/lib/secret-box";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { connectFakeAccount, FAKE_HOOK_SECRET, installFakeMp, payFake, setPaymentPolicy, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";
import { createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[TP-K3] helper del Mercado Pago falso", () => {
  let db: PrismaClient;
  let app: PrismaClient;
  let A: EphemeralTenant;
  let fake: InstalledFakeMp | null = null;

  beforeAll(() => {
    db = ownerClient();
    app = new PrismaClient();
  });
  // Consultorio nuevo por test: «una cuenta viva por profesional» (índice parcial de M18) haría chocar a los tests.
  beforeEach(async () => {
    A = await createEphemeralTenant(db);
  });
  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    await A?.cleanup();
  });
  afterAll(async () => {
    await db?.$disconnect();
    await app?.$disconnect();
  });

  it("[TP-K3] connectFakeAccount crea la cuenta ACTIVE y la credencial sellada abre con la AAD del código", async () => {
    fake = installFakeMp();
    const acc = await connectFakeAccount(db, A, { linksDelegated: true });

    const row = await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId }, include: { credential: true } });
    expect(row).toMatchObject({
      tenantId: A.tenantId,
      practitionerId: A.practitionerId,
      kind: "PRACTITIONER",
      status: "ACTIVE",
      mpUserId: "900000001",
      mpNickname: "VENDEDOR_PRUEBA_1",
      liveMode: false,
      linksDelegated: true,
      webhookRef: acc.webhookRef,
    });
    const cred = row.credential!;
    // Nunca el token en claro en la base; abre SOLO con la AAD de su cuenta y su campo.
    expect(cred.accessTokenBox).not.toContain(acc.accessToken);
    expect(openSecret(cred.accessTokenBox, mpCredentialAad(acc.accountId, "accessToken"))).toBe(acc.accessToken);
    expect(openSecret(cred.refreshTokenBox, mpCredentialAad(acc.accountId, "refreshToken"))).toBe(acc.refreshToken);
    expect(() => openSecret(cred.accessTokenBox, mpCredentialAad(acc.accountId, "refreshToken"))).toThrow(SecretBoxError);
    expect(cred.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 170 * 86_400_000);

    // El token es del fake: /users/me responde y el refresh rota.
    expect(await getMe(acc.accessToken)).toMatchObject({ nickname: "VENDEDOR_PRUEBA_1" });
    const r = await refreshTokens(acc.refreshToken);
    if ("error" in r) throw new Error(`refresh: ${r.error}`);
    expect(r.refreshToken).not.toBe(acc.refreshToken);
  });

  it("[TP-K3] con kinesoft_app la cuenta se ve solo con su GUC y la credencial nunca; con el owner, todo", async () => {
    fake = installFakeMp();
    const acc = await connectFakeAccount(db, A, { kind: "CLINIC", seller: 2 });
    expect(acc.practitionerId).toBeNull();
    const bypass = await appRoleBypassesRls();
    const seen = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${A.tenantId}, true)`;
      return {
        account: await tx.mpAccount.count({ where: { id: acc.accountId } }),
        credential: await tx.mpCredential.count({ where: { mpAccountId: acc.accountId } }),
      };
    });
    expect(seen).toEqual({ account: 1, credential: bypass ? 1 : 0 });
    const otherGuc = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', 'otro-consultorio', true)`;
      return tx.mpAccount.count({ where: { id: acc.accountId } });
    });
    expect(otherGuc).toBe(bypass ? 1 : 0);
  });

  it("[TP-K3] estados REAUTH/DISCONNECTED pasan los CHECK; setPaymentPolicy hace upsert", async () => {
    fake = installFakeMp();
    // DISCONNECTED primero: libera el índice parcial «una viva por profesional» para la REAUTH.
    const off = await connectFakeAccount(db, A, { status: "DISCONNECTED", linksDelegated: true });
    const re = await connectFakeAccount(db, A, { status: "REAUTH_REQUIRED" });
    const rows = await db.mpAccount.findMany({ where: { id: { in: [off.accountId, re.accountId] } }, include: { credential: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(off.accountId)).toMatchObject({ status: "DISCONNECTED", linksDelegated: false });
    expect(byId.get(off.accountId)!.credential!.purgeAfter).not.toBeNull();
    expect(byId.get(re.accountId)!.reauthRequiredAt).not.toBeNull();

    await setPaymentPolicy(db, A.tenantId, { mode: "REQUIRED", chargeKind: "PERCENT", percentBps: 3000 });
    await setPaymentPolicy(db, A.tenantId, { mode: "OPTIONAL", chargeKind: "FIXED", fixedCents: 500_000 });
    expect(await db.bookingPaymentPolicy.findUniqueOrThrow({ where: { tenantId: A.tenantId } })).toMatchObject({
      mode: "OPTIONAL",
      chargeKind: "FIXED",
      fixedCents: 500_000,
      percentBps: null,
    });
  });

  it("[TP-K3] payFake: el webhook sale firmado a la notification_url con ?acct= y el pago se ve con el token del vendedor", async () => {
    const posted: Request[] = [];
    fake = installFakeMp({
      webhook: async (req) => {
        posted.push(req);
        return new Response(JSON.stringify({ result: "applied" }), { status: 200 });
      },
    });
    const acc = await connectFakeAccount(db, A, { seller: 1 });
    const created = await mpFetch("/checkout/preferences", {
      token: acc.accessToken,
      method: "POST",
      body: {
        items: [{ id: "oc_k3", title: "Turno del 22/10 · Consultorio", quantity: 1, unit_price: 2000, currency_id: "ARS" }],
        external_reference: "oc:oc_k3",
        notification_url: `http://localhost:3000/api/webhooks/mercadopago?acct=${acc.webhookRef}`,
      },
    });
    if (!created.ok) throw new Error("no creó la preferencia");
    const pay = await payFake((created.json as { id: string }).id, "approved");
    expect(pay).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    expect(posted).toHaveLength(1);
    expect(fake.hooks).toHaveLength(1);
    const u = new URL(fake.hooks[0].url);
    expect(u.searchParams.get("acct")).toBe(acc.webhookRef);
    expect(u.searchParams.get("data.id")).toBe(pay.paymentId);
    expect(fake.hooks[0].headers["x-signature"]).toMatch(/^ts=\d+,v1=[0-9a-f]{64}$/);
    expect(FAKE_HOOK_SECRET).toBeTruthy();
    expect(await mpFetch(`/v1/payments/${pay.paymentId}`, { token: acc.accessToken })).toMatchObject({
      ok: true,
      json: { status: "approved", external_reference: "oc:oc_k3", transaction_amount: 2000 },
    });
    // Fuera del fake, la red está bloqueada (un test no sale a internet por accidente).
    await expect(fetch("https://api.mercadopago.com/users/me")).rejects.toThrow(/red real bloqueada/);
  });
});
