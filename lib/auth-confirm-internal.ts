/**
 * `/auth/confirm` resistente a escáneres (IAM-2c): la lógica pura del GET → `/auth/confirm/continuar` → POST.
 * Sin `next/*`, sin Supabase ni env: lo testea `tests/unit/auth-confirm.test.ts` y lo comparten el route
 * handler y la página intermedia (cada uno le pasa sus orígenes propios).
 *
 * Por qué existe: Outlook Safe Links (y otros escáneres de correo corporativo) ABREN cada link del mail
 * antes que la persona, para revisarlo. Con el GET que canjeaba el token (`verifyOtp`), el escáner lo
 * gastaba y la persona llegaba a «El link venció o ya se usó» — con la cuenta ya verificada, o sin poder
 * resetear la clave. Ahora:
 *  - GET: solo valida la FORMA de los parámetros y redirige a la página intermedia (no toca el token);
 *  - la página muestra «Confirmando…» y manda un form POST sola (con botón visible de respaldo);
 *  - POST: chequea el origen y recién ahí canjea.
 * Un escáner que solo abre la URL no llega a canjear. Patrón de Traze `app/auth/confirm/**` (SR-W2).
 */
import { isAllowedOrigin, safeNextFromUrl, unwrapConfirmNext } from "@/lib/safe-next";

/**
 * Tipos de `verifyOtp` que acepta la app. `signup`/`recovery`/`magiclink` los emite `issueAccessLink`;
 * `email` lo puede devolver GoTrue en el signup; `invite` es de los links viejos de Supabase que siguen en
 * buzones. Cualquier otro (p. ej. `email_change`, que la app no usa) → link inválido.
 */
export const CONFIRM_TYPES: ReadonlySet<string> = new Set(["signup", "email", "invite", "recovery", "magiclink"]);

/**
 * Forma del `token_hash`: GoTrue lo emite como hex (sha224 = 56 caracteres); las plantillas viejas con PKCE
 * lo prefijan con `pkce_`. Se acepta un alfabeto URL-safe con márgenes amplios en el largo: el objetivo no
 * es validar el token (eso lo hace GoTrue en el POST) sino no reenviar basura ni payloads a la página.
 */
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,512}$/;

export type ConfirmParams = { tokenHash: string; type: string; next: string };

/** Mismo default que `issueAccessLink`/`buildConfirmUrl`: recovery va a /reset, el resto a /dashboard. */
export function confirmFallback(type: string | null): string {
  return type === "recovery" ? "/reset" : "/dashboard";
}

/**
 * Lee y sanea los parámetros del link (de la query del GET, de la página o del form del POST).
 * `null` = el link no trae con qué canjear → `/login?error=link_invalid`.
 * `next` pasa por `safeNextFromUrl` (acepta una URL absoluta de un origen propio: los links viejos de las
 * plantillas de Supabase traen `{{ .RedirectTo }}` absoluto) y `unwrapConfirmNext` (un `next` que vuelve a
 * `/auth/confirm` iría sin token: bug `signup-confirm-doble-salto`). Se sanea en CADA paso, también en el
 * POST: el form de la página se puede adulterar.
 */
export function parseConfirmParams(
  get: (key: string) => string | null | undefined,
  allowedOrigins: Array<string | null | undefined>
): ConfirmParams | null {
  const tokenHash = get("token_hash");
  const type = get("type");
  if (typeof tokenHash !== "string" || !TOKEN_HASH_RE.test(tokenHash)) return null;
  if (typeof type !== "string" || !CONFIRM_TYPES.has(type)) return null;
  const fallback = confirmFallback(type);
  const next = unwrapConfirmNext(safeNextFromUrl(get("next") ?? null, allowedOrigins, fallback), fallback);
  return { tokenHash, type, next };
}

/** Path de la página intermedia con los parámetros YA saneados. */
export function confirmContinuePath(p: ConfirmParams): string {
  const q = new URLSearchParams({ token_hash: p.tokenHash, type: p.type, next: p.next });
  return `/auth/confirm/continuar?${q.toString()}`;
}

/**
 * ¿El POST que canjea viene de nuestra propia página? Un form de otro sitio podría postear un token
 * propio del atacante y dejar a la víctima logueada en la cuenta del atacante (login CSRF).
 *
 * Base: `isAllowedOrigin` (AUDIT §5.19). Única excepción: `Origin: null` con `Sec-Fetch-Site: same-origin`.
 * Algunos navegadores/extensiones con política de referrer estricta mandan `Origin: null` en un POST de
 * formulario propio (Traze lo midió: con `no-referrer` en la página, Chrome lo hace y todo link terminaba
 * en «inválido»). `Sec-Fetch-Site` lo pone el navegador y no se puede falsificar desde una página.
 */
export function isConfirmPostAllowed(headers: Headers, allowedOrigins: Array<string | null | undefined>): boolean {
  const origin = headers.get("origin");
  if (origin === "null") return headers.get("sec-fetch-site") === "same-origin";
  return isAllowedOrigin(headers, allowedOrigins);
}
