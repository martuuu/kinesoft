/**
 * Session / current-actor helpers.
 *
 * Two paths today:
 *
 * 1) **Authenticated** — once Supabase auth is wired in production, the
 *    `kine_session` cookie set by `app/auth/callback` carries the user id.
 *    We hydrate `UserProfile` + active membership.
 *
 * 2) **Dev / demo** — when there is no session, we fall back to the demo
 *    tenant from the seed (`movare`) and its first practitioner. This lets
 *    the workspace screens read/write real data while the auth provider
 *    is being configured.
 *
 * The single export is `getActor()`. Server actions and server components
 * call it instead of touching cookies directly so the auth strategy can
 * evolve without touching every call site.
 */
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { ensureRequestContext } from "@/lib/request-context";

export type Actor = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  practitionerId: string;
  practitionerName: string;
  userId: string | null;
};

export const getActor = cache(async (): Promise<Actor> => {
  const c = cookies();
  const h = headers();
  const slugFromCookie = c.get("kine_tenant")?.value;
  const slugFromHeader = h.get("x-tenant-slug");
  const slug = slugFromCookie ?? slugFromHeader ?? "movare";

  let tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    tenant = await prisma.tenant.findFirst();
  }
  if (!tenant) throw new Error("No tenant exists. Run `npm run prisma:seed`.");

  const prac = await prisma.practitioner.findFirst({
    where: { tenantId: tenant.id },
    include: { user: true },
  });
  if (!prac) {
    throw new Error(
      `Tenant ${tenant.slug} has no practitioner. Seed should create one.`
    );
  }

  const actor: Actor = {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    practitionerId: prac.id,
    practitionerName: prac.user.fullName ?? prac.user.email,
    userId: prac.userId,
  };

  // Push into AsyncLocalStorage so the audit extension can attribute
  // PHI reads to the active actor. `ensureRequestContext` is idempotent
  // when something further up the stack already entered the context.
  ensureRequestContext({
    tenantId: actor.tenantId,
    userId: actor.userId,
    practitionerId: actor.practitionerId,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: h.get("user-agent") ?? undefined,
  });

  return actor;
});

export async function requireActor() {
  return getActor();
}
