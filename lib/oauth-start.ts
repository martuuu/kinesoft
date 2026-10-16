import "server-only";
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";

/**
 * PL-2e (C-PL12, plan §20.5.8) · arranque común del login/alta con un proveedor OAuth de Supabase.
 *
 * Lo usan `POST /api/auth/oauth/[provider]` (Google y Facebook, login y signup de VX) y el alias viejo
 * `POST /api/auth/google` (sin llamadores desde VX-Z; queda por páginas cacheadas). Antes la lógica vivía solo en la ruta de
 * Google; al sumar Facebook se movió acá para que las dos rutas tengan exactamente los mismos controles:
 *   - allowlist de proveedores (`OAUTH_PROVIDERS`): un `[provider]` cualquiera nunca llega a Supabase;
 *   - Origin propio (login CSRF: un sitio ajeno no puede arrancar un login a una cuenta suya);
 *   - rate limit por IP compartido entre proveedores (`oauth:<ip>`, 10/min, igual que antes);
 *   - `next` por `safeNext` (el callback lo vuelve a validar);
 *   - proveedor apagado en Supabase → `provider_disabled` (ver `isProviderEnabled`);
 *   - errores al login como CÓDIGO (`/login?error=…`), nunca el texto de Supabase.
 * Sin `prompt=consent` / `access_type=offline` (A3b-S-auth): pedían un refresh token del proveedor que no se usa
 * (la sesión es la de Supabase) y forzaban el consentimiento en cada login.
 */

export const OAUTH_PROVIDERS = ["google", "facebook"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function parseOAuthProvider(raw: string | null | undefined): OAuthProvider | null {
  return (OAUTH_PROVIDERS as readonly string[]).includes(raw ?? "") ? (raw as OAuthProvider) : null;
}

export type OAuthStartError = "oauth_failed" | "rate_limited" | "provider_disabled";

/** 303 al login con el código; conserva `next` (salvo el default) para que el reintento vuelva al mismo lugar. */
export function oauthBackToLogin(req: Request, error: OAuthStartError, next: string): NextResponse {
  const u = new URL("/login", req.url);
  u.searchParams.set("error", error);
  if (next !== "/dashboard") u.searchParams.set("next", next);
  return NextResponse.redirect(u, { status: 303 });
}

// ── ¿Está prendido el proveedor en Supabase? ─────────────────────────────

/**
 * Por qué hace falta: `signInWithOAuth` de supabase-js NO habla con GoTrue, solo arma la URL de
 * `/auth/v1/authorize`. Si el proveedor está apagado en el dashboard, GoTrue contesta esa URL con un JSON 400
 * («Unsupported provider: provider is not enabled») EN EL NAVEGADOR de la persona: pantalla cruda, sin volver al
 * login. Se consulta antes `GET /auth/v1/settings` (público, con la anon key), que lista `external.<provider>`.
 *
 * Cache en memoria 60 s por instancia (la config cambia a mano, rara vez). Si la consulta falla (red, timeout,
 * forma rara) devuelve `null` = no se sabe y el login sigue: es una comodidad de UX, no un control de seguridad,
 * y un Supabase caído hace fallar el login de todos modos.
 *
 * Caché negativo de 15 s (VX-Z B5): un fallo también se recuerda, y mientras dura se devuelve `null` sin volver a
 * consultar. Sin él, con GoTrue caído o lento cada render del login/signup/turnero esperaba de nuevo el timeout de
 * 1,5 s por proveedor (`visibleOAuthProviders` los consulta en serie). Más corto que el positivo para que, cuando
 * GoTrue vuelve, el apagado se note rápido.
 */
const SETTINGS_TTL_MS = 60_000;
const SETTINGS_FAIL_TTL_MS = 15_000;
let settingsCache: { at: number; external: Record<string, boolean> } | null = null;
let settingsFailedAt: number | null = null;

function settingsFailed(now: number): null {
  settingsFailedAt = now;
  return null;
}

export async function isProviderEnabled(provider: OAuthProvider, now = Date.now()): Promise<boolean | null> {
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.external[provider] === true;
  if (settingsFailedAt !== null && now - settingsFailedAt < SETTINGS_FAIL_TTL_MS) return null;
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: key },
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      logger.warn("auth.oauth.settings_failed", { status: res.status });
      return settingsFailed(now);
    }
    const body = (await res.json()) as { external?: unknown };
    const ext = body?.external;
    if (!ext || typeof ext !== "object") {
      logger.warn("auth.oauth.settings_failed", { status: res.status, reason: "shape" });
      return settingsFailed(now);
    }
    const external: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(ext as Record<string, unknown>)) external[k] = v === true;
    settingsCache = { at: now, external };
    settingsFailedAt = null;
    return external[provider] === true;
  } catch (err) {
    logger.warn("auth.oauth.settings_failed", { message: err instanceof Error ? err.message : "unknown" });
    return settingsFailed(now);
  }
}

/** Solo tests: vacía la cache de `/auth/v1/settings` (la positiva y la negativa). */
export function __resetOAuthSettingsCacheForTests(): void {
  settingsCache = null;
  settingsFailedAt = null;
}

// ── Arranque ─────────────────────────────────────────────────────────────

/**
 * Arranca el flujo OAuth de `provider` para la request (form POST). Devuelve un 303 a Supabase/proveedor, un
 * 303 al login con el código de error, o 403 si el Origin es ajeno.
 */
export async function startOAuth(req: Request, provider: OAuthProvider): Promise<NextResponse> {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return new NextResponse("Origen no permitido.", { status: 403 });
  }

  // Form POST → 303 al login con `?error=rate_limited` (A3a-S-rl §4), no un 429 en texto plano.
  const rl = await rateLimit(`oauth:${clientIp(req.headers)}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return oauthBackToLogin(req, "rate_limited", next);

  if ((await isProviderEnabled(provider)) === false) {
    logger.warn("auth.oauth.provider_disabled", { provider });
    return oauthBackToLogin(req, "provider_disabled", next);
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=${encodeURIComponent(next)}`,
      // Sin `scopes`: GoTrue ya pide `email` a Facebook (y `public_profile` va siempre). Sumar scopes acá se
      // CONCATENA a los de GoTrue con su propio separador y puede romper el pedido. Si la persona niega el email
      // (o su cuenta de Facebook es por teléfono) el callback corta con `oauth_no_email` (H-PL2).
    },
  });
  if (error || !data.url) {
    logger.warn("auth.oauth.start_failed", { provider, message: error?.message ?? "no_url" });
    return oauthBackToLogin(req, "oauth_failed", next);
  }
  return NextResponse.redirect(data.url, { status: 303 });
}
