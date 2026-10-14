import "server-only";
/**
 * IAM-3c · a quién se le manda un link de ingreso al portal y adónde lleva.
 *
 * Lo usa `requestPortalLink` (`lib/portal-auth.ts`, pedido anónimo desde `/portal`). Vive fuera del
 * `"use server"` para que no quede expuesto como RPC (AUDIT §5.12) y para testear la decisión real.
 *
 * Regla central (supuesto [S4] del fake de GoTrue, `tests/helpers/gotrue-fake.ts`): un `generateLink`
 * magiclink a un email SIN cuenta **crea la cuenta**. Así que el link se pide SOLO si hay una ficha de
 * paciente con ese email exacto en algún consultorio; si no, no se toca GoTrue (un formulario anónimo no
 * puede fabricar cuentas para cualquier email).
 *
 * Decisión documentada: con ficha y sin cuenta, crear la cuenta vía magiclink ES aceptable. La ficha la
 * cargó el consultorio (es la misma confianza que la invitación al portal), la cuenta nace SIN confirmar y
 * solo se confirma cuando alguien con acceso al buzón abre el link (`/auth/confirm` → `verifyOtp`). Si
 * nunca lo abre, queda una cuenta sin confirmar e inofensiva (sin perfil ni membresías: la puede limpiar
 * `canSafelyDeleteAuthUser`).
 *
 * Staff ≠ paciente (AUDIT §5.22): una identidad con Membership en cualquier consultorio no recibe link
 * del portal (el portal igual no le mostraría fichas). Ningún caso cambia la respuesta al navegador.
 *
 * Canal service (BYPASSRLS): no hay Actor (el pedido es anónimo) y la búsqueda es entre consultorios por
 * email, como `getPortalAuth`. Todo match de email va escapado + `sameEmail` (C-IAM4, IAM-0a).
 */
import { prismaService as prisma } from "@/lib/db";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";

export type PortalLinkTarget =
  | {
      kind: "send";
      /** Destino después de `/auth/confirm`: `/portal/c/<slug>` si tiene ficha en ese consultorio, si no `/portal`. */
      next: string;
      /** Consultorio del mail (remitente, EmailLog): el del slug, o el único donde tiene ficha. */
      tenant: { id: string; name: string; publicEmail: string | null } | null;
      /** Ficha que motivó el envío (EmailLog `entityId`), si es una sola. */
      patientId: string | null;
    }
  | { kind: "skip"; reason: "no_patient" | "staff" };

export async function resolvePortalLinkTarget(email: string, slug: string | null): Promise<PortalLinkTarget> {
  const rows = await prisma.patient.findMany({
    where: { email: emailEqualsFilter(email) },
    select: {
      id: true,
      email: true,
      tenant: { select: { id: true, slug: true, name: true, publicEmail: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const patients = rows.filter((r) => sameEmail(r.email, email));
  if (patients.length === 0) return { kind: "skip", reason: "no_patient" };

  // Staff: por el email del perfil (toda identidad de staff tiene UserProfile) y post-filtro exacto.
  const staff = await prisma.membership.findMany({
    where: { user: { email: emailEqualsFilter(email) } },
    select: { user: { select: { email: true } } },
    take: 5,
  });
  if (staff.some((m) => sameEmail(m.user.email, email))) return { kind: "skip", reason: "staff" };

  const inSlug = slug ? patients.filter((p) => p.tenant.slug === slug) : [];
  if (inSlug.length > 0) {
    const t = inSlug[0].tenant;
    return {
      kind: "send",
      next: `/portal/c/${t.slug}`,
      tenant: { id: t.id, name: t.name, publicEmail: t.publicEmail },
      patientId: inSlug.length === 1 ? inSlug[0].id : null,
    };
  }
  // Sin slug (o con el slug de un consultorio donde no tiene ficha): al portal general. Si todas sus fichas
  // son de un mismo consultorio, el mail lleva su nombre; si no, va sin consultorio.
  const tenantIds = new Set(patients.map((p) => p.tenant.id));
  const only = tenantIds.size === 1 ? patients[0].tenant : null;
  return {
    kind: "send",
    next: "/portal",
    tenant: only ? { id: only.id, name: only.name, publicEmail: only.publicEmail } : null,
    patientId: patients.length === 1 ? patients[0].id : null,
  };
}
