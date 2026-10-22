/**
 * [TP-P4] Mercado Pago falso (C-TP12, brief §25.9) + cliente OAuth real (C-TP3) contra él. Se prueba el símbolo real
 * (`exchangeCode`, `refreshTokens`, `getMe`, `fakeMpHandle`, `simulateFakePayment`); lo único reemplazado es la red:
 * `globalThis.fetch` enruta `${APP_URL}/api/mp/fake/*` al handler del fake y captura el POST al webhook.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "@/lib/mp-connect/oauth-state";
import { authorizationUrl, exchangeCode, getMe, refreshTokens } from "@/lib/mp-connect/oauth-client";
import { mpFetch } from "@/lib/mp-connect/http";
import {
  fakeMpForceReauth,
  fakeMpHandle,
  fakeMpIssueTokens,
  resetFakeMp,
  simulateFakePayment,
} from "@/lib/mp-connect/fake-mp";
import { GET as routeGET } from "@/app/api/mp/fake/[...path]/route";

const APP = "http://localhost:3000";
const FAKE = `${APP}/api/mp/fake`;
const HOOK_SECRET = "secreto-de-prueba-del-webhook";
const VERIFIER = "v".repeat(43);
const VERIFIER_2 = "w".repeat(43);

type Hook = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let hooks: Hook[] = [];

function installFetch() {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(FAKE)) return fakeMpHandle(new Request(url, init));
    if (url.startsWith(`${APP}/api/webhooks/mercadopago`)) {
      hooks.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ result: "applied" }), { status: 200 });
    }
    throw new Error(`red real bloqueada en el test: ${url}`);
  });
}

beforeEach(() => {
  vi.stubEnv("MP_CONNECT_MODE", "fake");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
  vi.stubEnv("MP_OAUTH_CLIENT_ID", "app-de-prueba");
  vi.stubEnv("MP_OAUTH_CLIENT_SECRET", "secreto-app-de-prueba");
  vi.stubEnv("MP_CONNECT_WEBHOOK_SECRET", HOOK_SECRET);
  resetFakeMp();
  hooks = [];
  installFetch();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Recorre la pantalla de autorización como el navegador y devuelve el `code` del redirect. */
async function authorize(verifier: string, seller = "900000001"): Promise<string> {
  const authUrl = authorizationUrl({ state: "st-1", codeChallenge: pkceChallenge(verifier) });
  expect(authUrl).toMatch(new RegExp(`^${FAKE}/authorization\\?`));
  const page = await fakeMpHandle(new Request(authUrl!));
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Simulador de Mercado Pago (solo desarrollo)");
  expect(html).toContain("Autorizar como Vendedor de prueba 1");
  const q = new URL(authUrl!).searchParams;
  const form = new URLSearchParams({
    client_id: q.get("client_id")!,
    redirect_uri: q.get("redirect_uri")!,
    state: q.get("state")!,
    code_challenge: q.get("code_challenge")!,
    seller,
  });
  const res = await fakeMpHandle(
    new Request(`${FAKE}/authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })
  );
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${APP}/api/mp/oauth/callback`);
  expect(loc.searchParams.get("state")).toBe("st-1");
  return loc.searchParams.get("code")!;
}

describe("[TP-P4] Modo y fake", () => {
  it("[TP-P4] El fake exige PKCE, `redirect_uri` exacta y código de un uso; el refresh rota", async () => {
    // Sin PKCE o con otra redirect_uri la autorización ni se muestra.
    const noPkce = new URL(authorizationUrl({ state: "s", codeChallenge: pkceChallenge(VERIFIER) })!);
    noPkce.searchParams.delete("code_challenge");
    expect((await fakeMpHandle(new Request(noPkce))).status).toBe(400);
    const plain = new URL(authorizationUrl({ state: "s", codeChallenge: pkceChallenge(VERIFIER) })!);
    plain.searchParams.set("code_challenge_method", "plain");
    expect((await fakeMpHandle(new Request(plain))).status).toBe(400);
    const otherRedirect = new URL(authorizationUrl({ state: "s", codeChallenge: pkceChallenge(VERIFIER) })!);
    otherRedirect.searchParams.set("redirect_uri", "https://evil.example/cb");
    expect((await fakeMpHandle(new Request(otherRedirect))).status).toBe(400);

    // Verifier equivocado → invalid_grant, y el código queda consumido (un uso).
    const c1 = await authorize(VERIFIER);
    expect(await exchangeCode({ code: c1, codeVerifier: VERIFIER_2 })).toEqual({ error: "invalid_grant" });
    expect(await exchangeCode({ code: c1, codeVerifier: VERIFIER })).toEqual({ error: "invalid_grant" });

    // redirect_uri distinta en el canje → invalid_grant.
    const c2 = await authorize(VERIFIER);
    const raw = await mpFetch("/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: "app-de-prueba",
        client_secret: "secreto-app-de-prueba",
        code: c2,
        redirect_uri: `${APP}/api/mp/oauth/callback/`,
        code_verifier: VERIFIER,
      },
    });
    expect(raw).toMatchObject({ ok: false, kind: "http", status: 400, json: { error: "invalid_grant" } });

    // Canje correcto; el mismo código dos veces → la segunda falla.
    const c3 = await authorize(VERIFIER);
    const t1 = await exchangeCode({ code: c3, codeVerifier: VERIFIER });
    if ("error" in t1) throw new Error(`canje falló: ${t1.error}`);
    expect(t1).toMatchObject({ userId: "900000001", liveMode: false, publicKey: "FAKE-pk-900000001" });
    expect(t1.expiresIn).toBeGreaterThan(0);
    expect(await exchangeCode({ code: c3, codeVerifier: VERIFIER })).toEqual({ error: "invalid_grant" });
    expect(await getMe(t1.accessToken)).toEqual({ nickname: "VENDEDOR_PRUEBA_1", id: "900000001" });
    expect(await getMe("FAKE-token-inventado")).toEqual({ error: "unauthorized" });

    // Refresh rotativo: el par nuevo sirve, el refresh viejo no.
    const t2 = await refreshTokens(t1.refreshToken);
    if ("error" in t2) throw new Error(`refresh falló: ${t2.error}`);
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
    expect(t2.accessToken).not.toBe(t1.accessToken);
    expect(await refreshTokens(t1.refreshToken)).toEqual({ error: "invalid_grant" });
    expect(await getMe(t2.accessToken)).toMatchObject({ nickname: "VENDEDOR_PRUEBA_1" });

    // «Forzar reconexión» → el refresh vivo da invalid_grant (camino a REAUTH_REQUIRED).
    fakeMpForceReauth("900000001");
    expect(await refreshTokens(t2.refreshToken)).toEqual({ error: "invalid_grant" });

    // Cancelar vuelve al callback con error=access_denied.
    const cancel = await fakeMpHandle(
      new Request(`${FAKE}/authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ redirect_uri: `${APP}/api/mp/oauth/callback`, state: "st", seller: "cancel" }).toString(),
      })
    );
    expect(new URL(cancel.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("[TP-P4] simulador: 404 fuera de fake o en Vercel; el pago pasa firmado por la notification_url con ?acct=; pagos ajenos 404", async () => {
    // Guard de la ruta (se mira en cada request).
    expect((await routeGET(new Request(`${FAKE}/panel`))).status).toBe(200);
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await routeGET(new Request(`${FAKE}/panel`))).status).toBe(404);
    expect((await fakeMpHandle(new Request(`${FAKE}/users/me`))).status).toBe(404);
    await expect(simulateFakePayment({ preferenceId: "x", outcome: "approved" })).rejects.toThrow(/not_allowed/);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL", "1");
    expect((await routeGET(new Request(`${FAKE}/panel`))).status).toBe(404);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("MP_CONNECT_MODE", "sandbox");
    expect((await routeGET(new Request(`${FAKE}/panel`))).status).toBe(404);
    vi.stubEnv("MP_CONNECT_MODE", "fake");

    const s1 = fakeMpIssueTokens(1);
    const s2 = fakeMpIssueTokens(2);
    const notificationUrl = `${APP}/api/webhooks/mercadopago?acct=ref-abc`;
    const created = await mpFetch("/checkout/preferences", {
      token: s1.accessToken,
      method: "POST",
      body: {
        items: [{ id: "oc_1", title: "Turno del 22/10 · Consultorio", quantity: 1, unit_price: 1500.5, currency_id: "ARS" }],
        external_reference: "oc:oc_1",
        notification_url: notificationUrl,
        binary_mode: true,
        expires: true,
        expiration_date_to: new Date(Date.now() + 3600_000).toISOString(),
        back_urls: { success: `${APP}/ok`, failure: `${APP}/ko`, pending: `${APP}/pend` },
        metadata: { chargeId: "oc_1" },
      },
    });
    if (!created.ok) throw new Error("no creó la preferencia");
    const pref = created.json as { id: string; init_point: string; collector_id: number };
    expect(pref.collector_id).toBe(900000001);
    expect(pref.init_point).toBe(`${FAKE}/checkout/${pref.id}`);

    const checkout = await (await fakeMpHandle(new Request(pref.init_point))).text();
    for (const label of ["Simular pago aprobado", "Simular pago rechazado", "Simular pago pendiente", "Simular reintegro", "Simular con otro monto"]) {
      expect(checkout).toContain(label);
    }

    const r = await simulateFakePayment({ preferenceId: pref.id, outcome: "approved" });
    expect(r.webhookStatus).toBe(200);
    expect(hooks).toHaveLength(1);
    const hook = hooks[0];
    const hu = new URL(hook.url);
    expect(hu.searchParams.get("acct")).toBe("ref-abc");
    expect(hu.searchParams.get("data.id")).toBe(r.paymentId);
    expect(hu.searchParams.get("type")).toBe("payment");
    // Firma con el manifiesto de MP (id;request-id;ts) y el secreto de la rama nueva.
    const sig = Object.fromEntries(hook.headers["x-signature"].split(",").map((p) => p.split("=")));
    const manifest = `id:${r.paymentId};request-id:${hook.headers["x-request-id"]};ts:${sig.ts};`;
    expect(sig.v1).toBe(createHmac("sha256", HOOK_SECRET).update(manifest).digest("hex"));
    expect(hook.body).toMatchObject({ type: "payment", data: { id: r.paymentId } });

    // El consumidor vuelve a pedir el pago: con el token del vendedor sí, con el de otro 404.
    const mine = await mpFetch(`/v1/payments/${r.paymentId}`, { token: s1.accessToken });
    expect(mine).toMatchObject({
      ok: true,
      json: { status: "approved", transaction_amount: 1500.5, currency_id: "ARS", external_reference: "oc:oc_1", collector_id: 900000001 },
    });
    expect(await mpFetch(`/v1/payments/${r.paymentId}`, { token: s2.accessToken })).toMatchObject({ ok: false, status: 404 });

    // binary_mode: «pendiente» sale rechazado; otro monto; reintegro del aprobado por el mismo webhook.
    const pend = await simulateFakePayment({ preferenceId: pref.id, outcome: "pending" });
    expect((await mpFetch(`/v1/payments/${pend.paymentId}`, { token: s1.accessToken })) as { json: { status: string } }).toMatchObject({
      json: { status: "rejected" },
    });
    const other = await simulateFakePayment({ preferenceId: pref.id, outcome: "approved", amountCents: 100 });
    expect(await mpFetch(`/v1/payments/${other.paymentId}`, { token: s1.accessToken })).toMatchObject({ json: { transaction_amount: 1 } });
    const refund = await simulateFakePayment({ preferenceId: pref.id, outcome: "refunded" });
    expect(await mpFetch(`/v1/payments/${refund.paymentId}`, { token: s1.accessToken })).toMatchObject({ json: { status: "refunded" } });
    expect(hooks).toHaveLength(4);

    // Vencer la preferencia (PUT del dueño) → el simulador se niega a pagarla; otro vendedor no la puede tocar.
    const expireBody = { expires: true, expiration_date_to: new Date(Date.now() - 1000).toISOString() };
    expect(await mpFetch(`/checkout/preferences/${pref.id}`, { token: s2.accessToken, method: "PUT", body: expireBody })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await mpFetch(`/checkout/preferences/${pref.id}`, { token: s1.accessToken, method: "PUT", body: expireBody })).toMatchObject({ ok: true });
    await expect(simulateFakePayment({ preferenceId: pref.id, outcome: "approved" })).rejects.toThrow(/preference_expired/);

    // Nunca a otro origen: una notification_url ajena no recibe nada firmado.
    const foreign = await mpFetch("/checkout/preferences", {
      token: s1.accessToken,
      method: "POST",
      body: { items: [{ id: "x", title: "x", quantity: 1, unit_price: 10, currency_id: "ARS" }], notification_url: "https://evil.example/hook?acct=1" },
    });
    await expect(simulateFakePayment({ preferenceId: (foreign as { json: { id: string } }).json.id, outcome: "approved" })).rejects.toThrow(
      /notification_url_foreign/
    );
  });

  it("[TP-P4] mpFetch con el modo off no toca la red", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "off");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await mpFetch("/users/me", { token: "x" })).toEqual({ ok: false, kind: "network" });
    expect(authorizationUrl({ state: "s", codeChallenge: "c" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
