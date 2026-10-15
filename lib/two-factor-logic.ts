/**
 * 2FA por usuario (PL-1e, contrato C-PL6, plan §20.5.5) · lógica PURA (sin `next/*`, sin Prisma, sin crypto).
 *
 * La importan la sesión (`lib/session.ts`: corte en la foto de acceso), el gate de la app, las actions de 2FA de
 * PL-2a y el cliente (`useStepUpAction` lee `classifyStepUpError`). Por eso no puede arrastrar nada de servidor.
 *
 * Dos pruebas posibles de «pasó el segundo factor en ESTA sesión»:
 *  - TOTP: Supabase MFA sube la sesión a AAL2 (`aal` del JWT, que `getSessionUser` ya verificó). Sale gratis del
 *    token: cero queries.
 *  - Código por email o código de recuperación: no tocan el `aal` de Supabase, así que la prueba es nuestra: la
 *    cookie firmada `kine_2fa` ligada a userId + `session_id` (`lib/two-factor-cookie.ts`). Llega acá ya verificada
 *    como `sessionProofValid`.
 */

export type TwoFactorMethods = { totp: boolean; email: boolean };

export type SessionAssurance = {
  aal: "aal1" | "aal2" | null;
  /** `session_id` del access token. null = no se pudo saber (fallback sin token): la cookie no se puede ligar. */
  sessionId: string | null;
  /** `kine_2fa` firmada por nosotros, de este usuario y de ESTA sesión, sin vencer. */
  sessionProofValid: boolean;
};

export type TwoFactorState = "not_enabled" | "satisfied" | "required";

/** Ventana del step-up (PL-D11): cambiar plan, débito, titularidad, permisos y apagar 2FA. */
export const STEP_UP_TTL_S = 600;
/** Vida del código por email (PL-D12 / §20.5.5: 10 min, 5 intentos). */
export const EMAIL_CODE_TTL_S = 600;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/**
 * PL-1e (default, no estaba en el contrato): cuánto vale la prueba de sesión `kine_2fa` (email/recuperación). Una
 * jornada: la cookie ya muere con la sesión (va ligada al `session_id`), pero una sesión de Supabase se refresca
 * sin fin; sin techo, un código por email puesto una vez valdría meses en una PC compartida de recepción. TOTP no
 * tiene este techo (vale lo que la sesión AAL2).
 */
export const SESSION_PROOF_TTL_S = 12 * 60 * 60;

/**
 * El `digest` viaja del server al cliente aunque Next oculte el mensaje en producción: es lo único fiable para que
 * el cliente sepa «pedí el step-up» vs «configurá la 2FA primero».
 */
export const TWO_FACTOR_ERROR_DIGEST = { stepUp: "KINE_STEP_UP_REQUIRED", setup: "KINE_2FA_SETUP_REQUIRED" } as const;

/** `aal` del JWT normalizado: cualquier otra cosa (claim ausente, valor futuro de GoTrue) cuenta como null. */
export function normalizeAal(v: unknown): "aal1" | "aal2" | null {
  return v === "aal1" || v === "aal2" ? v : null;
}

export function hasAnyTwoFactorMethod(m: TwoFactorMethods): boolean {
  return m.totp || m.email;
}

/**
 * Estado de la 2FA de la sesión.
 *
 * - Sin ningún método prendido → `not_enabled` (nunca corta: la 2FA es opt-in por usuario).
 * - `aal2` → `satisfied` SOLO si la persona tiene la app (`m.totp`). PL-Z (a2#1, ALTO): antes bastaba `aal2`. Con
 *   solo el método email prendido y la contraseña robada, se enrolaba un TOTP PROPIO directo contra la API de GoTrue
 *   (no pide AAL2 si no hay factores verificados), se verificaba, la sesión subía a AAL2 y quedaba `satisfied`
 *   salteando el código por email del dueño. Un `aal2` sin el flag (reset del superadmin a medio camino) ya no
 *   cuenta: si queda el email prendido, pide el código.
 * - Cookie `kine_2fa` válida → `satisfied`, SOLO con `sessionId` (sin él la cookie no está ligada a nada: un
 *   fallback sin token no puede heredar la prueba de otra sesión).
 * - Si no → `required`: la sesión tiene que pasar por `/verificar-acceso` antes de entrar a la app.
 */
export function twoFactorStateOf(m: TwoFactorMethods, s: SessionAssurance): TwoFactorState {
  if (!hasAnyTwoFactorMethod(m)) return "not_enabled";
  if (s.aal === "aal2" && m.totp) return "satisfied";
  if (s.sessionId && s.sessionProofValid) return "satisfied";
  return "required";
}

function markersOf(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as { digest?: unknown; message?: unknown };
  // En prod Next conserva el `digest` propio y oculta el mensaje; en dev puede pasar al revés: se miran los dos.
  return [e.digest, e.message].filter((v): v is string => typeof v === "string");
}

/** ¿El error de una action es «falta step-up» o «falta configurar la 2FA»? null = otro error. */
export function classifyStepUpError(err: unknown): { kind: "step_up" } | { kind: "setup" } | null {
  const ms = markersOf(err);
  if (ms.includes(TWO_FACTOR_ERROR_DIGEST.stepUp)) return { kind: "step_up" };
  if (ms.includes(TWO_FACTOR_ERROR_DIGEST.setup)) return { kind: "setup" };
  return null;
}
