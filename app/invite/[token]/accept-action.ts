"use server";

// Pre-membership provisioning: the user is NOT yet a member of the invite's
// tenant, so no Actor GUC exists → service channel (BYPASSRLS). See lib/db.ts.
import { headers } from "next/headers";
import { revalidateTag } from "next/cache";
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { sameEmail } from "@/lib/email-match";
import { tags } from "@/lib/cache-tags";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { findInvitationByRawToken } from "@/lib/invitations-internal";
import {
  INVITE_MESSAGES,
  InvitationRaceError,
  closedInvitationMessage,
  joinTenantInTx,
  setActiveTenantCookie,
  usedAsPortalPatient,
} from "@/lib/invite-activation-internal";
import type { ActionResult } from "@/lib/validation";

/**
 * Aceptar una invitación con una sesión que YA existe (alguien con cuenta: un
 * kine de otro consultorio, o quien activó antes y volvió a entrar). Quien no
 * tiene cuenta la crea en la misma página con `activateInvitationAction`
 * (IAM-2b, `activate-action.ts`).
 *
 * IAM-2b:
 *   - la invitación se resuelve con `findInvitationByRawToken` (C-IAM5): un
 *     link anterior reenviado sigue valiendo (antes: 404 tras «Reenviar») y una
 *     anulada se rechaza (antes no existía el estado);
 *   - las filas las escribe `joinTenantInTx` (la misma de la activación): CAS
 *     sobre `acceptedAt IS NULL AND revokedAt IS NULL` primero, así dos
 *     aceptaciones a la vez no escriben dos veces; perfil, Practitioner DE ESTE
 *     consultorio (IAM-1: un kine de A que acepta B queda profesional de B con
 *     su agenda), membresía, agenda por defecto y audit en la misma tx;
 *   - cookie `kine_tenant` = este consultorio: quien acepta entra al que acaba
 *     de aceptar, no al anterior.
 *
 * Staff ≠ paciente (AUDIT §5.22) se mantiene: una identidad del portal de
 * pacientes no se suma al equipo.
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

  const now = new Date();
  const invite = await findInvitationByRawToken(token, now);
  if (!invite) return { ok: false, error: INVITE_MESSAGES.not_found };
  if (invite.status !== "pending") return { ok: false, error: closedInvitationMessage(invite.status) };
  if (!sameEmail(invite.email, user.email)) {
    return { ok: false, error: "El email de tu sesión no coincide con la invitación." };
  }

  if (await usedAsPortalPatient({ userId: user.id, email: user.email })) {
    return { ok: false, error: INVITE_MESSAGES.patient_identity };
  }

  try {
    const existing = await prisma.userProfile.findUnique({ where: { id: user.id }, select: { fullName: true } });
    const metaName = (user.user_metadata?.full_name as string | undefined)?.trim() || null;
    await prisma.$transaction((tx) =>
      joinTenantInTx(tx, {
        invitation: invite,
        userId: user.id,
        email: user.email!,
        // Antes se pisaba el nombre con el de la invitación en cada aceptación; ahora solo si no hay uno.
        fullName: metaName ?? existing?.fullName ?? `${invite.firstName} ${invite.lastName}`,
        avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
        now,
        via: "session",
      })
    );
  } catch (err) {
    if (err instanceof InvitationRaceError) {
      const again = await findInvitationByRawToken(token, new Date());
      return {
        ok: false,
        error: closedInvitationMessage(again && again.status !== "pending" ? again.status : "accepted"),
      };
    }
    // Nunca el token crudo en logs (handoff A3a): con él se acepta la
    // invitación. El id de la invitación alcanza para correlacionar.
    logger.error("invitation.accept.failed", {
      invitationId: invite.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "No pudimos aceptar la invitación." };
  }

  // Handoff A2: el nuevo miembro puede ser un Practitioner nuevo → el
  // listado cacheado de profesionales del tenant queda viejo sin esto.
  revalidateTag(tags.practitioners(invite.tenantId));
  setActiveTenantCookie(invite.tenantId);
  logger.info("invitation.accept", { invitationId: invite.id, tenantId: invite.tenantId });
  return { ok: true, data: undefined };
}
