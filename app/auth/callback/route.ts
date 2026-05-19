import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Supabase OAuth callback. Exchanges the `code` for a session, then
 * upserts the `UserProfile` row so app code can rely on the FK existing.
 *
 * For patients (portal flow) we also create a `Patient` if the email
 * matches and a `PatientTenantLink` for the tenant in `?tenant=`.
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

  // Patient portal: associate to a tenant if requested
  if (tenantSlug) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (tenant && user.email) {
      const patient = await prisma.patient.findFirst({
        where: { tenantId: tenant.id, email: user.email },
      });
      if (patient) {
        await prisma.patient.update({
          where: { id: patient.id },
          data: { userId: user.id },
        });
        await prisma.patientTenantLink.upsert({
          where: { patientId_tenantId: { patientId: patient.id, tenantId: tenant.id } },
          create: { patientId: patient.id, tenantId: tenant.id },
          update: {},
        });
      }
    }
  }

  return NextResponse.redirect(`${url.origin}${next}`);
}
