"use server";

/**
 * Action que acuña el token corto del canal Broadcast privado (SV04b, C-SV5; plan
 * §18.2 «Token»). La llama el driver `supabase` del cliente al conectar y al 80 % del
 * TTL (8 min). Nunca tira (tampoco con errores no tipados: `realtime-error`, FX1b):
 * el cliente degrada a polling con `{ok:false}`.
 *
 * Orden: `getActor()` → acceso del consultorio (BO2-D) → capability (ver `realtimeAllowed`) →
 * driver `supabase` → secreto presente → rate limit 30 cada 10 min por usuario →
 * firma. No hay input (nada que validar con zod) y no se toca la base más allá de
 * leer el rol: el `tenant_id` del token sale del actor de la sesión, nunca del cliente.
 *
 * El token no se loguea nunca (ni el secreto): con él se lee el canal del consultorio.
 *
 * HF-1a (D-HF1, decisión de Martin 18-oct; H-RT3): la agenda en vivo es de TODOS los planes. Antes había un
 * `assertModule(actor, "salaEspera")` acá, y `salaEspera` es solo de Clínica/Libre: un consultorio en plan
 * Consultorio con Secretaria nunca recibía «Llegó» ni los cambios de los demás sin recargar. Lo que sigue siendo de
 * Clínica/Libre (`/sala`, «Llamar», la TV, los avisos con sonido) tiene sus propios gates; el canal solo lleva
 * avisos de «cambió algo, volvé a pedir» (sin PHI). BILLING y el soporte siguen afuera (`realtimeAllowed`).
 *
 * HF-1a (H-RT1): cada rechazo deja `realtime.mint_denied` con un código de motivo, UNA vez por usuario, motivo y
 * ventana de 10 min (en memoria del proceso): en prod el motivo se perdía y el cliente reintenta cada pocos segundos,
 * así que loguear cada intento llenaría el log del mismo renglón.
 */
import { env, tenantAccessEnforcement } from "@/lib/env";
import { effectiveMode, publicSurfacesOpen } from "@/lib/tenant-access";
import { logger } from "@/lib/logger";
import { getActor, ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { realtimeAllowed } from "@/lib/realtime-bootstrap";
import { signRealtimeToken } from "@/lib/realtime-token-internal";
import { logMintDenied as logDenied } from "@/lib/realtime-mint-log";

// HF-1a: «agenda en vivo», no «sala de espera»: desde D-HF1 el canal es de la agenda en todos los planes.
const NO_ACCESS = "No tenés acceso a la agenda en vivo.";

// 30 cada 10 min: un cliente sano pide ~1 cada 8 min por pestaña; el margen cubre
// varias pestañas y reconexiones, y corta un loop de re-mint que martille el server.
const RATE = { limit: 30, windowMs: 10 * 60_000 };

// Un log por proceso alcanza para "falta el secreto": es config, no un evento.
let warnedMissingSecret = false;

export async function mintRealtimeToken(): Promise<
  { ok: true; data: { token: string; expiresAt: string } } | { ok: false; error: string }
> {
  let who: { userId: string; tenantId: string } | null = null;
  try {
    const actor = await getActor();
    who = { userId: actor.userId, tenantId: actor.tenantId };
    // BO2-D (C-BO1 `publicSurfacesOpen`, modo EFECTIVO): sin token con el consultorio en solo lectura bajo
    // `enforce` (suspendido / baja ya no llegan acá: `getActor` no entra a un consultorio bloqueado). El cliente
    // degrada a polling, que lee igual (leer nunca se corta). Va antes del rate limit: no gasta cupo.
    if (!publicSurfacesOpen(effectiveMode(actor.access.mode, tenantAccessEnforcement()))) {
      logDenied("access_readonly", actor.userId, actor.tenantId);
      return { ok: false, error: "realtime-off" };
    }
    const caps = await memberCapabilitiesForActor(actor);
    if (!realtimeAllowed(actor, caps)) {
      logDenied("no_capability", actor.userId, actor.tenantId);
      return { ok: false, error: NO_ACCESS };
    }

    if (env.REALTIME_DRIVER !== "supabase") {
      logDenied("driver_off", actor.userId, actor.tenantId);
      return { ok: false, error: "realtime-off" };
    }

    const secret = env.SUPABASE_JWT_SECRET;
    if (!secret) {
      if (!warnedMissingSecret) {
        warnedMissingSecret = true;
        // Sin nombrar la variable en el log: el guard (d) de SV prohíbe token/secret en logs.
        logger.warn("realtime.mint_unconfigured", { tenantId: actor.tenantId });
      }
      logDenied("unconfigured", actor.userId, actor.tenantId);
      return { ok: false, error: "realtime-unconfigured" };
    }

    const rl = await rateLimit(`rt:token:${actor.userId}`, RATE);
    if (!rl.ok) {
      logDenied("rate_limited", actor.userId, actor.tenantId);
      return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };
    }

    const { token, expiresAt } = signRealtimeToken({
      tenantId: actor.tenantId,
      now: new Date(),
      secret,
      kid: env.SUPABASE_JWT_KID,
    });
    return { ok: true, data: { token, expiresAt: expiresAt.toISOString() } };
  } catch (e) {
    if (e instanceof ForbiddenError) {
      logDenied("forbidden", who?.userId ?? null, who?.tenantId ?? null);
      return { ok: false, error: e.message || NO_ACCESS };
    }
    if (e instanceof UnauthenticatedError) {
      logDenied("unauthenticated", who?.userId ?? null, who?.tenantId ?? null);
      return { ok: false, error: "Tu sesión venció." };
    }
    // FX1b: antes `throw e`. Un error no tipado (rol que no se pudo leer, rate
    // limit caído, bug al firmar) llegaba al cliente como excepción de la
    // action, y el driver lo trataba distinto de un `{ok:false}` (reintento sin
    // backoff en vez de degradar a polling). El contrato dice «nunca tira».
    // Se loguea solo el tipo y el mensaje del error: nunca el JWT ni el secreto
    // (si el error ocurrió después de firmar, el JWT vive en una variable que
    // acá no se toca; el logger además redacta `eyJ…`).
    try {
      logger.error("realtime.mint_failed", {
        errName: e instanceof Error ? e.name : typeof e,
        err: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // el log tampoco puede romper el «nunca tira»
    }
    return { ok: false, error: "realtime-error" };
  }
}
