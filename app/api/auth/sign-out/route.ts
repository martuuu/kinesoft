import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";
import { clearActiveTenantCookie } from "@/lib/tenant-choice";
import { clearTwoFactorCookies } from "@/lib/two-factor-cookie";
import { endSupportSession } from "@/lib/support-session-internal";
import { logger } from "@/lib/logger";
import { cookies } from "next/headers";
import { sessionModeCookie } from "@/lib/supabase/session-mode";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { IDLE_COOKIE } from "@/lib/idle-logout";
// Canal service: `PushSubscription` es SERVICE_ONLY (M21). El `userId` de la sesión va a mano en el WHERE.
import { prismaService } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";
import { PUSH_SUB_COOKIE } from "@/lib/web-push-types";

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
  await forgetThisBrowserPushDevice();
  const supabase = getSupabaseServerClient();
  // HD-2 (§27): con GoTrue caído (`/auth/v1/logout` 5xx, red cortada) supabase-js devuelve `{ error }` y NO borra la
  // sesión local (`_signOut` solo sigue de largo con 401/403/404): la persona tocaba «Cerrar sesión», llegaba al login
  // y seguía logueada en esa PC (el refresh token seguía en la cookie). El `.catch` cubre la versión que tira. En ese
  // caso se borran a mano TODAS las `sb-*` (los chunks `.0`/`.1` del token y el verificador de PKCE) con las mismas
  // opciones con que se escriben (`cookie-options.ts`: si path o flags no coinciden, el navegador no las pisa). La
  // sesión puede seguir viva en GoTrue hasta que venza el refresh token, pero ya no queda en este navegador.
  const { error } = await supabase.auth.signOut().catch((e: unknown) => ({ error: e }));
  if (error) {
    const e = error as { status?: unknown; name?: unknown };
    logger.warn("auth.sign_out_failed", {
      status: typeof e.status === "number" ? e.status : null,
      name: typeof e.name === "string" ? e.name : "unknown",
    });
    const { path, httpOnly, secure, sameSite } = SUPABASE_COOKIE_OPTIONS;
    for (const c of cookies().getAll()) {
      if (c.name.startsWith("sb-")) cookies().set(c.name, "", { path, httpOnly, secure, sameSite, maxAge: 0 });
    }
  }
  // IN (§27): la marca de actividad del cierre por inactividad es de esta sesión. Mismo path y SameSite con que la
  // escribe el cliente (`components/layout/idle-logout.tsx`); no httpOnly porque la escribe JS (el borrado igual
  // funciona: lo que tiene que coincidir es nombre + path + dominio).
  cookies().set(IDLE_COOKIE, "", {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  // IAM-3a: el consultorio elegido es de esta sesión; el próximo login (quizá otra cuenta) arranca sin él.
  clearActiveTenantCookie();
  // PL-2a: las pruebas de 2FA (`kine_2fa`, `kine_stepup`) ya no validarían (van ligadas al `session_id` que se
  // acaba de cerrar), pero no tienen por qué quedar en el browser de una PC compartida.
  clearTwoFactorCookies();
  // B5: al cerrar sesión se olvida «no mantener»; el próximo login decide de nuevo.
  const sessionPref = sessionModeCookie("persistent");
  cookies().set(sessionPref.name, sessionPref.value, sessionPref.options);
  const next = safeNext(new URL(req.url).searchParams.get("next"), "/login");
  return NextResponse.redirect(new URL(next, env.NEXT_PUBLIC_APP_URL), { status: 303 });
}

/**
 * CF2 (§29, D-CF2-12; brief T.C «Sign-out»): el dispositivo de push de ESTE navegador (cookie `ks_push_sub`, la deja
 * `savePushSubscription`) se borra al cerrar sesión. Si no, el celular o la PC compartida seguía recibiendo los avisos de
 * turnos de quien ya se fue (la suscripción del navegador sobrevive al logout). Cubre el cierre por inactividad: el
 * cliente postea a esta misma ruta.
 *
 * - ANTES del `signOut`: necesita el usuario de la sesión. `getSessionUser` (verificación local del JWT, sin red en el
 *   caso normal) y solo si hay cookie: un sign-out sin push no paga nada.
 * - `id` = cookie Y `userId` = usuario de la sesión: la cookie la puede pisar cualquiera en su navegador; con un id
 *   ajeno no borra nada. Sin sesión (token vencido) tampoco: queda la fila, que el sender descarta cuando el push
 *   service la rechace (404/410) o a las 5 fallas.
 * - Nunca rompe el sign-out: la base caída deja la fila, pero la sesión se cierra igual. El log no lleva el endpoint
 *   (es una URL-capacidad) ni el mensaje del error (Prisma puede citar valores).
 * - La cookie se limpia siempre, con las mismas opciones con que se escribe (si no coinciden, el navegador no la pisa).
 */
async function forgetThisBrowserPushDevice(): Promise<void> {
  const deviceId = cookies().get(PUSH_SUB_COOKIE)?.value ?? "";
  if (!deviceId) return;
  try {
    // Un cuid mide 25; el tope solo evita mandar basura larga a la base.
    const user = deviceId.length <= 64 ? await getSessionUser() : null;
    if (user) await prismaService.pushSubscription.deleteMany({ where: { id: deviceId, userId: user.id } });
  } catch (err) {
    logger.warn("push.sign_out_cleanup_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
  cookies().set(PUSH_SUB_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
