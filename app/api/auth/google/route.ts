import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";

export const runtime = "nodejs";

/**
 * Kicks off the Supabase Google OAuth flow. Used by the practitioner login
 * form, the patient portal sign-in button and the public booking wizard
 * (all three are form POSTs; the wizard used to be a GET link → 405).
 *
 * Supabase returns a one-time URL that opens the Google consent screen and
 * redirects back to `/auth/callback?code=...`.
 *
 * A3b-S-auth:
 *   - sin `prompt=consent` / `access_type=offline`: pedían un refresh token de
 *     GOOGLE (no lo usamos: la sesión es la de Supabase) y forzaban la
 *     pantalla de consentimiento en cada login;
 *   - `next` pasa por `safeNext` y el callback lo vuelve a validar;
 *   - Origin propio (login CSRF);
 *   - los errores vuelven al login como código, no como JSON crudo.
 */
function backToLogin(req: Request, error: string, next: string) {
  const u = new URL("/login", req.url);
  u.searchParams.set("error", error);
  if (next !== "/dashboard") u.searchParams.set("next", next);
  return NextResponse.redirect(u, { status: 303 });
}

export async function POST(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return new NextResponse("Origen no permitido.", { status: 403 });
  }

  // Form POST → 303 al login con `?error=rate_limited` (A3a-S-rl §4), no un
  // 429 en texto plano. Se conserva `next` para que el reintento vuelva al
  // mismo lugar (portal / turnero).
  const rl = await rateLimit(`oauth:${clientIp(req.headers)}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return backToLogin(req, "rate_limited", next);

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url) {
    logger.warn("auth.google.start_failed", { message: error?.message ?? "no_url" });
    return backToLogin(req, "oauth_failed", next);
  }
  return NextResponse.redirect(data.url, { status: 303 });
}
