"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import {
  INVITE_MESSAGES,
  activateInvitation,
  type ActivateInvitationInputType,
  type ActivationActionResult,
} from "@/lib/invite-activation-internal";

/**
 * «Activar tu cuenta» desde `/invite/<token>` (IAM-2b, arreglo del punto 4 del
 * QA del 14-oct). Todo lo que escribe vive en `activateInvitation`
 * (`lib/invite-activation-internal.ts`, testeado contra la base con el fake de
 * GoTrue); acá queda lo que necesita el request real:
 *
 *  1. la IP para el rate limit;
 *  2. `signInWithPassword` con el cliente de Supabase con cookies: la cuenta
 *     se acaba de crear con esa contraseña, así que el invitado entra sin un
 *     segundo paso (antes: «Te mandamos un email» que nunca llegaba);
 *  3. `redirect("/dashboard")`.
 *
 * Si el login falla después de activar (no debería: la cuenta nace
 * confirmada) se le dice que la cuenta ya está y que ingrese a mano: nada se
 * deshace, la membresía y la invitación aceptada son correctas.
 */
export async function activateInvitationAction(
  input: ActivateInvitationInputType
): Promise<ActivationActionResult> {
  const r = await activateInvitation(input, { ip: clientIp(headers()) });
  if (!r.ok) return r;

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email: r.email, password: input.password });
    if (error) {
      logger.warn("invitation.activate.signin_failed", { invitationId: r.invitationId, code: error.code });
      return { ok: false, code: "signin_failed", error: INVITE_MESSAGES.signin_failed };
    }
  } catch (err) {
    logger.warn("invitation.activate.signin_failed", {
      invitationId: r.invitationId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { ok: false, code: "signin_failed", error: INVITE_MESSAGES.signin_failed };
  }

  // Fuera del try: `redirect` tira NEXT_REDIRECT a propósito.
  redirect("/dashboard");
}
