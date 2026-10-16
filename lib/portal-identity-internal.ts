import "server-only";
/**
 * Identidad del portal del paciente (ES4 S24a, brief §3.1). ÚNICA puerta de autorización del portal.
 *
 * Por qué existe: hasta ES4 el portal autorizaba por coincidencia de email entre consultorios (`getPortalAuth` y
 * `authedPatientByTenant` de `lib/portal.ts`). Una ficha con el email de la cuenta pero SIN vincular ya mostraba plan,
 * turnos y check-in: bastaba con que el consultorio cargara un email (con un typo, o el de un familiar) para que otra
 * cuenta verificada viera PHI ajena (AUDIT `portal-auth-por-email-no-userid`). Ahora autoriza el vínculo
 * `Patient.userId` por (tenantId, userId), que solo se escribe con las reglas de `lib/portal-link-internal.ts`
 * (exactamente una ficha libre, o invitación con token) y CAS.
 *
 * Reglas:
 *   - nunca mira el email para autorizar (guard `tests/unit/portal-identity-guard.test.ts`);
 *   - `findFirst`/`findMany` por `{ tenantId, userId }` o `{ userId }`, nunca `findUnique` por userId: el único es
 *     por consultorio (`Patient_tenantId_userId_key`), la misma cuenta tiene una ficha en cada consultorio;
 *   - staff ≠ paciente (AUDIT §5.22): con Membership en cualquier consultorio, el portal no la trata como paciente;
 *   - ES4-D4: una ficha archivada no ve el portal de ese consultorio;
 *   - canal `prismaService` (sin Actor ni GUC): por eso cada query lleva `userId` y `tenantId` explícitos, y los
 *     callers (S24, S24p, S24d, S24e) acotan todo lo que lean por el par `patientId` + `tenantId` del ref.
 *
 * El alias de slug viejo se resuelve en la página (`resolveSlugAlias`), no acá.
 */
import type { TenantModule } from "@/lib/tenant-modules";
import type { TenantAccessInput } from "@/lib/tenant-access";
import type { TenantVertical } from "@prisma/client";
// Superficie del paciente, sin Actor: canal service (BYPASSRLS). Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { getTenantModulesById } from "@/lib/tenant-entitlements-internal";
import { publicSurfacesOpenFor } from "@/lib/public-booking-internal";

export type PortalUser = { id: string; email: string; fullName: string | null; isStaff: boolean };

/**
 * null = sin sesión o email sin confirmar. Mismo criterio que el `verifiedUser()` que vivía en lib/portal.ts: el
 * portal NUNCA actúa sobre un email sin verificar (toma de cuenta por alta con el email de otro). El magic link del
 * portal llega por `/auth/confirm` → `verifyOtp`, que confirma el email al canjearse (IAM-3c).
 */
export async function getPortalUser(): Promise<PortalUser | null> {
  // `getVerifiedSessionUser` (IAM-3a): un round-trip a GoTrue por request (memo), trae `email_confirmed_at` (el JWT
  // no) y nunca tira.
  const user = await getVerifiedSessionUser();
  if (!user?.email) return null;
  if (!user.emailConfirmedAt) return null;
  const staff = await prisma.membership.findFirst({ where: { userId: user.id }, select: { id: true } });
  return { id: user.id, email: user.email.toLowerCase(), fullName: user.fullName, isStaff: !!staff };
}

export type PortalPatientRef = {
  userId: string;
  tenantId: string;
  patientId: string;
  tenant: { id: string; slug: string; name: string; vertical: TenantVertical; publicEmail: string | null };
  modules: ReadonlySet<TenantModule>; // getTenantModulesById(tenantId)
  surfacesOpen: boolean; // publicSurfacesOpenFor(tenant): escrituras sin Actor (check-in, «Mis datos»)
  patient: { firstName: string; lastName: string; assignedPractitionerId: string | null };
};

const TENANT_SELECT = {
  id: true,
  slug: true,
  name: true,
  vertical: true,
  publicEmail: true,
  // TenantAccessInput (BO2-D): lo que necesita `publicSurfacesOpenFor`.
  status: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  subscriptionStatusChangedAt: true,
} as const;

const PATIENT_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  firstName: true,
  lastName: true,
  assignedPractitionerId: true,
} as const;

type TenantRow = TenantAccessInput & {
  id: string;
  slug: string;
  name: string;
  vertical: TenantVertical;
  publicEmail: string | null;
};

async function toRef(
  userId: string,
  tenant: TenantRow,
  patient: { id: string; firstName: string; lastName: string; assignedPractitionerId: string | null }
): Promise<PortalPatientRef> {
  return {
    userId,
    tenantId: tenant.id,
    patientId: patient.id,
    // Allowlist explícita: los campos de acceso (status/suscripción) se usan acá y no viajan en el ref.
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      vertical: tenant.vertical,
      publicEmail: tenant.publicEmail,
    },
    modules: await getTenantModulesById(tenant.id),
    surfacesOpen: publicSurfacesOpenFor(tenant),
    patient: {
      firstName: patient.firstName,
      lastName: patient.lastName,
      assignedPractitionerId: patient.assignedPractitionerId,
    },
  };
}

/**
 * Resuelve por (tenantId, userId): `prisma.patient.findFirst({ where: { tenantId, userId, archivedAt: null } })`
 * (ES4-D4). null si: sin usuario verificado, staff (§5.22), slug inexistente o sin ficha VINCULADA.
 * Nunca mira el email. S24, S24p, S24d y S24e la usan; nadie más autoriza en el portal.
 */
export async function requirePortalPatient(slug: string): Promise<PortalPatientRef | null> {
  const me = await getPortalUser();
  if (!me || me.isStaff) return null;
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: TENANT_SELECT });
  if (!tenant) return null;
  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, userId: me.id, archivedAt: null },
    select: PATIENT_SELECT,
  });
  // Defensa en profundidad sobre el canal BYPASSRLS: la fila tiene que ser de ESTE consultorio y de ESTA cuenta.
  if (!patient || patient.tenantId !== tenant.id || patient.userId !== me.id) return null;
  return toRef(me.id, tenant, patient);
}

/**
 * Fichas vinculadas a la cuenta, en todos los consultorios: `findMany({ where: { userId } })`. Nunca findUnique.
 * No mira staff: lo decide el caller con `getPortalUser()` (getPortalAuth devuelve «sin fichas» para staff).
 * Orden estable (alta de la ficha, id) para que la lista del portal no salte entre renders.
 */
export async function listPortalPatients(userId: string): Promise<PortalPatientRef[]> {
  if (!userId) return [];
  const rows = await prisma.patient.findMany({
    where: { userId, archivedAt: null },
    select: { ...PATIENT_SELECT, tenant: { select: TENANT_SELECT } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return Promise.all(rows.filter((r) => r.userId === userId).map((r) => toRef(userId, r.tenant, r)));
}
