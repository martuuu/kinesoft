/**
 * ES4 S24v · códigos y copy de `/portal/vincular` (brief §3.4). Puro: lo usan la action (`lib/portal-vincular.ts`,
 * que como `"use server"` solo puede exportar funciones async) y la página, que muestra el error que la action le
 * devuelve en `?e=<código>` (el form anda sin JS: el POST redirige de vuelta a la página con el código, nunca con
 * texto libre en la URL).
 */
export const PORTAL_VINCULAR_ERRORS = {
  /** Token vencido (7 días), alterado o mal formado; o la ficha ya no tiene el email al que se mandó. */
  invalid: "La invitación venció o ya no es válida. Pedile a tu consultorio que te mande una nueva.",
  session: "Entrá con tu cuenta para vincular tu ficha.",
  staff:
    "Entraste con una cuenta del equipo de un consultorio. El portal es para pacientes: entrá con tu email personal.",
  other_email:
    "Esta invitación es para otro email. Cerrá sesión y entrá con el email al que te llegó la invitación.",
  not_found: "No encontramos la ficha de esta invitación. Pedile a tu consultorio que te mande una nueva.",
  linked_elsewhere: "Esta ficha ya está vinculada a otra cuenta. Si es tuya, escribile a tu consultorio.",
  conflict: "Tu cuenta ya tiene otra ficha vinculada en este consultorio. Escribile a tu consultorio para que lo revise.",
  rate_limited: "Hiciste muchos intentos seguidos. Esperá un rato y probá de nuevo.",
} as const;

export type PortalVincularError = keyof typeof PORTAL_VINCULAR_ERRORS;

export function portalVincularErrorFrom(raw: string | null | undefined): PortalVincularError | null {
  return raw && Object.prototype.hasOwnProperty.call(PORTAL_VINCULAR_ERRORS, raw) ? (raw as PortalVincularError) : null;
}

/** Path de la página con el token (y el error, si hay). El token es base64url + ".": va tal cual, sin escapar. */
export function portalVincularPath(token: string, error?: PortalVincularError): string {
  const q = new URLSearchParams({ t: token });
  if (error) q.set("e", error);
  return `/portal/vincular?${q.toString()}`;
}
