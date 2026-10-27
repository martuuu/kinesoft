/**
 * [BO-Z B4] Canal de soporte. Antes cada pantalla de bloqueo decía «escribinos» sin decir a dónde: el titular de un
 * consultorio en solo lectura o suspendido no tenía cómo escribir (no hay billing in-app y el cambio de plan lo hace
 * Plataforma). El email es UNA variable pública, `NEXT_PUBLIC_SUPPORT_EMAIL` (`supportEmail`: null si no está o no es
 * válida, nunca un mail vacío).
 *
 * Puro y client-safe. `process.env.NEXT_PUBLIC_SUPPORT_EMAIL` se lee con el nombre LITERAL a propósito: Next solo
 * inlinea en el bundle del cliente los accesos literales (`process.env[x]` quedaría `undefined` en el browser).
 * Para los tests se puede pasar el valor a mano.
 *
 * PV (§27, TK-U2): los links de soporte ya no son `mailto:` sino `/contacto?motivo=…` (`contactHref`). El email queda
 * solo como «segunda opción» escrita en el form de sesión de `/contacto`. PV INT-c borró `supportMailto`,
 * `supportContactText` y `SUPPORT_FALLBACK_TEXT`: sin llamadores después de que el alta asistida
 * (`signupAssistedMessage`) pasó a apuntar a la página de contacto.
 */
import type { TicketMotivo } from "@/lib/support-ticket-sources";

/** Validación simple (no RFC): algo@algo.tld, sin espacios ni `<>`/comillas que rompan el `href`. */
const EMAIL_RE = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/;

/** El email de soporte normalizado, o null si no está o no parece un email. */
export function supportEmail(raw: string | undefined | null = process.env.NEXT_PUBLIC_SUPPORT_EMAIL): string | null {
  const v = (raw ?? "").trim();
  return v && EMAIL_RE.test(v) ? v : null;
}

/**
 * PV (§27, TK-U2): link a la entrada pública única de contacto, `/contacto?motivo=<slug>&plan=<SaasPlan>`. Reemplaza al
 * `mailto:` en todo «escribinos» de soporte: decisión de Martin (27-oct, literal) «que todos los contactos de
 * formularios y consultas a soporte vayan a la parte de /plataforma de Superadmin, y se abran como "tickets"». Un mail
 * suelto no deja rastro en /plataforma; `/contacto` decide por la sesión (lead, Configuración → Soporte o ticket con
 * la identidad de la sesión) y siempre termina en un ticket.
 *
 * `motivo` sin validar acá a propósito: es un slug de `TICKET_MOTIVO` tipado en el llamador, y `/contacto` trata uno
 * desconocido como el default (`ticketSourceFromMotivo`).
 */
export function contactHref(motivo?: TicketMotivo, plan?: string): string {
  const q = new URLSearchParams();
  if (motivo) q.set("motivo", motivo);
  if (plan) q.set("plan", plan);
  const qs = q.toString();
  return qs ? `/contacto?${qs}` : "/contacto";
}
