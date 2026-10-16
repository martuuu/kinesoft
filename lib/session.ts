/**
 * Session / current-actor helpers.
 *
 * Authentication model (post-Sprint 11):
 *
 *   1. Supabase auth gives us `user.id` (`getSessionUser`, lib/session-user.ts). PF-0b: el access token se
 *      verifica LOCALMENTE (sin ida y vuelta a GoTrue); la revocación la cubre `UserProfile.disabledAt`, que
 *      se lee acá en cada request.
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
import { displayUserName } from "@/lib/display-name";
import { cookies, headers } from "next/headers";
import { cache } from "react";
// buildActor/buildDemoActor DISCOVER the tenant (unfiltered membership lookup)
// before any Actor exists → no GUC can be set → they must use the BYPASSRLS
// service channel, or the flip to the app role locks out every login.
import { prismaService } from "@/lib/db";
import { withTenantDb, type DbClient } from "@/lib/rls";
import { getSessionUser } from "@/lib/session-user";
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";
import { staticGenerationAsyncStorage } from "next/dist/client/components/static-generation-async-storage.external";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import {
  isUsableMembership,
  resolveAccessState,
  type AccessState,
  type MembershipLite,
} from "@/lib/access-logic";
import { isClinicalMember } from "@/lib/roles";
import type { SaasPlan } from "@prisma/client";
import type { MemberAccess } from "@/lib/saas-plans-types";
import { twoFactorStateOf, type TwoFactorMethods, type TwoFactorState } from "@/lib/two-factor-logic";
import { STEP_UP_COOKIE, TWO_FACTOR_COOKIE, hasSessionProof } from "@/lib/two-factor-cookie";
import { logger } from "@/lib/logger";
import { ensureRequestContext, primeRequestContext } from "@/lib/request-context";
import { timeAsync } from "@/lib/server-timing";
import { clientIp } from "@/lib/client-ip";
import type { TenantEntitlements } from "@/lib/tenant-modules";
import { tenantAccessEnforcement } from "@/lib/env";
import { getRequestContext } from "@/lib/request-context";
import {
  SUPPORT_COOKIE,
  discardSupportCookieIfPresent,
  resolveSupportTarget,
  type SupportTarget,
} from "@/lib/support-session-internal";
import {
  ReadOnlyModeError as ReadOnlyModeErrorClass,
  assertWritableFor,
  canWrite,
  effectiveMode,
  isTenantBlocked,
  tenantAccessFor,
  type TenantAccess,
  type TenantAccessInput,
} from "@/lib/tenant-access";

// C-BO2: `ReadOnlyModeError` es parte de la API de sesión; vive en lib/tenant-access.ts (puro) porque
// `runWithRls` también la tira y lib/rls.ts no puede importar este módulo (ciclo).
export { ReadOnlyModeError } from "@/lib/tenant-access";

export type Actor = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  /**
   * IAM-4a: el `Practitioner` del actor en el consultorio activo, SOLO para roles clínicos (OWNER, ADMIN,
   * PRACTITIONER: `isClinicalRole`). `null` para la Secretaria (ASSISTANT) y Facturación (BILLING), aunque tengan
   * una fila `Practitioner` vieja (antes de IAM-4a `acceptInvite` se la creaba a todos; no se borra y desde IAM-2e
   * no es reservable). Ojo con las columnas nullable: `{ assignedPractitionerId: actor.practitionerId }` con
   * `null` compila a `IS NULL` y abre todo lo «sin asignar». Para eso están `ownPatientsWhere` /
   * `isActorPractitioner` (`lib/practitioner-scope.ts`) y `requireActorPractitionerId` (write-paths clínicos).
   */
  practitionerId: string | null;
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
  /**
   * BO1-A (C-BO1): acceso del consultorio activo con el modo REAL (`tenantAccessFor`), calculado de la misma fila
   * de Tenant que ya trae `loadAccessMemberships` (sin sentencias nuevas). Los cortes usan el modo efectivo
   * (`effectiveMode` con `TENANT_ACCESS_ENFORCEMENT`); la banda usa este para avisar antes de cortar.
   */
  access: TenantAccess;
  /**
   * BO2-E (C-BO9): sesión de soporte de un superadmin en un consultorio ajeno (rama de soporte de `resolveActor`).
   * Con soporte: `practitionerId` null, capacidades `SUPPORT_CAPS` (Secretaria sin clínico; vive en lib/capabilities.ts y
   * la aplica `capabilitiesForActor` de lib/authz.ts), las tx en
   * solo lectura salvo `withSupportWritable` (C-BO4) y cada audit (`auditInTx`/`auditSecurityEvent`) estampa `supportSessionId`.
   */
  support: { sessionId: string; superadminEmail: string } | null;
  /**
   * PL-1e (C-PL5): rol + «¿atiende?» + permisos delegados del actor en el consultorio activo, de la MISMA fila de
   * `Membership` que leyó la foto (`loadAccessMemberships`): cero queries (`getMemberAccess` de lib/authz.ts lo
   * devuelve tal cual). `null` en soporte (no es miembro: sus capacidades son `SUPPORT_CAPS`) y en el actor demo.
   */
  membership: MemberAccess | null;
};

/**
 * Solo las tres columnas: no se cuela el resto de la fila de Tenant en el Actor. PL-1e: `plan` es el plan SaaS
 * (`Tenant.saasPlan`, PL-D1); el `Tenant.plan` legado lo espeja el escritor y ya no se lee para los módulos.
 */
function entitlementsOf(t: {
  vertical: TenantEntitlements["vertical"];
  plan: SaasPlan;
  publicBookingEnabled: boolean;
}): TenantEntitlements {
  return { vertical: t.vertical, plan: t.plan, publicBookingEnabled: t.publicBookingEnabled };
}

/**
 * `two_factor` (PL-1e, C-PL6): hay sesión y membresía, pero el usuario tiene la 2FA prendida y esta sesión no la
 * pasó (ni AAL2 ni `kine_2fa`). El layout lo manda a `/verificar-acceso?next=` (fuera de `(app)`: sin bucle).
 */
export type UnauthenticatedReason = "no_session" | "no_membership" | "two_factor";

export class UnauthenticatedError extends Error {
  constructor(public reason: UnauthenticatedReason = "no_session") {
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

/**
 * IAM-4a: el profesional del actor para un write-path SOLO clínico, cuya columna es NOT NULL y apunta a
 * `Practitioner` (`ClinicalCase.authorId`, `PlanTemplate.authorId`). Esos caminos ya exigen una capability
 * clínica (`plans.manage` / `clinical.read` + full) que un rol no clínico no tiene, así que acá solo llega un
 * clínico, que siempre tiene `practitionerId` (`buildActor`). Es la red: si algún día un rol sin profesional
 * pasara el gate, falla cerrado con un 403 en vez de tirar un error de Prisma o escribir con el `userId`.
 */
export function requireActorPractitionerId(
  actor: Pick<Actor, "practitionerId">,
  message = "Esta acción es solo para profesionales del consultorio."
): string {
  if (!actor.practitionerId) throw new ForbiddenError(message);
  return actor.practitionerId;
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
  /** PL-1e (C-PL5): de la misma fila de Membership (M8). `clinical` lo usa `isUsableMembership` (1b). */
  clinical: boolean;
  grantSettings: boolean;
  grantBilling: boolean;
  tenant: {
    id: string;
    slug: string;
    name: string;
    vertical: TenantEntitlements["vertical"];
    /** PL-1e: el plan SaaS (`Tenant.saasPlan`), no el legado. */
    plan: SaasPlan;
    publicBookingEnabled: boolean;
    onboardingCompletedAt: Date | null;
  } & TenantAccessInput;
};

/** `disabledAt` (BO1-A): deshabilitado a nivel plataforma (M7): sin acceso a ningún consultorio ni a /plataforma. */
export type AccessProfile = {
  fullName: string | null;
  email: string;
  isPlatformAdmin: boolean;
  disabledAt: Date | null;
  /** PL-1e: métodos de 2FA prendidos (`UserProfile.twoFactorTotp/twoFactorEmail`, M8), en la misma sentencia. */
  twoFactor: TwoFactorMethods;
};

/** Fila de `loadAccessMemberships`: el perfil repetido por membresía (LEFT JOIN: sin membresías, una fila con nulls). */
type AccessRow = {
  fullName: string | null;
  email: string;
  isPlatformAdmin: boolean;
  userDisabledAt: Date | null;
  twoFactorTotp: boolean;
  twoFactorEmail: boolean;
  tenantId: string | null;
  role: AccessMembership["role"] | null;
  acceptedAt: Date | null;
  membershipDisabledAt: Date | null;
  clinical: boolean | null;
  grantSettings: boolean | null;
  grantBilling: boolean | null;
  slug: string | null;
  name: string | null;
  vertical: AccessMembership["tenant"]["vertical"] | null;
  saasPlan: AccessMembership["tenant"]["plan"] | null;
  publicBookingEnabled: boolean | null;
  onboardingCompletedAt: Date | null;
  status: AccessMembership["tenant"]["status"] | null;
  subscriptionStatus: AccessMembership["tenant"]["subscriptionStatus"] | null;
  trialEndsAt: Date | null;
  subscriptionStatusChangedAt: Date | null;
  practitionerId: string | null;
};

/**
 * Todo lo que decide a qué consultorio entra una sesión (perfil, membresías con su consultorio y el `Practitioner`
 * de cada una), en UNA sentencia. Por `prismaService`: todavía no hay Actor ni GUC (ver import arriba), y el filtro
 * es el `userId` de la sesión verificada.
 *
 * PF-0b: antes era un `findUnique` con `select` anidado, que Prisma 5 ejecuta como una query por relación
 * (UserProfile → Membership → Tenant + Practitioner: 4 idas y vueltas EN SERIE antes de cada página y action; PF-0a
 * las midió en ~18 ms en la misma región y ~500 ms cruzado). `relationLoadStrategy: "join"` pide el preview
 * `relationJoins` en el generator (afecta a toda la app): SQL a mano, con los mismos campos. Los enums vuelven como
 * texto (`::text`) y se tipan con los de Prisma; los nombres de columna los cubren los tests de integración de
 * sesión (`tests/integration/session-fast-path.test.ts` compara contra la lectura con Prisma).
 */
export async function loadAccessMemberships(userId: string): Promise<{
  profile: AccessProfile | null;
  memberships: AccessMembership[];
  preferredTenantId: string | null;
}> {
  // Gate de IAM-3: la preferencia guardada (`UserPreferences.tenantId`) NO se lee acá. Con la decisión 6 de Martin
  // (cada login pregunta a qué consultorio entrar) la única fuente del consultorio activo es la cookie `kine_tenant`,
  // y leer la preferencia sumaba una sentencia a CADA request (rompía el techo estricto de createBooking: 34 → 35).
  // M6: Practitioner es único por (tenantId, userId): el JOIN da a lo sumo uno por membresía.
  const rows = await prismaService.$queryRaw<AccessRow[]>`
    SELECT u."fullName", u."email", u."isPlatformAdmin", u."disabledAt" AS "userDisabledAt",
           u."twoFactorTotp", u."twoFactorEmail",
           m."tenantId", m."role"::text AS "role", m."acceptedAt", m."disabledAt" AS "membershipDisabledAt",
           m."clinical", m."grantSettings", m."grantBilling",
           t."slug", t."name", t."vertical"::text AS "vertical", t."saasPlan"::text AS "saasPlan",
           t."publicBookingEnabled", t."onboardingCompletedAt",
           t."status"::text AS "status", t."subscriptionStatus"::text AS "subscriptionStatus",
           t."trialEndsAt", t."subscriptionStatusChangedAt",
           p."id" AS "practitionerId"
      FROM "UserProfile" u
      LEFT JOIN "Membership" m ON m."userId" = u."id"
      LEFT JOIN "Tenant" t ON t."id" = m."tenantId"
      LEFT JOIN "Practitioner" p ON p."tenantId" = m."tenantId" AND p."userId" = u."id"
     WHERE u."id" = ${userId}
     ORDER BY m."invitedAt" ASC, m."tenantId" ASC`;
  const first = rows[0];
  if (!first) return { profile: null, memberships: [], preferredTenantId: null };
  const memberships: AccessMembership[] = [];
  for (const r of rows) {
    // Sin membresías: una sola fila con la parte de Membership/Tenant en null.
    if (!r.tenantId || !r.role || !r.slug || r.name === null || !r.vertical || !r.saasPlan || !r.status || !r.subscriptionStatus) {
      continue;
    }
    memberships.push({
      tenantId: r.tenantId,
      role: r.role,
      acceptedAt: r.acceptedAt,
      disabledAt: r.membershipDisabledAt,
      hasPractitioner: r.practitionerId !== null,
      practitionerId: r.practitionerId,
      // PL-1e: columnas NOT NULL de M8 (en el LEFT JOIN solo son null sin membresía, caso que se saltea arriba). El
      // `?? true/false` replica los DEFAULT de M8 por si una fila vieja llegara null: nunca concede de más.
      clinical: r.clinical ?? true,
      grantSettings: r.grantSettings ?? false,
      grantBilling: r.grantBilling ?? false,
      tenant: {
        id: r.tenantId,
        slug: r.slug,
        name: r.name,
        vertical: r.vertical,
        plan: r.saasPlan,
        publicBookingEnabled: !!r.publicBookingEnabled,
        onboardingCompletedAt: r.onboardingCompletedAt,
        // BO1-A: las 4 columnas de `tenantAccessFor` (TENANT_ACCESS_SELECT), en la misma lectura.
        status: r.status,
        subscriptionStatus: r.subscriptionStatus,
        trialEndsAt: r.trialEndsAt,
        subscriptionStatusChangedAt: r.subscriptionStatusChangedAt,
      },
    });
  }
  return {
    profile: {
      fullName: first.fullName,
      email: first.email,
      isPlatformAdmin: first.isPlatformAdmin,
      disabledAt: first.userDisabledAt,
      twoFactor: { totp: !!first.twoFactorTotp, email: !!first.twoFactorEmail },
    },
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
  /** BO1-A: el instante con el que se calculó el acceso de cada consultorio (uno por foto). */
  now: Date;
  /**
   * BO1-A: membresías aceptadas y habilitadas en consultorios suspendidos o dados de baja (modo EFECTIVO). No
   * cuentan como usables; `getSessionBlock` las usa para explicar por qué no entra.
   */
  tenantBlocks: Array<{ tenantId: string; tenantName: string; role: AccessMembership["role"]; kind: "suspended" | "closed" }>;
  /**
   * PL-1e (C-PL6): 2FA de la sesión. `methods` sale de la misma sentencia (UserProfile); `state` cruza eso con el
   * `aal` del JWT y la cookie `kine_2fa` (`twoFactorStateOf`). Sin perfil: `not_enabled`.
   */
  twoFactor: { methods: TwoFactorMethods; state: TwoFactorState };
};

function readActiveTenantCookie(): string | null {
  try {
    const v = cookies().get(ACTIVE_TENANT_COOKIE)?.value?.trim();
    return v ? v.slice(0, 64) : null;
  } catch {
    return null; // fuera de un request
  }
}

/**
 * BO1-A: un consultorio suspendido/dado de baja (modo efectivo) y un usuario deshabilitado en la plataforma se
 * ven, para la lógica de acceso, como membresías deshabilitadas: no son usables, nunca ganan la elección y, si no
 * queda ninguna, el estado es `no_access` (el gate lo manda a la pantalla del bloqueo, no a /onboarding). Así no se
 * toca `lib/access-logic.ts` y el resto (selector, /elegir-consultorio) hereda el corte. Si hay OTRO consultorio
 * usable, entra a ese. Las membresías originales quedan tal cual (las pantallas muestran los datos reales).
 */
function accessView(
  memberships: AccessMembership[],
  profile: Pick<AccessProfile, "disabledAt"> | null,
  now: Date
): { logicView: AccessMembership[]; tenantBlocks: AccessSnapshot["tenantBlocks"] } {
  const enforcement = tenantAccessEnforcement();
  const userDisabled = !!profile?.disabledAt;
  const tenantBlocks: AccessSnapshot["tenantBlocks"] = [];
  const logicView = memberships.map((m) => {
    const mode = effectiveMode(tenantAccessFor(m.tenant, now).mode, enforcement);
    const blocked = isTenantBlocked(mode);
    if (blocked && m.acceptedAt && !m.disabledAt) {
      tenantBlocks.push({ tenantId: m.tenantId, tenantName: m.tenant.name, role: m.role, kind: mode });
    }
    return userDisabled || blocked ? { ...m, disabledAt: m.disabledAt ?? now } : m;
  });
  return { logicView, tenantBlocks };
}

/**
 * Las membresías USABLES de verdad (BO1-A): `isUsableMembership` + usuario no deshabilitado + consultorio no
 * suspendido/dado de baja. Para quien lee `loadAccessMemberships` por su cuenta (lectura fresca de
 * `setActiveTenant`, «done» de /onboarding) y no la foto del request.
 */
export function usableAccessMemberships(
  memberships: AccessMembership[],
  profile: Pick<AccessProfile, "disabledAt"> | null,
  now: Date = new Date()
): AccessMembership[] {
  const { logicView } = accessView(memberships, profile, now);
  const ids = new Set(logicView.filter((m) => isUsableMembership(m)).map((m) => m.tenantId));
  return memberships.filter((m) => ids.has(m.tenantId));
}

async function loadAccessSnapshot(): Promise<AccessSnapshot | null> {
  const user = await getSessionUser();
  if (!user) return null;
  // PF-0a: marca `access` (la lectura de membresías por el canal service) con PERF_TIMING=1.
  const { profile, memberships, preferredTenantId } = await timeAsync("access", () => loadAccessMemberships(user.id));
  const cookieTenantId = readActiveTenantCookie();
  const now = new Date();
  const { logicView, tenantBlocks } = accessView(memberships, profile, now);
  const usableIds = new Set(logicView.filter((m) => isUsableMembership(m)).map((m) => m.tenantId));
  const usable = memberships.filter((m) => usableIds.has(m.tenantId));
  // IAM-0c/IAM-3a: la cookie guarda el tenantId (antes se leía como slug y nadie la escribía).
  const cookieValid = !!cookieTenantId && usable.some((m) => m.tenantId === cookieTenantId);
  const state = resolveAccessState(logicView, { cookieTenantId, preferredTenantId });
  const methods: TwoFactorMethods = profile?.twoFactor ?? { totp: false, email: false };
  // La cookie se lee (HMAC) solo si hay algún método prendido: el resto de los usuarios no paga nada.
  const twoFactorState = twoFactorStateOf(methods, {
    aal: user.aal,
    sessionId: user.sessionId,
    sessionProofValid: (methods.totp || methods.email) && hasSessionProof(user.id, user.sessionId),
  });
  return {
    userId: user.id,
    profile,
    memberships,
    usable,
    cookieTenantId,
    preferredTenantId,
    cookieValid,
    state,
    now,
    tenantBlocks,
    twoFactor: { methods, state: twoFactorState },
  };
}

/**
 * C-BO2: por qué esta sesión no puede entrar a la app, si es por un bloqueo (null = no hay bloqueo; puede igual
 * no tener acceso por otra razón: /sin-acceso u /onboarding). Misma foto del request: cero queries extra.
 * - `user_disabled`: `UserProfile.disabledAt` (M7) → /cuenta-desactivada. Gana siempre.
 * - `tenant_suspended` / `tenant_closed`: SOLO si no quedó ningún consultorio usable (con otro usable, entra a
 *   ese) y hay una membresía aceptada y habilitada en un consultorio bloqueado → /suspendido.
 */
export type SessionBlock =
  | { kind: "user_disabled" }
  | { kind: "tenant_suspended"; tenantName: string }
  | { kind: "tenant_closed"; tenantName: string }
  | null;

export function sessionBlockOf(s: AccessSnapshot): SessionBlock {
  if (s.profile?.disabledAt) return { kind: "user_disabled" };
  if (s.state.kind === "ok") return null;
  const b = s.tenantBlocks.find((x) => x.kind === "suspended") ?? s.tenantBlocks[0];
  if (!b) return null;
  return b.kind === "suspended"
    ? { kind: "tenant_suspended", tenantName: b.tenantName }
    : { kind: "tenant_closed", tenantName: b.tenantName };
}

export async function getSessionBlock(): Promise<SessionBlock> {
  const s = await getAccessSnapshot();
  return s ? sessionBlockOf(s) : null;
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
  // PL-1e (C-PL6): antes que todo lo del consultorio (también antes de `no_membership`): sin el segundo factor la
  // sesión no ve ni a qué consultorios pertenece. El bloqueo de usuario deshabilitado lo resuelve el gate antes.
  if (s.twoFactor.state === "required") throw new UnauthenticatedError("two_factor");
  for (const m of s.memberships) {
    if (m.acceptedAt && !m.disabledAt && !m.hasPractitioner && !isUsableMembership(m)) {
      logger.warn("session.membership.unusable", { userId: s.userId, tenantId: m.tenantId, reason: "missing_practitioner" });
    }
  }
  if (s.state.kind !== "ok" || !s.profile) {
    throw new UnauthenticatedError("no_membership");
  }
  // BO1-A: red explícita (la foto ya deja `no_access` a un usuario deshabilitado).
  if (s.profile.disabledAt) throw new UnauthenticatedError("no_membership");
  const tenantId = s.state.tenantId;
  const chosen = s.memberships.find((m) => m.tenantId === tenantId);
  if (!chosen) throw new UnauthenticatedError("no_membership");
  // IAM-4a: los clínicos tienen Practitioner (`isUsableMembership` ya lo exige: esto es la red). Los no clínicos
  // entran sin él y, si tienen una fila vieja, se ignora: un actor no clínico nunca «es» un profesional (ni para
  // `assignedPractitionerId`, ni para shares, ni para la agenda propia).
  // PL-1e (PL-D4): «clínico» es por MIEMBRO (`isClinicalMember`): un Titular/Admin que no atiende (`clinical=false`)
  // es no clínico aunque su rol lo fuera, y no tiene profesional.
  const membership: MemberAccess = {
    role: chosen.role,
    clinical: chosen.clinical,
    grantSettings: chosen.grantSettings,
    grantBilling: chosen.grantBilling,
  };
  const clinical = isClinicalMember(membership);
  if (clinical && !chosen.practitionerId) throw new UnauthenticatedError("no_membership");
  return {
    tenantId,
    tenantSlug: chosen.tenant.slug,
    tenantName: chosen.tenant.name,
    practitionerId: clinical ? chosen.practitionerId : null,
    // DIR-0: el actor puede ser no clínico; sin nombre → «Usuario sin nombre», nunca el email.
    practitionerName: displayUserName(s.profile.fullName),
    userId: s.userId,
    isPlatformAdmin: s.profile.isPlatformAdmin,
    entitlements: entitlementsOf(chosen.tenant),
    access: tenantAccessFor(chosen.tenant, s.now),
    support: null,
    membership,
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
  // PL-1e: el demo (solo dev) también lleva su MemberAccess: con `null` `getMemberAccess` no le daría capacidades.
  const m = await prismaService.membership.findUnique({
    where: { userId_tenantId: { userId: prac.userId, tenantId: tenant.id } },
    select: { role: true, clinical: true, grantSettings: true, grantBilling: true },
  });
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    practitionerId: prac.id,
    practitionerName: displayUserName(prac.user.fullName),
    userId: prac.userId,
    isPlatformAdmin: prac.user.isPlatformAdmin,
    entitlements: entitlementsOf({ ...tenant, plan: tenant.saasPlan }),
    access: tenantAccessFor(tenant, new Date()),
    support: null,
    membership: m,
  };
}

/**
 * BO2-E (C-BO9, decisión 3 de Martin): el Actor SINTÉTICO de «Entrar como soporte». El consultorio es el destino de
 * la `SupportSession` abierta (no una membresía: el superadmin no es miembro, `startSupportSession` lo exige), sin
 * profesional (nunca «es» un profesional del consultorio: ni agenda propia ni pacientes «propios»), con el acceso
 * REAL del destino (la banda lo muestra) y la marca `support` que pone el request en solo lectura
 * (`isReadOnlyActor`) y que `capabilitiesForActor` (lib/authz.ts) traduce a `SUPPORT_CAPS` (lib/capabilities.ts:
 * Secretaria sin `clinical.read`).
 * `userId` es el del superadmin: la auditoría del consultorio dice quién fue y el `supportSessionId` dice «como
 * soporte».
 */
function buildSupportActor(s: AccessSnapshot & { profile: AccessProfile }, t: SupportTarget): Actor {
  return {
    tenantId: t.tenantId,
    tenantSlug: t.tenant.slug,
    tenantName: t.tenant.name,
    practitionerId: null,
    practitionerName: `${displayUserName(s.profile.fullName)} (soporte)`,
    userId: s.userId,
    isPlatformAdmin: true,
    entitlements: entitlementsOf(t.tenant),
    access: tenantAccessFor(t.tenant, s.now),
    support: { sessionId: t.sessionId, superadminEmail: t.superadminEmail },
    // PL-1e: el soporte no es miembro del destino (C-BO9): sin MemberAccess; sus capacidades son `SUPPORT_CAPS`.
    membership: null,
  };
}

/**
 * Rama de soporte. Solo un superadmin vigente (y no deshabilitado) la puede tomar; a cualquier otro la cookie se le
 * ignora y se borra. Sin la cookie no hay query (`resolveSupportTarget` sale antes): el resto de los usuarios no
 * paga nada. Gana sobre el consultorio propio del superadmin: mientras está «como soporte» la app es la del
 * destino; al salir (o al cerrar sesión) vuelve a la suya. /plataforma no pasa por acá (`requirePlatformAdmin`).
 */
async function resolveSupportActor(s: AccessSnapshot): Promise<Actor | null> {
  const profile = s.profile;
  if (!profile || !profile.isPlatformAdmin || profile.disabledAt) {
    discardSupportCookieIfPresent();
    return null;
  }
  const target = await resolveSupportTarget(s.userId);
  return target ? buildSupportActor({ ...s, profile }, target) : null;
}

/** Actor, o por qué no hay (PL-1e: `getActor` tira con ESE motivo; `tryGetActor` devuelve null igual que antes). */
type ActorOutcome = { actor: Actor; reason: null } | { actor: null; reason: UnauthenticatedReason };

async function resolveActor(): Promise<ActorOutcome> {
  const snapshot = await getAccessSnapshot();
  if (snapshot) {
    // PL-1e: la 2FA corta ANTES de la rama de soporte: un superadmin con 2FA prendida y sin pasarla tampoco entra
    // «como soporte» (la cookie de soporte no reemplaza al segundo factor).
    if (snapshot.twoFactor.state === "required") return { actor: null, reason: "two_factor" };
    const support = await resolveSupportActor(snapshot);
    if (support) return { actor: support, reason: null };
    try {
      return { actor: buildActor(snapshot), reason: null };
    } catch (err) {
      if (!(err instanceof UnauthenticatedError)) throw err;
      // IAM-3a: con sesión pero sin consultorio usable NO se cae al demo (antes sí): en dev eso mostraba el
      // consultorio demo a un usuario suspendido o sin profesional y tapaba justo el caso del bucle. El layout lo
      // manda a /onboarding o /sin-acceso. Prod no cambia (DEMO_ALLOWED es false ahí).
      return { actor: null, reason: err.reason };
    }
  }
  if (DEMO_ALLOWED) {
    const demo = await buildDemoActor();
    return demo ? { actor: demo, reason: null } : { actor: null, reason: "no_session" };
  }
  return { actor: null, reason: "no_session" };
}

/*
 * ── PF2-e (C-PF8): memo del actor por request ─────────────────────────────────────────────────────────────────────
 *
 * Por qué: `cache()` de React solo deduplica DENTRO de un render RSC; en una server action no hace nada, así que cada
 * `getActor()`/`tryGetActor()` de la action (el suyo, `withAccountWritable`, `requireModule`, `getCapabilities`…)
 * volvía a leer el acceso por el canal de servicio (`createSupportThread`: 2 lecturas; ver
 * tests/integration/pf2-tx-budget.test.ts). Meta del brief: ≤ 1 resolución por action.
 *
 * Molde de `lib/session-user.ts` (memo por store de `requestAsyncStorage` + token). La clave lleva TODO lo que puede
 * cambiar el actor dentro de un mismo request:
 *  - la identidad verificada (`getSessionUser`: ya memoizada por token): usuario + `session_id` + `aal`. Si la action
 *    inicia sesión con otro usuario a mitad de camino, la clave cambia;
 *  - las cookies que lee la resolución: `kine_tenant` (`switchTenant`/`setActiveTenant` la cambian → memo nueva),
 *    `kine_support` (entrar/salir de soporte), `kine_2fa` y `kine_stepup` (pasar la 2FA). La de step-up no la lee el
 *    actor hoy: va igual, ante la duda (pedido del brief);
 *  - la «época» de revalidación del request (`pathWasRevalidated` + cantidad de tags de `staticGenerationAsyncStorage`).
 *    Next 14.2 re-renderiza la página DENTRO del mismo request (y del mismo store) cuando la action revalidó
 *    (`generateFlight` en action-handler.js): sin esto, una action que cambia el nombre/plan/turnero del consultorio
 *    o la membresía del propio usuario mostraba en ese render el actor de ANTES del cambio. Límite conocido: si la
 *    action pide el actor DESPUÉS de revalidar un tag, escribe y revalida el MISMO tag otra vez, ese re-render reusa el
 *    actor (no hay caso así hoy; en el peor caso se ve viejo hasta la próxima navegación, que es otro request).
 *
 * Qué NO se memoiza: sin store (scripts, unit, integración sin request: cada llamada resuelve, como antes); sin sesión
 * (`getSessionUser` null: incluye el actor demo de dev); los resultados NEGATIVOS (sin membresía, 2FA pendiente,
 * deshabilitado): son raros y un alta (`/onboarding`, invitación) puede crear la membresía y pedir el actor en el
 * mismo request; y un actor cuyo `userId` no coincide con el de la clave (red: nunca debería pasar). Nada es global
 * por usuario: el WeakMap cuelga del objeto del request y muere con él; dos requests concurrentes del mismo usuario
 * tienen stores distintos y no comparten nada.
 *
 * Usuario o membresía deshabilitados, consultorio suspendido y modo solo lectura se evalúan igual que antes: una vez
 * por request (como ya pasaba en las páginas con `cache()`); el request siguiente vuelve a leer todo.
 */
const actorMemo = new WeakMap<object, Map<string, Promise<ActorOutcome>>>();

function currentRequestStore(): object | null {
  try {
    return (requestAsyncStorage.getStore() as object | undefined) ?? null;
  } catch {
    return null;
  }
}

function readCookieForKey(name: string): string | null {
  return cookies().get(name)?.value ?? null;
}

function revalidationEpoch(): string {
  try {
    const s = staticGenerationAsyncStorage.getStore() as
      | { pathWasRevalidated?: boolean; revalidatedTags?: string[] }
      | undefined;
    return `${s?.pathWasRevalidated ? 1 : 0}:${s?.revalidatedTags?.length ?? 0}`;
  } catch {
    return "0:0";
  }
}

/** Clave de la memo, o null = no memoizar (sin sesión o sin cookies legibles). */
async function actorMemoKey(): Promise<{ key: string; userId: string } | null> {
  const user = await getSessionUser();
  if (!user) return null;
  let jar: Array<string | null>;
  try {
    jar = [ACTIVE_TENANT_COOKIE, SUPPORT_COOKIE, TWO_FACTOR_COOKIE, STEP_UP_COOKIE].map(readCookieForKey);
  } catch {
    return null;
  }
  return { key: JSON.stringify([user.id, user.sessionId ?? null, user.aal ?? null, ...jar, revalidationEpoch()]), userId: user.id };
}

async function memoizedResolveActor(): Promise<ActorOutcome> {
  // PF-0a: marca `actor` (auth + membresías + soporte) con PERF_TIMING=1; apagado es `resolveActor()` tal cual.
  const resolve = () => timeAsync("actor", resolveActor);
  const store = currentRequestStore();
  if (!store) return resolve();
  const k = await actorMemoKey();
  if (!k) return resolve();
  let perKey = actorMemo.get(store);
  if (!perKey) {
    perKey = new Map();
    actorMemo.set(store, perKey);
  }
  const hit = perKey.get(k.key);
  if (hit) return hit;
  const p = resolve();
  const memo = perKey;
  memo.set(k.key, p);
  const forget = () => {
    if (memo.get(k.key) === p) memo.delete(k.key);
  };
  p.then((o) => {
    if (!o.actor || o.actor.userId !== k.userId) forget();
  }, forget);
  return p;
}

const cachedResolve = cache(async (): Promise<ActorOutcome> => {
  const outcome = await memoizedResolveActor();
  const actor = outcome.actor;
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
      // BO1-A (C-BO3): `runWithRls` abre las tx de este tenant en solo lectura con el modo EFECTIVO (con el
      // default `banner` nunca, salvo soporte de BO2-E).
      readOnly: isReadOnlyActor(actor),
      supportSessionId: actor.support?.sessionId ?? null,
    });
  }
  return outcome;
});

/**
 * Returns the active actor; **throws `UnauthenticatedError`** when there is
 * no session. This is the canonical call for server actions and protected
 * routes. Surfaces that need to render a "please sign in" card should call
 * `tryGetActor()` instead.
 */
export async function getActor(): Promise<Actor> {
  // BO1-A: antes del primer await (ver `primeRequestContext`): así el caller ve el contexto (modo lectura, C-BO3).
  primeRequestContext();
  const { actor, reason } = await cachedResolve();
  if (!actor) {
    // PL-1e: `two_factor` viaja tal cual (la action/página sabe que tiene que mandar a /verificar-acceso). El resto
    // sigue siendo `no_session`, como antes (callers que distinguen `no_membership` lo leen de la foto).
    throw new UnauthenticatedError(reason === "two_factor" ? "two_factor" : "no_session");
  }
  return actor;
}

/** Variant that returns null instead of throwing. */
export async function tryGetActor(): Promise<Actor | null> {
  primeRequestContext();
  return (await cachedResolve()).actor;
}

/** Backwards-compatible alias. */
export async function requireActor(): Promise<Actor> {
  return getActor();
}

/** El Actor escribe con el modo efectivo vigente (y no es soporte). */
function isReadOnlyActor(actor: Pick<Actor, "access" | "support">): boolean {
  return !!actor.support || !canWrite(effectiveMode(actor.access.mode, tenantAccessEnforcement()));
}

/**
 * C-BO3: para las escrituras que NO pasan por `runWithRls` (canal sin GUC: preferencias, favoritos, tags
 * globales). Tira `ReadOnlyModeError` si el consultorio está en solo lectura con el modo efectivo, o si es una
 * sesión de soporte fuera de una action `supportWritable` (C-BO4). Con el default `banner` no corta nada.
 */
export function assertWritable(actor: Pick<Actor, "access" | "support">): void {
  // PL-1e (C-PL10): misma regla que `isReadOnlyFor` de lib/rls.ts: una action de cuenta (`withAccountWritable`) de
  // un actor que no es soporte escribe aunque el consultorio esté en solo lectura (tiene que poder pagar).
  if (getRequestContext()?.accountWritable && !actor.support) return;
  assertWritableFor({
    access: actor.access,
    enforcement: tenantAccessEnforcement(),
    support: !!actor.support,
    supportWritable: !!getRequestContext()?.supportWritable,
  });
}

/**
 * Variante de `assertWritable` para actions que devuelven `ActionResult` (no tiran): el mensaje en voseo para
 * devolver como `{ ok: false, error }`, o null si puede escribir. Una excepción tirada desde una server action en
 * producción llega al cliente como un error genérico de Next; así el usuario lee por qué.
 */
export function writableError(actor: Pick<Actor, "access" | "support">): string | null {
  try {
    assertWritable(actor);
    return null;
  } catch (err) {
    if (err instanceof ReadOnlyModeErrorClass) return err.message;
    throw err;
  }
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
