import "server-only";
/**
 * Vinculación de la identidad de portal con la ficha (`Patient.userId`) al
 * volver del OAuth (`app/auth/callback/route.ts`). Extraído de la ruta en
 * IAM-0a para poder testear la función REAL contra Postgres: un route handler
 * de Next solo puede exportar los verbos HTTP y la config.
 *
 * Reglas (ver el doc de la ruta):
 *   - solo con `email_confirmed_at`: una identidad sin verificar nunca se
 *     vincula a PHI (lo chequea el caller y se vuelve a chequear acá);
 *   - staff ≠ paciente (A3b-S-auth): con Membership en cualquier consultorio no
 *     se vincula;
 *   - no se "roba" una ficha ya vinculada a otra identidad;
 *   - IAM-0a: match de email EXACTO. Con `equals` + `mode: "insensitive"` el
 *     email iba pelado a un `ILIKE` y `jpere_@hotmail.com` (verificado) se
 *     vinculaba a la ficha SIN vincular de `jperez@hotmail.com` = toma de
 *     ficha. Filtro escapado + `sameEmail` antes de escribir.
 */
// OAuth callback, no Actor; tenant resolved by slug + Patient/PatientTenantLink
// writes → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";

export type PortalLinkOutcome =
  | "linked"
  | "no_tenant"
  | "unverified"
  | "staff"
  | "no_patient"
  | "linked_elsewhere";

export async function linkPortalPatientOnCallback(
  user: { id: string; email: string | null | undefined; emailVerified: boolean },
  tenantSlug: string
): Promise<PortalLinkOutcome> {
  if (!user.email || !user.emailVerified) return "unverified";
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  const isStaff = !!(await prisma.membership.findFirst({
    where: { userId: user.id },
    select: { id: true },
  }));
  if (tenant && isStaff) {
    logger.warn("portal.link.refused", { tenantSlug, reason: "identity_is_staff" });
    return "staff";
  }
  if (!tenant) return "no_tenant";
  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, email: emailEqualsFilter(user.email) },
    select: { id: true, userId: true, email: true },
  });
  if (!patient || !sameEmail(patient.email, user.email)) return "no_patient";
  // Only link if this Patient row has no userId yet OR is already
  // bound to this same user. Refuses to "steal" a Patient already
  // linked to another Supabase identity.
  if (patient.userId == null || patient.userId === user.id) {
    await prisma.patient.update({
      where: { id: patient.id },
      data: { userId: user.id },
    });
    await prisma.patientTenantLink.upsert({
      where: { patientId_tenantId: { patientId: patient.id, tenantId: tenant.id } },
      create: { patientId: patient.id, tenantId: tenant.id },
      update: {},
    });
    return "linked";
  }
  logger.warn("portal.link.refused", {
    tenantSlug,
    email: user.email,
    reason: "patient already linked to a different identity",
  });
  return "linked_elsewhere";
}
