import "server-only";
/**
 * Salud de la plataforma (BO2-C, plan §19.5; absorbe la «4d» de IAM). Detectores de cuentas y consultorios rotos,
 * cada uno con conteo y lista corta, para `/plataforma/salud` (BO3-D). Las reparaciones viven en
 * `lib/platform-users.ts` (actions auditadas).
 *
 * Por qué (§19.1, «cuentas muertas»): hasta BO2 estos estados solo se veían entrando a la base, y varios dejan a
 * alguien afuera sin mensaje útil: miembro clínico sin `Practitioner` (bucle de acceso, `missing_practitioner`),
 * consultorio sin dueño activo (nadie gestiona el equipo), invitaciones vencidas que nadie anuló, altas trabadas,
 * usuarios de Auth huérfanos (email «tomado» para una invitación nueva) y emails desincronizados entre
 * `UserProfile` y Auth (borrar/editar desde el dashboard de Supabase).
 *
 * Seguridad: `prismaService` (cruza consultorios) → `requirePlatformAdmin` en cada export. Sin PHI: ningún
 * detector lee `Patient` (las cuentas de portal se excluyen de «sin acceso» por `_count`/relación, sin traer filas).
 *
 * Detectores que dependen de LISTAR Auth (huérfanos de Auth, emails distintos): paginan `AuthAdminPort.listUsers`.
 * Si Auth falla o el padrón pasa el freno de páginas, el detector vuelve `available: false` (nunca una lista
 * parcial) y el directorio cubre el caso de a uno (buscar por email exacto muestra el usuario «solo Auth»).
 */
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { authAdmin, type AuthUserLite } from "@/lib/identity/auth-admin";
import { canSafelyDeleteAuthUser } from "@/lib/access-logic";
import { CLINICAL_ROLES } from "@/lib/roles";
import {
  HEALTH_SAMPLE_LIMIT,
  authOrphansFrom,
  emailMismatchesFrom,
  stalledOnboardingCutoff,
  summarize,
  unavailableDetector,
  type AuthOrphanRow,
  type EmailMismatchRow,
  type HealthDetector,
  type MissingPractitionerRow,
  type PlatformHealthReport,
  type PractitionerWithoutMembershipRow,
} from "@/lib/platform-health-logic";
import type { Role } from "@prisma/client";

export type { PlatformHealthReport } from "@/lib/platform-health-logic";

const LIST_PER_PAGE = 1000;
/** Mismo freno que `findUserByEmail` (100k cuentas): al pasarlo, el detector se declara no disponible. */
const LIST_MAX_PAGES = 100;

/** Todos los usuarios de Auth, o null si Auth falla o hay demasiados (nunca una lista parcial: daría falsos huérfanos… al revés). */
async function listAllAuthUsers(): Promise<AuthUserLite[] | null> {
  const port = authAdmin();
  const out: AuthUserLite[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const r = await port.listUsers({ page, perPage: LIST_PER_PAGE });
    if (!r.ok) return null;
    out.push(...r.data.users);
    if (r.data.users.length < LIST_PER_PAGE) return out;
  }
  return null;
}

const NOT_CLOSED: Prisma.TenantWhereInput = { status: { not: "CLOSED" } };

async function authDetectors(): Promise<{
  authOrphans: HealthDetector<AuthOrphanRow>;
  emailMismatches: HealthDetector<EmailMismatchRow>;
}> {
  const authUsers = await listAllAuthUsers();
  if (!authUsers) return { authOrphans: unavailableDetector(), emailMismatches: unavailableDetector() };

  const ids = authUsers.map((u) => u.id);
  const profiles = ids.length
    ? await prismaService.userProfile.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
    : [];
  const orphans = authOrphansFrom(authUsers, new Set(profiles.map((p) => p.id)));
  const orphanIds = orphans.map((o) => o.id);
  // Sin perfil no puede haber membresías ni fichas (FK a UserProfile), pero se cuentan igual: el criterio de
  // borrado es el de `canSafelyDeleteAuthUser` y no se reimplementa con supuestos.
  const [memberships, links] = orphanIds.length
    ? await Promise.all([
        prismaService.membership.groupBy({ by: ["userId"], where: { userId: { in: orphanIds } }, _count: { _all: true } }),
        prismaService.patient.groupBy({ by: ["userId"], where: { userId: { in: orphanIds } }, _count: { _all: true } }),
      ])
    : [[], []];
  const mCount = new Map(memberships.map((m) => [m.userId, m._count._all]));
  const pCount = new Map(links.map((p) => [p.userId as string, p._count._all]));
  const orphanRows: AuthOrphanRow[] = orphans
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((a) => ({
      authUserId: a.id,
      email: a.email,
      createdAt: a.createdAt,
      canDelete: canSafelyDeleteAuthUser({
        emailConfirmedAt: a.emailConfirmedAt,
        lastSignInAt: a.lastSignInAt,
        hasProfile: false,
        membershipCount: mCount.get(a.id) ?? 0,
        patientLinks: pCount.get(a.id) ?? 0,
      }),
    }));
  return { authOrphans: summarize(orphanRows), emailMismatches: summarize(emailMismatchesFrom(profiles, authUsers)) };
}

async function clinicalWithoutPractitioner(): Promise<HealthDetector<MissingPractitionerRow>> {
  const roles = [...CLINICAL_ROLES] as string[];
  const base = Prisma.sql`
    FROM "Membership" m
    JOIN "Tenant" t ON t."id" = m."tenantId"
    JOIN "UserProfile" u ON u."id" = m."userId"
    WHERE m."acceptedAt" IS NOT NULL
      AND m."disabledAt" IS NULL
      AND m."role"::text = ANY(${roles}::text[])
      AND t."status" <> 'CLOSED'
      AND NOT EXISTS (SELECT 1 FROM "Practitioner" p WHERE p."tenantId" = m."tenantId" AND p."userId" = m."userId")`;
  const [rows, [{ n }]] = await Promise.all([
    prismaService.$queryRaw<Array<{ tenantId: string; tenantName: string; userId: string; email: string; role: string }>>`
      SELECT m."tenantId", t."name" AS "tenantName", m."userId", u."email", m."role"::text AS "role"
      ${base}
      ORDER BY m."acceptedAt" DESC, m."id"
      LIMIT ${HEALTH_SAMPLE_LIMIT}`,
    prismaService.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n ${base}`,
  ]);
  return summarize(
    rows.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, userId: r.userId, email: r.email, role: r.role as Role })),
    Number(n)
  );
}

async function practitionersWithoutMembership(): Promise<HealthDetector<PractitionerWithoutMembershipRow>> {
  const base = Prisma.sql`
    FROM "Practitioner" p
    JOIN "Tenant" t ON t."id" = p."tenantId"
    JOIN "UserProfile" u ON u."id" = p."userId"
    WHERE t."status" <> 'CLOSED'
      AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."tenantId" = p."tenantId" AND m."userId" = p."userId")`;
  const [rows, [{ n }]] = await Promise.all([
    prismaService.$queryRaw<PractitionerWithoutMembershipRow[]>`
      SELECT p."id" AS "practitionerId", p."tenantId", t."name" AS "tenantName", p."userId", u."email"
      ${base}
      ORDER BY p."createdAt" DESC, p."id"
      LIMIT ${HEALTH_SAMPLE_LIMIT}`,
    prismaService.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n ${base}`,
  ]);
  return summarize(rows, Number(n));
}

/** Todos los detectores. Cada uno es independiente: uno que no puede correr no tapa a los demás. */
export async function getPlatformHealth(): Promise<PlatformHealthReport> {
  await requirePlatformAdmin("platform.read");
  const now = new Date();

  // Perfil que no lleva a ningún lado: sin membresías, sin fichas de portal (relación, sin traer filas) y no superadmin.
  const profileOrphanWhere: Prisma.UserProfileWhereInput = {
    memberships: { none: {} },
    patients: { none: {} },
    isPlatformAdmin: false,
  };
  // Consultorio sin un OWNER aceptado, sin suspender y con su usuario habilitado: nadie puede gestionar el equipo.
  const noOwnerWhere: Prisma.TenantWhereInput = {
    ...NOT_CLOSED,
    memberships: { none: { role: "OWNER", acceptedAt: { not: null }, disabledAt: null, user: { disabledAt: null } } },
  };
  const expiredWhere: Prisma.InvitationWhereInput = {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { lte: now },
    tenant: NOT_CLOSED,
  };
  const stalledWhere: Prisma.TenantWhereInput = {
    ...NOT_CLOSED,
    onboardingCompletedAt: null,
    createdAt: { lt: stalledOnboardingCutoff(now) },
  };

  const [
    auth,
    clinical,
    pracNoMember,
    profileRows,
    profileCount,
    noOwnerRows,
    noOwnerCount,
    expiredRows,
    expiredCount,
    stalledRows,
    stalledCount,
  ] = await Promise.all([
    authDetectors(),
    clinicalWithoutPractitioner(),
    practitionersWithoutMembership(),
    prismaService.userProfile.findMany({
      where: profileOrphanWhere,
      select: { id: true, email: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: HEALTH_SAMPLE_LIMIT,
    }),
    prismaService.userProfile.count({ where: profileOrphanWhere }),
    prismaService.tenant.findMany({
      where: noOwnerWhere,
      select: { id: true, name: true, slug: true, status: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: HEALTH_SAMPLE_LIMIT,
    }),
    prismaService.tenant.count({ where: noOwnerWhere }),
    prismaService.invitation.findMany({
      where: expiredWhere,
      select: { id: true, tenantId: true, email: true, role: true, expiresAt: true, tenant: { select: { name: true } } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: HEALTH_SAMPLE_LIMIT,
    }),
    prismaService.invitation.count({ where: expiredWhere }),
    prismaService.tenant.findMany({
      where: stalledWhere,
      select: { id: true, name: true, slug: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: HEALTH_SAMPLE_LIMIT,
    }),
    prismaService.tenant.count({ where: stalledWhere }),
  ]);

  return {
    generatedAt: now.toISOString(),
    authOrphans: auth.authOrphans,
    emailMismatches: auth.emailMismatches,
    profilesWithoutAccess: summarize(
      profileRows.map((p) => ({ userId: p.id, email: p.email, createdAt: p.createdAt.toISOString() })),
      profileCount
    ),
    clinicalWithoutPractitioner: clinical,
    practitionersWithoutMembership: pracNoMember,
    tenantsWithoutOwner: summarize(
      noOwnerRows.map((t) => ({ tenantId: t.id, name: t.name, slug: t.slug, status: t.status })),
      noOwnerCount
    ),
    expiredInvitations: summarize(
      expiredRows.map((i) => ({
        invitationId: i.id,
        tenantId: i.tenantId,
        tenantName: i.tenant.name,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt.toISOString(),
      })),
      expiredCount
    ),
    stalledOnboarding: summarize(
      stalledRows.map((t) => ({ tenantId: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt.toISOString() })),
      stalledCount
    ),
  };
}
