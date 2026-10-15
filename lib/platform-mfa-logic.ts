/**
 * BO4 · lógica pura del endurecimiento del superadmin (plan §19.5 fila BO4, BO-D6 «TOTP obligatorio para
 * superadmins»). Sin `next/*`, sin Supabase, sin `node:*`: la importan el server (`lib/platform-actor.ts`, el layout
 * de `(platform)`, las pantallas de `/plataforma-mfa`) y el cliente (`components/plataforma/reauth-modal.tsx`), y la
 * testea el unit (`tests/unit/platform-mfa-logic.test.ts`).
 *
 * Por qué una decisión pura y no `if`s sueltos en `requirePlatformAdmin`: hay cuatro entradas (flag, nivel de la
 * sesión, riesgo de la acción, re-verificación reciente) y cinco salidas; el orden importa (sin factor no se puede
 * «verificar», y la re-verificación solo tiene sentido sobre una sesión que ya es AAL2). En una tabla de casos se ve
 * entera; repartida entre el layout y las actions, no.
 */

/** `PLATFORM_MFA_ENFORCEMENT` (lib/env.ts). Default `off`: Martin se enrola en prod antes de prenderlo. */
export const PLATFORM_MFA_ENFORCEMENTS = ["off", "enforce"] as const;
export type PlatformMfaEnforcement = (typeof PLATFORM_MFA_ENFORCEMENTS)[number];

/** Riesgo de una acción de Plataforma (lo asigna `PLATFORM_ACTION_POLICY`). */
export type PlatformRisk = "low" | "medium" | "high";

export type AalLevel = "aal1" | "aal2";

/**
 * Lo que devuelve `supabase.auth.mfa.getAuthenticatorAssuranceLevel(jwt)` (ver supuestos en `lib/platform-mfa.ts`):
 *  - `currentLevel`: el `aal` del JWT de esta sesión (aal2 = pasó por TOTP en esta sesión);
 *  - `nextLevel`: aal2 si el usuario tiene algún factor VERIFICADO; si no, igual a `currentLevel`.
 * null = sin sesión.
 */
export type MfaAssurance = { currentLevel: AalLevel | null; nextLevel: AalLevel | null };

/** Re-verificación para las acciones `high`: vale 10 minutos desde el último código bien puesto. */
export const PLATFORM_REAUTH_TTL_S = 10 * 60;

/**
 * Estado de la verificación en dos pasos de la sesión:
 *  - `verified`: la sesión es AAL2 (se pidió el código en esta sesión);
 *  - `pending`: hay un factor verificado pero la sesión es AAL1 (entró con contraseña/Google y falta el código);
 *  - `none`: no tiene ningún factor verificado: hay que configurarlo.
 *
 * `currentLevel === "aal2"` gana aunque `nextLevel` diga otra cosa: GoTrue calcula `nextLevel = currentLevel` cuando
 * no hay factores, así que una sesión AAL2 cuyo factor se borró después sigue diciendo aal2/aal2. Mirar solo
 * `nextLevel` para «tiene factor» la mandaría a configurar con una sesión que ya demostró el segundo paso.
 */
export function mfaStatusOf(a: MfaAssurance): "verified" | "pending" | "none" {
  if (a.currentLevel === "aal2") return "verified";
  if (a.nextLevel === "aal2") return "pending";
  return "none";
}

export type PlatformMfaDecision =
  | { kind: "ok"; mfa: boolean }
  | { kind: "setup_required" }
  | { kind: "verify_required" }
  | { kind: "reauth_required" }
  | { kind: "unavailable" };

/**
 * Qué hace `requirePlatformAdmin` con el segundo paso.
 *
 * - `off`: nunca bloquea. `mfa` dice si la sesión es AAL2 cuando se pudo leer (lo usa el registro de «Entrar como
 *   soporte», que con `off` queda permitido para desarrollo pero deja `mfa:false` en el payload).
 * - `enforce`: sin lectura del nivel (GoTrue caído) → `unavailable` (falla cerrado: no se deja pasar a ciegas);
 *   sin factor → configurar; con factor y AAL1 → verificar; AAL2 y riesgo `high` sin re-verificación reciente →
 *   `reauth_required`; si no, ok.
 *
 * El orden es el de los pasos que puede dar la persona: no se le pide re-verificar a quien todavía no configuró.
 */
export function decidePlatformMfa(p: {
  enforcement: PlatformMfaEnforcement;
  assurance: MfaAssurance | null;
  risk: PlatformRisk | null;
  reauthFresh: boolean;
}): PlatformMfaDecision {
  if (p.enforcement !== "enforce") {
    return { kind: "ok", mfa: p.assurance ? mfaStatusOf(p.assurance) === "verified" : false };
  }
  if (!p.assurance) return { kind: "unavailable" };
  const status = mfaStatusOf(p.assurance);
  if (status === "none") return { kind: "setup_required" };
  if (status === "pending") return { kind: "verify_required" };
  if (p.risk === "high" && !p.reauthFresh) return { kind: "reauth_required" };
  return { kind: "ok", mfa: true };
}

// ── Errores que cruzan al cliente ─────────────────────────────────────────────

/**
 * `digest` de los errores de Plataforma que la UI tiene que reconocer.
 *
 * Por qué digest y no el mensaje: en producción Next reemplaza el mensaje de todo error tirado por una server action
 * («An error occurred in the Server Components render…») y solo conserva `digest`. Next 14.2 respeta un `digest`
 * que ya trae el error (`create-error-handler.js`: «If the error already has a digest, respect the original
 * digest»), así que es el único canal tipado de una action que TIRA (todas las de `lib/platform-*` llaman a
 * `requirePlatformAdmin` antes de su try). Antes de BO4 el rate limit tiraba con su mensaje y en prod la UI
 * mostraba «Revisá la conexión»: ahora el helper del cliente lo traduce al copy uniforme.
 *
 * Prefijo `KINE_` (nunca `NEXT_`: Next interpreta los digests `NEXT_REDIRECT`/`NEXT_NOT_FOUND`).
 */
export const PLATFORM_ERROR_DIGEST = {
  reauth: "KINE_PLATFORM_REAUTH",
  mfaSetup: "KINE_PLATFORM_MFA_SETUP",
  mfaVerify: "KINE_PLATFORM_MFA_VERIFY",
  mfaUnavailable: "KINE_PLATFORM_MFA_UNAVAILABLE",
  /** `KINE_PLATFORM_RATE_LIMITED:<segundos>`. */
  rateLimited: "KINE_PLATFORM_RATE_LIMITED",
} as const;

export const PLATFORM_MFA_COPY = {
  setup: "Para usar Plataforma tenés que configurar la verificación en dos pasos.",
  verify: "Ingresá el código de tu app de autenticación para seguir en Plataforma.",
  unavailable: "No pudimos comprobar la verificación en dos pasos. Probá de nuevo en unos segundos.",
  reauth: "Esta acción pide que confirmes tu código de verificación de nuevo.",
} as const;

/** Mismo texto que `rateLimitedMessage` de `lib/rate-limit.ts` (ese módulo no se puede importar en el cliente). */
export function platformRateLimitedCopy(seconds: number): string {
  return `Demasiados intentos. Probá de nuevo en ${Math.max(1, Math.ceil(seconds))} s.`;
}

export type PlatformActionErrorKind =
  | { kind: "reauth" }
  | { kind: "mfa_setup" }
  | { kind: "mfa_verify" }
  | { kind: "mfa_unavailable" }
  | { kind: "rate_limited"; seconds: number };

/** Reconoce un error de Plataforma por su `digest` (prod) o por el mismo campo en dev. null = otro error. */
export function classifyPlatformActionError(err: unknown): PlatformActionErrorKind | null {
  if (!err || typeof err !== "object") return null;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== "string") return null;
  if (digest === PLATFORM_ERROR_DIGEST.reauth) return { kind: "reauth" };
  if (digest === PLATFORM_ERROR_DIGEST.mfaSetup) return { kind: "mfa_setup" };
  if (digest === PLATFORM_ERROR_DIGEST.mfaVerify) return { kind: "mfa_verify" };
  if (digest === PLATFORM_ERROR_DIGEST.mfaUnavailable) return { kind: "mfa_unavailable" };
  if (digest.startsWith(`${PLATFORM_ERROR_DIGEST.rateLimited}:`)) {
    const s = Number(digest.slice(PLATFORM_ERROR_DIGEST.rateLimited.length + 1));
    return { kind: "rate_limited", seconds: Number.isFinite(s) && s > 0 ? s : 1 };
  }
  return null;
}

/** Lo que devuelve `startPlatformMfaEnrollment`: QR como data URI SVG y el secreto para tipear a mano. */
export type PlatformMfaEnrollment = { factorId: string; qrCode: string; secret: string };

// ── Código TOTP y destinos ────────────────────────────────────────────────────

/** El código que se tipea: 6 dígitos; se toleran espacios y guiones («123 456» como lo muestran las apps). */
export function normalizeTotpCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

export const PLATFORM_MFA_SETUP_PATH = "/plataforma-mfa/configurar";
export const PLATFORM_MFA_VERIFY_PATH = "/plataforma-mfa/verificar";

/**
 * Adónde vuelve después del código. Solo paths de Plataforma: un `next` de la app del consultorio (o de afuera) no
 * tiene nada que hacer acá y es la puerta de un open redirect. `safe` es `safeNext` ya aplicado por el caller.
 */
export function platformNextOrDefault(safe: string): string {
  return safe === "/plataforma" || safe.startsWith("/plataforma/") || safe.startsWith("/plataforma?") ? safe : "/plataforma";
}

export function platformMfaRedirect(step: "setup" | "verify", next: string): string {
  const base = step === "setup" ? PLATFORM_MFA_SETUP_PATH : PLATFORM_MFA_VERIFY_PATH;
  return `${base}?next=${encodeURIComponent(platformNextOrDefault(next))}`;
}
