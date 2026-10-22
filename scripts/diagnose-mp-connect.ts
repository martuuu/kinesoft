/**
 * [TP-2h] Diagnóstico de «Cobros online con Mercado Pago» (T5, plan §25.9/§25.15): verifica, uno por uno, los
 * SUPUESTOS [S1]…[S11] que el código de `lib/mp-connect/*` y el MP falso (`lib/mp-connect/fake-mp.ts`) hacen sobre
 * Mercado Pago. Molde: `scripts/diagnose-auth.ts` (supuestos del fake de GoTrue).
 *
 * Por qué: los tests y el E2E corren contra el MP FALSO. Si el fake supone algo que MP no hace (p. ej. que el refresh
 * viejo deja de servir, o que el webhook de un pago con token de vendedor llega firmado con el secreto de NUESTRA app),
 * los tests dan verde y prod no. Este script ejercita el MISMO código de la app (`oauth-client`, `mpFetch`,
 * `buildChargePreference`, `verifyMpSignature`) contra:
 *   - el **MP falso** (default, `MP_CONNECT_MODE` sin setear o `fake`): todo en el proceso, sin red, sin base y SIN leer
 *     `.env*`. Es lo que corre CI y cualquier agente. Prueba que el fake cumple el contrato;
 *   - el **sandbox real** (`MP_CONNECT_MODE=sandbox`): LO CORRE MARTIN AL FINAL (§25.15 paso 7), con las credenciales de
 *     la app de prueba y un túnel. Nunca un agente (regla de T5: producción y MP real, inadmisibles).
 *
 * Supuestos:
 *   [S1]  La autorización exige PKCE S256 y la `redirect_uri` EXACTA, y vuelve con `code` + `state`.
 *   [S2]  El canje del código con el `code_verifier` da access + refresh + user_id + expires_in; el código es de un uso.
 *   [S3]  El aviso de un pago cobrado con el token del VENDEDOR llega firmado con el secreto de webhooks de NUESTRA app
 *         (`x-signature` con el manifiesto `id;request-id;ts`). Decide `MP_CONNECT_WEBHOOK_SIGNATURE`.
 *   [S4]  `/users/me` con el token del vendedor devuelve su nickname; con un token inválido, 401.
 *   [S5]  MP notifica la `notification_url` de la PREFERENCIA (con su `?acct=`), con `data.id` y `type=payment`.
 *   [S6]  Crear una preferencia con el token del vendedor devuelve `id` + `init_point`; `expires`/`expiration_date_to`
 *         se respetan (vencida no se paga).
 *   [S7]  `GET /v1/payments/:id` con el token de OTRO vendedor no devuelve el pago (404/403).
 *   [S8]  El refresh es ROTATIVO: devuelve un par nuevo y el refresh usado deja de servir (`invalid_grant`).
 *   [S9]  `PUT /checkout/preferences/:id` con `expires` en el pasado vence la preferencia (no se puede pagar).
 *   [S10] El pago trae `collector_id` = el vendedor, `external_reference` (`oc:<id>`), ARS y el monto.
 *   [S11] Un reintegro deja el pago en `refunded` con `transaction_amount_refunded`.
 *
 * Seguridad: imprime ✓/✗ y códigos. Nunca tokens, códigos de autorización, secretos ni el `code_verifier` completo.
 *
 * Uso:
 *   npx tsx --conditions=react-server scripts/diagnose-mp-connect.ts              # MP falso (default)
 *   # Sandbox (SOLO Martin, al final, con el túnel y la app de prueba):
 *   #   1) MP_CONNECT_MODE=sandbox … scripts/diagnose-mp-connect.ts --sandbox                 → imprime la URL de [S1]
 *   #   2) … --sandbox --code <code de la vuelta> --verifier-file <archivo que dejó el paso 1>  → S2, S4, S6, S8, S9
 *   #   3) pagar la preferencia de [S6] con el comprador de prueba y mirar el log del webhook (S3, S5, S10, S11 manuales)
 * Sale con código 1 si algún supuesto automático da ✗.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "diagnose-mp-connect";
type Check = { id: string; desc: string; pass: boolean | null; detail: string };
const results: Check[] = [];

function check(id: string, desc: string, pass: boolean | null, detail = "") {
  results.push({ id, desc, pass, detail });
  const mark = pass === null ? "·" : pass ? "✓" : "✗";
  console.log(`${mark}  ${id.padEnd(5)} ${desc}${detail ? `  (${detail})` : ""}`);
}

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/** Corre un paso sin dejar que una excepción corte los demás (el mensaje nunca trae tokens: son errores propios). */
async function step(id: string, desc: string, fn: () => Promise<{ pass: boolean; detail?: string }>) {
  try {
    const r = await fn();
    check(id, desc, r.pass, r.detail ?? "");
  } catch (err) {
    check(id, desc, false, `excepción ${err instanceof Error ? err.name : "desconocida"}`);
  }
}

// ── MP falso ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Literales de prueba (los mismos que `tests/helpers/mp-connect-fake.ts`): nunca valores de `.env*`. */
const FAKE = {
  appUrl: "http://localhost:3000",
  clientId: "kinesoft-fake-app",
  clientSecret: "kinesoft-fake-secret",
  hookSecret: "secreto-de-prueba-del-webhook",
};

async function runFake(): Promise<void> {
  // Entorno ANTES de importar la app: el modo y la URL se leen en cada llamada, pero `env` se congela al importar.
  process.env.MP_CONNECT_MODE = "fake";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  process.env.NEXT_PUBLIC_APP_URL = FAKE.appUrl;
  process.env.MP_OAUTH_CLIENT_ID = FAKE.clientId;
  process.env.MP_OAUTH_CLIENT_SECRET = FAKE.clientSecret;
  process.env.MP_CONNECT_WEBHOOK_SECRET = FAKE.hookSecret;
  process.env.MP_CONNECT_WEBHOOK_SIGNATURE = "required";

  const fakeMp = await import("../lib/mp-connect/fake-mp");
  const oauth = await import("../lib/mp-connect/oauth-client");
  const { mpFetch } = await import("../lib/mp-connect/http");
  const { pkceChallenge } = await import("../lib/mp-connect/oauth-state");
  const { buildChargePreference, connectNotificationUrl } = await import("../lib/mp-connect/preference");
  const { verifyMpSignature } = await import("../lib/mp-connect/signature");
  const { mpRedirectUri, MP_FAKE_PATH } = await import("../lib/mp-connect/constants");
  fakeMp.resetFakeMp();

  // Red en el proceso: lo que va al fake lo atiende `fakeMpHandle`; el webhook lo recibe este script (verifica la
  // firma con el MISMO verificador que la rama connect). Cualquier otro host tira: nada sale a internet.
  const fakeBase = `${FAKE.appUrl}${MP_FAKE_PATH}`;
  const hooks: { url: URL; signatureOk: boolean }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(fakeBase)) return fakeMp.fakeMpHandle(input instanceof Request && !init ? input : new Request(url, init));
    if (url.startsWith(`${FAKE.appUrl}/api/webhooks/mercadopago`)) {
      const u = new URL(url);
      const h = new Headers(init?.headers);
      const v = verifyMpSignature({
        signature: h.get("x-signature"),
        requestId: h.get("x-request-id"),
        dataId: u.searchParams.get("data.id"),
        secret: FAKE.hookSecret,
      });
      hooks.push({ url: u, signatureOk: v.ok });
      return new Response(JSON.stringify({ result: "applied" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("red real bloqueada");
  }) as typeof fetch;

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("base64url");
  let code = "";
  const tokens: { a?: { accessToken: string; refreshToken: string; userId: string }; b?: { accessToken: string } } = {};

  await step("S1", "autorización con PKCE S256 y redirect exacta vuelve con code + state", async () => {
    const authUrl = oauth.authorizationUrl({ state, codeChallenge: pkceChallenge(verifier) });
    if (!authUrl) return { pass: false, detail: "sin URL (modo/credenciales)" };
    const u = new URL(authUrl);
    const pkceOk = u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("redirect_uri") === mpRedirectUri(FAKE.appUrl);
    const page = await fetch(authUrl);
    // Sin PKCE la pantalla tiene que negarse.
    const noPkce = new URL(authUrl);
    noPkce.searchParams.delete("code_challenge");
    const refused = (await fetch(noPkce.toString())).status === 400;
    const decide = await fetch(`${fakeBase}/authorization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: FAKE.clientId,
        redirect_uri: mpRedirectUri(FAKE.appUrl),
        state,
        code_challenge: pkceChallenge(verifier),
        seller: fakeMp.FAKE_MP_SELLERS[0].userId,
      }),
    });
    const back = new URL(decide.headers.get("location") ?? "about:blank");
    code = back.searchParams.get("code") ?? "";
    const ok = pkceOk && page.status === 200 && refused && back.searchParams.get("state") === state && code !== "";
    return { pass: ok, detail: `pantalla ${page.status}, sin PKCE ${refused ? "rechaza" : "ACEPTA"}` };
  });

  await step("S2", "canje con code_verifier da el par de tokens; el código es de un uso", async () => {
    const bad = await oauth.exchangeCode({ code, codeVerifier: randomBytes(32).toString("base64url") });
    const r = await oauth.exchangeCode({ code, codeVerifier: verifier });
    // El canje con verifier malo QUEMÓ el código (un uso): se pide uno nuevo para el canje bueno.
    let good = r;
    if ("error" in r) {
      const again = await fetch(`${fakeBase}/authorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: FAKE.clientId, redirect_uri: mpRedirectUri(FAKE.appUrl), state, code_challenge: pkceChallenge(verifier), seller: fakeMp.FAKE_MP_SELLERS[0].userId }),
      });
      const c2 = new URL(again.headers.get("location") ?? "about:blank").searchParams.get("code") ?? "";
      good = await oauth.exchangeCode({ code: c2, codeVerifier: verifier });
      const reuse = await oauth.exchangeCode({ code: c2, codeVerifier: verifier });
      if ("error" in good || !("error" in reuse)) return { pass: false, detail: "el código se pudo reusar o el canje falló" };
    }
    if ("error" in good) return { pass: false, detail: good.error };
    tokens.a = { accessToken: good.accessToken, refreshToken: good.refreshToken, userId: good.userId };
    const pass = "error" in bad && bad.error === "invalid_grant" && good.expiresIn > 0 && good.liveMode === false;
    return { pass, detail: `verifier malo → ${"error" in bad ? bad.error : "ACEPTADO"}, expires_in ${good.expiresIn}s` };
  });

  await step("S4", "/users/me devuelve el nickname; un token inválido da 401", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    const me = await oauth.getMe(tokens.a.accessToken);
    const bad = await oauth.getMe("token-que-no-existe");
    const pass = !("error" in me) && me.id === tokens.a.userId && "error" in bad && bad.error === "unauthorized";
    return { pass };
  });

  const chargeId = `diag${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let prefId = "";
  await step("S6", "preferencia con el token del vendedor: id + init_point; vencida no se paga", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    const body = buildChargePreference({
      charge: { id: chargeId, amountCents: 1_234_56 },
      tenantName: "Consultorio de diagnóstico",
      mode: "LINK",
      notificationUrl: connectNotificationUrl(FAKE.appUrl, "diag-acct-ref-0000000000"),
      backUrls: { success: `${FAKE.appUrl}/pagar/x?r=ok`, failure: `${FAKE.appUrl}/pagar/x?r=failed`, pending: `${FAKE.appUrl}/pagar/x?r=pending` },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const r = await mpFetch("/checkout/preferences", { method: "POST", token: tokens.a.accessToken, body });
    const j = (r.ok ? r.json : {}) as { id?: string; init_point?: string };
    prefId = j.id ?? "";
    const past = buildChargePreference({
      charge: { id: `${chargeId}x`, amountCents: 100 },
      tenantName: "Consultorio de diagnóstico",
      mode: "LINK",
      notificationUrl: connectNotificationUrl(FAKE.appUrl, "diag-acct-ref-0000000000"),
      backUrls: { success: `${FAKE.appUrl}/a`, failure: `${FAKE.appUrl}/b`, pending: `${FAKE.appUrl}/c` },
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r2 = await mpFetch("/checkout/preferences", { method: "POST", token: tokens.a.accessToken, body: past });
    const pastId = ((r2.ok ? r2.json : {}) as { id?: string }).id ?? "";
    let expiredRefused = false;
    try {
      await fakeMp.simulateFakePayment({ preferenceId: pastId, outcome: "approved" });
    } catch (e) {
      expiredRefused = e instanceof fakeMp.FakeMpError && e.code === "preference_expired";
    }
    return { pass: r.ok && !!prefId && !!j.init_point && expiredRefused, detail: `vencida ${expiredRefused ? "rechazada" : "PAGABLE"}` };
  });

  let paymentId = "";
  await step("S3", "el aviso del pago llega firmado con el secreto de NUESTRA app", async () => {
    const r = await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "approved" });
    paymentId = r.paymentId;
    const last = hooks[hooks.length - 1];
    return { pass: !!last && last.signatureOk, detail: `webhook ${r.webhookStatus}` };
  });

  await step("S5", "notifica la notification_url de la preferencia con ?acct=, data.id y type=payment", async () => {
    const last = hooks[hooks.length - 1];
    const pass =
      !!last &&
      last.url.searchParams.get("acct") === "diag-acct-ref-0000000000" &&
      last.url.searchParams.get("data.id") === paymentId &&
      last.url.searchParams.get("type") === "payment";
    return { pass };
  });

  await step("S10", "el pago trae collector_id, external_reference oc:<id>, ARS y el monto", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    const r = await mpFetch(`/v1/payments/${paymentId}`, { token: tokens.a.accessToken });
    const p = (r.ok ? r.json : {}) as Record<string, unknown>;
    const pass =
      r.ok &&
      String(p.collector_id) === tokens.a.userId &&
      p.external_reference === `oc:${chargeId}` &&
      p.currency_id === "ARS" &&
      p.transaction_amount === 1234.56;
    return { pass };
  });

  await step("S7", "con el token de OTRO vendedor el pago no aparece", async () => {
    const b = fakeMp.fakeMpIssueTokens(2, FAKE.clientId);
    tokens.b = { accessToken: b.accessToken };
    const r = await mpFetch(`/v1/payments/${paymentId}`, { token: b.accessToken });
    return { pass: !r.ok && r.kind === "http" && (r.status === 404 || r.status === 403), detail: `status ${!r.ok ? r.status : 200}` };
  });

  await step("S11", "un reintegro deja el pago refunded con el monto reintegrado", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "refunded" });
    const r = await mpFetch(`/v1/payments/${paymentId}`, { token: tokens.a.accessToken });
    const p = (r.ok ? r.json : {}) as Record<string, unknown>;
    return { pass: r.ok && p.status === "refunded" && p.transaction_amount_refunded === 1234.56 };
  });

  await step("S9", "PUT con expires en el pasado vence la preferencia", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    const r = await mpFetch(`/checkout/preferences/${encodeURIComponent(prefId)}`, {
      method: "PUT",
      token: tokens.a.accessToken,
      body: { expires: true, expiration_date_to: new Date(Date.now() - 60_000).toISOString() },
    });
    let refused = false;
    try {
      await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "approved" });
    } catch (e) {
      refused = e instanceof fakeMp.FakeMpError && e.code === "preference_expired";
    }
    return { pass: r.ok && refused };
  });

  await step("S8", "refresh rotativo: par nuevo y el refresh usado deja de servir", async () => {
    if (!tokens.a) return { pass: false, detail: "sin token de S2" };
    const r1 = await oauth.refreshTokens(tokens.a.refreshToken);
    const r2 = await oauth.refreshTokens(tokens.a.refreshToken);
    const pass =
      !("error" in r1) && r1.refreshToken !== tokens.a.refreshToken && r1.accessToken !== tokens.a.accessToken && "error" in r2 && r2.error === "invalid_grant";
    return { pass, detail: `reuso → ${"error" in r2 ? r2.error : "ACEPTADO"}` };
  });
}

// ── Sandbox (lo corre Martin) ───────────────────────────────────────────────────────────────────────────────────────

async function runSandbox(): Promise<number> {
  if (!hasFlag("sandbox") || (process.env.MP_CONNECT_MODE ?? "").trim().toLowerCase() !== "sandbox") {
    console.error(`[${NAME}] El sandbox pide MP_CONNECT_MODE=sandbox Y --sandbox (lo corre Martin al final, §25.15 paso 7).`);
    return 2;
  }
  if (process.env.VERCEL_ENV || process.env.VERCEL) {
    console.error(`[${NAME}] No corre dentro de Vercel.`);
    return 2;
  }
  const oauth = await import("../lib/mp-connect/oauth-client");
  const { mpFetch } = await import("../lib/mp-connect/http");
  const { pkceChallenge } = await import("../lib/mp-connect/oauth-state");
  const { buildChargePreference, connectNotificationUrl } = await import("../lib/mp-connect/preference");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (!appUrl || /localhost|127\.0\.0\.1/.test(appUrl)) {
    console.error(`[${NAME}] NEXT_PUBLIC_APP_URL tiene que ser la URL del túnel registrada en la app de MP.`);
    return 2;
  }

  const code = argValue("code");
  // Fuera del repo: el verifier no sirve sin el código, pero igual no tiene que terminar en un commit.
  const verifierFile = argValue("verifier-file") ?? join(tmpdir(), "kinesoft-mp-diag-verifier");
  if (!code) {
    const verifier = randomBytes(32).toString("base64url");
    const url = oauth.authorizationUrl({ state: randomBytes(12).toString("base64url"), codeChallenge: pkceChallenge(verifier) });
    if (!url) {
      check("S1", "URL de autorización", false, "faltan MP_OAUTH_CLIENT_ID/SECRET");
      return 1;
    }
    writeFileSync(verifierFile, verifier, { mode: 0o600 });
    console.log(`[S1] Abrí esta URL con el VENDEDOR de prueba, autorizá y copiá el ?code= de la vuelta:\n${url}`);
    console.log(`     (code_verifier guardado en ${verifierFile}, huella ${createHash("sha256").update(verifier).digest("hex").slice(0, 8)}). Después:`);
    console.log(`     … --sandbox --code <code> --verifier-file ${verifierFile}`);
    return 0;
  }
  const verifier = readFileSync(verifierFile, "utf8").trim();
  check("S1", "la autorización volvió con code (PKCE S256, redirect exacta)", true, "manual");

  const t = await oauth.exchangeCode({ code, codeVerifier: verifier });
  check("S2", "canje con code_verifier", !("error" in t), "error" in t ? t.error : `expires_in ${t.expiresIn}s, live_mode ${t.liveMode}`);
  if ("error" in t) return 1;
  const reuse = await oauth.exchangeCode({ code, codeVerifier: verifier });
  check("S2b", "el código es de un uso", "error" in reuse, "error" in reuse ? reuse.error : "REUSABLE");

  const me = await oauth.getMe(t.accessToken);
  check("S4", "/users/me con el token del vendedor", !("error" in me) && me.id === t.userId);

  const chargeId = `diag${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const body = buildChargePreference({
    charge: { id: chargeId, amountCents: 100 },
    tenantName: "Consultorio de diagnostico",
    mode: "LINK",
    notificationUrl: connectNotificationUrl(appUrl, "diag-sandbox-acct-00000"),
    backUrls: { success: `${appUrl}/pagar/diag?r=ok`, failure: `${appUrl}/pagar/diag?r=failed`, pending: `${appUrl}/pagar/diag?r=pending` },
    expiresAt: new Date(Date.now() + 2 * 3_600_000),
  });
  const pref = await mpFetch("/checkout/preferences", { method: "POST", token: t.accessToken, body });
  const pj = (pref.ok ? pref.json : {}) as { id?: string; sandbox_init_point?: string };
  check("S6", "preferencia con el token del vendedor", pref.ok && !!pj.id, pref.ok ? "" : `status ${pref.status ?? pref.kind}`);
  if (pj.sandbox_init_point) console.log(`     Pagá $1 con el COMPRADOR de prueba: ${pj.sandbox_init_point}`);

  const r1 = await oauth.refreshTokens(t.refreshToken);
  const r2 = await oauth.refreshTokens(t.refreshToken);
  check("S8", "refresh rotativo (el usado deja de servir)", !("error" in r1) && "error" in r2, "error" in r2 ? r2.error : "REUSABLE");

  check("S3", "aviso firmado con el secreto de nuestra app", null, "manual: mirá en el log del túnel mp_connect.webhook (firma ok/mismatch)");
  check("S5", "notifica la notification_url con ?acct=", null, "manual: el log tiene que mostrar acct=diag-sandbox-acct-00000");
  check("S7", "pago invisible con el token de otro vendedor", null, "manual: con el 2.º vendedor, GET /v1/payments/<id> → 404");
  check("S9", "PUT vence la preferencia", null, "manual: después de pagar, vencerla y probar de nuevo el link");
  check("S10", "collector_id, external_reference, ARS y monto", null, `manual: external_reference = oc:${chargeId}`);
  check("S11", "reintegro → refunded", null, "manual: reintegrá desde la cuenta del vendedor y mirá el log");
  return results.some((r) => r.pass === false) ? 1 : 0;
}

async function main(): Promise<number> {
  const mode = (process.env.MP_CONNECT_MODE ?? "").trim().toLowerCase();
  if (mode === "live") {
    console.error(`[${NAME}] Nunca contra MP en producción (MP_CONNECT_MODE=live).`);
    return 2;
  }
  if (mode === "sandbox" || hasFlag("sandbox")) return runSandbox();
  console.log(`[${NAME}] contra el MP FALSO (en el proceso; sin red, sin base, sin .env)`);
  await runFake();
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n${results.length - failed.length}/${results.length} supuestos ✓${failed.length ? ` · ✗ ${failed.map((f) => f.id).join(", ")}` : ""}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[${NAME}] error: ${err instanceof Error ? err.name : "desconocido"}`);
    process.exit(1);
  }
);
