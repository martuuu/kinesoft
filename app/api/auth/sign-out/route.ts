import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";
import { clearActiveTenantCookie } from "@/lib/tenant-choice";
import { clearTwoFactorCookies } from "@/lib/two-factor-cookie";
import { endSupportSession } from "@/lib/support-session-internal";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Signs the current Supabase session out and bounces back to the
 * practitioner login. The patient portal (which has its own sign-out
 * form) can pass `?next=/portal` to override the destination.
 *
 * A3b-S-auth: `next` pasa por `safeNext` (antes `${APP_URL}${next}` con
 * `next=@evil.com` daba `https://app…@evil.com`) y se exige Origin propio
 * (un sitio ajeno no puede desloguear a nadie con un form auto-submit).
 */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return new NextResponse("Origen no permitido.", { status: 403 });
  }
  // BO2-E (decisión 3 de Martin): el soporte termina al cerrar sesión. ANTES del signOut (necesita el usuario de la
  // sesión) y sin bloquear el logout si falla: la fila quedaría abierta, pero la cookie se borra igual y sin cookie
  // el soporte ya no abre nada; la próxima «Entrar como soporte» la cierra como `replaced`.
  try {
    await endSupportSession("logout");
  } catch (err) {
    logger.warn("support.end_on_logout_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
  const supabase = getSupabaseServerClient();
  await supabase.auth.signOut();
  // IAM-3a: el consultorio elegido es de esta sesión; el próximo login (quizá otra cuenta) arranca sin él.
  clearActiveTenantCookie();
  // PL-2a: las pruebas de 2FA (`kine_2fa`, `kine_stepup`) ya no validarían (van ligadas al `session_id` que se
  // acaba de cerrar), pero no tienen por qué quedar en el browser de una PC compartida.
  clearTwoFactorCookies();
  const next = safeNext(new URL(req.url).searchParams.get("next"), "/login");
  return NextResponse.redirect(new URL(next, env.NEXT_PUBLIC_APP_URL), { status: 303 });
}
