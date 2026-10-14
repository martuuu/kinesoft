"use server";

// Pre-membership provisioning: the user is NOT yet a member of the invite's
// tenant, so no Actor GUC exists → service channel (BYPASSRLS). See lib/db.ts.
import { headers } from "next/headers";
import { revalidateTag } from "next/cache";
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import { tags } from "@/lib/cache-tags";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { provisionPractitionerAgenda } from "@/lib/agenda-defaults";
import type { ActionResult } from "@/lib/validation";

/**
 * Accept a team invitation. Caller must already be authenticated via
 * Supabase with the email that matches the invitation.
 *
 * On success we:
 *   - Upsert `UserProfile` from the Supabase user.
 *   - Find or create the `Practitioner` OF THIS TENANT. IAM-1 (M6, decisión
 *     6 de Martin del 14-oct): `Practitioner` es único por (tenantId,
 *     userId), así que un kine de A que acepta B queda profesional de B con
 *     su agenda. Antes (único global) se salteaba el Practitioner si tenía
 *     uno en otro consultorio y quedaba con membresía en B sin poder entrar
 *     (`buildActor` → no_membership → bucle, hallazgo [A] de §19.1).
 *   - Upsert `Membership` with the invited role.
 *   - B-pre B2.3: give the Practitioner of this tenant the default agenda,
 *     same rules/ids as the agenda_foundations backfill: primary Location
 *     (created if missing), Mon-Sat slots with the tenant hours,
 *     PractitionerService for shared services (and their own),
 *     PractitionerPayer for every active Insurer. Idempotent.
 *   - Stamp `Invitation.acceptedAt` + `acceptedByUserId` (M6).
 *
 * Todavía crea Practitioner para TODO rol (también Secretario/a y
 * Facturación): sacarlo es IAM-2e/IAM-4 (`PRACTITIONER_FOR_ALL_ROLES`).
 */
export async function acceptInvite(token: string): Promise<ActionResult> {
  // A3a-S-rl: sin límite se podía probar tokens por fuerza bruta (el token es
  // de 192 bits, así que es más contención de carga que de adivinanza) y
  // martillar el canal service. 10 cada 10 min por IP.
  const rl = await rateLimit(`invite:accept:${clientIp(headers())}`, { limit: 10, windowMs: 600_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { ok: false, error: "Iniciá sesión para aceptar la invitación." };
  }
  if (!user.email_confirmed_at) {
    return { ok: false, error: "Tenés que confirmar tu email antes de aceptar." };
  }

  const invite = await prisma.invitation.findUnique({
    where: { token: hashInviteToken(token) },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });
  if (!invite) return { ok: false, error: "Invitación inválida." };
  if (invite.acceptedAt) return { ok: false, error: "Esta invitación ya fue aceptada." };
  if (invite.expiresAt < new Date()) return { ok: false, error: "La invitación venció." };
  if (!sameEmail(invite.email, user.email)) {
    return { ok: false, error: "El email de tu sesión no coincide con la invitación." };
  }

  // Staff ≠ paciente (A3b-S-auth): una identidad que ya se usa en el portal
  // de pacientes (vinculada a una ficha, o su email es de una ficha con portal
  // vinculado) en CUALQUIER consultorio no se suma al equipo. Canal service a
  // propósito: quien pregunta es el dueño de la identidad, así que no filtra
  // nada ajeno (el chequeo de `createInvitation` es solo del propio tenant).
  const asPatient = await prisma.patient.findFirst({
    where: {
      OR: [
        { userId: user.id },
        // IAM-0a: escapado. Pelado en el ILIKE, la identidad `ana_@x.com` se
        // rechazaba por la ficha con portal de `anax@x.com` (otra persona).
        { email: emailEqualsFilter(user.email), userId: { not: null } },
      ],
    },
    select: { id: true },
  });
  if (asPatient) {
    return {
      ok: false,
      error:
        "Esta cuenta se usa en el portal de pacientes. Para sumarte al equipo, pedí la invitación con otro email.",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.userProfile.upsert({
        where: { id: user.id },
        create: {
          id: user.id,
          email: user.email!.toLowerCase(),
          fullName:
            (user.user_metadata?.full_name as string | undefined) ??
            `${invite.firstName} ${invite.lastName}`,
          avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
        },
        update: {
          email: user.email!.toLowerCase(),
          fullName:
            (user.user_metadata?.full_name as string | undefined) ??
            `${invite.firstName} ${invite.lastName}`,
        },
      });

      // IAM-1: el Practitioner DE ESTE consultorio (clave compuesta
      // tenantId+userId). Si ya existe (re-invitación de alguien que estuvo,
      // o una segunda invitación) se reusa sin pisar su especialidad; los de
      // otros consultorios no importan acá.
      const { id: practitionerId } = await tx.practitioner.upsert({
        where: { tenantId_userId: { tenantId: invite.tenant.id, userId: user.id } },
        create: {
          userId: user.id,
          tenantId: invite.tenant.id,
          specialty: invite.specialty,
        },
        update: {},
        select: { id: true },
      });

      await tx.membership.upsert({
        where: {
          userId_tenantId: { userId: user.id, tenantId: invite.tenant.id },
        },
        create: {
          userId: user.id,
          tenantId: invite.tenant.id,
          role: invite.role,
          acceptedAt: new Date(),
        },
        update: { acceptedAt: new Date(), role: invite.role },
      });

      // B2.3: después de la membresía aceptada (la regla del backfill es
      // "profesional con membresía aceptada"). Idempotente: una segunda
      // invitación aceptada por la misma persona no duplica ni pisa franjas
      // ya cargadas.
      await provisionPractitionerAgenda(tx, { tenantId: invite.tenant.id, practitionerId });

      await tx.invitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedByUserId: user.id },
      });
    });

    await audit({
      tenantId: invite.tenant.id,
      actorId: user.id,
      action: "invitation.accept",
      entity: "Invitation",
      entityId: invite.id,
    });
    // Handoff A2: el nuevo miembro puede ser un Practitioner nuevo → el
    // listado cacheado de profesionales del tenant queda viejo sin esto.
    revalidateTag(tags.practitioners(invite.tenant.id));
    logger.info("invitation.accept", {
      tenantSlug: invite.tenant.slug,
      email: invite.email,
    });

    return { ok: true, data: undefined };
  } catch (err) {
    // Nunca el token crudo en logs (handoff A3a): con él se acepta la
    // invitación. El id de la invitación alcanza para correlacionar.
    logger.error("invitation.accept.failed", {
      invitationId: invite.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "No pudimos aceptar la invitación." };
  }
}
