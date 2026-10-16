/**
 * Estado puro del cliente realtime (SV07a, §18.2 «Cliente»).
 *
 * Sin DOM y sin `@supabase/realtime-js`: lo importan los drivers y el provider, y
 * se testea con `vi.useFakeTimers` en Node. Todo lo que decide CUÁNDO (coalescer,
 * backoff, polling, refresh del token) vive acá para que los drivers sean solo
 * cableado.
 */
import { parseRealtimeAgendaMessage, type RealtimeAgendaMessage } from "@/lib/realtime-message-guard";
import type {
  ConnectionState,
  DriverStatus,
  ResyncReason,
  StatusInfo,
  Timers,
} from "@/lib/realtime-client-types";

/** Ventana del coalescer: una ráfaga (batch de 20 turnos, varias llegadas) = 1 refetch. */
export const COALESCE_WINDOW_MS = 250;
/** Polling de respaldo cuando el canal no está (§18.0 punto 5). */
export const POLL_INTERVAL_MS = 60_000;
export const BACKOFF_BASE_MS = 1_000;
/** Tope del backoff: con Supabase caído, cada pestaña reintenta a lo sumo cada 30 s. */
export const BACKOFF_MAX_MS = 30_000;
/** El token se renueva al 80 % de su vida (600 s → a los 480 s, §18.2). */
export const TOKEN_REFRESH_RATIO = 0.8;
/**
 * Piso entre renovaciones. Si el reloj del cliente está adelantado, el token
 * recién emitido «ya venció» para él y sin piso pediría otro en loop; el rate
 * limit del mint es 30 cada 10 min por usuario y el piso deja 20 (1 cada 30 s).
 */
export const TOKEN_REFRESH_MIN_MS = 30_000;

/** Timers del host leídos EN CADA LLAMADA (no al cargar el módulo): así `vi.useFakeTimers` los reemplaza. */
export const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Coalescer = {
  push(msgs: ReadonlyArray<RealtimeAgendaMessage>): void;
  /** Descarga ya lo pendiente (p. ej. antes de un resync manual). */
  flush(): void;
  /** Descarta lo pendiente sin entregarlo (unmount). */
  cancel(): void;
};

/**
 * Junta los mensajes que llegan dentro de una ventana FIJA que arranca con el
 * primero y los entrega en un solo lote, en orden de llegada.
 *
 * Ventana fija y no debounce: con un goteo cada 100 ms un debounce no descargaría
 * nunca y la agenda quedaría congelada justo cuando más cambia. No deduplica: el
 * consumer decide por `day`/`practitionerId` y re-pide una vez por lote.
 */
export function createCoalescer(
  windowMs: number = COALESCE_WINDOW_MS,
  onFlush: (batch: RealtimeAgendaMessage[]) => void,
  timers: Timers = defaultTimers
): Coalescer {
  let buffer: RealtimeAgendaMessage[] = [];
  let handle: unknown = null;

  const flush = () => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      onFlush(batch);
    } catch (err) {
      devWarn("realtime.coalescer_consumer_threw", err);
    }
  };

  return {
    push(msgs) {
      if (msgs.length === 0) return;
      buffer.push(...msgs);
      if (handle === null) {
        handle = timers.setTimeout(() => {
          handle = null;
          flush();
        }, windowMs);
      }
    },
    flush,
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
      buffer = [];
    },
  };
}

/**
 * Espera antes del reintento `attempt` (0 = primer reintento):
 * `min(30 s, 1 s · 2^attempt)` × jitter en (0.5, 1]. El jitter evita que todas las
 * pestañas de un consultorio reconecten en el mismo milisegundo cuando Supabase
 * vuelve. `random` inyectable: `() => 0` da factor 1 (tests).
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // 2^15 ya pasa el tope; cortar el exponente evita Infinity con intentos enormes.
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 15));
  let r = 0;
  try {
    r = random();
  } catch {
    r = 0;
  }
  if (!Number.isFinite(r) || r < 0 || r >= 1) r = 0;
  return Math.round(base * (1 - 0.5 * r));
}

/** Cada cuánto re-pedir sin canal. `null` = no hay polling (canal vivo, o realtime apagado = SR). */
export function nextPollDelay(state: ConnectionState): number | null {
  return state === "live" || state === "off" ? null : POLL_INTERVAL_MS;
}

/**
 * ¿Este evento obliga a re-pedir todo? Sí cuando se pudieron perder mensajes: el
 * canal se cayó y volvió, la pestaña estuvo oculta (timers y socket congelados),
 * volvió la red, o lo pidió el usuario. La primera conexión no: la página recién
 * llegó del server con datos frescos.
 */
export function shouldResync(reason: ResyncReason): boolean {
  return reason !== "connect";
}

/** Momento (ms epoch) en que hay que renovar el token: 80 % de lo que le queda, con piso de 30 s. */
export function nextTokenRefreshAt(expiresAt: string | Date, now: number | Date): number {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const expMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  if (!Number.isFinite(expMs)) return nowMs + TOKEN_REFRESH_MIN_MS;
  const delay = Math.floor((expMs - nowMs) * TOKEN_REFRESH_RATIO);
  return nowMs + Math.max(TOKEN_REFRESH_MIN_MS, delay);
}

/** Payload crudo del canal → mensaje validado o `null`. Nunca tira (el canal no es confiable). */
export function parseIncoming(payload: unknown): RealtimeAgendaMessage | null {
  // PF1.0-a (C-PF3): guard TS puro con la semántica del schema zod (sin zod en el bundle del shell). Nunca tira:
  // un getter hostil cuenta como inválido.
  return parseRealtimeAgendaMessage(payload);
}

/**
 * Lote crudo (el SSE local manda un array JSON por evento) → mensajes válidos.
 * Acepta string JSON, array u objeto suelto; descarta los inválidos uno por uno.
 */
export function parseIncomingBatch(raw: unknown): RealtimeAgendaMessage[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const items = Array.isArray(value) ? value : [value];
  const out: RealtimeAgendaMessage[] = [];
  for (const item of items) {
    const m = parseIncoming(item);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Estado para el usuario. Precedencia:
 * 1. `off` (realtime apagado o driver cerrado) → `off`.
 * 2. Navegador sin red (`navigator.onLine === false`) → `polling`: el socket está
 *    muerto aunque el driver todavía no se haya enterado.
 * 3. Driver `live` → `live` (un canal suscripto manda sobre un contador viejo).
 * 4. ≥ 2 fallos seguidos → `polling` (arranca el respaldo de 60 s).
 * 5. Si no (1 fallo, o arrancando) → `reconnecting`: el indicador no puede decir
 *    «Sin conexión en vivo» durante el primer segundo de carga.
 * `online` indefinido (SSR, sin `navigator`) cuenta como online.
 */
export function deriveConnectionState(
  driverStatus: DriverStatus,
  consecutiveFailures: number,
  online: boolean | undefined
): ConnectionState {
  if (driverStatus === "off") return "off";
  if (online === false) return "polling";
  if (driverStatus === "live") return "live";
  if (consecutiveFailures >= 2) return "polling";
  return "reconnecting";
}

/**
 * `console.warn` solo fuera de producción. Nunca recibe el token: los drivers
 * pasan un código fijo y, a lo sumo, el `message` de un error del transporte.
 */
export function devWarn(code: string, err?: unknown): void {
  if (process.env.NODE_ENV === "production") return;
  const detail = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  // eslint-disable-next-line no-console
  console.warn(`[realtime] ${code}`, detail ?? "");
}

/**
 * Listeners y estado compartidos por los dos drivers. Cada callback corre en su
 * try: un consumer que tira no corta la entrega a los demás ni rompe el driver.
 * `reconnecting` se emite siempre (uno por fallo, ver `StatusInfo`); el resto,
 * solo cuando cambia.
 */
export function createDriverEvents() {
  const messageListeners = new Set<(msgs: RealtimeAgendaMessage[]) => void>();
  const statusListeners = new Set<(s: DriverStatus, info?: StatusInfo) => void>();
  let status: DriverStatus = "idle";

  return {
    get status(): DriverStatus {
      return status;
    },
    onMessage(cb: (msgs: RealtimeAgendaMessage[]) => void): () => void {
      messageListeners.add(cb);
      return () => {
        messageListeners.delete(cb);
      };
    },
    onStatus(cb: (s: DriverStatus, info?: StatusInfo) => void): () => void {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    emitMessages(msgs: RealtimeAgendaMessage[]): void {
      if (msgs.length === 0) return;
      for (const cb of Array.from(messageListeners)) {
        try {
          cb(msgs);
        } catch (err) {
          devWarn("realtime.message_listener_threw", err);
        }
      }
    },
    setStatus(next: DriverStatus, info: StatusInfo): void {
      if (next === status && next !== "reconnecting") return;
      status = next;
      for (const cb of Array.from(statusListeners)) {
        try {
          cb(next, info);
        } catch (err) {
          devWarn("realtime.status_listener_threw", err);
        }
      }
    },
  };
}
