import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase/server";
// Sin Actor todavía (el usuario recién verifica): upsert del UserProfile por
// el canal service, igual que /auth/callback. See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeNextFromUrl, unwrapConfirmNext } from "@/lib/safe-next";
import { RECOVERY_COOKIE, RECOVERY_TTL_S, makeRecoveryCookieValue } from "@/lib/recovery-cookie";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";

export const runtime = "nodejs";

/**
 * Landing de los links de email de Supabase con `token_hash` (A3b-S-auth).
 *
 * Contrato con las plantillas de Supabase Auth (tarea del dueño, ver
 * EXTERNAL-CONFIG): `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<tipo>&next=<destino>`.
 *   - `type`: `signup` / `email` (confirmación de alta), `invite`,
 *     `recovery`, `magiclink`. Cualquier otro → link inválido.
 *   - `next`: path propio o URL absoluta de la app (`{{ .RedirectTo }}`); pasa
 *     por `safeNextFromUrl`. Default: `/reset` para recovery, `/dashboard`
 *     para el resto.
 *
 * Por qué `token_hash` + `verifyOtp` y no el `?code=` de PKCE: el code de
 * PKCE solo se puede canjear en el MISMO browser que pidió el mail (el
 * verifier vive en una cookie de ese browser). Con signup / reset la gente
 * abre el mail en el celular → "link inválido". `verifyOtp` no depende de eso.
 *
 * En `recovery` además deja la cookie firmada `ks_recovery` (15 min,
 * httpOnly): es la que habilita a /reset a cambiar la clave SIN pedir la
 * actual (A3c-S-signup). Contrato en `lib/recovery-cookie.ts`.
 */
const ALLOWED_TYPES = new Set<EmailOtpType>(["signup", "email", "invite", "recovery", "magiclink"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get("token_hash");
  const rawType = url.searchParams.get("type");
  const type = rawType && ALLOWED_TYPES.has(rawType as EmailOtpType) ? (rawType as EmailOtpType) : null;
  const fallback = type === "recovery" ? "/reset" : "/dashboard";
  // unwrapConfirmNext: un `next` que vuelve a /auth/confirm (links viejos con
  // emailRedirectTo=/auth/confirm?next=…) iría sin token_hash → link inválido.
  const next = unwrapConfirmNext(
    safeNextFromUrl(url.searchParams.get("next"), [url.origin, env.NEXT_PUBLIC_APP_URL], fallback),
    fallback
  );

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL("/login?error=link_invalid", url.origin));
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error || !data.user) {
    // Link vencido o ya usado (los scanners de mail a veces lo "abren" antes).
    logger.warn("auth.confirm.failed", { type, message: error?.message ?? "no_user" });
    return NextResponse.redirect(new URL("/login?error=link_invalid", url.origin));
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

  if (type === "recovery") {
    cookies().set(RECOVERY_COOKIE, makeRecoveryCookieValue(user.id), {
      path: "/",
      httpOnly: true,
      secure: SUPABASE_COOKIE_OPTIONS.secure,
      sameSite: "lax",
      maxAge: RECOVERY_TTL_S,
    });
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
