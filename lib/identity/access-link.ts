import "server-only";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/safe-next";
import { logger } from "@/lib/logger";
import { authAdmin, type AuthAdminErrorCode } from "@/lib/identity/auth-admin";

/**
 * Emisor de links de acceso (IAM-0d, contrato C-IAM3).
 *
 * ADR del bloque IAM (plan §19.4): Supabase solo emite el token
 * (`admin.generateLink` devuelve `hashed_token` y no manda nada); la app arma el
 * link a SU `/auth/confirm` y manda el mail con su transporte (`lib/email`). Así la
 * Site URL y las plantillas de Supabase dejan de importar para estos links.
 *
 * Por qué `token_hash` a `/auth/confirm` y no el `action_link` de GoTrue: el
 * action_link usa el flujo implícito (tokens en el `#fragment`, que el server no
 * lee) y depende de la Site URL. `/auth/confirm` hace `verifyOtp({ type,
 * token_hash })` server-side y deja la sesión en cookies (ver
 * `app/auth/confirm/route.ts`). Patrón de Traze `app/lib/auth-links.ts`.
 *
 * Este módulo NO manda mails: el caller arma la plantilla con la URL y llama a
 * `sendEmail`. El link es una credencial de un clic: nunca se loguea ni el token
 * ni la URL completa (solo el host, que alcanza para ver un dominio equivocado).
 */

/** Destino por defecto si el `next` no es un path propio (mismo default que `/auth/confirm`). */
function fallbackFor(type: string): string {
  return type === "recovery" ? "/reset" : "/dashboard";
}

export function buildConfirmUrl(p: { tokenHash: string; type: string; next: string }): string {
  // Sin barra final en la base: `https://app/` + `/auth/confirm` daría `//auth`.
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const params = new URLSearchParams({
    token_hash: p.tokenHash,
    type: p.type,
    // El `next` se sanea acá Y en `/auth/confirm`: un link que sale de la app no
    // puede llevar un open redirect, aunque la ruta lo vuelva a cortar.
    next: safeNext(p.next, fallbackFor(p.type)),
  });
  return `${base}/auth/confirm?${params.toString()}`;
}

/**
 * El `type` del link, que es el que `/auth/confirm` le pasa a `verifyOtp`.
 *
 * GoTrue busca el token según el type (`signup`/`invite` → confirmation_token;
 * `recovery`/`magiclink` → recovery_token; `email` → cualquiera de los dos), así
 * que tiene que coincidir con lo que emitió:
 *  - recovery  → `recovery`. Siempre: es el ÚNICO type con el que `/auth/confirm`
 *    deja la cookie `ks_recovery` (cambiar la clave sin la actual).
 *  - magiclink → `magiclink`; pero si el email no tenía cuenta, GoTrue la CREA y
 *    emite un token de confirmación con `verification_type: "signup"` → el link va
 *    con `signup`. Nunca `recovery`, aunque GoTrue dijera eso: un magic link no
 *    puede habilitar el cambio de clave sin la actual.
 *  - signup    → `signup` (GoTrue lo devuelve así; si devolviera `email`, también
 *    lo acepta `/auth/confirm`).
 * Supuestos verificados contra Supabase real por `scripts/diagnose-auth.ts`.
 */
function confirmTypeFor(kind: "recovery" | "magiclink" | "signup", returned: string): string {
  if (kind === "recovery") return "recovery";
  if (kind === "magiclink") return returned === "signup" ? "signup" : "magiclink";
  return returned === "email" ? "email" : "signup";
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export async function issueAccessLink(p: {
  email: string;
  kind: "recovery" | "magiclink" | "signup";
  next: string;
  password?: string;
}): Promise<{ ok: true; url: string; userId: string | null } | { ok: false; code: AuthAdminErrorCode }> {
  const res = await authAdmin().generateLink({
    type: p.kind,
    email: p.email,
    ...(p.password !== undefined ? { password: p.password } : {}),
  });
  if (!res.ok) {
    // Sin el email: el caller sabe a quién; acá solo qué falló.
    logger.warn("identity.access_link.failed", { kind: p.kind, code: res.code });
    return { ok: false, code: res.code };
  }
  const type = confirmTypeFor(p.kind, res.data.verificationType);
  const url = buildConfirmUrl({ tokenHash: res.data.hashedToken, type, next: p.next });
  logger.info("identity.access_link.issued", {
    kind: p.kind,
    type,
    host: hostOf(url),
    newUser: p.kind === "magiclink" && type === "signup" ? true : undefined,
  });
  return { ok: true, url, userId: res.data.userId };
}
