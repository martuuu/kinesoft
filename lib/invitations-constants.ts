/**
 * Constantes y helpers puros de las invitaciones de equipo (IAM-2a). Viven fuera de `lib/invitations.ts` porque un
 * archivo `"use server"` solo puede exportar funciones async, y `lib/onboarding.ts` (`openPendingInvitation`) usa
 * las mismas reglas.
 */

/** Vigencia de una invitación (y de cada reenvío / link nuevo, que la extienden desde ahora). */
export const INVITE_TTL_MS = 7 * 86_400_000;

/**
 * Cuántos links anteriores (hashes en `Invitation.priorTokens`) siguen valiendo después de varios «Reenviar».
 * Hallazgo del 14-oct: reenviar rotaba el token y el link del primer mail daba 404; ahora el hash anterior se
 * guarda. El tope evita que una invitación reenviada muchas veces acumule links vivos sin fin: con el rate limit
 * del destinatario (1 cada 10 min) diez reenvíos son más de hora y media de insistencia, y el invitado siempre
 * tiene el mail más nuevo.
 */
export const PRIOR_TOKENS_MAX = 10;

/** Lista de anteriores después de reenviar: agrega el hash que deja de ser el vigente y recorta a los más nuevos. */
export function appendPriorToken(prior: readonly string[], previousHash: string): string[] {
  const next = prior.filter((h) => h !== previousHash);
  next.push(previousHash);
  return next.slice(-PRIOR_TOKENS_MAX);
}

/**
 * Qué decirle a quien invitó sobre el mail (IAM-2a). Reemplaza el «✓ Email enviado vía Supabase» / «Configurá
 * SUPABASE_SERVICE_ROLE_KEY…», que mentía en los dos sentidos: «enviado» solo quería decir que Supabase no devolvió
 * error (el SMTP default no entrega a externos) y la key no tenía nada que ver con que el mail saliera.
 * `tone` = cómo pintarlo: ok (salió), warn (no salió por el entorno: compartí el link) o error (falló o bloqueado).
 */
export function inviteEmailStatusCopy(
  status: "sent" | "skipped" | "failed" | "blocked",
  reason: string | null
): { tone: "ok" | "warn" | "error"; text: string } {
  switch (status) {
    case "sent":
      return { tone: "ok", text: "Mandamos el mail de invitación." };
    case "skipped":
      return {
        tone: "warn",
        text:
          reason === "no_api_key"
            ? "El mail no salió: el envío de mails todavía no está configurado. Compartí el link a mano."
            : "El mail no salió en este entorno (los mails solo salen en producción). Compartí el link a mano.",
      };
    case "blocked":
      return { tone: "error", text: "El mail no salió: el link apuntaba a una dirección local. Avisale a soporte." };
    case "failed":
      return { tone: "error", text: "El proveedor de mails rechazó el envío. Probá reenviar en unos minutos o compartí el link." };
  }
}

/** «N cosa(s)» con plural regular en español (turno/turnos, paciente asignado/pacientes asignados). */
function countNoun(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Por qué no se puede pasar a alguien a un rol no clínico (IAM-4c). Una Secretaria o Facturación no es reservable
 * (`bookablePractitionerWhere`) ni «posee» pacientes (`ownPatientsWhere` con `practitionerId` null): sus turnos
 * futuros saldrían de la agenda por profesional y sus pacientes quedarían a cargo de nadie. Mismo criterio que
 * `removeMember`: se frena con el conteo y se reasigna primero. Devuelve null si no hay nada que reasignar.
 */
export function reassignBeforeRoleChangeCopy(futureBookings: number, assignedPatients: number): string | null {
  const parts: string[] = [];
  if (futureBookings > 0) parts.push(countNoun(futureBookings, "turno futuro", "turnos futuros"));
  if (assignedPatients > 0) parts.push(countNoun(assignedPatients, "paciente asignado", "pacientes asignados"));
  if (parts.length === 0) return null;
  return `Reasigná sus ${parts.join(" y ")} antes de cambiarle el rol: con ese rol ya no atiende.`;
}

/**
 * Qué decirle a quien pidió «Mandar link para nueva contraseña» (IAM-4c). A diferencia de la invitación, acá NUNCA
 * hay un link para compartir a mano (quien gestiona el equipo no lo ve: es la llave de la cuenta de otra persona),
 * así que cuando el mail no sale el camino es «Olvidé mi contraseña» desde el login.
 */
export function passwordResetEmailStatusCopy(
  status: "sent" | "skipped" | "failed" | "blocked",
  reason: string | null
): { tone: "ok" | "warn" | "error"; text: string } {
  switch (status) {
    case "sent":
      return { tone: "ok", text: "Le mandamos el mail con el link para crear una contraseña nueva." };
    case "skipped":
      return {
        tone: "warn",
        text:
          reason === "no_api_key"
            ? "El mail no salió: el envío de mails todavía no está configurado. Pedile que use «Olvidé mi contraseña» al ingresar."
            : "El mail no salió en este entorno (los mails solo salen en producción).",
      };
    case "blocked":
      return { tone: "error", text: "El mail no salió: el link apuntaba a una dirección local. Avisale a soporte." };
    case "failed":
      return { tone: "error", text: "El proveedor de mails rechazó el envío. Probá de nuevo en unos minutos." };
  }
}
