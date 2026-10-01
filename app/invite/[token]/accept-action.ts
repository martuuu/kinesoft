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
 *   - Upsert `Practitioner` for this tenant (one Practitioner per
 *     UserProfile per schema constraint, so if the user is already a
 *     practitioner somewhere, that's their row — we just attach a
 *     membership to this tenant).
 *   - Upsert `Membership` with the invited role.
 *   - B-pre B2.3: if the user is (now) a Practitioner OF THIS tenant, give
 *     them the default agenda, same rules/ids as the agenda_foundations
 *     backfill: primary Location (created if missing), Mon-Sat slots with the
 *     tenant hours, PractitionerService for shared services (and their own),
 *     PractitionerPayer for every active Insurer. Idempotent.
 *   - Stamp `Invitation.acceptedAt`.
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
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
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
        { email: { equals: user.email, mode: "insensitive" }, userId: { not: null } },
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

      // The Practitioner row has a unique constraint on userId, so the
      // same human can only "be a practitioner" in one tenant via this
      // table. If they already have a practitioner row in another
      // tenant, we still create the Membership but skip Practitioner.
      const existingPrac = await tx.practitioner.findUnique({
        where: { userId: user.id },
        select: { id: true, tenantId: true },
      });
      let practitionerId: string | null =
        existingPrac?.tenantId === invite.tenant.id ? existingPrac.id : null;
      if (!existingPrac) {
        const created = await tx.practitioner.create({
          data: {
            userId: user.id,
            tenantId: invite.tenant.id,
            specialty: invite.specialty,
          },
          select: { id: true },
        });
        practitionerId = created.id;
      }

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
      // "profesional con membresía aceptada"). Solo si el Practitioner es de
      // ESTE tenant: el de otro consultorio no atiende acá (no hay qué
      // configurar). Idempotente: una segunda invitación aceptada por la
      // misma persona no duplica ni pisa franjas ya cargadas.
      if (practitionerId) {
        await provisionPractitionerAgenda(tx, { tenantId: invite.tenant.id, practitionerId });
      }

      await tx.invitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
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
