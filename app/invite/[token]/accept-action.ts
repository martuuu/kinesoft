"use server";

import { prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { hashInviteToken } from "@/lib/invitations-tokens";
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
 *   - Stamp `Invitation.acceptedAt`.
 */
export async function acceptInvite(token: string): Promise<ActionResult> {
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
      if (!existingPrac) {
        await tx.practitioner.create({
          data: {
            userId: user.id,
            tenantId: invite.tenant.id,
            specialty: invite.specialty,
          },
        });
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
    logger.info("invitation.accept", {
      tenantSlug: invite.tenant.slug,
      email: invite.email,
    });

    return { ok: true, data: undefined };
  } catch (err) {
    logger.error("invitation.accept.failed", {
      token,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "No pudimos aceptar la invitación." };
  }
}
