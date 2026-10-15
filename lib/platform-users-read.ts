import "server-only";
/**
 * Directorio global de usuarios de /plataforma (BO2-C, plan §19.5 fila «C usuarios y reparación»). Lecturas para
 * los server components de BO3-D; no son server actions (sin "use server": no tienen por qué ser invocables con un
 * POST desde el browser).
 *
 * Seguridad (invariantes del gate de BO):
 *  - Todo va por `prismaService` (canal service, BYPASSRLS): el directorio cruza TODOS los consultorios. La única
 *    barrera es `requirePlatformAdmin`, y la llama CADA export (el layout de /plataforma es UX, no seguridad).
 *  - PHI: sobre `Patient` solo `_count` (cuántas fichas tiene vinculadas una cuenta de portal), nunca un `find*`
 *    ni un `select` que traiga filas, y NUNCA de qué consultorios son: ser paciente en tal lugar es dato de salud
 *    (Ley 26.529) y el superadmin no es equipo clínico de nadie. Las membresías (equipo) sí se nombran.
 *  - DTOs con lista cerrada de campos (`lib/platform-health-logic.ts`), fijada por el test de integración con un
 *    fixture de PHI.
 *  - Búsqueda: Prisma compila `contains` + `insensitive` a `ILIKE '%…%'` SIN escapar (verificado contra el Docker
 *    local el 14-oct: `contains: "%"` matcheaba todo). Se escapa con `escapeLike`, igual que el hallazgo [A] de
 *    IAM-0a. Acá no autoriza nada, pero un `_` en el buscador no tiene que devolver medio directorio.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { authAdmin } from "@/lib/identity/auth-admin";
import { canSafelyDeleteAuthUser } from "@/lib/access-logic";
import { emailEqualsFilter, escapeLike, normalizeEmail } from "@/lib/email-match";
import {
  PLATFORM_USERS_PAGE_SIZE,
  classifyPlatformUser,
  emailsDiffer,
  isAuthBanned,
  type PlatformAuthOnlyHit,
  type PlatformUserAuthState,
  type PlatformUserDetail,
  type PlatformUserKindFilter,
  type PlatformUserPage,
  type PlatformUserRow,
} from "@/lib/platform-health-logic";

export type {
  PlatformUserRow,
  PlatformUserPage,
  PlatformUserDetail,
  PlatformAuthOnlyHit,
  PlatformUserKindFilter,
} from "@/lib/platform-health-logic";

const SearchInput = z
  .object({
    q: z.string().trim().max(200).optional().default(""),
    kind: z.enum(["all", "team", "portal", "orphan"]).optional().default("all"),
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  })
  .strict();

const UserIdInput = z.string().trim().min(1).max(128);

/** Equipo = alguna membresía o superadmin; portal = solo fichas; huérfano = nada (espejo de `classifyPlatformUser`). */
function kindWhere(kind: PlatformUserKindFilter): Prisma.UserProfileWhereInput {
  switch (kind) {
    case "team":
      return { OR: [{ memberships: { some: {} } }, { isPlatformAdmin: true }] };
    case "portal":
      return { memberships: { none: {} }, isPlatformAdmin: false, patients: { some: {} } };
    case "orphan":
      return { memberships: { none: {} }, isPlatformAdmin: false, patients: { none: {} } };
    default:
      return {};
  }
}

const rowSelect = {
  id: true,
  email: true,
  fullName: true,
  isPlatformAdmin: true,
  disabledAt: true,
  createdAt: true,
  // COUNT(*) en SQL: no trae filas de pacientes (contrato PHI).
  _count: { select: { memberships: true, patients: true } },
} satisfies Prisma.UserProfileSelect;

type RowSource = Prisma.UserProfileGetPayload<{ select: typeof rowSelect }>;

function toRow(u: RowSource): PlatformUserRow {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    kind: classifyPlatformUser({
      membershipCount: u._count.memberships,
      portalLinkCount: u._count.patients,
      isPlatformAdmin: u.isPlatformAdmin,
    }),
    isPlatformAdmin: u.isPlatformAdmin,
    disabled: u.disabledAt !== null,
    membershipCount: u._count.memberships,
    portalLinkCount: u._count.patients,
    createdAt: u.createdAt.toISOString(),
  };
}

/**
 * Usuario que Auth conoce y la base no (huérfano de Auth: el invitado que revocaron, el alta abandonada). Solo con
 * un email exacto: el puerto no lista (handoff), así que es la única forma de verlo sin el detector de salud.
 * Si hay un `UserProfile` con ese id (email desincronizado), no es «solo Auth»: lo cubre el detector de emails.
 */
async function authOnlyHitFor(email: string): Promise<PlatformAuthOnlyHit | null> {
  const profiles = await prismaService.userProfile.count({ where: { email: emailEqualsFilter(email) } });
  if (profiles > 0) return null;
  const found = await authAdmin().findUserByEmail(email);
  if (!found.ok || !found.data) return null;
  const a = found.data;
  const [hasProfile, membershipCount, patientLinks] = await Promise.all([
    prismaService.userProfile.count({ where: { id: a.id } }),
    prismaService.membership.count({ where: { userId: a.id } }),
    prismaService.patient.count({ where: { userId: a.id } }),
  ]);
  if (hasProfile > 0) return null;
  return {
    authUserId: a.id,
    email: a.email,
    emailConfirmed: a.emailConfirmedAt !== null,
    lastSignInAt: a.lastSignInAt,
    createdAt: a.createdAt,
    canDelete: canSafelyDeleteAuthUser({
      emailConfirmedAt: a.emailConfirmedAt,
      lastSignInAt: a.lastSignInAt,
      hasProfile: false,
      membershipCount,
      patientLinks,
    }),
  };
}

/** Directorio: busca por email o nombre (contiene, sin mayúsculas), filtra por tipo y pagina de a 25. */
export async function searchPlatformUsers(raw: unknown = {}): Promise<PlatformUserPage> {
  await requirePlatformAdmin("platform.read");
  const parsed = SearchInput.safeParse(raw ?? {});
  const { q, kind, page } = parsed.success ? parsed.data : { q: "", kind: "all" as const, page: 1 };

  const term = q ? escapeLike(q) : "";
  const where: Prisma.UserProfileWhereInput = {
    AND: [
      term
        ? { OR: [{ email: { contains: term, mode: "insensitive" } }, { fullName: { contains: term, mode: "insensitive" } }] }
        : {},
      kindWhere(kind),
    ],
  };

  const [rows, total] = await Promise.all([
    prismaService.userProfile.findMany({
      where,
      select: rowSelect,
      orderBy: [{ email: "asc" }, { id: "asc" }],
      skip: (page - 1) * PLATFORM_USERS_PAGE_SIZE,
      take: PLATFORM_USERS_PAGE_SIZE,
    }),
    prismaService.userProfile.count({ where }),
  ]);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
  const authOnly =
    looksLikeEmail && page === 1 && (kind === "all" || kind === "orphan") ? await authOnlyHitFor(normalizeEmail(q)) : null;

  return { rows: rows.map(toRow), total, page, pageSize: PLATFORM_USERS_PAGE_SIZE, authOnly };
}

async function authStateFor(userId: string, profileEmail: string): Promise<PlatformUserAuthState> {
  const r = await authAdmin().getUser(userId);
  if (!r.ok) return r.code === "not_found" ? { status: "missing" } : { status: "unavailable" };
  return {
    status: "ok",
    email: r.data.email,
    emailConfirmed: r.data.emailConfirmedAt !== null,
    lastSignInAt: r.data.lastSignInAt,
    banned: isAuthBanned(r.data, new Date()),
    emailMismatch: emailsDiffer(profileEmail, r.data.email),
  };
}

/** Detalle: membresías (consultorio, rol, suspendida, aceptada, con profesional), superadmin, deshabilitado y Auth. */
export async function getPlatformUser(userId: unknown): Promise<PlatformUserDetail | null> {
  await requirePlatformAdmin("platform.read");
  const id = UserIdInput.safeParse(userId);
  if (!id.success) return null;

  const u = await prismaService.userProfile.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      email: true,
      fullName: true,
      isPlatformAdmin: true,
      disabledAt: true,
      disabledReason: true,
      createdAt: true,
      memberships: {
        select: {
          id: true,
          tenantId: true,
          role: true,
          acceptedAt: true,
          disabledAt: true,
          tenant: { select: { name: true, slug: true, status: true, vertical: true } },
        },
        orderBy: [{ acceptedAt: { sort: "desc", nulls: "last" } }, { invitedAt: "desc" }],
      },
      _count: { select: { patients: true } },
    },
  });
  if (!u) return null;

  const [practitioners, auth] = await Promise.all([
    prismaService.practitioner.findMany({ where: { userId: u.id }, select: { tenantId: true } }),
    authStateFor(u.id, u.email),
  ]);
  const withPractitioner = new Set(practitioners.map((p) => p.tenantId));

  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    kind: classifyPlatformUser({
      membershipCount: u.memberships.length,
      portalLinkCount: u._count.patients,
      isPlatformAdmin: u.isPlatformAdmin,
    }),
    isPlatformAdmin: u.isPlatformAdmin,
    disabled: u.disabledAt !== null,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    disabledReason: u.disabledReason,
    createdAt: u.createdAt.toISOString(),
    memberships: u.memberships.map((m) => ({
      membershipId: m.id,
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      tenantSlug: m.tenant.slug,
      tenantStatus: m.tenant.status,
      tenantVertical: m.tenant.vertical,
      role: m.role,
      accepted: m.acceptedAt !== null,
      acceptedAt: m.acceptedAt ? m.acceptedAt.toISOString() : null,
      suspended: m.disabledAt !== null,
      hasPractitioner: withPractitioner.has(m.tenantId),
    })),
    portalLinkCount: u._count.patients,
    auth,
  };
}
