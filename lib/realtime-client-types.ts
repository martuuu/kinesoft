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

/**
 * Por qué se le avisa al driver que pruebe ya (eventos del browser o el usuario).
 * HF-1b: `reconnect` es el botón «Reconectar» del detalle del indicador. Es el único que reintenta YA con el canal
 * estacionado por un rechazo permanente (ver `RealtimeDiag.permanent`); `manual` es el «Actualizar» de la agenda, que
 * re-pide datos y no tiene por qué gastar un mint por clic.
 */
export type NudgeReason = "visible" | "online" | "manual" | "reconnect";

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
export type StatusInfo = {
  failures: number;
  reconnected: boolean;
  /** HF-1b: por qué falló el último intento (solo en `reconnecting`). Aditivo: los drivers viejos no lo mandan. */
  diag?: RealtimeDiag;
};

/**
 * HF-1b (H-RT1): en qué paso se cortó la conexión. En orden: el bootstrap del layout trae driver y URL, se baja el
 * chunk del driver (`import`), se pide el token (`mint`), se abre el socket y se une el canal privado (`join`). El
 * detalle del indicador los pinta ✓/✗ en este orden.
 */
export type RealtimeDiagStep = "bootstrap" | "import" | "mint" | "socket" | "join";

/**
 * Código estable del fallo (va al beacon y al copy del indicador; el `reason` es el texto técnico).
 * - `auth`: el server de Realtime rechazó el JWT o el canal (CHANNEL_ERROR con «Unauthorized»/«JWT»…).
 * - `no_access` · `session` · `rate_limited` · `off` · `unconfigured` · `server_error`: respuestas `{ok:false}` del
 *   mint (sin el módulo o el permiso, sesión vencida, rate limit, driver apagado en el server, sin secreto, error).
 * - `stale_build`: deploy nuevo con la pestaña (o la PWA) vieja: el chunk ya no existe o la action del token cambió de
 *   id. No se arregla reintentando: «Hay una versión nueva · Recargá».
 * - `network` · `timeout` · `closed` · `channel_error`: transitorios del transporte.
 * - `no_transport`: el bootstrap pidió un driver pero falta la URL o la clave (config del deploy).
 */
export type RealtimeDiagCode =
  | "auth"
  | "no_access"
  | "session"
  | "rate_limited"
  | "off"
  | "unconfigured"
  | "server_error"
  | "stale_build"
  | "network"
  | "timeout"
  | "closed"
  | "channel_error"
  | "no_transport";

export type RealtimeDiag = {
  step: RealtimeDiagStep;
  code: RealtimeDiagCode;
  /** Texto técnico recortado a 160 caracteres y sin nada con forma de JWT (`clipDiagReason`). */
  reason: string;
  /**
   * Reintentar en seguida no lo arregla (rechazo de auth, mint `{ok:false}`, versión vieja). Después de
   * `PERMANENT_FAILURES_TO_PARK` seguidos el driver se estaciona: reintenta cada 5 min, o ante `visible`/`online` si ya
   * pasaron 5 min, o ya con «Reconectar».
   */
  permanent: boolean;
  /** ms epoch del fallo. */
  at: number;
};

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

/**
 * Token del canal tal como lo devuelve `mintRealtimeToken()` (`data`); `null` = no hay (red: transitorio).
 * HF-1b: un `{ code, reason }` es el motivo del `{ok:false}` (o de la action que ya no existe) ya clasificado; antes
 * se perdía y el driver re-minteaba en bucle hasta agotar el rate limit.
 */
export type RealtimeTokenFailure = { code: RealtimeDiagCode; reason: string };
export type RealtimeTokenGetter = () => Promise<{ token: string; expiresAt: string } | RealtimeTokenFailure | null>;

/** Dependencias comunes de los drivers (todas opcionales; default = las del browser). */
export type DriverDeps = {
  timers?: Timers;
  /** Reloj en ms epoch (refresh del token). Default `Date.now()`. */
  now?: () => number;
  /** Fuente del jitter del backoff. Default `Math.random`; `() => 0` = sin jitter. */
  random?: () => number;
};
