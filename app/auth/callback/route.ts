import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
// OAuth callback, no Actor; tenant resolved by slug + Patient/PatientTenantLink
// writes → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

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
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";
  const tenantSlug = url.searchParams.get("tenant");
  if (!code) return NextResponse.redirect(`${url.origin}/login?error=missing_code`);

  const supabase = getSupabaseServerClient();
  const { data: session, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !session.user) {
    return NextResponse.redirect(`${url.origin}/login?error=${encodeURIComponent(error?.message ?? "oauth")}`);
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
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (tenant) {
      const patient = await prisma.patient.findFirst({
        where: { tenantId: tenant.id, email: user.email.toLowerCase() },
        select: { id: true, userId: true },
      });
      // Only link if this Patient row has no userId yet OR is already
      // bound to this same user. Refuses to "steal" a Patient already
      // linked to another Supabase identity.
      if (patient && (patient.userId == null || patient.userId === user.id)) {
        await prisma.patient.update({
          where: { id: patient.id },
          data: { userId: user.id },
        });
        await prisma.patientTenantLink.upsert({
          where: { patientId_tenantId: { patientId: patient.id, tenantId: tenant.id } },
          create: { patientId: patient.id, tenantId: tenant.id },
          update: {},
        });
      } else if (patient && patient.userId && patient.userId !== user.id) {
        logger.warn("portal.link.refused", {
          tenantSlug,
          email: user.email,
          reason: "patient already linked to a different identity",
        });
      }
    }
  } else if (tenantSlug && !emailVerified) {
    logger.warn("portal.link.refused", {
      tenantSlug,
      email: user.email,
      reason: "email_not_confirmed",
    });
  }

  return NextResponse.redirect(`${url.origin}${next}`);
}
