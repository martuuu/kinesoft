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
 *   - IAM-3c: el log de rechazo ya no lleva el email en claro (el logger lo
 *     redactaba, pero el contrato es no pasarlo: alcanza con slug y motivo).
 *   - IAM-3c: con dos fichas del mismo email en un consultorio (familia que
 *     comparte el mail) se vincula UNA, siempre la misma (la más vieja): el
 *     único es (tenantId, userId) y el `findFirst` sin orden podía elegir la
 *     otra en el siguiente login → P2002 → el callback devolvía 500.
 *
 * `linkPortalPatientsOnSignIn` (IAM-3c) es la puerta de entrada al iniciar
 * sesión: deduce los consultorios del `next` (Google y magic link vuelven con
 * `next=/portal` o `/portal/c/<slug>`). Antes el callback solo vinculaba con
 * `?tenant=<slug>`, que NADIE armaba (`app/api/auth/google/route.ts` manda solo
 * `next`): el vínculo no ocurría nunca y el portal funcionaba solo por el
 * match de email. El vínculo importa: es lo que hace valer «staff ≠ paciente»
 * en el signup y en las invitaciones (AUDIT §5.22, `userId: { not: null }`).
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
  // Ya vinculada a ESTA identidad en este consultorio: nada que hacer (el único
  // (tenantId, userId) no permite una segunda ficha).
  const already = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, userId: user.id },
    select: { id: true },
  });
  if (already) return "linked";
  const candidates = await prisma.patient.findMany({
    where: { tenantId: tenant.id, email: emailEqualsFilter(user.email) },
    select: { id: true, userId: true, email: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const exact = candidates.filter((c) => sameEmail(c.email, user.email));
  if (exact.length === 0) return "no_patient";
  // Preferir una ficha libre: si la más vieja es de otra identidad y hay otra
  // libre con el mismo email (familia), se vincula la libre.
  const patient = exact.find((c) => c.userId == null) ?? exact[0];
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
    reason: "patient already linked to a different identity",
  });
  return "linked_elsewhere";
}

const PORTAL_TENANT_RE = /^\/portal\/c\/([a-z0-9-]{1,64})(?:[/?#]|$)/;

/**
 * Vínculo al iniciar sesión (Google por `/auth/callback`, magic link por
 * `/auth/confirm`). Solo actúa si el destino es el portal:
 *   - `/portal/c/<slug>` → ese consultorio;
 *   - `/portal` (o cualquier otra ruta del portal) → cada consultorio con una
 *     ficha de ese email EXACTO (lo mismo que el portal ya le muestra).
 * Cualquier otro destino (staff que entra al dashboard) no vincula nada.
 * Las reglas de AUDIT §5.8 las aplica `linkPortalPatientOnCallback` por
 * consultorio. Nunca tira: un vínculo que falla no puede dejar sin entrar.
 */
export async function linkPortalPatientsOnSignIn(
  user: { id: string; email: string | null | undefined; emailVerified: boolean },
  next: string
): Promise<PortalLinkOutcome[]> {
  if (!user.email || !user.emailVerified) return [];
  const path = next.startsWith("/") ? next : "";
  if (path !== "/portal" && !path.startsWith("/portal/") && !path.startsWith("/portal?")) return [];
  try {
    const m = PORTAL_TENANT_RE.exec(path);
    let slugs: string[];
    if (m) {
      slugs = [m[1]];
    } else {
      const rows = await prisma.patient.findMany({
        where: { email: emailEqualsFilter(user.email) },
        select: { email: true, tenant: { select: { slug: true } } },
      });
      slugs = Array.from(new Set(rows.filter((r) => sameEmail(r.email, user.email)).map((r) => r.tenant.slug)));
    }
    const out: PortalLinkOutcome[] = [];
    for (const slug of slugs) out.push(await linkPortalPatientOnCallback(user, slug));
    return out;
  } catch (err) {
    logger.warn("portal.link.failed", { error: err instanceof Error ? err.name : "unknown" });
    return [];
  }
}
