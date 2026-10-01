import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";

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
 */
export function getSupabaseServerClient() {
  const cookieStore = cookies();
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
              cookieStore.set(name, value, { ...options, ...SUPABASE_COOKIE_OPTIONS });
            }
          } catch {
            // server component: no se pueden escribir cookies; lo hace el middleware.
          }
        },
      },
    }
  );
}
