"use server";

/**
 * TV (T7, §26.4 C-TV, D12): token corto del canal Broadcast para la PANTALLA de la sala (sin Actor: la identidad es la
 * cookie del dispositivo). Misma forma de retorno que `mintRealtimeToken` (`lib/realtime-token.ts`) para que el driver
 * `supabase` del cliente lo use sin ramas, y mismo `signRealtimeToken({tenantId})` con los mismos claims y topic: no
 * cambia el SQL de M5. Con el driver `local` la TV solo hace polling (D13). Cae bajo guard-realtime (d): nada de
 * `console.log` ni del token en logs.
 *
 * STUB de TV-1k (ola X1): devuelve `{ok:false}` (el cliente degrada a polling, igual que con el driver apagado). Lo
 * implementa TV-2d (X2): sesión del dispositivo → driver `supabase` → secreto presente → rate limit
 * `rt:display:<id>` 30 cada 10 min → firma. Nunca tira.
 */

export async function mintDisplayRealtimeToken(): Promise<
  { ok: true; data: { token: string; expiresAt: string } } | { ok: false; error: string }
> {
  return { ok: false, error: "realtime-off" };
}
