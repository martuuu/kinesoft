import "server-only";
import { OAUTH_PROVIDERS, isProviderEnabled, type OAuthProvider } from "@/lib/oauth-start";

/**
 * [VX2-a · D-VX16] Qué botones sociales muestran el login y el signup.
 *
 * Regla §20.19 (nada a medio hacer): un proveedor APAGADO en Supabase (`isProviderEnabled` = `false`) no se ofrece;
 * antes el botón llevaba a `/login?error=provider_disabled`, un callejón. `null` (no se pudo saber: Supabase lento o
 * caído, env sin configurar) → se MUESTRA: el arranque igual vuelve a chequear y, si estaba apagado, cae en el
 * aviso traducido del login. Esconder todo ante la duda dejaría sin Google a todos por un timeout.
 *
 * Por qué un tope propio (`timeoutMs`): esto corre en el render del login. `isProviderEnabled` ya corta a 1,5 s, pero
 * el login no tiene que esperar eso por una comodidad de UX (riesgo 6 del brief). Si se pasa, se muestran todos; la
 * consulta sigue en el fondo y deja la cache (60 s) caliente para el próximo render.
 */
export const OAUTH_VISIBILITY_TIMEOUT_MS = 600;

/** Puro: estado de cada proveedor → los que se muestran, en el orden de `OAUTH_PROVIDERS` (Google primero). */
export function visibleProvidersFrom(state: Partial<Record<OAuthProvider, boolean | null>>): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((p) => state[p] !== false);
}

export async function visibleOAuthProviders(timeoutMs = OAUTH_VISIBILITY_TIMEOUT_MS): Promise<OAuthProvider[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  // Google primero y Facebook después (no en paralelo): con la cache fría, la primera consulta llena
  // `settingsCache` y la segunda sale de ahí, en vez de dos GET a `/auth/v1/settings` por render.
  const lookup = (async () => {
    const state: Partial<Record<OAuthProvider, boolean | null>> = {};
    for (const p of OAUTH_PROVIDERS) state[p] = await isProviderEnabled(p);
    return state;
  })();
  try {
    const state = await Promise.race([lookup, timeout]);
    return visibleProvidersFrom(state ?? {});
  } catch {
    // `isProviderEnabled` no tira (devuelve null), pero el login no puede caerse por esto.
    return [...OAUTH_PROVIDERS];
  } finally {
    clearTimeout(timer);
  }
}
