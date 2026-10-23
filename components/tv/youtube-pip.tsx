"use client";

/**
 * Recuadro de YouTube de la TV de Sala de espera (T7 · TV-2p, plan §26.4 «YouTube» y UI «youtube-pip»).
 *
 * - El iframe es siempre `youtube-nocookie.com` y la URL la arma `youtubeEmbedUrl` (la base guarda solo el id). Si
 *   devuelve `null` (sin video o una ref inválida) no se renderiza nada: la TV queda en el layout sin video.
 * - Control por `postMessage` (lib/youtube-player-protocol.ts) sin cargar `iframe_api`: la CSP enforced de `/tv` no
 *   abre `script-src` a YouTube y el grupo de bundle `display` tiene 125 kB. Sin framer ni librerías.
 * - `referrerPolicy="strict-origin-when-cross-origin"`: sin Referer YouTube responde con el error 153 (TV-1c).
 * - El video arranca siempre con `mute=1` (los navegadores bloquean el autoplay con sonido) y se desmuta por la JS API
 *   solo si `soundUnlocked && !muted` (el toque «Tocá OK para activar el sonido» del kiosco y la config de la pantalla).
 * - Una TV queda prendida días: si el video falla (error fatal) o no está listo a los 20 s, el recuadro se oculta
 *   (`onVisible(false)`, el padre pasa al layout sin video) y se reintenta cada 5 min, o cada 2 si es un vivo, que
 *   suele volver solo cuando el canal retoma la transmisión. En el reintento no se muestra hasta el `onReady`, para que
 *   el layout no parpadee cada 5 minutos con un recuadro negro.
 * - En cada llamado nuevo (`callSeq` cambia): DUCK baja el volumen `DUCK_MS` para que se oiga el chime y la voz,
 *   HIDE oculta (y silencia) el recuadro ese tiempo, KEEP no hace nada. HIDE oculta solo el recuadro (`setHidden`) y
 *   NO emite `onVisible(false)`: el layout de la TV queda quieto (TV-I).
 *
 * Sin jsdom no corren effects en los tests: toda la lógica de tiempos vive en `createYouTubePipEngine`, que es el
 * mismo objeto que crea el componente (tests/unit/render/youtube-pip.test.tsx).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DUCK_MS, type DisplayMediaDuringCall, type DisplayMediaKind } from "@/lib/reception-displays-types";
import { youtubeEmbedUrl, type YouTubeMediaKind } from "@/lib/youtube";
import {
  YT_ORIGIN,
  YT_STATE,
  parsePlayerMessage,
  ytCommand,
  ytListening,
  type YtPlayerMessage,
} from "@/lib/youtube-player-protocol";

export const PIP_READY_TIMEOUT_MS = 20_000;
export const PIP_RETRY_MS = 300_000;
export const PIP_RETRY_LIVE_MS = 120_000;
/** Cada cuánto se repite `listening` hasta el `onReady`. */
export const PIP_LISTEN_EVERY_MS = 1_000;
export const PIP_BASE_VOLUME = 100;
/** Volumen durante el DUCK: se sigue oyendo de fondo, pero no tapa el chime. */
export const PIP_DUCK_VOLUME = 20;

const PIP_ID = "kine-tv-pip";

type Timer = ReturnType<typeof setTimeout> | null;

export type PipEngineOpts = {
  kind: YouTubeMediaKind;
  /** Manda un mensaje (ya serializado) al iframe. */
  post: (msg: string) => void;
  /** Remonta el iframe (reintento). */
  reload: () => void;
  /**
   * Disponibilidad del video (falló, no cargó, reintento): decide el layout del padre. Solo se llama cuando cambia;
   * arranca visible.
   */
  setVisible: (v: boolean) => void;
  /**
   * HIDE durante un llamado: oculta SOLO el recuadro, sin tocar el layout. TV-I (handoff de TV-2u2): antes HIDE pasaba
   * por `setVisible(false)` y la TV saltaba a HERO_IDLE/sin video 12 s y volvía, un salto de layout por cada llamado.
   */
  setHidden?: (h: boolean) => void;
};

export type PipEngine = {
  /** Arranca un intento: arma el timeout de 20 s del `onReady`. */
  begin: () => void;
  /** El iframe disparó `load`: empieza el handshake `listening`. */
  loaded: () => void;
  handle: (msg: YtPlayerMessage) => void;
  /** Mensaje crudo de `window` (`event.origin`, `event.data`): los de otro origen se ignoran. */
  handleRaw: (origin: unknown, data: unknown) => void;
  setAudio: (a: { muted: boolean; soundUnlocked: boolean }) => void;
  call: (mode: DisplayMediaDuringCall) => void;
  dispose: () => void;
};

export function createYouTubePipEngine(o: PipEngineOpts): PipEngine {
  const live = o.kind === "LIVE" || o.kind === "CHANNEL_LIVE";
  let ready = false;
  let failed = false;
  let attempt = 0;
  let audible = false;
  let ducked = false;
  let hiddenForCall = false;
  let disposed = false;
  let shown = true;
  let readyTimer: Timer = null;
  let listenTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: Timer = null;
  let callTimer: Timer = null;

  const clear = (t: Timer) => t && clearTimeout(t);
  const stopListening = () => {
    if (listenTimer) clearInterval(listenTimer);
    listenTimer = null;
  };

  function emit() {
    // En el primer intento se muestra mientras carga (es lo esperable al prender la TV); en un reintento, no.
    // `hiddenForCall` NO entra: es local al recuadro (`setHidden`), no cambia el layout.
    const v = !failed && (ready || attempt === 0);
    if (v !== shown) {
      shown = v;
      o.setVisible(v);
    }
  }

  function applyAudio() {
    if (!ready) return;
    if (audible && !hiddenForCall) {
      o.post(ytCommand("unMute"));
      o.post(ytCommand("setVolume", [ducked ? PIP_DUCK_VOLUME : PIP_BASE_VOLUME]));
    } else {
      o.post(ytCommand("mute"));
    }
  }

  function fail() {
    if (disposed) return;
    ready = false;
    failed = true;
    clear(readyTimer);
    readyTimer = null;
    stopListening();
    clear(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt += 1;
      failed = false;
      o.reload();
      begin();
    }, live ? PIP_RETRY_LIVE_MS : PIP_RETRY_MS);
    emit();
  }

  function begin() {
    if (disposed) return;
    ready = false;
    clear(readyTimer);
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!ready) fail();
    }, PIP_READY_TIMEOUT_MS);
  }

  function loaded() {
    if (disposed || ready) return;
    stopListening();
    o.post(ytListening(PIP_ID));
    listenTimer = setInterval(() => {
      if (ready || disposed) return stopListening();
      o.post(ytListening(PIP_ID));
    }, PIP_LISTEN_EVERY_MS);
  }

  function handle(msg: YtPlayerMessage) {
    if (disposed || failed) return;
    if (msg.event === "onReady") {
      if (ready) return;
      ready = true;
      clear(readyTimer);
      readyTimer = null;
      stopListening();
      applyAudio();
      o.post(ytCommand("playVideo"));
      emit();
      return;
    }
    if (msg.event === "onError") {
      if (msg.fatal) fail();
      return;
    }
    const state = msg.event === "onStateChange" ? msg.state : msg.info.playerState;
    if (state === YT_STATE.ENDED && ready) {
      // Un vivo que terminó muestra el cartel de YouTube: se oculta y se reintenta (vuelve cuando retoma). Una lista
      // sin `loop` termina: se vuelve al primero. El VIDEO repite solo (`loop=1&playlist=<id>`).
      if (live) fail();
      else if (o.kind === "PLAYLIST") o.post(ytCommand("playVideoAt", [0]));
    }
  }

  function call(mode: DisplayMediaDuringCall) {
    if (disposed || mode === "KEEP") return;
    clear(callTimer);
    if (mode === "DUCK") {
      ducked = true;
      if (audible && !hiddenForCall) applyAudio();
    } else {
      if (!hiddenForCall) o.setHidden?.(true);
      hiddenForCall = true;
      applyAudio();
    }
    // Un llamado encima de otro extiende desde el último: el agache dura DUCK_MS desde el llamado más reciente.
    callTimer = setTimeout(() => {
      callTimer = null;
      const wasAudible = audible && !hiddenForCall;
      const wasHidden = hiddenForCall;
      ducked = false;
      hiddenForCall = false;
      if (wasHidden) o.setHidden?.(false);
      if (wasHidden || wasAudible) applyAudio();
    }, DUCK_MS);
  }

  return {
    begin,
    loaded,
    handle,
    handleRaw: (origin, data) => {
      const msg = parsePlayerMessage(origin, data);
      if (msg) handle(msg);
    },
    setAudio: ({ muted, soundUnlocked }) => {
      audible = soundUnlocked && !muted;
      applyAudio();
    },
    call,
    dispose: () => {
      disposed = true;
      clear(readyTimer);
      clear(retryTimer);
      clear(callTimer);
      stopListening();
    },
  };
}

// ── Componente ──────────────────────────────────────────────────────────────

export type YouTubePipProps = {
  /** `null`, `NONE` o ref vacía → no se renderiza nada. */
  media: { kind: DisplayMediaKind | YouTubeMediaKind; ref: string | null } | null;
  muted: boolean;
  soundUnlocked: boolean;
  /** Sube con cada llamado nuevo. El valor inicial no dispara nada (no se agacha por un llamado viejo). */
  callSeq: number;
  duringCall: DisplayMediaDuringCall;
  onVisible?: (v: boolean) => void;
  /**
   * Origin de la página para `youtubeEmbedUrl` (`origin=` del iframe). Por defecto el del navegador; en el server no
   * hay y no se renderiza el iframe (se arma tras hidratar). Lo pasan los tests y una vista previa que lo conozca.
   */
  origin?: string;
  className?: string;
};

const noopSubscribe = () => () => {};

export function YouTubePip({
  media,
  muted,
  soundUnlocked,
  callSeq,
  duringCall,
  onVisible,
  origin,
  className,
}: YouTubePipProps) {
  const browserOrigin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => null,
  );
  const pageOrigin = origin ?? browserOrigin;
  const kind = media && media.kind !== "NONE" ? (media.kind as YouTubeMediaKind) : null;
  const src =
    kind && media?.ref && pageOrigin ? youtubeEmbedUrl({ kind, ref: media.ref }, { origin: pageOrigin }) : null;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const engineRef = useRef<PipEngine | null>(null);
  const [visible, setVisible] = useState(true);
  const [hiddenForCall, setHiddenForCall] = useState(false);
  const [attemptKey, setAttemptKey] = useState(0);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const audioRef = useRef({ muted, soundUnlocked });
  audioRef.current = { muted, soundUnlocked };
  const duringCallRef = useRef(duringCall);
  duringCallRef.current = duringCall;

  // Un motor por video: cambiar el link reinicia timers e intentos.
  useEffect(() => {
    if (!src || !kind) return;
    setVisible(true);
    setHiddenForCall(false);
    onVisibleRef.current?.(true);
    const engine = createYouTubePipEngine({
      kind,
      post: (msg) => iframeRef.current?.contentWindow?.postMessage(msg, YT_ORIGIN),
      reload: () => setAttemptKey((k) => k + 1),
      setVisible: (v) => {
        setVisible(v);
        onVisibleRef.current?.(v);
      },
      setHidden: setHiddenForCall,
    });
    engineRef.current = engine;
    engine.setAudio(audioRef.current);
    engine.begin();
    const onMessage = (e: MessageEvent) => {
      // Además del origen exacto (parsePlayerMessage), tiene que venir de NUESTRO iframe.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      engine.handleRaw(e.origin, e.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      engine.dispose();
      engineRef.current = null;
    };
  }, [src, kind]);

  useEffect(() => {
    engineRef.current?.setAudio({ muted, soundUnlocked });
  }, [muted, soundUnlocked]);

  const lastCallSeq = useRef(callSeq);
  useEffect(() => {
    if (callSeq === lastCallSeq.current) return;
    lastCallSeq.current = callSeq;
    engineRef.current?.call(duringCallRef.current);
  }, [callSeq]);

  if (!src) return null;

  // Oculto = opacidad 0 y sin eventos, pero montado: un iframe desmontado no puede avisar su `onReady` en el
  // reintento. El padre decide el layout con `onVisible`; el HIDE de un llamado solo apaga este recuadro.
  const shown = visible && !hiddenForCall;
  return (
    <div
      className={className ?? "relative h-full w-full overflow-hidden rounded-[var(--r-lg)] bg-black"}
      data-visible={shown ? "true" : "false"}
      aria-hidden={shown ? undefined : true}
      style={shown ? undefined : { opacity: 0, pointerEvents: "none" }}
    >
      <iframe
        key={attemptKey}
        ref={iframeRef}
        src={src}
        title="Video de la sala de espera"
        allow="autoplay; fullscreen; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full border-0"
        onLoad={() => engineRef.current?.loaded()}
      />
    </div>
  );
}
