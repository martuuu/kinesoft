import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import {
  REALTIME_EVENT,
  REALTIME_PUBLISH_TIMEOUT_MS,
  topicFor,
} from "@/lib/realtime-constants";
import {
  availabilityMessage,
  buildRealtimeMessages,
  type RealtimeAgendaMessage,
} from "@/lib/realtime-events";
import { emit as emitLocal } from "@/lib/realtime-local-bus";

/**
 * Publisher del canal realtime de la agenda (SV04a, C-SV4 — FIRMA CONGELADA).
 *
 * Lo llama SOLO `lib/booking-events-internal.ts` (después del commit). Arma los
 * mensajes con `buildRealtimeMessages` (sin PHI, C-SV2) y los entrega según
 * `env.REALTIME_DRIVER`:
 *   - `off`      → nada (la app es idéntica a SR);
 *   - `local`    → bus en memoria (`lib/realtime-local-bus.ts`) → SSE de dev;
 *   - `supabase` → UN POST a la REST de Broadcast con TODOS los mensajes del
 *     commit (un batch de 20 turnos = 1 POST, no 20).
 *
 * El driver se lee AL LLAMAR, no al importar: los tests cambian el env mockeado
 * entre casos y un valor capturado al importar los dejaría a todos en el primero.
 *
 * Por qué con timeout y breaker (SV-D7): el publish se ESPERA (Vercel corta las
 * promesas sueltas al responder y Next 14.2 no tiene `after()`), así que su
 * latencia la paga la action. Tope de `REALTIME_PUBLISH_TIMEOUT_MS` (1,5 s) por
 * POST, y si Supabase falla 3 veces seguidas el breaker se abre 30 s: mientras
 * está abierto no se hace el POST (una Secretaria marcando 10 llegadas con
 * Supabase caído no paga 10 × 1,5 s). Con la config incompleta (sin URL o sin
 * service key) se abre 300 s: eso no se arregla solo en 30 s.
 *
 * NUNCA tira: el turno ya está escrito; un fallo del canal se loguea (a lo sumo
 * una línea por minuto por motivo, para no inundar el log con Supabase caído) y
 * los clientes se ponen al día por el polling de 60 s. El log lleva tenantId,
 * cantidad de refs, status y motivo; jamás la service key, el token ni el body.
 */

export type PublishResult =
  | { ok: true; messages: number }
  | {
      ok: false;
      reason: "off" | "timeout" | "http" | "config" | "breaker" | "error";
      status?: number;
    };

/** `day: null` = varios días (bloqueo largo, FX1b): un solo mensaje. */
export type AvailabilityScope = { practitionerId: string | null; day: string | null };

/** Lo que `__setRealtimePublisherForTests` reemplaza (y lo que implementa `tests/helpers/realtime-fake.ts`). */
export type RealtimePublisher = {
  publishBookingChanges(tenantId: string, refs: ReadonlyArray<BookingChangeRef>): Promise<PublishResult>;
  publishAvailability(tenantId: string, scope: AvailabilityScope): Promise<PublishResult>;
};

export const BREAKER = { failures: 3, openMs: 30_000, openMsOnConfigError: 300_000 } as const;
const LOG_EVERY_MS = 60_000;

type FailReason = Exclude<Extract<PublishResult, { ok: false }>["reason"], "off">;

// Estado de módulo (por instancia de lambda): suficiente para que una instancia
// caliente no repita el POST contra un Supabase caído. No hace falta compartirlo.
const state = {
  failures: 0,
  openUntil: 0,
  lastLogAt: new Map<string, number>(),
  override: null as RealtimePublisher | null,
  fetchImpl: null as typeof fetch | null,
};

/**
 * Tests unitarios del hook: reemplaza el publisher entero (con `null` vuelve al
 * real). La integración NO usa esto: `tests/helpers/integration-setup.ts` mockea
 * el módulo (el `.env.local` puede traer una service key real).
 */
export function __setRealtimePublisherForTests(p: RealtimePublisher | null): void {
  state.override = p;
}

/** Tests del publisher: `fetch` fake y reset del breaker y del throttle del log. */
export const __realtimePublisherInternals = {
  setFetch(f: typeof fetch | null): void {
    state.fetchImpl = f;
  },
  reset(): void {
    state.failures = 0;
    state.openUntil = 0;
    state.lastLogAt.clear();
    state.fetchImpl = null;
    state.override = null;
  },
  breaker(): { failures: number; openUntil: number } {
    return { failures: state.failures, openUntil: state.openUntil };
  },
};

export async function publishBookingChanges(
  tenantId: string,
  refs: ReadonlyArray<BookingChangeRef>
): Promise<PublishResult> {
  if (state.override) return state.override.publishBookingChanges(tenantId, refs);
  try {
    if (env.REALTIME_DRIVER === "off") return { ok: false, reason: "off" };
    return await deliver(tenantId, buildRealtimeMessages(refs, new Date()), refs.length);
  } catch (e) {
    return fail(tenantId, refs.length, "error", undefined, e);
  }
}

export async function publishAvailability(
  tenantId: string,
  scope: AvailabilityScope
): Promise<PublishResult> {
  if (state.override) return state.override.publishAvailability(tenantId, scope);
  try {
    if (env.REALTIME_DRIVER === "off") return { ok: false, reason: "off" };
    return await deliver(tenantId, [availabilityMessage(scope, new Date())], 0);
  } catch (e) {
    return fail(tenantId, 0, "error", undefined, e);
  }
}

async function deliver(
  tenantId: string,
  messages: RealtimeAgendaMessage[],
  refCount: number
): Promise<PublishResult> {
  if (messages.length === 0) return { ok: true, messages: 0 };

  if (env.REALTIME_DRIVER === "local") {
    emitLocal(tenantId, messages);
    return { ok: true, messages: messages.length };
  }

  // supabase
  if (Date.now() < state.openUntil) {
    // Abierto: no se cuenta como un fallo nuevo (si no, nunca se cerraría).
    logThrottled(tenantId, refCount, "breaker", undefined);
    return { ok: false, reason: "breaker" };
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return fail(tenantId, refCount, "config");

  const body = JSON.stringify({
    messages: messages.map((payload) => ({
      topic: topicFor(tenantId),
      event: REALTIME_EVENT,
      payload,
      private: true,
    })),
  });

  const f = state.fetchImpl ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REALTIME_PUBLISH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(`${url.replace(/\/+$/, "")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    return fail(tenantId, refCount, ctrl.signal.aborted ? "timeout" : "error", undefined, e);
  } finally {
    clearTimeout(timer);
  }

  // El cuerpo (vacío en el 202) no se lee: se cancela para no dejar el socket
  // tomado hasta el GC.
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // body ya consumido o sin stream: nada que liberar
  }

  if (res.status < 200 || res.status >= 300) return fail(tenantId, refCount, "http", res.status);

  state.failures = 0;
  state.openUntil = 0;
  return { ok: true, messages: messages.length };
}

function fail(
  tenantId: string,
  refCount: number,
  reason: FailReason,
  status?: number,
  err?: unknown
): PublishResult {
  try {
    if (reason !== "breaker") {
      state.failures += 1;
      if (reason === "config") {
        // La config no se arregla sola: se abre ya y por más tiempo.
        state.openUntil = Date.now() + BREAKER.openMsOnConfigError;
      } else if (state.failures >= BREAKER.failures) {
        state.openUntil = Date.now() + BREAKER.openMs;
      }
    }
    logThrottled(tenantId, refCount, reason, status, err);
  } catch {
    // "nunca tira" incluye el camino de error
  }
  return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
}

function logThrottled(
  tenantId: string,
  refCount: number,
  reason: FailReason,
  status: number | undefined,
  err?: unknown
): void {
  try {
    const now = Date.now();
    const last = state.lastLogAt.get(reason);
    if (last !== undefined && now - last < LOG_EVERY_MS) return;
    state.lastLogAt.set(reason, now);
    // `err` va solo como nombre del error (AbortError, TypeError…): el mensaje
    // de un fetch fallido puede traer la URL con el host del proyecto, y nunca
    // queremos arriesgar headers ni body.
    logger.warn("realtime.publish_failed", {
      tenantId,
      refs: refCount,
      status: status ?? null,
      reason,
      ...(err instanceof Error ? { errName: err.name } : {}),
    });
  } catch {
    // el log tampoco puede tirar
  }
}
