import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Opciones de las cookies de sesión de Supabase (`sb-<ref>-auth-token*`),
 * compartidas por el cliente de servidor (`server.ts`) y el middleware
 * (A3b-S-auth). Vive aparte porque el middleware corre en edge y no puede
 * importar `server.ts` (usa `cookies()` de `next/headers`).
 *
 * - `httpOnly: true`: el default de `@supabase/ssr` 0.5 es `false` (para que
 *   `createBrowserClient` pueda leer la sesión desde `document.cookie`). En
 *   KineSoft ningún código cliente usa el browser client para auth
 *   (`lib/supabase/browser.ts` no tiene importadores al 30-sep: login,
 *   Google, sign-out y reset van por route handlers/server actions), así que
 *   la cookie no tiene por qué ser legible desde JS: un XSS ya no se lleva el
 *   refresh token. Si algún día se usa `getSupabaseBrowserClient()` para
 *   auth, esto lo rompe: hay que decidirlo entonces, no cambiarlo acá.
 * - `secure` solo en producción (en `next dev` por http la cookie no se
 *   setearía). Se mira NODE_ENV porque Preview también es https.
 * - `sameSite: "lax"`: el callback de OAuth y los links de email llegan por
 *   navegación top-level GET, que `lax` permite; un POST cross-site no lleva
 *   la cookie.
 */
export const SUPABASE_COOKIE_OPTIONS: CookieOptionsWithName = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};
