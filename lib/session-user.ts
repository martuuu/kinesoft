import "server-only";
/**
 * Usuario de la sesión, verificado contra Supabase (IAM-3a).
 *
 * Por qué existe: había 7 `auth.getUser()` sueltos (session, onboarding, turnero, auth, /invite x2, portal), cada
 * uno con su manejo de error distinto (algunos tiraban si Supabase no respondía, otros no miraban `error`) y cada
 * uno un round-trip a GoTrue en el MISMO request: el layout de la app llamaba a `getUser` dos veces (actor +
 * gate). Uno solo, envuelto en `cache()` (un llamado por request de RSC/action) y que nunca tira.
 *
 * `getUser` y no `getSession`: valida el JWT contra el server (la cookie la puede fabricar el cliente).
 *
 * Ojo con `cache()`: dentro de UN request el resultado queda fijo. Quien inicia o cierra sesión en una action
 * (activación de invitación, login) no debe llamar a esto ANTES del cambio y esperar ver el usuario nuevo
 * después en el mismo request. Hoy nadie lo hace.
 */
import { cache } from "react";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { timeAsync } from "@/lib/server-timing";

export type VerifiedSessionUser = {
  id: string;
  /** Tal cual lo devuelve Supabase (puede ser null en identidades sin email). Normalizar en el caller. */
  email: string | null;
  /** ISO de `email_confirmed_at`, o null si no confirmó. */
  emailConfirmedAt: string | null;
  /** `user_metadata.full_name` (Google lo trae; la activación de invitación lo escribe). */
  fullName: string | null;
  /** `user_metadata.avatar_url` (Google). */
  avatarUrl: string | null;
};

async function readSessionUser(): Promise<VerifiedSessionUser | null> {
  try {
    const { data, error } = await getSupabaseServerClient().auth.getUser();
    // supabase-js no tira: un token vencido o Supabase caído llega como `error`. Se trata como sin sesión.
    if (error || !data?.user?.id) return null;
    const u = data.user;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    return {
      id: u.id,
      email: u.email ?? null,
      emailConfirmedAt: u.email_confirmed_at ?? null,
      fullName: typeof meta.full_name === "string" ? meta.full_name : null,
      avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
    };
  } catch {
    // Sin configurar (dev sin Supabase) o fuera de un request (cookies() tira): sin sesión.
    return null;
  }
}

/**
 * PF-0a: la marca `auth` de `lib/server-timing.ts` (con `PERF_TIMING=1`; apagado es `readSessionUser()` tal cual). Va
 * por debajo de `cache()`: mide la llamada REAL a GoTrue (una por request), no los aciertos de la memo.
 */
const readSessionUserTimed = () => timeAsync("auth", readSessionUser);

// `cache` solo existe en el build react-server que empaqueta Next; en el runner de unit (react 18 pelado) no
// está. Sin él, pass-through: cada llamada lee de nuevo (mismo trato que el mock de integration-setup).
const memo: <T extends (...a: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/** El usuario verificado de esta sesión, o null. Nunca tira. Un solo `auth.getUser()` por request. */
export const getVerifiedSessionUser: () => Promise<VerifiedSessionUser | null> = memo(readSessionUserTimed);
