/**
 * Cookie del consultorio activo (IAM-0c, C-IAM2). Puro: nombre y opciones,
 * sin `next/headers` (la escribe el selector de consultorio de IAM-3b y la
 * lee `buildActor` en IAM-3a).
 *
 * Valor: el `tenantId` (no el slug). Hoy `lib/session.ts` lee `kine_tenant`
 * como slug, pero ningún código la escribe (verificado al 14-oct), así que el
 * cambio de significado no deja cookies viejas que migrar. Igual nunca se
 * confía: `chooseActiveTenant` la ignora si no es una membresía usable.
 *
 * Opciones con el mismo criterio que `SUPABASE_COOKIE_OPTIONS`
 * (`lib/supabase/cookie-options.ts`): httpOnly porque ningún JS del cliente la
 * necesita (se cambia por server action), `secure` solo en producción (en
 * `next dev` por http no se setearía) y `lax` para que viaje en la navegación
 * top-level después de cambiar de consultorio.
 */
export const ACTIVE_TENANT_COOKIE = "kine_tenant";

/** Un año: es una preferencia, no una credencial; la sesión vence por su lado. */
const ONE_YEAR_S = 60 * 60 * 24 * 365;

export const ACTIVE_TENANT_COOKIE_OPTIONS: {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: ONE_YEAR_S,
};
