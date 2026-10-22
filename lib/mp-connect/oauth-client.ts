import "server-only";
import { env, mpConnectMode } from "@/lib/env";
import { MP_OAUTH_TOKEN_PATH, MP_USERS_ME_PATH, mpHostsFor, mpRedirectUri } from "@/lib/mp-connect/constants";
import { buildAuthorizationUrl } from "@/lib/mp-connect/oauth-state";
import { mpAppUrl, mpFetch, type MpFetchResult } from "@/lib/mp-connect/http";

/**
 * OAuth de vendedores de Mercado Pago (T5 TP-P4, C-TP3; doc de MP «OAuth», brief §25.2 #9).
 *
 * - Autorización con PKCE S256 (activado en la app de MP) y `redirect_uri` EXACTA (`mpRedirectUri`).
 * - Canje del código (10 min, un uso) y refresh rotativo (`offline_access`, token de 180 días): el refresh viejo deja
 *   de servir apenas se usa, así que quien refresca tiene que guardar el par nuevo en la misma operación (CAS sobre
 *   `version` en `account-client.ts`).
 * - `test_token=true` en sandbox: sin él MP emite un token productivo aunque la cuenta sea de prueba.
 *
 * Los tokens solo viajan en el valor de retorno: nada de esto los loguea (`mpFetch` tampoco).
 */
export type MpTokenSet = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  publicKey: string | null;
  expiresIn: number;
  liveMode: boolean;
};
export type MpOAuthError = { error: "invalid_grant" | "network" | "bad_response" };

/** Client id vigente (leído en cada llamada). En `fake` sin client id se usa uno fijo: el simulador no lo verifica contra nada real. */
function clientCredentials(): { clientId: string; clientSecret: string } | null {
  const id = process.env.MP_OAUTH_CLIENT_ID?.trim() || env.MP_OAUTH_CLIENT_ID;
  const secret = process.env.MP_OAUTH_CLIENT_SECRET?.trim() || env.MP_OAUTH_CLIENT_SECRET;
  if (id && secret) return { clientId: id, clientSecret: secret };
  if (mpConnectMode() === "fake") return { clientId: id || "kinesoft-fake-app", clientSecret: secret || "kinesoft-fake-secret" };
  return null;
}

/**
 * URL de autorización para el modo vigente. Devuelve null con el modo `off` o sin credenciales de la app: el caller
 * (`startMpConnect`) lo traduce a «Mercado Pago no está disponible», nunca a una URL a medias.
 */
export function authorizationUrl(o: { state: string; codeChallenge: string }): string | null {
  const mode = mpConnectMode();
  const creds = clientCredentials();
  if (mode === "off" || !creds) return null;
  const appUrl = mpAppUrl();
  return buildAuthorizationUrl({
    authUrl: mpHostsFor(mode, appUrl).authUrl,
    clientId: creds.clientId,
    redirectUri: mpRedirectUri(appUrl),
    state: o.state,
    codeChallenge: o.codeChallenge,
  });
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Clasifica la respuesta del endpoint de token. 400/401 con `invalid_grant` = código/refresh vencido, usado o revocado. */
function toTokenSet(r: MpFetchResult): MpTokenSet | MpOAuthError {
  if (!r.ok) {
    if (r.kind !== "http") return { error: "network" };
    // 5xx/429: MP caído o limitando; reintentable, no es culpa del grant.
    if (r.status === undefined || r.status >= 500 || r.status === 429) return { error: "network" };
    const body = (r.json ?? {}) as Record<string, unknown>;
    const code = String(body.error ?? body.code ?? "").toLowerCase();
    return code === "invalid_grant" ? { error: "invalid_grant" } : { error: "bad_response" };
  }
  const j = (r.json ?? {}) as Record<string, unknown>;
  const accessToken = str(j.access_token);
  const refreshToken = str(j.refresh_token);
  const userId = str(j.user_id);
  const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : null;
  if (!accessToken || !refreshToken || !userId || expiresIn === null) return { error: "bad_response" };
  return {
    accessToken,
    refreshToken,
    userId,
    publicKey: str(j.public_key),
    expiresIn,
    liveMode: j.live_mode === true,
  };
}

function tokenBody(extra: Record<string, string>): Record<string, unknown> | null {
  const creds = clientCredentials();
  if (!creds) return null;
  const body: Record<string, unknown> = {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    ...extra,
  };
  if (mpConnectMode() === "sandbox") body.test_token = true;
  return body;
}

export async function exchangeCode(o: { code: string; codeVerifier: string }): Promise<MpTokenSet | MpOAuthError> {
  const body = tokenBody({
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: mpRedirectUri(mpAppUrl()),
    code_verifier: o.codeVerifier,
  });
  if (!body) return { error: "network" };
  return toTokenSet(await mpFetch(MP_OAUTH_TOKEN_PATH, { method: "POST", body }));
}

export async function refreshTokens(refreshToken: string): Promise<MpTokenSet | MpOAuthError> {
  const body = tokenBody({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (!body) return { error: "network" };
  return toTokenSet(await mpFetch(MP_OAUTH_TOKEN_PATH, { method: "POST", body }));
}

/** Nickname de la cuenta (lo que se muestra en «Conectada como …»). `id` para cruzar con el `user_id` del canje. */
export async function getMe(
  accessToken: string
): Promise<{ nickname: string; id: string | null } | { error: "unauthorized" | "network" | "bad_response" }> {
  const r = await mpFetch(MP_USERS_ME_PATH, { token: accessToken });
  if (!r.ok) {
    if (r.kind === "http" && (r.status === 401 || r.status === 403)) return { error: "unauthorized" };
    return { error: r.kind === "http" && (r.status ?? 0) < 500 ? "bad_response" : "network" };
  }
  const j = (r.json ?? {}) as Record<string, unknown>;
  const nickname = str(j.nickname);
  if (!nickname) return { error: "bad_response" };
  return { nickname: nickname.slice(0, 120), id: str(j.id) };
}
