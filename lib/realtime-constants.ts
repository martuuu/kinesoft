/**
 * Constantes del canal realtime de la Sala de Espera (SV, C-SV1 — FIRMA CONGELADA).
 *
 * Puro y client-safe: lo importan el publisher (server), el token (server) y los
 * drivers del browser. Por eso no importa nada de server (ni `env`, ni Prisma):
 * si lo hiciera, el bundle del cliente arrastraría `server-only` y rompería.
 */

/** Nombre del evento Broadcast. Uno solo: el `kind` del payload distingue el cambio. */
export const REALTIME_EVENT = "agenda";

/**
 * Topic privado del consultorio. La policy de M5 (`kinesoft_realtime_can_read`)
 * compara literalmente `'tenant:' || tenant_id || ':agenda'`: si este formato
 * cambia, el canal deja de entregar sin error visible. No lo toques sin M5.
 */
export function topicFor(tenantId: string): string {
  return `tenant:${tenantId}:agenda`;
}

/**
 * Tope de mensajes por POST a Broadcast (SV-D10). Un batch de 20 turnos va en un
 * solo POST con 20 mensajes; más que eso se colapsa (`buildRealtimeMessages`):
 * el cliente igual re-pide, así que un mensaje por día/profesional alcanza.
 */
export const MAX_MESSAGES_PER_POST = 20;

/** Tope del POST de publish (SV-D7): se espera, pero una action no paga más que esto. */
export const REALTIME_PUBLISH_TIMEOUT_MS = 1500;

/** TTL del token del canal (SV-D6: `exp = iat + 600`); el cliente lo renueva al 80 %. */
export const REALTIME_TOKEN_TTL_SEC = 600;

/** `off` = app idéntica a SR; `local` = bus en memoria + SSE (solo dev); `supabase` = Broadcast. */
export const REALTIME_DRIVERS = ["off", "local", "supabase"] as const;
export type RealtimeDriverName = (typeof REALTIME_DRIVERS)[number];
