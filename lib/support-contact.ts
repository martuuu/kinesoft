/**
 * [BO-Z B4] Canal de soporte de KineSoft. Antes cada pantalla de bloqueo decía «escribinos» sin decir a dónde: el
 * titular de un consultorio en solo lectura o suspendido no tenía cómo escribir (no hay billing in-app y el cambio
 * de plan lo hace Plataforma). Ahora el canal es UNA variable pública, `NEXT_PUBLIC_SUPPORT_EMAIL`:
 *  - seteada → «escribinos a soporte@…» con `mailto:` (componente `SupportContact`);
 *  - no seteada o inválida → «escribile al equipo de KineSoft», SIN link: un `mailto:` vacío o roto abre el cliente
 *    de mail en blanco y es peor que no ofrecerlo.
 *
 * Puro y client-safe. `process.env.NEXT_PUBLIC_SUPPORT_EMAIL` se lee con el nombre LITERAL a propósito: Next solo
 * inlinea en el bundle del cliente los accesos literales (`process.env[x]` quedaría `undefined` en el browser).
 * Para los tests se puede pasar el valor a mano.
 */

/** Validación simple (no RFC): algo@algo.tld, sin espacios ni `<>`/comillas que rompan el `href`. */
const EMAIL_RE = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/;

/** El email de soporte normalizado, o null si no está o no parece un email. */
export function supportEmail(raw: string | undefined | null = process.env.NEXT_PUBLIC_SUPPORT_EMAIL): string | null {
  const v = (raw ?? "").trim();
  return v && EMAIL_RE.test(v) ? v : null;
}

/** `mailto:` del soporte (con el asunto opcional ya codificado), o null sin email. */
export function supportMailto(email: string | null = supportEmail(), subject?: string): string | null {
  if (!email) return null;
  return subject ? `mailto:${email}?subject=${encodeURIComponent(subject)}` : `mailto:${email}`;
}

export const SUPPORT_FALLBACK_TEXT = "escribile al equipo de KineSoft";

/**
 * La frase en texto plano (para strings que no pueden llevar un link): «escribinos a soporte@…» o «escribile al
 * equipo de KineSoft». `capital` la arranca con mayúscula (inicio de oración).
 */
export function supportContactText(opts: { capital?: boolean; email?: string | null } = {}): string {
  const email = opts.email === undefined ? supportEmail() : opts.email;
  const s = email ? `escribinos a ${email}` : SUPPORT_FALLBACK_TEXT;
  return opts.capital ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
