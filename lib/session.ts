/**
 * Session / current-actor helpers.
 *
 * Authentication model (post-Sprint 11):
 *
 *   1. Supabase auth gives us `user.id` + `user.email`.
 *   2. We look up the user's `Membership` rows. Active members can switch
 *      between tenants via the `kine_tenant` cookie — but only across
 *      tenants they belong to. The cookie is validated, not trusted.
 *   3. If no cookie, we use the most recently invited membership as the
 *      default active tenant.
 *
 * The `x-tenant-slug` request header is **explicitly ignored** here. The
 * middleware sets it for public routes (`/c/<slug>/…`, subdomains), but
 * that header is for tenant resolution on public surfaces — never for
 * authentication. Reading it would be a cross-tenant takeover vector.
 *
 * Dev/demo fallback: when explicitly enabled via `KINESOFT_ALLOW_DEMO_ACTOR=1`
 * (set in `.env.local` only, never in production), a missing session falls
 * through to the demo tenant + first practitioner. This lets local dev
 * keep working without spinning up Supabase. It is **off by default**.
 *
 * Public API:
 *   - `getActor()`     — throws UnauthenticatedError if no session. The
 *                        canonical call for server actions and protected
 *                        routes. Keeps the pre-existing signature.
 *   - `tryGetActor()`  — returns null instead of throwing. For surfaces
 *                        that can render a "please sign in" state.
 */
import { cookies, headers } from "next/headers";
import { cache } from "react";
// buildActor/buildDemoActor DISCOVER the tenant (unfiltered membership lookup)
// before any Actor exists → no GUC can be set → they must use the BYPASSRLS
// service channel, or the flip to the app role locks out every login.
import { prismaService } from "@/lib/db";
import { withTenantDb, type DbClient } from "@/lib/rls";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ensureRequestContext } from "@/lib/request-context";

export type Actor = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  practitionerId: string;
  practitionerName: string;
  userId: string;
};

export class UnauthenticatedError extends Error {
  constructor(public reason: "no_session" | "no_membership" = "no_session") {
    super(reason);
    this.name = "UnauthenticatedError";
  }
}

const DEMO_ALLOWED =
  process.env.KINESOFT_ALLOW_DEMO_ACTOR === "1" &&
  process.env.NODE_ENV !== "production";

async function buildActor(input: {
  userId: string;
  desiredTenantSlug?: string | null;
}): Promise<Actor> {
  const memberships = await prismaService.membership.findMany({
    where: { userId: input.userId, acceptedAt: { not: null } },
    include: { tenant: true },
    orderBy: { invitedAt: "desc" },
  });
  if (memberships.length === 0) {
    throw new UnauthenticatedError("no_membership");
  }

  // Respect the cookie only if the user is actually a member of that tenant.
  const desired = input.desiredTenantSlug?.toLowerCase();
  const chosen =
    (desired && memberships.find((m) => m.tenant.slug === desired)) ||
    memberships[0];

  const prac = await prismaService.practitioner.findFirst({
    where: { tenantId: chosen.tenantId, userId: input.userId },
    include: { user: true },
  });
  if (!prac) {
    throw new UnauthenticatedError("no_membership");
  }

  return {
    tenantId: chosen.tenantId,
    tenantSlug: chosen.tenant.slug,
    tenantName: chosen.tenant.name,
    practitionerId: prac.id,
    practitionerName: prac.user.fullName ?? prac.user.email,
    userId: input.userId,
  };
}

async function buildDemoActor(): Promise<Actor | null> {
  const tenant = await prismaService.tenant.findFirst({ where: { slug: "movare" } });
  if (!tenant) return null;
  const prac = await prismaService.practitioner.findFirst({
    where: { tenantId: tenant.id },
    include: { user: true },
  });
  if (!prac) return null;
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    practitionerId: prac.id,
    practitionerName: prac.user.fullName ?? prac.user.email,
    userId: prac.userId,
  };
}

async function resolveActor(): Promise<Actor | null> {
  const c = cookies();
  try {
    const supabase = getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    if (data.user?.id) {
      return await buildActor({
        userId: data.user.id,
        desiredTenantSlug: c.get("kine_tenant")?.value ?? null,
      });
    }
  } catch (err) {
    if (!(err instanceof UnauthenticatedError)) throw err;
  }
  if (DEMO_ALLOWED) {
    return buildDemoActor();
  }
  return null;
}

const cachedResolve = cache(async (): Promise<Actor | null> => {
  const actor = await resolveActor();
  if (actor) {
    const h = headers();
    ensureRequestContext({
      tenantId: actor.tenantId,
      userId: actor.userId,
      practitionerId: actor.practitionerId,
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: h.get("user-agent") ?? undefined,
      // Minted by middleware; safe to trust because middleware strips
      // any client-supplied value and re-mints if absent.
      requestId: h.get("x-request-id") ?? undefined,
    });
  }
  return actor;
});

/**
 * Returns the active actor; **throws `UnauthenticatedError`** when there is
 * no session. This is the canonical call for server actions and protected
 * routes. Surfaces that need to render a "please sign in" card should call
 * `tryGetActor()` instead.
 */
export async function getActor(): Promise<Actor> {
  const a = await cachedResolve();
  if (!a) throw new UnauthenticatedError("no_session");
  return a;
}

/** Variant that returns null instead of throwing. */
export async function tryGetActor(): Promise<Actor | null> {
  return cachedResolve();
}

/** Backwards-compatible alias. */
export async function requireActor(): Promise<Actor> {
  return getActor();
}

/**
 * Ownership helper used by mutating server actions.
 *
 * Patterns like
 *
 *     const owned = await prisma.patient.findFirst({
 *       where: { id: patientId, tenantId: actor.tenantId },
 *       select: { id: true },
 *     });
 *     if (!owned) return { ok: false, error: "..." };
 *
 * recur dozens of times across `lib/`. `requireOwned` collapses them:
 *
 *     const actor = await getActor();
 *     await requireOwned("patient", patientId, actor);
 *
 * Throws `NotFoundError` when the row doesn't exist in the actor's
 * tenant. Server actions can catch it and translate to an ActionResult.
 *
 * Returns the row so the caller can use any selected fields without a
 * second round trip — pass `select` to narrow the payload.
 */
import { prisma as _prisma } from "@/lib/db";

export class NotFoundError extends Error {
  constructor(public model: string, public id: string) {
    super(`${model}:${id} not found in active tenant`);
    this.name = "NotFoundError";
  }
}

type OwnedDelegates = {
  patient: typeof _prisma.patient;
  booking: typeof _prisma.booking;
  service: typeof _prisma.service;
  practitioner: typeof _prisma.practitioner;
  treatmentProgram: typeof _prisma.treatmentProgram;
  planTemplate: typeof _prisma.planTemplate;
  patientFile: typeof _prisma.patientFile;
};
type OwnedModel = keyof OwnedDelegates;

/**
 * Walks Prisma to a tenant-scoped row by `id`. Throws if not found in
 * the actor's tenant. Use this instead of hand-rolled findFirst boilerplate.
 *
 * RLS (Ola B2): the models it probes are all tenant-scoped, so the read
 * self-primes a `runWithRls(actor.tenantId)` transaction. Callers already
 * inside a `runWithRls` must pass their `tx` as `opts.db` to avoid nesting.
 */
export async function requireOwned<M extends OwnedModel>(
  model: M,
  id: string,
  actor: Actor,
  opts: { select?: Record<string, boolean>; db?: DbClient } = {}
): Promise<{ id: string } & Record<string, unknown>> {
  const row = await withTenantDb(actor.tenantId, opts.db, (c) => {
    const delegate = (c as unknown as Record<
      string,
      {
        findFirst: (args: {
          where: { id: string; tenantId: string };
          select?: Record<string, boolean>;
        }) => Promise<({ id: string } & Record<string, unknown>) | null>;
      }
    >)[model];
    return delegate.findFirst({
      where: { id, tenantId: actor.tenantId },
      ...(opts.select ? { select: { id: true, ...opts.select } } : {}),
    });
  });
  if (!row) throw new NotFoundError(model, id);
  return row;
}
