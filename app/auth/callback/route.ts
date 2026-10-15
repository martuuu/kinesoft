import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
// OAuth callback, no Actor; tenant resolved by slug + Patient/PatientTenantLink
// writes → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { safeNext } from "@/lib/safe-next";
import { linkPortalPatientOnCallback, linkPortalPatientsOnSignIn } from "@/lib/portal-link-internal";
import { ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_COOKIE_OPTIONS } from "@/lib/active-tenant-cookie";
import { oauthCallbackErrorCode, oauthProfileFromUser } from "@/lib/identity/oauth-profile";

export const runtime = "nodejs";

/**
 * Supabase OAuth callback. Exchanges the `code` for a session, then
 * upserts the `UserProfile` row so app code can rely on the FK existing.
 *
 * Patient linking (portal flow):
 *   - Requires `email_confirmed_at` on the Supabase user — unverified
 *     identities are never linked to PHI.
 *   - Only links if the user has no other Patient linked yet in this
 *     tenant (prevents account-takeover by re-binding to a different
 *     Patient row via the same email).
 *   - A3b-S-auth: match de email case-insensitive (había fichas cargadas con
 *     mayúsculas que nunca vinculaban) y staff ≠ paciente: una identidad con
 *     Membership en cualquier consultorio no se vincula a una ficha (el
 *     portal la rechaza igual, ver `lib/portal.ts`).
 *   - `next` pasa por `safeNext`: antes `${origin}${next}` con
 *     `next=@evil.com` redirigía a `https://app…@evil.com` (open redirect).
 *     Los errores vuelven al login como código, no como `error.message`.
 *   - IAM-3c: el vínculo se deduce del `next` (`/portal` → cada consultorio
 *     con ficha de ese email; `/portal/c/<slug>` → ese) con
 *     `linkPortalPatientsOnSignIn`. Antes solo vinculaba con `?tenant=<slug>`,
 *     que nadie armaba (el botón de Google manda solo `next`): no vinculaba
 *     nunca. El `?tenant=` se sigue respetando por compatibilidad.
 *   - IAM-3c (decisión 6 de Martin, 14-oct): al iniciar sesión se BORRA la
 *     cookie del consultorio activo `kine_tenant`; con más de un consultorio
 *     usable la app pregunta a cuál entrar (IAM-3a/3b). Con el mismo path y
 *     flags con que se escribe, si no el navegador no la reemplaza.
 *   - PL-2e (C-PL12, H-PL2): sirve a Google y a Facebook. Nombre y avatar salen de
 *     `lib/identity/oauth-profile.ts` (cada proveedor usa claves distintas en `user_metadata`).
 *     SIN email no se crea `UserProfile` (antes `email: ""`: perfil inservible y, por el único de
 *     `email`, la segunda cuenta así tiraba 500): se cierra la sesión recién abierta y se vuelve al login
 *     con `oauth_no_email`. Si GoTrue vuelve con `?error=` se clasifica (`oauthCallbackErrorCode`) en vez
 *     de decir `missing_code`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  const tenantSlug = url.searchParams.get("tenant");
  if (!code) {
    const providerError = url.searchParams.get("error");
    if (providerError) {
      const errorCode = url.searchParams.get("error_code");
      const mapped = oauthCallbackErrorCode(providerError, errorCode, url.searchParams.get("error_description"));
      // Sin la descripción: es texto libre de GoTrue / del proveedor.
      logger.warn("auth.callback.provider_error", { error: providerError, errorCode, mapped });
      return NextResponse.redirect(`${url.origin}/login?error=${mapped}`);
    }
    return NextResponse.redirect(`${url.origin}/login?error=missing_code`);
  }

  const supabase = getSupabaseServerClient();
  const { data: session, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !session.user) {
    logger.warn("auth.callback.exchange_failed", { message: error?.message ?? "no_user" });
    return NextResponse.redirect(`${url.origin}/login?error=oauth_failed`);
  }
  const user = session.user;
  const profile = oauthProfileFromUser(user);
  if (!profile.email) {
    // H-PL2: Facebook registrado con teléfono o sin permiso de email. La identidad queda en Supabase sin
    // perfil nuestro; la sesión se cierra para que no quede nadie «logueado» sin UserProfile.
    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    logger.warn("auth.callback.no_email", {
      provider: profile.provider,
      ...(signOutError ? { signOutError: signOutError.message } : {}),
    });
    return NextResponse.redirect(`${url.origin}/login?error=oauth_no_email`);
  }
  const email = profile.email;
  const emailVerified = !!user.email_confirmed_at;

  await prisma.userProfile.upsert({
    where: { id: user.id },
    create: { id: user.id, email, fullName: profile.fullName, avatarUrl: profile.avatarUrl },
    // Sin nombre/avatar usable no se pisa lo que había (`undefined` = no tocar).
    update: { email, fullName: profile.fullName ?? undefined, avatarUrl: profile.avatarUrl ?? undefined },
  });

  if (tenantSlug && emailVerified) {
    // IAM-0a: la vinculación vive en `lib/portal-link-internal.ts` (testeable
    // contra Postgres; una ruta de Next no puede exportar helpers).
    await linkPortalPatientOnCallback({ id: user.id, email, emailVerified }, tenantSlug);
  } else if (emailVerified) {
    await linkPortalPatientsOnSignIn({ id: user.id, email, emailVerified }, next);
  } else if (tenantSlug && !emailVerified) {
    // IAM-3c: sin el email en claro (alcanza con el slug y el motivo).
    logger.warn("portal.link.refused", { tenantSlug, reason: "email_not_confirmed" });
  }

  const res = NextResponse.redirect(new URL(next, url.origin));
  res.cookies.set(ACTIVE_TENANT_COOKIE, "", { ...ACTIVE_TENANT_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}
