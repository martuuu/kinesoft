"use server";

/**
 * ES4 S24v · vincular la ficha desde la invitación del consultorio (brief §3.4, PD-15).
 *
 * El consultorio manda una invitación (`sendPatientPortalInvite`) con un token HMAC de 7 días
 * (`lib/portal-invite-token.ts`) que apunta a UNA ficha. Es la salida para los casos que el auto-vínculo por email no
 * resuelve a propósito: dos fichas con el mismo email en el consultorio (`ambiguous`), o una ficha que ganó el email
 * después. El vínculo pasa acá, en un POST explícito: la página (`/portal/vincular`) nunca escribe en el GET (mismo
 * criterio anti-escáner que `/auth/confirm`: un antivirus de correo que abre el link no puede vincular nada).
 *
 * Reglas, todas antes de escribir:
 *   - token válido (firma, 7 días) → si no, `invalid`;
 *   - sesión con email verificado (`getPortalUser`) y que no sea staff (AUDIT §5.22);
 *   - el email de la sesión es el de la invitación (`emailHash`): la invitación la abre quien recibió el mail, no
 *     cualquiera que tenga el link reenviado;
 *   - la ficha existe en ESE consultorio (el par sale del token firmado; canal BYPASSRLS → `tenantId` en el where),
 *     no está archivada (ES4-D4) y TODAVÍA tiene ese email: si el consultorio corrigió un email mal cargado, la
 *     invitación vieja (que pudo llegarle a otra persona) deja de valer sin esperar los 7 días;
 *   - la escritura es `linkPatientCas` (count 1): ficha de otra cuenta → `linked_elsewhere`, otra ficha de esta cuenta
 *     en el consultorio (único (tenantId, userId), P2002) → `conflict`. Usar dos veces el mismo token con la misma
 *     cuenta da `already`, sin escribir: el «un solo uso» lo da el CAS, sin tabla.
 *
 * Logs `portal.invite.*` con `reason` y slug: nunca el token ni el email (IAM-3c).
 */
import { redirect } from "next/navigation";
// Superficie del paciente, sin Actor: canal service (BYPASSRLS). Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { getPortalUser } from "@/lib/portal-identity-internal";
import { linkPatientCas } from "@/lib/portal-link-internal";
import { portalEmailHash, readPortalInviteToken } from "@/lib/portal-invite-token";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { PORTAL_VINCULAR_ERRORS, portalVincularPath, type PortalVincularError } from "@/lib/portal-vincular-copy";
import type { ActionResult } from "@/lib/validation";

type Outcome = { ok: true; slug: string; outcome: "linked" | "already" } | { ok: false; code: PortalVincularError };

function refuse(code: PortalVincularError, tenantSlug?: string): Outcome {
  logger.warn("portal.invite.refused", tenantSlug ? { tenantSlug, reason: code } : { reason: code });
  return { ok: false, code };
}

async function linkByInvite(token: string | null): Promise<Outcome> {
  const claims = readPortalInviteToken(token);
  if (!claims) return refuse("invalid");

  const me = await getPortalUser();
  if (!me) return refuse("session");
  if (me.isStaff) return refuse("staff");

  // 10/h por cuenta (brief §3.4): cada intento lee la base; con un token válido en la mano no hay nada que adivinar,
  // pero un loop no puede martillar el CAS.
  const rl = await rateLimit(`portal-vincular:user:${me.id}`, { limit: 10, windowMs: 3_600_000 });
  if (!rl.ok) return refuse("rate_limited");

  if (portalEmailHash(me.email) !== claims.emailHash) return refuse("other_email");

  const patient = await prisma.patient.findFirst({
    where: { id: claims.patientId, tenantId: claims.tenantId },
    select: { id: true, tenantId: true, userId: true, email: true, archivedAt: true, tenant: { select: { slug: true } } },
  });
  if (!patient || patient.tenantId !== claims.tenantId || patient.archivedAt) return refuse("not_found");
  const slug = patient.tenant.slug;
  if (!patient.email || portalEmailHash(patient.email) !== claims.emailHash) return refuse("invalid", slug);
  if (patient.userId && patient.userId !== me.id) return refuse("linked_elsewhere", slug);
  if (!patient.userId) {
    // El único (tenantId, userId) no admite una segunda ficha de esta cuenta en el consultorio: se avisa con su
    // motivo en vez de dejar que el CAS lo descubra como P2002.
    const other = await prisma.patient.findFirst({
      // Las archivadas no cuentan (M1): el CAS libera su vínculo en la misma tx.
      where: { tenantId: claims.tenantId, userId: me.id, archivedAt: null, NOT: { id: patient.id } },
      select: { id: true },
    });
    if (other) return refuse("conflict", slug);
  }

  const r = await linkPatientCas({ userId: me.id, tenantId: claims.tenantId, patientId: patient.id });
  // count 0 (otra cuenta la tomó entre la lectura y el write) o P2002 (carrera con otra ficha de esta cuenta).
  if (r === "conflict") return refuse("linked_elsewhere", slug);
  logger.info("portal.invite.linked", { tenantSlug: slug, outcome: r });
  return { ok: true, slug, outcome: r };
}

function tokenFrom(formData: FormData): string | null {
  const t = formData.get("t");
  return typeof t === "string" && t ? t : null;
}

/** Contrato §3.4: vincula y devuelve el slug del consultorio; los errores, en voseo. */
export async function linkPortalByInvite(formData: FormData): Promise<ActionResult<{ slug: string }>> {
  const r = await linkByInvite(tokenFrom(formData));
  return r.ok ? { ok: true, data: { slug: r.slug } } : { ok: false, error: PORTAL_VINCULAR_ERRORS[r.code] };
}

/**
 * La action del form de `/portal/vincular` (anda sin JS): vinculada → `/portal/c/<slug>`; si no, vuelve a la página
 * con `?e=<código>` (nunca texto libre en la URL). Sin token legible vuelve al portal: no hay invitación que mostrar.
 */
export async function submitPortalInvite(formData: FormData): Promise<void> {
  const token = tokenFrom(formData);
  const r = await linkByInvite(token);
  // ES4-Z (b): `?vinculado=1` → la página del consultorio confirma «Listo: vinculaste tu ficha de …».
  if (r.ok) redirect(`/portal/c/${encodeURIComponent(r.slug)}?vinculado=1`);
  if (!token || token.length > 1024) redirect("/portal");
  redirect(portalVincularPath(token, r.code));
}
