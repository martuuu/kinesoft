/**
 * Driver local del canal de la agenda (SV07a): `EventSource` contra
 * `/api/realtime/local` (SSE servido por el bus en memoria, solo con
 * `REALTIME_DRIVER=local`; `lib/env.ts` lo prohíbe en Production, SV-D11).
 *
 * Existe para desarrollar y hacer QA de la Sala de Espera sin Supabase. Mismo
 * contrato que el driver Supabase (nunca tira, solo escucha, backoff, señal de
 * reconexión) para que el provider no distinga uno de otro.
 *
 * Por qué se cierra y recrea en `onerror` en vez de dejar el reintento nativo del
 * EventSource: el nativo no tiene backoff (reintenta cada ~3 s para siempre) y,
 * ante un 401/404 de la ruta, el navegador lo cierra sin avisar. Con el ciclo
 * propio el provider ve `reconnecting`/`failures` igual que con Supabase y cae a
 * polling con el mismo criterio.
 */
import {
  backoffDelay,
  createDriverEvents,
  defaultTimers,
  devWarn,
  parseIncomingBatch,
} from "@/lib/realtime-client-state";
import type { DriverDeps, RealtimeDriver } from "@/lib/realtime-client-types";

/** Lo único del `EventSource` del browser que el driver usa. */
export type EventSourceLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
};

export type EventSourceCtor = new (url: string) => EventSourceLike;

export type LocalDriverDeps = DriverDeps & {
  /** Fake en tests; en el browser se usa `globalThis.EventSource`. */
  EventSource?: EventSourceCtor;
};

export type LocalDriverOptions = {
  endpoint?: string;
  deps?: LocalDriverDeps;
};

export function createLocalDriver(opts: LocalDriverOptions = {}): RealtimeDriver {
  const endpoint = opts.endpoint ?? "/api/realtime/local";
  const deps = opts.deps;
  const timers = deps?.timers ?? defaultTimers;
  const random = deps?.random ?? Math.random;
  const events = createDriverEvents();

  let started = false;
  let closed = false;
  let gen = 0;
  let failures = 0;
  let dropped = false;
  let source: EventSourceLike | null = null;
  let retryTimer: unknown = null;

  const isStale = (myGen: number) => closed || myGen !== gen;

  function resolveCtor(): EventSourceCtor | undefined {
    return deps?.EventSource ?? (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  }

  function clearRetry() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function closeSource() {
    const s = source;
    source = null;
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onerror = null;
    try {
      s.close();
    } catch (err) {
      devWarn("realtime.local_close_failed", err);
    }
  }

  function fail(myGen: number) {
    if (isStale(myGen)) return;
    gen++;
    failures++;
    dropped = true;
    closeSource();
    events.setStatus("reconnecting", { failures, reconnected: false });
    clearRetry();
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      open();
    }, backoffDelay(failures - 1, random));
  }

  function open() {
    if (closed) return;
    clearRetry();
    const myGen = ++gen;
    const Ctor = resolveCtor();
    if (!Ctor) {
      // Sin EventSource (SSR, entorno raro): no hay transporte; el provider queda en off.
      devWarn("realtime.local_no_eventsource");
      events.setStatus("off", { failures, reconnected: false });
      return;
    }
    let s: EventSourceLike;
    try {
      s = new Ctor(endpoint);
    } catch (err) {
      devWarn("realtime.local_open_failed", err);
      fail(myGen);
      return;
    }
    source = s;
    s.onopen = () => {
      if (isStale(myGen)) return;
      const reconnected = dropped;
      dropped = false;
      failures = 0;
      events.setStatus("live", { failures: 0, reconnected });
    };
    s.onmessage = (ev) => {
      if (isStale(myGen)) return;
      // El server manda un array de mensajes por evento; lo inválido se descarta.
      const msgs = parseIncomingBatch(ev?.data);
      if (msgs.length > 0) events.emitMessages(msgs);
      else devWarn("realtime.invalid_payload");
    };
    s.onerror = () => {
      if (isStale(myGen)) return;
      fail(myGen);
    };
  }

  return {
    async connect() {
      if (started || closed) return;
      started = true;
      events.setStatus("connecting", { failures, reconnected: false });
      open();
    },

    close() {
      if (closed) return;
      closed = true;
      gen++;
      clearRetry();
      closeSource();
      events.setStatus("off", { failures, reconnected: false });
    },

    onMessage: events.onMessage,
    onStatus: events.onStatus,

    nudge() {
      if (closed || !started) return;
      if (retryTimer !== null) {
        clearRetry();
        open();
      }
    },
  };
}
