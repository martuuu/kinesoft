import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase/server";
// Sin Actor todavía (el usuario recién verifica): upsert del UserProfile por
// el canal service, igual que /auth/callback. See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { confirmContinuePath, isConfirmPostAllowed, parseConfirmParams } from "@/lib/auth-confirm-internal";
import { RECOVERY_COOKIE, RECOVERY_TTL_S, makeRecoveryCookieValue } from "@/lib/recovery-cookie";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { linkPortalPatientsOnSignIn } from "@/lib/portal-link-internal";
import { ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_COOKIE_OPTIONS } from "@/lib/active-tenant-cookie";

export const runtime = "nodejs";

/**
 * Landing de los links de email con `token_hash` (A3b-S-auth; resistente a escáneres desde IAM-2c).
 *
 * Quién arma el link: desde IAM-2c la APP (`lib/identity/access-link.ts#buildConfirmUrl`, mail propio por
 * `lib/email`): `${APP_URL}/auth/confirm?token_hash=…&type=…&next=…`. Los links viejos de las plantillas
 * de Supabase tienen la misma forma y siguen funcionando.
 *   - `type`: `signup` / `email` (confirmación de alta), `invite`, `recovery`, `magiclink`. Otro → inválido.
 *   - `next`: path propio o URL absoluta de la app; se sanea siempre (default `/reset` en recovery,
 *     `/dashboard` en el resto). Ver `lib/auth-confirm-internal.ts#parseConfirmParams`.
 *
 * IAM-2c · GET → `/auth/confirm/continuar` → POST. Outlook Safe Links (y otros escáneres) abren el link
 * antes que la persona: si el GET canjeaba, el escáner gastaba el token y la persona veía «el link venció».
 *   - GET: valida la forma y redirige (303) a la página intermedia. NO llama a `verifyOtp`.
 *   - POST (el form de esa página, que se manda solo): chequea el origen, canjea, deja la sesión en
 *     cookies y redirige (303 → el navegador sigue con GET) a `next`.
 *
 * Por qué `token_hash` + `verifyOtp` y no el `?code=` de PKCE: el code de PKCE solo se canjea en el MISMO
 * browser que pidió el mail (el verifier vive en una cookie de ese browser), y la gente abre el mail en el
 * celular → "link inválido". `verifyOtp` no depende de eso.
 *
 * En `recovery` además deja la cookie firmada `ks_recovery` (15 min, httpOnly): es la que habilita a
 * /reset a cambiar la clave SIN pedir la actual (A3c-S-signup; AUDIT §5.20, contrato en
 * `lib/recovery-cookie.ts`). Solo acá y solo tras un `verifyOtp` de recovery exitoso.
 */

function allowedOrigins(url: URL): string[] {
  return [url.origin, env.NEXT_PUBLIC_APP_URL];
}

// `type` (opcional) le dice al login qué salida ofrecer: «olvidé mi contraseña» o «reenviar confirmación» (IAM-2d).
function invalid(url: URL, type?: string): NextResponse {
  const u = new URL("/login?error=link_invalid", url.origin);
  if (type === "recovery") u.searchParams.set("link", "recovery");
  else if (type === "signup" || type === "email") u.searchParams.set("link", "signup");
  return NextResponse.redirect(u, 303);
}

/** GET: NO canjea. Lleva a la página intermedia con los parámetros ya saneados. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = parseConfirmParams((k) => url.searchParams.get(k), allowedOrigins(url));
  if (!params) return invalid(url);
  const res = NextResponse.redirect(new URL(confirmContinuePath(params), url.origin), 303);
  // El token viaja en la URL: que ningún intermediario lo cachee ni salga como Referer a otro sitio.
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

/** POST: el form de `/auth/confirm/continuar`. Canjea el token, abre la sesión y redirige a `next`. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const origins = allowedOrigins(url);
  if (!isConfirmPostAllowed(req.headers, origins)) {
    // Un form de otro sitio con un token del atacante dejaría a la víctima logueada en la cuenta ajena.
    logger.warn("auth.confirm.origin_rejected", {
      origin: req.headers.get("origin") === "null" ? "null" : req.headers.get("origin") ? "otro" : "ausente",
      secFetchSite: req.headers.get("sec-fetch-site") ?? "ausente",
    });
    return invalid(url);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return invalid(url);
  }
  const params = parseConfirmParams((k) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  }, origins);
  if (!params) return invalid(url);
  const type = params.type as EmailOtpType;

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: params.tokenHash });
  if (error || !data.user) {
    // Vencido, ya usado, o de otro proyecto. Desde IAM-2c un escáner ya no lo gasta (solo hace GET).
    logger.warn("auth.confirm.failed", { type, message: error?.message ?? "no_user" });
    return invalid(url, type);
  }
  const user = data.user;

  // Mismo upsert que /auth/callback: el resto de la app asume que el
  // UserProfile existe para toda identidad con sesión.
  await prisma.userProfile.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      email: (user.email ?? "").toLowerCase(),
      fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
      avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
    },
    update: { email: (user.email ?? "").toLowerCase() },
  });

  // IAM-3c: el magic link del portal vincula la ficha (Patient.userId) del consultorio del `next` (§5.8). Nunca tira.
  await linkPortalPatientsOnSignIn({ id: user.id, email: user.email, emailVerified: !!user.email_confirmed_at }, params.next);
  // Decisión 6 (14-oct): todo inicio de sesión limpia el consultorio activo; si hay más de uno, la app pregunta.
  cookies().set(ACTIVE_TENANT_COOKIE, "", { ...ACTIVE_TENANT_COOKIE_OPTIONS, maxAge: 0 });

  if (type === "recovery") {
    cookies().set(RECOVERY_COOKIE, makeRecoveryCookieValue(user.id), {
      path: "/",
      httpOnly: true,
      secure: SUPABASE_COOKIE_OPTIONS.secure,
      sameSite: "lax",
      maxAge: RECOVERY_TTL_S,
    });
  }

  // 303: el navegador sigue con un GET (un 307 repetiría el POST en el destino).
  return NextResponse.redirect(new URL(params.next, url.origin), 303);
}
