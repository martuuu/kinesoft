import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
// OAuth callback, no Actor; tenant resolved by slug + Patient/PatientTenantLink
// writes → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { safeNext } from "@/lib/safe-next";
import { linkPortalPatientOnCallback } from "@/lib/portal-link-internal";

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
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  const tenantSlug = url.searchParams.get("tenant");
  if (!code) return NextResponse.redirect(`${url.origin}/login?error=missing_code`);

  const supabase = getSupabaseServerClient();
  const { data: session, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !session.user) {
    logger.warn("auth.callback.exchange_failed", { message: error?.message ?? "no_user" });
    return NextResponse.redirect(`${url.origin}/login?error=oauth_failed`);
  }
  const user = session.user;
  const emailVerified = !!user.email_confirmed_at;

  await prisma.userProfile.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      email: user.email ?? "",
      fullName: user.user_metadata?.full_name ?? null,
      avatarUrl: user.user_metadata?.avatar_url ?? null,
    },
    update: {
      email: user.email ?? "",
      fullName: user.user_metadata?.full_name ?? undefined,
      avatarUrl: user.user_metadata?.avatar_url ?? undefined,
    },
  });

  if (tenantSlug && user.email && emailVerified) {
    // IAM-0a: la vinculación vive en `lib/portal-link-internal.ts` (testeable
    // contra Postgres; una ruta de Next no puede exportar helpers).
    await linkPortalPatientOnCallback({ id: user.id, email: user.email, emailVerified }, tenantSlug);
  } else if (tenantSlug && !emailVerified) {
    logger.warn("portal.link.refused", {
      tenantSlug,
      email: user.email,
      reason: "email_not_confirmed",
    });
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
