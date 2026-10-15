/**
 * PL-2e (C-PL12, plan §20.5.8) · qué tomamos del usuario de Supabase al volver de Google o Facebook.
 *
 * Lógica pura (sin `next/*` ni Supabase): la usa `app/auth/callback/route.ts` y la cubre
 * `tests/unit/oauth-profile.test.ts`.
 *
 * Por qué existe:
 *  - H-PL2: el callback guardaba `email: user.email ?? ""`. Una cuenta de Facebook registrada con teléfono, o que
 *    negó el permiso de email, creaba un `UserProfile` con `""` (sin forma de recuperar la cuenta ni de recibir
 *    avisos; y como `email` es único, la SEGUNDA cuenta así rompía el callback con un 500). Ahora sin email no hay
 *    perfil: `email === null` y el callback corta con `oauth_no_email`.
 *  - GoTrue llena `user_metadata` distinto según el proveedor y la versión: Google trae `full_name`/`name` y
 *    `avatar_url`/`picture`; Facebook puede traer solo `name` y `picture`. Antes se leían solo las claves de
 *    Google y el perfil de Facebook quedaba sin nombre (y la app terminaba mostrando el email: decisión 19).
 *  - El nombre nunca puede ser un email (decisión 19) y el avatar solo se guarda si es https de un host que
 *    `next/image` y la CSP permiten (`OAUTH_AVATAR_HOSTS`): un host fuera de `images.remotePatterns` hace que
 *    `<Image>` tire en render. Mantener esta lista igual a `next.config.mjs` (`remotePatterns` e `img-src`).
 */

/** Hosts de avatar aceptados. Google sirve las fotos de perfil desde lh3; Facebook desde lookaside. */
export const OAUTH_AVATAR_HOSTS = ["lh3.googleusercontent.com", "platform-lookaside.fbsbx.com"] as const;

/** Tope de largo: un nombre de proveedor más largo que esto es basura (y rompe layouts). */
const MAX_NAME_LEN = 120;
const MAX_URL_LEN = 2048;

export type OAuthUserLike = {
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

export type OAuthProfile = {
  /** Email normalizado (trim). `null` = el proveedor no lo dio: NO se crea perfil. */
  email: string | null;
  /** `null` = el proveedor no dio un nombre usable (el callback no pisa el que había). */
  fullName: string | null;
  /** `null` = sin avatar usable (el callback no pisa el que había). */
  avatarUrl: string | null;
  /** `google` | `facebook` | `email` | … según `app_metadata.provider`; solo para logs. */
  provider: string | null;
};

const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Primer nombre usable entre `full_name` y `name`: trim, espacios colapsados, sin emails, con tope de largo. */
export function oauthDisplayName(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  for (const key of ["full_name", "name"] as const) {
    const raw = str(meta[key]);
    if (!raw) continue;
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > MAX_NAME_LEN) continue;
    if (EMAIL_LIKE.test(clean)) continue; // decisión 19: nunca un email como nombre
    return clean;
  }
  return null;
}

/** Primer avatar usable entre `avatar_url` y `picture`: https y de un host de `OAUTH_AVATAR_HOSTS`. */
export function oauthAvatarUrl(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  for (const key of ["avatar_url", "picture"] as const) {
    const raw = str(meta[key])?.trim();
    if (!raw || raw.length > MAX_URL_LEN) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" || u.username || u.password || u.port) continue;
      if (!(OAUTH_AVATAR_HOSTS as readonly string[]).includes(u.hostname)) continue;
      return u.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function oauthProfileFromUser(user: OAuthUserLike): OAuthProfile {
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const provider = str(user.app_metadata?.provider);
  return {
    email: email.length > 0 && email.includes("@") ? email : null,
    fullName: oauthDisplayName(user.user_metadata),
    avatarUrl: oauthAvatarUrl(user.user_metadata),
    provider,
  };
}

/** Códigos de `/login?error=` que puede emitir el arranque o el callback de OAuth. */
export type OAuthLoginError = "oauth_failed" | "oauth_no_email" | "provider_disabled" | "email_not_confirmed";

/**
 * Mapea el `?error=` con que GoTrue vuelve al callback al código de `/login?error=`. Nunca se pinta el texto de
 * GoTrue (puede traer cualquier cosa); se mira solo para clasificar:
 *  - sin email del proveedor: «Error getting user email from external provider» (o un `error_code` con
 *    `email_address_not_provided` / `no_email`, según versión) → `oauth_no_email`;
 *  - `provider_email_needs_verification`: GoTrue mandó un mail para confirmar (email del proveedor sin verificar
 *    que choca con una cuenta) → `email_not_confirmed`, que ya tiene su mensaje y su «reenviar»;
 *  - proveedor apagado (`provider_disabled`, `oauth_provider_not_supported`, «provider is not enabled») →
 *    `provider_disabled`;
 *  - todo lo demás (consentimiento negado, state vencido, …) → `oauth_failed`.
 */
export function oauthCallbackErrorCode(
  error: string | null,
  errorCode: string | null,
  description: string | null
): OAuthLoginError {
  const code = (errorCode ?? "").toLowerCase();
  const text = `${error ?? ""} ${description ?? ""}`.toLowerCase();
  if (code === "provider_email_needs_verification") return "email_not_confirmed";
  if (
    code.includes("email_address_not_provided") ||
    code.includes("no_email") ||
    /getting user email|email.*not provided|no email/.test(text)
  ) {
    return "oauth_no_email";
  }
  if (
    code === "provider_disabled" ||
    code === "oauth_provider_not_supported" ||
    /provider is not enabled|unsupported provider/.test(text)
  ) {
    return "provider_disabled";
  }
  return "oauth_failed";
}
