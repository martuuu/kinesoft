import "server-only";
import { logger } from "@/lib/logger";

/**
 * HF-1a (H-RT1, plan §22.4) · log acotado de los rechazos de `mintRealtimeToken`.
 *
 * En prod el motivo de un `{ok:false}` se perdía (el cliente degradaba a polling en silencio) y no había cómo saber
 * si la agenda no entraba en vivo por el plan, el rol, el driver, el secreto o el rate limit. Pero el cliente
 * reintenta cada pocos segundos: loguear cada intento llenaría el log del mismo renglón. Entonces: UNA línea por
 * usuario y motivo cada 10 min, en memoria del proceso (en Vercel cada lambda tiene la suya: alcanza para ver el
 * motivo, no es un contador).
 *
 * Vive fuera de `lib/realtime-token.ts` porque ese archivo es `"use server"`: todo lo que exporta es un endpoint, y el
 * reset de los tests no puede serlo. Solo códigos de motivo e ids: nunca el copy, el token ni el secreto (guard (d)).
 */
export type MintDenyReason =
  | "access_readonly"
  | "no_capability"
  | "driver_off"
  | "unconfigured"
  | "rate_limited"
  | "forbidden"
  | "unauthenticated";

const WINDOW_MS = 10 * 60_000;
// Tope de claves: si se llena (muchos usuarios rechazados en 10 min) se vacía entera. Perder la deduplicación un
// rato es mejor que crecer sin límite en un proceso largo.
const MAX_KEYS = 1_000;
const logged = new Map<string, number>();

export function logMintDenied(reason: MintDenyReason, userId: string | null, tenantId: string | null): void {
  try {
    const key = `${userId ?? "anon"}|${reason}`;
    const t = Date.now();
    const until = logged.get(key);
    if (until !== undefined && until > t) return;
    if (logged.size >= MAX_KEYS) logged.clear();
    logged.set(key, t + WINDOW_MS);
    logger.warn("realtime.mint_denied", { reason, userId, tenantId });
  } catch {
    // el log no puede romper el «nunca tira» de la action
  }
}

/** Solo tests: vacía la deduplicación. */
export function __resetMintDeniedLogForTests(): void {
  logged.clear();
}
