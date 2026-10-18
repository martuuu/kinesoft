import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import {
  SESSION_MODE_COOKIE,
  applySessionCookiePolicy,
  sessionModeFromCookie,
  type SessionMode,
} from "@/lib/supabase/session-mode";

/**
 * Cliente de Supabase para server components, route handlers y server actions.
 *
 * A3b-S-auth: pasa de `get/set/remove` (deprecado en `@supabase/ssr` 0.5, y
 * que no maneja bien los tokens partidos en chunks `…-auth-token.0/.1`) a
 * `getAll/setAll`, con las cookies `httpOnly` + `secure` (prod) + `sameSite=lax`
 * de `cookie-options.ts`.
 *
 * En un server component `cookies().set` tira (solo se puede en actions y
 * route handlers): se ignora, porque el refresh real de la sesión lo hace el
 * middleware en cada request y propaga las cookies nuevas a la respuesta.
 *
 * «Mantenerme conectado» (tanda B): cada cookie de sesión que se escribe pasa por `applySessionCookiePolicy` con el
 * modo de `kine_session_mode` (ver `session-mode.ts`). `opts.sessionMode` lo pisa: el login lo pasa explícito porque
 * en ese request la cookie de preferencia todavía no existe (la escribe la misma respuesta).
 */
export function getSupabaseServerClient(opts: { sessionMode?: SessionMode } = {}) {
  const cookieStore = cookies();
  const mode = opts.sessionMode ?? sessionModeFromCookie(cookieStore.get(SESSION_MODE_COOKIE)?.value);
  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookieOptions: SUPABASE_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, applySessionCookiePolicy({ ...options, ...SUPABASE_COOKIE_OPTIONS }, mode));
            }
          } catch {
            // server component: no se pueden escribir cookies; lo hace el middleware.
          }
        },
      },
    }
  );
}
