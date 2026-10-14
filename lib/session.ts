/**
 * Session / current-actor helpers.
 *
 * Authentication model (post-Sprint 11):
 *
 *   1. Supabase auth gives us `user.id` + `user.email` (`getVerifiedSessionUser`,
 *      lib/session-user.ts: un solo `auth.getUser()` por request).
 *   2. IAM-3a: se cargan TODAS las membresías del usuario (aceptadas o no, con
 *      `disabledAt`) y si tiene `Practitioner` en cada consultorio
 *      (`getAccessSnapshot`). Solo cuentan las USABLES (`lib/access-logic.ts`).
 *   3. Consultorio activo = `chooseActiveTenant`: la cookie `kine_tenant`
 *      (guarda el tenantId; se valida, nunca se confía) → `UserPreferences.tenantId`
 *      → la usable aceptada más recientemente. Una membresía rota se saltea:
 *      nunca tapa a una sana (bucle de redirecciones del 14-oct, §19.1).
 *   4. Decisión 6 de Martin (14-oct): con 2+ consultorios usables y sin cookie
 *      válida el layout pregunta a cuál entrar (`/elegir-consultorio`); el login
 *      borra la cookie para que pregunte en cada inicio de sesión.
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
import { getVerifiedSessionUser } from "@/lib/session-user";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import {
  isUsableMembership,
  resolveAccessState,
  type AccessState,
  type MembershipLite,
} from "@/lib/access-logic";
import { logger } from "@/lib/logger";
import { ensureRequestContext } from "@/lib/request-context";
import { clientIp } from "@/lib/client-ip";
import type { TenantEntitlements } from "@/lib/tenant-modules";

export type Actor = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  practitionerId: string;
  practitionerName: string;
  userId: string;
  // Platform superadmin (cross-tenant): authors the global exercise catalog +
  // the "Plataforma" owner panel. Orthogonal to the tenant-scoped Role.
  isPlatformAdmin: boolean;
  /**
   * EV0 (C-EV3): vertical + plan + switch del turnero del tenant ACTIVO, de la
   * misma fila de `Tenant` que `buildActor` ya trae (`include: { tenant: true }`),
   * sin query extra. Los módulos salen de acá (`modulesFor`, `lib/authz.ts`).
   * Se resuelve en cada request (sin cache entre requests): un cambio desde
   * /plataforma se ve en la próxima navegación.
   */
  entitlements: TenantEntitlements;
};

/** Solo las tres columnas: no se cuela el resto de la fila de Tenant en el Actor. */
function entitlementsOf(t: {
  vertical: TenantEntitlements["vertical"];
  plan: TenantEntitlements["plan"];
  publicBookingEnabled: boolean;
}): TenantEntitlements {
  return { vertical: t.vertical, plan: t.plan, publicBookingEnabled: t.publicBookingEnabled };
}

export class UnauthenticatedError extends Error {
  constructor(public reason: "no_session" | "no_membership" = "no_session") {
    super(reason);
    this.name = "UnauthenticatedError";
  }
}

/** Thrown when an authenticated actor lacks the required privilege. */
export class ForbiddenError extends Error {
  constructor(public reason = "forbidden") {
    super(reason);
    this.name = "ForbiddenError";
  }
}

const DEMO_ALLOWED =
  process.env.KINESOFT_ALLOW_DEMO_ACTOR === "1" &&
  process.env.NODE_ENV !== "production";

/**
 * Membresía tal como la ve el acceso (IAM-3a): la forma pura de `access-logic` + el `Practitioner` de ese
 * consultorio (si hay) + las columnas del tenant que el Actor, el gate y el selector necesitan. Incluye las NO
 * aceptadas y las deshabilitadas: `resolveAccessState` necesita verlas para decir POR QUÉ no hay acceso.
 */
export type AccessMembership = MembershipLite & {
  practitionerId: string | null;
  tenant: {
    id: string;
    slug: string;
    name: string;
    vertical: TenantEntitlements["vertical"];
    plan: TenantEntitlements["plan"];
    publicBookingEnabled: boolean;
    onboardingCompletedAt: Date | null;
  };
};

export type AccessProfile = { fullName: string | null; email: string; isPlatformAdmin: boolean };

/**
 * Todo lo que decide a qué consultorio entra una sesión, en una lectura (perfil con membresías y profesionales). Por `prismaService`: todavía no hay Actor ni GUC (ver import arriba), y el filtro es el
 * `userId` de la sesión verificada.
 */
export async function loadAccessMemberships(userId: string): Promise<{
  profile: AccessProfile | null;
  memberships: AccessMembership[];
  preferredTenantId: string | null;
}> {
  // Gate de IAM-3: la preferencia guardada (`UserPreferences.tenantId`) NO se lee acá. Con la decisión 6 de Martin
  // (cada login pregunta a qué consultorio entrar) la única fuente del consultorio activo es la cookie `kine_tenant`,
  // y leer la preferencia sumaba una sentencia a CADA request (rompía el techo estricto de createBooking: 34 → 35).
  const [profile] = await Promise.all([
    prismaService.userProfile.findUnique({
      where: { id: userId },
      select: {
        fullName: true,
        email: true,
        isPlatformAdmin: true,
        memberships: {
          select: {
            tenantId: true,
            role: true,
            acceptedAt: true,
            disabledAt: true,
            tenant: {
              select: {
                id: true,
                slug: true,
                name: true,
                vertical: true,
                plan: true,
                publicBookingEnabled: true,
                onboardingCompletedAt: true,
              },
            },
          },
        },
        practitioners: { select: { id: true, tenantId: true } },
      },
    }),
  ]);
  if (!profile) return { profile: null, memberships: [], preferredTenantId: null };
  // M6: Practitioner es único por (tenantId, userId), así que el mapa no pierde nada.
  const pracByTenant = new Map(profile.practitioners.map((p) => [p.tenantId, p.id]));
  const memberships = profile.memberships.map<AccessMembership>((m) => ({
    tenantId: m.tenantId,
    role: m.role,
    acceptedAt: m.acceptedAt,
    disabledAt: m.disabledAt,
    hasPractitioner: pracByTenant.has(m.tenantId),
    practitionerId: pracByTenant.get(m.tenantId) ?? null,
    tenant: m.tenant,
  }));
  return {
    profile: { fullName: profile.fullName, email: profile.email, isPlatformAdmin: profile.isPlatformAdmin },
    memberships,
    preferredTenantId: null,
  };
}

/** Foto del acceso de la sesión de este request (C-IAM7 la consume vía `lib/tenant-choice.ts`). */
export type AccessSnapshot = {
  userId: string;
  profile: AccessProfile | null;
  memberships: AccessMembership[];
  /** Usables (`isUsableMembership`), en el orden de la query. */
  usable: AccessMembership[];
  cookieTenantId: string | null;
  preferredTenantId: string | null;
  /** `kine_tenant` apunta a una membresía usable (si no, se ignora: nunca se confía). */
  cookieValid: boolean;
  state: AccessState;
};

function readActiveTenantCookie(): string | null {
  try {
    const v = cookies().get(ACTIVE_TENANT_COOKIE)?.value?.trim();
    return v ? v.slice(0, 64) : null;
  } catch {
    return null; // fuera de un request
  }
}

async function loadAccessSnapshot(): Promise<AccessSnapshot | null> {
  const user = await getVerifiedSessionUser();
  if (!user) return null;
  const { profile, memberships, preferredTenantId } = await loadAccessMemberships(user.id);
  const cookieTenantId = readActiveTenantCookie();
  const usable = memberships.filter((m) => isUsableMembership(m));
  // IAM-0c/IAM-3a: la cookie guarda el tenantId (antes se leía como slug y nadie la escribía).
  const cookieValid = !!cookieTenantId && usable.some((m) => m.tenantId === cookieTenantId);
  const state = resolveAccessState(memberships, { cookieTenantId, preferredTenantId });
  return { userId: user.id, profile, memberships, usable, cookieTenantId, preferredTenantId, cookieValid, state };
}

/**
 * Foto del acceso de la sesión verificada (null = sin sesión). Una por request (`cache`): el layout, el gate,
 * `getActor` y el selector de consultorio leen la misma, así no pueden discrepar entre sí dentro de un render.
 */
export const getAccessSnapshot: () => Promise<AccessSnapshot | null> = cache(loadAccessSnapshot);

/**
 * Actor a partir de la foto (IAM-3a). Antes tomaba la membresía aceptada invitada más recientemente y, si ahí no
 * había `Practitioner`, tiraba `no_membership` aunque hubiera otro consultorio sano: el layout mandaba a
 * /onboarding, que veía membresías y decía «done» → /dashboard → … (bucle del 14-oct, §19.1). Ahora elige entre
 * las USABLES (`chooseActiveTenant`: cookie → `UserPreferences.tenantId` → la aceptada más reciente) y solo tira
 * si no hay ninguna; las rotas se saltean y se loguean (para repararlas desde Plataforma / Usuarios).
 */
function buildActor(s: AccessSnapshot): Actor {
  for (const m of s.memberships) {
    if (m.acceptedAt && !m.disabledAt && !m.hasPractitioner && !isUsableMembership(m)) {
      logger.warn("session.membership.unusable", { userId: s.userId, tenantId: m.tenantId, reason: "missing_practitioner" });
    }
  }
  if (s.state.kind !== "ok" || !s.profile) {
    throw new UnauthenticatedError("no_membership");
  }
  const tenantId = s.state.tenantId;
  const chosen = s.memberships.find((m) => m.tenantId === tenantId);
  // `PRACTITIONER_FOR_ALL_ROLES` (IAM-4 lo apaga): hoy toda membresía usable tiene Practitioner y el Actor lo exige.
  if (!chosen || !chosen.practitionerId) throw new UnauthenticatedError("no_membership");
  return {
    tenantId,
    tenantSlug: chosen.tenant.slug,
    tenantName: chosen.tenant.name,
    practitionerId: chosen.practitionerId,
    practitionerName: s.profile.fullName ?? s.profile.email,
    userId: s.userId,
    isPlatformAdmin: s.profile.isPlatformAdmin,
    entitlements: entitlementsOf(chosen.tenant),
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
    isPlatformAdmin: prac.user.isPlatformAdmin,
    entitlements: entitlementsOf(tenant),
  };
}

async function resolveActor(): Promise<Actor | null> {
  const snapshot = await getAccessSnapshot();
  if (snapshot) {
    try {
      return buildActor(snapshot);
    } catch (err) {
      if (!(err instanceof UnauthenticatedError)) throw err;
      // IAM-3a: con sesión pero sin consultorio usable NO se cae al demo (antes sí): en dev eso mostraba el
      // consultorio demo a un usuario suspendido o sin profesional y tapaba justo el caso del bucle. El layout lo
      // manda a /onboarding o /sin-acceso. Prod no cambia (DEMO_ALLOWED es false ahí).
      return null;
    }
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
      ip: clientIp(h, null) ?? undefined,
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
 * Gate for platform-superadmin surfaces (the "Plataforma" owner panel + global
 * catalog authoring). Throws `UnauthenticatedError` if there's no session, or
 * `ForbiddenError` if the actor isn't a platform admin. Superadmin writes to
 * the global catalog go through `prismaService` (BYPASSRLS) — the app role
 * physically can't touch `tenantId IS NULL` rows — so this app-layer check is
 * the single enforcement chokepoint.
 */
export async function requireSuperAdmin(): Promise<Actor> {
  const a = await getActor();
  if (!a.isPlatformAdmin) throw new ForbiddenError("platform_admin_required");
  return a;
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
