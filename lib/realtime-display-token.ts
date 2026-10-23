"use server";

/**
 * TV (T7 · TV-2d, §26.4 C-TV, D12): token corto del canal Broadcast para la PANTALLA de la sala (sin Actor: la
 * identidad es la cookie del dispositivo). Misma forma de retorno que `mintRealtimeToken` (`lib/realtime-token.ts`)
 * para que el driver `supabase` del cliente lo use sin ramas, y el mismo `signRealtimeToken({tenantId})`: mismos claims
 * y mismo topic `tenant:<id>:agenda`, así que **no cambia el SQL de M5** (la policy no sabe si el token es de una
 * persona o de una TV; el canal solo lleva avisos de «cambió algo, volvé a pedir», sin PHI). El `tenant_id` sale de la
 * FILA de la pantalla, nunca del cliente.
 *
 * Orden: sesión del dispositivo (cookie → no revocada → secreto → acceso del consultorio abierto → módulo
 * `salaEspera`; `resolveDisplaySession`) → driver `supabase` (con `local` la TV solo hace polling, D13) → secreto
 * presente → rate limit `rt:display:<id>` 30 cada 10 min (un cliente sano re-acuña a los 8 min) → firma. Nunca tira.
 *
 * Logs: los rechazos van por el mismo log acotado del mint del staff (`logMintDenied`, una línea por identidad y
 * motivo cada 10 min). La identidad es `display:<id>` (no hay usuario) y los motivos se mapean a los de
 * `MintDenyReason`: sin vincular / revocada → `unauthenticated`, consultorio cerrado → `access_readonly`, sin módulo →
 * `no_capability`. Guard-realtime (d): nada de `console.log` ni del token o el secreto en un log.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { signRealtimeToken } from "@/lib/realtime-token-internal";
import { logMintDenied as logDenied } from "@/lib/realtime-mint-log";
import { resolveDisplaySession } from "@/lib/display-device-internal";

const RATE = { limit: 30, windowMs: 10 * 60_000 };

let warnedMissingSecret = false;

export async function mintDisplayRealtimeToken(): Promise<
  { ok: true; data: { token: string; expiresAt: string } } | { ok: false; error: string }
> {
  try {
    const s = await resolveDisplaySession();
    if (s.state !== "paired") {
      if (s.state === "unavailable") {
        logDenied(s.reason === "access_closed" ? "access_readonly" : "no_capability", null, null);
      } else {
        logDenied("unauthenticated", null, null);
      }
      return { ok: false, error: "realtime-off" };
    }
    const who = `display:${s.displayId}`;

    if (env.REALTIME_DRIVER !== "supabase") {
      logDenied("driver_off", who, s.tenantId);
      return { ok: false, error: "realtime-off" };
    }

    const signingKey = env.SUPABASE_JWT_SECRET;
    if (!signingKey) {
      if (!warnedMissingSecret) {
        warnedMissingSecret = true;
        logger.warn("realtime.mint_unconfigured", { tenantId: s.tenantId });
      }
      logDenied("unconfigured", who, s.tenantId);
      return { ok: false, error: "realtime-unconfigured" };
    }

    const rl = await rateLimit(`rt:display:${s.displayId}`, RATE);
    if (!rl.ok) {
      logDenied("rate_limited", who, s.tenantId);
      return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };
    }

    const signed = signRealtimeToken({ tenantId: s.tenantId, now: new Date(), secret: signingKey, kid: env.SUPABASE_JWT_KID });
    return { ok: true, data: { token: signed.token, expiresAt: signed.expiresAt.toISOString() } };
  } catch (e) {
    // Solo el tipo y el mensaje: si el error ocurrió después de firmar, el JWT vive en una variable que acá no se toca.
    try {
      logger.error("realtime.display_mint_failed", {
        errName: e instanceof Error ? e.name : typeof e,
        err: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // el log tampoco puede romper el «nunca tira»
    }
    return { ok: false, error: "realtime-error" };
  }
}
