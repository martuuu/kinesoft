/**
 * Destinos de redirect y chequeo de Origin para los flujos de auth
 * (A3b-S-auth). Lógica pura: sin `next/*` ni Supabase, así la testea el unit
 * (tests/unit/safe-next.test.ts) y la puede importar el middleware (edge).
 *
 * Por qué existe: `sign-in`, `sign-out`, `google` y `/auth/callback` tomaban
 * `?next=` crudo y armaban el destino con `${origin}${next}`. Con
 * `next=@evil.com` eso da `https://app.kinesoft@evil.com` (userinfo + host
 * ajeno) y con `next=//evil.com` un redirect protocol-relative: open redirect
 * clásico, usado para phishing con un link "de KineSoft".
 */

/** Largo máximo razonable de un path propio; más largo = sospechoso. */
const MAX_NEXT_LEN = 2048;

/**
 * Devuelve `raw` solo si es un path PROPIO de la app; si no, `fallback`.
 *
 * Reglas (todas tienen un payload de open-redirect conocido detrás):
 *   - empieza con `/` (nada de `https://…`, `javascript:…`, `@host`, `evil.com`);
 *   - no empieza con `//` (protocol-relative) ni `/\` (los browsers
 *     normalizan `\` a `/`, así `/\evil.com` = `//evil.com`);
 *   - sin `\` en ningún lado, por la misma normalización;
 *   - sin caracteres de control ni espacios en blanco: el parser de URL del
 *     browser descarta TAB/LF/CR, así `/\t/evil.com` termina en `//evil.com`;
 *   - verificación final: resuelto contra un origin centinela, el origin no
 *     cambia (atrapa cualquier variante que se nos escape de lo anterior).
 */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LEN) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return fallback;
  try {
    const base = "http://safe-next.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

/**
 * Chequeo de Origin para los POST de auth (login CSRF / logout CSRF): un sitio
 * ajeno no puede postear credenciales suyas a `/api/auth/sign-in` (el usuario
 * quedaría logueado en la cuenta del atacante) ni desloguear a nadie.
 *
 * - `Origin` presente → tiene que ser uno de `allowedOrigins`.
 * - `Origin` ausente → se mira `Sec-Fetch-Site`: `same-origin` / `none`
 *   (navegación directa) pasan; `cross-site` / `same-site` no.
 * - Ninguno de los dos → se deja pasar: no es un browser (curl, un test), y
 *   el CSRF necesita un browser que adjunte cookies. Los browsers modernos
 *   mandan `Origin` en todo POST.
 */
export function isAllowedOrigin(
  headers: Headers,
  allowedOrigins: Array<string | null | undefined>
): boolean {
  const allowed = new Set(
    allowedOrigins
      .filter((o): o is string => typeof o === "string" && o.length > 0)
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return null;
        }
      })
      .filter((o): o is string => o !== null)
  );
  const origin = headers.get("origin");
  if (origin) {
    // `Origin: null` (sandbox, redirect cross-origin) nunca es propio.
    if (origin === "null") return false;
    return allowed.has(origin);
  }
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  return true;
}

/**
 * Como `safeNext`, pero acepta además una URL ABSOLUTA si su origin es uno
 * de los propios, y la reduce a path. Existe por las plantillas de email de
 * Supabase: `{{ .RedirectTo }}` llega absoluto (`https://app…/invite/<t>`)
 * cuando el link apunta a `/auth/confirm?…&next={{ .RedirectTo }}`.
 */
export function safeNextFromUrl(
  raw: string | null | undefined,
  allowedOrigins: Array<string | null | undefined>,
  fallback = "/dashboard"
): string {
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const ok = allowedOrigins.some((o) => {
        if (!o) return false;
        try {
          return new URL(o).origin === u.origin;
        } catch {
          return false;
        }
      });
      if (!ok) return fallback;
      return safeNext(`${u.pathname}${u.search}${u.hash}`, fallback);
    } catch {
      return fallback;
    }
  }
  return safeNext(raw, fallback);
}

/**
 * Desenvuelve un `next` que apunta de vuelta a `/auth/confirm` (A3c, bug
 * `signup-confirm-doble-salto`). La plantilla de Supabase pone
 * `next={{ .RedirectTo }}`; si alguna vez el `emailRedirectTo` fue
 * `/auth/confirm?next=/onboarding`, `/auth/confirm` redirigía a sí mismo SIN
 * `token_hash` → "link inválido" con la cuenta ya verificada. Se toma el
 * `next` interno (hasta 3 niveles) y se re-valida con `safeNext`. Puro.
 */
export function unwrapConfirmNext(path: string, fallback = "/dashboard"): string {
  let current = path;
  for (let i = 0; i < 3; i++) {
    if (current !== "/auth/confirm" && !current.startsWith("/auth/confirm?")) return current;
    let inner: string | null = null;
    try {
      inner = new URL(current, "http://x").searchParams.get("next");
    } catch {
      return fallback;
    }
    current = safeNext(inner, fallback);
  }
  return current.startsWith("/auth/confirm") ? fallback : current;
}
