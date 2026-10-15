/**
 * Lógica pura de las pantallas de auth (IAM-2d): qué mensaje y qué salida («CTA») mostrar para cada código de
 * error del login, y el cooldown de los botones de «reenviar». Sin React ni `next/*`, así la cubre el unit
 * (tests/unit/login-error-message.test.ts) y la usan login, signup, forgot y onboarding por igual.
 */

/**
 * Mensajes de error del login por código (A3b-S-auth). Los emiten `/api/auth/sign-in`, `/api/auth/google`,
 * `/api/auth/oauth/[provider]` (PL-2e: Google y Facebook), `/auth/callback` y `/auth/confirm`. Un código desconocido muestra el genérico: nunca se pinta el valor de
 * la query (antes `/login?error=<texto libre>` pintaba lo que quisiera el que armaba el link).
 */
const LOGIN_ERRORS: Record<string, string> = {
  rate_limited: "Demasiados intentos. Esperá un minuto y probá de nuevo.",
  invalid_credentials: "Email o contraseña incorrectos.",
  missing_credentials: "Completá tu email y tu contraseña.",
  email_not_confirmed:
    "Todavía no confirmaste tu email. Buscá el mail que te mandamos y seguí el link, o pedí uno nuevo.",
  // PL-2e: sin nombrar al proveedor (ahora puede ser Google o Facebook).
  oauth_failed: "No pudimos completar el ingreso. Probá de nuevo.",
  missing_code: "No pudimos completar el ingreso. Probá de nuevo.",
  // H-PL2: el proveedor no devolvió email (Facebook lo permite) → nunca se crea un perfil con email vacío.
  oauth_no_email:
    "No recibimos tu email y lo necesitamos para tu cuenta. Probá de nuevo y aceptá compartir el email, o registrate con tu email.",
  provider_disabled: "Ese método de ingreso no está disponible por ahora. Entrá con tu email y contraseña.",
  link_invalid: "El link venció o ya se usó. Pedí uno nuevo.",
};
const GENERIC_LOGIN_ERROR = "No pudimos iniciar sesión. Probá de nuevo.";

/** Salidas que ofrece el aviso de error del login. */
export type LoginErrorCta = "resend_verification" | "forgot";

/**
 * De qué era el link que falló en `/auth/confirm` (`?link=` en /login). Hoy `/auth/confirm` no lo manda
 * (handoff de IAM-2d): sin él se ofrecen las dos salidas, porque no sabemos si era un alta o una contraseña.
 */
export type ConfirmLinkKind = "signup" | "recovery";

/** Acota `?link=` a los dos casos con salida propia; cualquier otro valor = desconocido. */
export function parseConfirmLinkKind(raw: string | undefined | null): ConfirmLinkKind | undefined {
  if (raw === "signup" || raw === "email") return "signup";
  if (raw === "recovery") return "recovery";
  return undefined;
}

export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : GENERIC_LOGIN_ERROR;
}

/**
 * Mensaje + salidas del aviso del login. Por qué las salidas: el QA del 14-oct (§19.1) mostró que «el link
 * venció» o «no confirmaste tu email» dejaban a la persona sin nada para hacer más que volver a registrarse
 * (que no manda nada si la cuenta ya existe). Cada código con arreglo trae su botón.
 */
export function loginErrorFeedback(
  code: string | undefined,
  linkKind?: ConfirmLinkKind
): { message: string; ctas: LoginErrorCta[] } | null {
  const message = loginErrorMessage(code);
  if (message === null) return null;
  if (code === "email_not_confirmed") return { message, ctas: ["resend_verification"] };
  if (code === "link_invalid") {
    if (linkKind === "recovery") {
      return { message: "El link para crear tu contraseña venció o ya se usó. Pedí uno nuevo.", ctas: ["forgot"] };
    }
    if (linkKind === "signup") {
      return {
        message: "El link para confirmar tu email venció o ya se usó. Pedí uno nuevo.",
        ctas: ["resend_verification"],
      };
    }
    return { message, ctas: ["forgot", "resend_verification"] };
  }
  return { message, ctas: [] };
}

/** Espera entre reenvíos de un mail (verificación o link de contraseña): evita el doble clic y el spam. */
export const RESEND_COOLDOWN_S = 60;

/** Segundos que faltan hasta `untilMs` (redondeado hacia arriba; 0 = ya se puede). */
export function cooldownSecondsLeft(untilMs: number | null, nowMs: number): number {
  if (untilMs === null) return 0;
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** Texto del botón de reenvío: con cooldown dice cuánto falta, así no parece roto. */
export function resendButtonLabel(label: string, secondsLeft: number, pending: boolean): string {
  if (pending) return "Enviando…";
  if (secondsLeft > 0) return `Podés reenviarlo en ${secondsLeft} s`;
  return label;
}

/** Respuesta genérica de «reenviar verificación» (misma exista o no la cuenta: sin oráculo, C-IAM6). */
export const RESEND_VERIFICATION_SENT = "Si tu cuenta está pendiente de confirmar, te mandamos un email nuevo.";

/** Respuesta genérica de «olvidé mi contraseña» (misma exista o no la cuenta). */
export const FORGOT_SENT =
  "Si existe una cuenta con ese email, te mandamos un link para crear una contraseña nueva. Vence en 1 hora.";
