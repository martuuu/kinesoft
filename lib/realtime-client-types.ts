/**
 * Tipos del cliente realtime de la agenda (SV07a, C-SV7 — FIRMA CONGELADA).
 *
 * Puro y client-safe. A propósito NO importa tipos de `@supabase/realtime-js`
 * (ni siquiera `import type`): el guard (e) de §18.9 exige que ese paquete entre
 * solo por `import()` dinámico dentro de `lib/realtime-client-supabase.ts`, y el
 * contrato del driver no tiene por qué saber qué transporte hay abajo (el local es
 * un EventSource). Las formas mínimas del SDK que usa el driver viven en ese
 * archivo, con un chequeo de tipos contra el SDK real.
 */
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

/**
 * Estado del transporte, visto desde el driver.
 * - `idle`: creado, todavía sin `connect()`.
 * - `connecting`: primer intento en curso.
 * - `live`: suscripto; los mensajes llegan.
 * - `reconnecting`: se cayó o no pudo conectar; hay un reintento programado.
 * - `off`: cerrado con `close()` o el entorno no tiene el transporte.
 */
export type DriverStatus = "idle" | "connecting" | "live" | "reconnecting" | "off";

/**
 * Estado que ve el usuario (lo deriva `deriveConnectionState`): el indicador
 * muestra «En vivo» · «Reconectando…» · «Sin conexión en vivo · se actualiza cada
 * 60 s» · nada (`off`). `polling` = el provider re-pide cada 60 s.
 */
export type ConnectionState = "live" | "reconnecting" | "polling" | "off";

/** Por qué se le avisa al driver que pruebe ya (eventos del browser o el usuario). */
export type NudgeReason = "visible" | "online" | "manual";

/** Qué dispara (o no) un re-pedido completo de la página. Ver `shouldResync`. */
export type ResyncReason = "connect" | "reconnect" | "visible" | "online" | "manual";

/**
 * Segundo argumento de `onStatus` (aditivo al contrato: un callback de un solo
 * parámetro sigue siendo válido).
 * - `failures`: fallos SEGUIDOS desde el último `live` (0 en `live`). El provider
 *   lo pasa a `deriveConnectionState` para decidir `reconnecting` vs `polling`.
 * - `reconnected`: `true` solo en el `live` que sigue a una caída (o a un primer
 *   intento fallido). Es la señal de resync: mientras el canal no estuvo, se
 *   pudieron perder mensajes, así que el provider re-pide todo.
 *
 * `reconnecting` se emite UNA VEZ POR FALLO (no se deduplica) para que el consumer
 * vea crecer `failures`; los demás estados se emiten solo cuando cambian.
 */
export type StatusInfo = { failures: number; reconnected: boolean };

/**
 * Transporte de mensajes del canal de la agenda. Solo ESCUCHA: no hay `send` ni
 * nada que publique (la policy de M5 no tiene INSERT y el cliente no tiene por
 * qué intentarlo; el publish es del server, después del commit).
 *
 * Garantías de ambos drivers:
 * - Nunca tiran ni rechazan: `connect()` resuelve siempre; los errores pasan a
 *   `reconnecting` con backoff.
 * - `onMessage` entrega mensajes ya validados con `RealtimeAgendaMessageSchema`
 *   (lo inválido se descarta). NO coalescen: eso lo hace el provider con
 *   `createCoalescer`, que es quien le entrega lotes a `useRealtime().subscribe`.
 * - Un listener que tira no rompe al driver ni a los demás listeners.
 * - `close()` limpia timers, canal y socket; después de `close()` el driver no
 *   reconecta ni entrega nada (es de un solo uso: el provider crea otro).
 */
export interface RealtimeDriver {
  connect(): Promise<void>;
  close(): void;
  onMessage(cb: (msgs: RealtimeAgendaMessage[]) => void): () => void;
  onStatus(cb: (s: DriverStatus, info?: StatusInfo) => void): () => void;
  nudge(reason: NudgeReason): void;
}

/** Timers inyectables (los tests usan `vi.useFakeTimers` o un registro a mano). */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Token del canal tal como lo devuelve `mintRealtimeToken()` (`data`); `null` = no hay. */
export type RealtimeTokenGetter = () => Promise<{ token: string; expiresAt: string } | null>;

/** Dependencias comunes de los drivers (todas opcionales; default = las del browser). */
export type DriverDeps = {
  timers?: Timers;
  /** Reloj en ms epoch (refresh del token). Default `Date.now()`. */
  now?: () => number;
  /** Fuente del jitter del backoff. Default `Math.random`; `() => 0` = sin jitter. */
  random?: () => number;
};
