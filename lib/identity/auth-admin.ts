import "server-only";
import type { GenerateLinkParams, SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeEmail } from "@/lib/email-match";
import { logger } from "@/lib/logger";

/**
 * Puerto de Auth admin (IAM-0d, contrato C-IAM3): el ÚNICO lugar de la app que
 * llama a `supabase.auth.admin.*`.
 *
 * Por qué existe:
 *  - ADR del bloque IAM (plan §19.4): «la app manda todos los mails; Supabase solo
 *    emite tokens». Las altas, invitaciones, resets y magic links pasan a
 *    `createUser` / `generateLink` (que NO mandan nada) + mail propio. Concentrar
 *    `auth.admin` acá hace verificable esa regla: lo que no pasa por este puerto
 *    (`inviteUserByEmail`, `signUp`, `resetPasswordForEmail`) no se usa.
 *  - supabase-js NO tira: devuelve `{ error }`. Cada caller lo traducía a su
 *    manera (o no lo miraba: `scripts/create-tenant.ts` buscaba el «already» en
 *    el texto). Acá todo error vuelve como `{ ok:false, code }` con un código
 *    cerrado, y el puerto nunca tira (ni con fetch caído ni sin service key).
 *  - Testeable: `__setAuthAdminForTests` inyecta el fake de GoTrue
 *    (`tests/helpers/gotrue-fake.ts`) y los flujos de IAM-2/3 corren enteros en
 *    unit. Los supuestos del fake los verifica `scripts/diagnose-auth.ts` contra
 *    Supabase real.
 *
 * Mismo patrón que Traze `app/lib/auth-admin.ts` (BC-W2), con dos diferencias:
 * los códigos son los de C-IAM3 (no los de Traze) y `findUserByEmail` es nuevo.
 */

export type AuthUserLite = {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  bannedUntil: string | null;
};
export type AuthAdminErrorCode = "email_exists" | "not_found" | "weak_password" | "rate_limited" | "config" | "error";
export type AuthAdminResult<T> = { ok: true; data: T } | { ok: false; code: AuthAdminErrorCode; message: string };
export interface AuthAdminPort {
  createUser(p: {
    email: string;
    password?: string;
    emailConfirm: boolean;
    fullName?: string | null;
  }): Promise<AuthAdminResult<AuthUserLite>>;
  deleteUser(id: string): Promise<AuthAdminResult<null>>;
  updateUserById(
    id: string,
    p: { password?: string; emailConfirm?: boolean; fullName?: string | null; banDuration?: string | "none" }
  ): Promise<AuthAdminResult<AuthUserLite>>;
  getUser(id: string): Promise<AuthAdminResult<AuthUserLite>>;
  findUserByEmail(email: string): Promise<AuthAdminResult<AuthUserLite | null>>; // pagina listUsers; match exacto normalizado
  generateLink(p: {
    type: "signup" | "magiclink" | "recovery" | "invite";
    email: string;
    password?: string;
    redirectTo?: string;
  }): Promise<
    AuthAdminResult<{
      hashedToken: string;
      verificationType: "signup" | "magiclink" | "recovery" | "invite" | "email";
      userId: string | null;
    }>
  >;
}

/**
 * Mensajes en voseo, mostrables tal cual (sin nombrar al proveedor). El texto
 * crudo de GoTrue no sale de acá: va al log, sin PII.
 */
const MESSAGES: Record<AuthAdminErrorCode, string> = {
  email_exists: "Ese email ya tiene una cuenta.",
  not_found: "La cuenta no existe.",
  weak_password: "La contraseña es demasiado débil. Elegí una más larga y menos previsible.",
  rate_limited: "Demasiados intentos seguidos. Esperá unos minutos y volvé a probar.",
  config: "El servicio de cuentas no está configurado en este entorno.",
  error: "No pudimos completar la operación con la cuenta. Probá de nuevo en unos minutos.",
};

/** Tamaño de página de `listUsers` (el máximo que acepta GoTrue). */
const LIST_PER_PAGE = 1000;
/**
 * Tope de páginas de `findUserByEmail` (100k cuentas). Es un freno contra un
 * bucle infinito si GoTrue devolviera siempre páginas llenas; muy por encima de
 * lo que va a tener KineSoft. Al pasarlo se devuelve `error`, nunca `null`: un
 * «no existe» falso haría que el caller cree una cuenta duplicada.
 */
const LIST_MAX_PAGES = 100;

const VERIFICATION_TYPES = new Set(["signup", "magiclink", "recovery", "invite", "email"] as const);
type VerificationType = "signup" | "magiclink" | "recovery" | "invite" | "email";

type AuthErrorLike = { code?: unknown; status?: unknown; message?: unknown; name?: unknown };

/**
 * Traduce un error de supabase-js (devuelto o lanzado) a un código de C-IAM3.
 * Duck-typing por `code`/`status`/`message` y no `instanceof AuthApiError`
 * (frágil entre bundles; mismo criterio que Traze `classifyAuthAdminError`).
 *
 * `email_exists`: GoTrue ≥2.1xx manda `code: "email_exists"` (o
 * `user_already_exists` en algunas rutas); las versiones viejas solo el texto
 * «A user with this email address has already been registered» con 422. El 422
 * SOLO no alcanza: `weak_password` y `validation_failed` también son 422.
 */
export function classifyAuthAdminError(err: unknown): AuthAdminErrorCode {
  if (!err || typeof err !== "object") return "error";
  const e = err as AuthErrorLike;
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  if (code === "email_exists" || code === "user_already_exists") return "email_exists";
  if (/already (been )?registered/i.test(message)) return "email_exists";
  if (code === "weak_password") return "weak_password";
  if (status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return "rate_limited";
  }
  if (code === "user_not_found" || status === 404) return "not_found";
  return "error";
}

function fail<T>(op: string, err: unknown): AuthAdminResult<T> {
  const code = classifyAuthAdminError(err);
  // Los motivos de negocio (email tomado, clave débil, no existe) los resuelve el
  // caller con el código; lo inesperado queda en el log. Sin email ni password:
  // solo la operación y lo que GoTrue dijo (el logger además redacta emails).
  if (code === "error" || code === "rate_limited") {
    const e = (err ?? {}) as AuthErrorLike;
    logger.warn("identity.auth_admin.failed", {
      op,
      code,
      gotrueCode: typeof e.code === "string" ? e.code : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
      message: typeof e.message === "string" ? e.message.slice(0, 200) : undefined,
    });
  }
  return { ok: false, code, message: MESSAGES[code] };
}

function configFail<T>(): AuthAdminResult<T> {
  return { ok: false, code: "config", message: MESSAGES.config };
}

function toLite(u: User): AuthUserLite {
  // GoTrue devuelve `""` (no null) en email de cuentas solo-teléfono; `banned_until`
  // no viene en el tipo `User` de todas las versiones, se lee igual.
  const raw = u as User & { banned_until?: string | null };
  return {
    id: u.id,
    email: u.email ? u.email : null,
    emailConfirmedAt: u.email_confirmed_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
    createdAt: u.created_at,
    bannedUntil: raw.banned_until ?? null,
  };
}

function cleanName(fullName: string | null | undefined): string | null | undefined {
  if (fullName === undefined || fullName === null) return fullName;
  const t = fullName.trim();
  return t.length ? t : null;
}

/** Corre `fn` con el cliente admin; sin cliente → `config`; si tira → `error`. Nunca tira. */
async function withClient<T>(
  op: string,
  fn: (c: SupabaseClient) => Promise<AuthAdminResult<T>>
): Promise<AuthAdminResult<T>> {
  let client: SupabaseClient | null;
  try {
    client = getSupabaseAdminClient();
  } catch (e) {
    return fail(op, e);
  }
  if (!client) return configFail();
  try {
    return await fn(client);
  } catch (e) {
    return fail(op, e);
  }
}

function userResult(op: string, data: { user: User | null } | null, error: unknown): AuthAdminResult<AuthUserLite> {
  if (error) return fail(op, error);
  if (!data?.user) return fail(op, { message: "respuesta sin usuario" });
  return { ok: true, data: toLite(data.user) };
}

const supabasePort: AuthAdminPort = {
  createUser(p) {
    return withClient("createUser", async (c) => {
      const name = cleanName(p.fullName);
      const { data, error } = await c.auth.admin.createUser({
        email: normalizeEmail(p.email),
        ...(p.password !== undefined ? { password: p.password } : {}),
        email_confirm: p.emailConfirm,
        ...(name ? { user_metadata: { full_name: name } } : {}),
      });
      return userResult("createUser", data, error);
    });
  },

  deleteUser(id) {
    return withClient("deleteUser", async (c) => {
      // Borrado DURO (sin `shouldSoftDelete`): el soft-delete deja el email
      // tomado y una invitación compensada no podría volver a crear la cuenta.
      const { error } = await c.auth.admin.deleteUser(id);
      if (error) return fail("deleteUser", error);
      return { ok: true, data: null };
    });
  },

  updateUserById(id, p) {
    return withClient("updateUserById", async (c) => {
      const attrs: Record<string, unknown> = {};
      if (p.password !== undefined) attrs.password = p.password;
      if (p.emailConfirm !== undefined) attrs.email_confirm = p.emailConfirm;
      // GoTrue mergea `user_metadata` por clave: mandar solo `full_name` no pisa
      // el resto (avatar de Google, etc.). `null` lo borra a propósito.
      if (p.fullName !== undefined) attrs.user_metadata = { full_name: cleanName(p.fullName) ?? null };
      if (p.banDuration !== undefined) attrs.ban_duration = p.banDuration;
      const { data, error } = await c.auth.admin.updateUserById(id, attrs);
      return userResult("updateUserById", data, error);
    });
  },

  getUser(id) {
    return withClient("getUser", async (c) => {
      const { data, error } = await c.auth.admin.getUserById(id);
      return userResult("getUser", data, error);
    });
  },

  findUserByEmail(email) {
    return withClient("findUserByEmail", async (c) => {
      // GoTrue admin no tiene «buscar por email»: se pagina `listUsers` y se
      // compara EXACTO (normalizado), nunca con un filtro tipo ILIKE: con
      // comodines `jpere_@…` encontraba a `jperez@…` (hallazgo [A] del 14-oct).
      const target = normalizeEmail(email);
      if (!target) return { ok: true, data: null };
      for (let page = 1; page <= LIST_MAX_PAGES; page++) {
        const { data, error } = await c.auth.admin.listUsers({ page, perPage: LIST_PER_PAGE });
        if (error) return fail("findUserByEmail", error);
        const users = data?.users ?? [];
        const hit = users.find((u) => typeof u.email === "string" && normalizeEmail(u.email) === target);
        if (hit) return { ok: true, data: toLite(hit) };
        if (users.length < LIST_PER_PAGE) return { ok: true, data: null };
      }
      return fail("findUserByEmail", { message: `más de ${LIST_MAX_PAGES} páginas de usuarios` });
    });
  },

  generateLink(p) {
    return withClient("generateLink", async (c) => {
      // `signup` exige `password` en el tipo de supabase-js, pero GoTrue solo lo
      // pide al CREAR la cuenta: sobre un usuario sin confirmar re-emite sin él
      // (reenviar verificación). Por eso se omite la clave si no viene, y GoTrue
      // decide (supuesto verificado por diagnose-auth).
      const params = {
        type: p.type,
        email: normalizeEmail(p.email),
        ...(p.password !== undefined ? { password: p.password } : {}),
        ...(p.redirectTo !== undefined ? { options: { redirectTo: p.redirectTo } } : {}),
      } as GenerateLinkParams;
      const { data, error } = await c.auth.admin.generateLink(params);
      if (error) return fail("generateLink", error);
      const hashed = data?.properties?.hashed_token;
      // 200 sin `hashed_token`: en Traze era «pantalla en verde y nadie con acceso».
      if (!hashed) return fail("generateLink", { message: "respuesta sin hashed_token" });
      const returned = data.properties.verification_type as string | undefined;
      const verificationType: VerificationType =
        returned && VERIFICATION_TYPES.has(returned as VerificationType) ? (returned as VerificationType) : p.type;
      return { ok: true, data: { hashedToken: hashed, verificationType, userId: data.user?.id ?? null } };
    });
  },
};

let injected: AuthAdminPort | null = null;

/** El puerto vigente: el fake si un test lo inyectó; si no, el real sobre `getSupabaseAdminClient()`. */
export function authAdmin(): AuthAdminPort {
  return injected ?? supabasePort;
}

/** Solo tests: inyecta un `AuthAdminPort` (el fake de GoTrue); `null` vuelve al real. */
export function __setAuthAdminForTests(p: AuthAdminPort | null): void {
  injected = p;
}
