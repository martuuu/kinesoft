/**
 * PV (§27, LG; contrato de PV-K): constantes de los Términos y la Política de privacidad.
 *
 * Decisión de Martin (27-oct): legales con borrador + casilla. `LEGAL_VERSION` es lo que se graba en el evento
 * `legal.accepted` (payload `{version, via}`): cambiar el texto de forma sustancial = nueva versión = se vuelve a pedir
 * la aceptación (`hasAcceptedCurrentLegal` filtra por versión).
 *
 * PURO y SIN imports: lo usan las páginas `force-static` de `/terminos` y `/privacidad`, el AuthShell, la landing y el
 * turnero (bundle público).
 */

export const LEGAL_VERSION = "2026-10-31";
export const LEGAL_VERSION_LABEL = "Versión 1 · vigente desde el 31 de octubre de 2026";

export const TERMS_PATH = "/terminos";
export const PRIVACY_PATH = "/privacidad";

export const LEGAL_LINKS = [
  { href: TERMS_PATH, label: "Términos y condiciones" },
  { href: PRIVACY_PATH, label: "Política de privacidad" },
] as const;

/**
 * Quién opera el servicio. Los tres primeros los completa Martin (razón social, CUIT, domicilio); mientras sean `null`
 * la página no muestra esa línea (nunca un «CUIT: null» ni un dato inventado).
 */
export const LEGAL_ENTITY: { name: string | null; cuit: string | null; address: string | null; jurisdiction: string } = {
  name: null,
  cuit: null,
  address: null,
  jurisdiction: "Tribunales ordinarios de la Ciudad Autónoma de Buenos Aires",
};

export const LEGAL_ACCEPT_ERROR = "Para seguir, aceptá los Términos y la Política de privacidad.";

/** Por dónde se aceptó (va al payload del evento). */
export type LegalAcceptVia = "signup" | "onboarding" | "invite_activate" | "invite_accept";

/**
 * Valor de la casilla → aceptó. Un checkbox HTML tildado manda `"on"` (sin `value`); los clientes JS mandan `true` o
 * `"true"`, y `"1"` por paridad con `remember`. Todo lo demás (ausente, vacío, `"off"`, `"false"`, el número 1) es NO:
 * la aceptación tiene que ser explícita, ante la duda no se registra.
 */
export function legalAcceptedFromForm(v: unknown): boolean {
  return v === true || v === "on" || v === "true" || v === "1";
}
