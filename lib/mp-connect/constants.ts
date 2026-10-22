/**
 * Constantes de «Conectar Mercado Pago» (T5 TP-P2, brief §25.4, Anexo B C-TP3).
 *
 * Puro y sin `env`: lo importan el server (oauth-client, account-client, fake) y los tests sin arrastrar la validación
 * del ENV. Quien necesita la URL de la app la pasa (`env.NEXT_PUBLIC_APP_URL`).
 *
 * Hosts: sandbox y live usan los MISMOS hosts de MP; lo que cambia es la app/credencial (`test_token=true` en el canje,
 * brief §25.2 hallazgo 9). El modo `fake` apunta al MP falso local (`/api/mp/fake`, C-TP12), que responde 404 salvo
 * `MP_CONNECT_MODE=fake` y sin `VERCEL_ENV`/`VERCEL`.
 *
 * CSP (hallazgo 10): `*.mercadopago.com` no matchea `auth.mercadopago.com.ar`; por eso la autorización usa
 * `auth.mercadopago.com` (el genérico, que MP redirige al sitio del país) y el cliente llega por navegación
 * (`location.assign`), nunca por form POST ni fetch desde el browser.
 */
export type MpConnectHostMode = "fake" | "sandbox" | "live";

export const MP_AUTH_URL = "https://auth.mercadopago.com/authorization";
export const MP_API_BASE = "https://api.mercadopago.com";
export const MP_FAKE_PATH = "/api/mp/fake";

export const MP_HTTP_TIMEOUT_MS = 8000;

/** Callback del OAuth. La `redirect_uri` tiene que coincidir EXACTA con la registrada en la app de MP. */
export const REDIRECT_PATH = "/api/mp/oauth/callback";
/** Path de la cookie `kine_mp_oauth`: solo viaja al callback, no a toda la app. */
export const MP_OAUTH_COOKIE_PATH = "/api/mp/oauth";

/** Endpoints de la API de MP usados por el OAuth (relativos a `apiBase`). */
export const MP_OAUTH_TOKEN_PATH = "/oauth/token";
export const MP_USERS_ME_PATH = "/users/me";

function trimSlash(appUrl: string): string {
  return appUrl.replace(/\/+$/, "");
}

/** Hosts por modo. En `fake`, la autorización es una página del MP falso dentro de la propia app. */
export function mpHostsFor(mode: MpConnectHostMode, appUrl: string): { authUrl: string; apiBase: string } {
  if (mode === "fake") {
    const base = `${trimSlash(appUrl)}${MP_FAKE_PATH}`;
    return { authUrl: `${base}/authorization`, apiBase: base };
  }
  return { authUrl: MP_AUTH_URL, apiBase: MP_API_BASE };
}

/** `redirect_uri` exacta (sin doble barra aunque `NEXT_PUBLIC_APP_URL` termine en `/`). */
export function mpRedirectUri(appUrl: string): string {
  return `${trimSlash(appUrl)}${REDIRECT_PATH}`;
}
