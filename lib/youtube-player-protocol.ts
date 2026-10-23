/**
 * Protocolo `postMessage` del reproductor embebido de YouTube (T7 · TV-2p, contrato C-TV «YouTube», plan §26.4).
 *
 * Puro y apto para cliente. Por qué no se carga `https://www.youtube.com/iframe_api`: es un script de terceros que
 * habría que sumar a `script-src` de la CSP enforced de `/tv` (TV-1c solo abre `frame-src` a nocookie) y que pesa en
 * el grupo de bundle `display` (125 kB). El iframe con `enablejsapi=1` habla el mismo protocolo «widget» por
 * `postMessage` con JSON; acá están solo las piezas que la TV necesita.
 *
 * Seguridad: la TV es una pantalla pública. `parsePlayerMessage` acepta SOLO el origen exacto de nocookie (ni
 * `www.youtube.com`, ni otro esquema/puerto, ni un sufijo parecido): cualquier otra ventana que le mande un
 * `onError` no puede ocultar ni recargar el video. El componente además compara `event.source` con su iframe.
 */

export const YT_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * Errores con los que el reproductor no se recupera solo: 2 parámetro inválido, 5 error HTML5, 100 video borrado o
 * privado, 101/150 el dueño no permite embeber, 153 falta el Referer (pasa si la página manda `no-referrer`: por eso
 * `/tv` NO lleva `referrer: same-origin` y el iframe va con `strict-origin-when-cross-origin`).
 */
export const YT_FATAL = [2, 5, 100, 101, 150, 153] as const;

/** Estados de `onStateChange` / `infoDelivery.playerState` que usa la TV. */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

/** Solo los comandos que usa el pip: una lista cerrada para que nadie le mande cualquier `func` al iframe. */
export type YtCommandFunc = "playVideo" | "pauseVideo" | "mute" | "unMute" | "setVolume" | "playVideoAt";
type YtArg = number | string | boolean;

export type YtPlayerMessage =
  | { event: "onReady" }
  | { event: "onStateChange"; state: number }
  | { event: "onError"; code: number; fatal: boolean }
  | { event: "infoDelivery"; info: { playerState?: number; volume?: number; muted?: boolean } };

/** `{"event":"command","func":…,"args":[…]}`: lo que `postMessage` le manda al iframe. */
export function ytCommand(func: YtCommandFunc, args: YtArg[] = []): string {
  return JSON.stringify({ event: "command", func, args });
}

/**
 * Handshake: hasta que el padre no manda `listening`, el reproductor no emite eventos (ni `onReady`). Es lo mismo
 * que hace `iframe_api` por dentro; se repite hasta el `onReady` porque el primero puede llegar antes de que el
 * reproductor esté escuchando.
 */
export function ytListening(id: string): string {
  return JSON.stringify({ event: "listening", id, channel: "widget" });
}

/** Un `infoDelivery` real pesa unos pocos kB; más que esto no es del reproductor y no se parsea. */
const MAX_MESSAGE = 64_000;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function parsePlayerMessage(origin: unknown, data: unknown): YtPlayerMessage | null {
  if (origin !== YT_ORIGIN) return null;
  let obj: unknown = data;
  if (typeof data === "string") {
    if (data.length > MAX_MESSAGE) return null;
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const { event, info } = obj as { event?: unknown; info?: unknown };

  switch (event) {
    case "onReady":
      return { event: "onReady" };
    case "onStateChange":
      return isInt(info) ? { event: "onStateChange", state: info } : null;
    case "onError":
      return isInt(info)
        ? { event: "onError", code: info, fatal: (YT_FATAL as readonly number[]).includes(info) }
        : null;
    case "infoDelivery":
    case "initialDelivery": {
      if (!info || typeof info !== "object" || Array.isArray(info)) return null;
      // Solo los campos que usa la TV, tipados; el resto (títulos, URLs, listas) no sale de acá.
      const src = info as Record<string, unknown>;
      const out: { playerState?: number; volume?: number; muted?: boolean } = {};
      if (isInt(src.playerState)) out.playerState = src.playerState;
      if (typeof src.volume === "number" && Number.isFinite(src.volume)) out.volume = src.volume;
      if (typeof src.muted === "boolean") out.muted = src.muted;
      return { event: "infoDelivery", info: out };
    }
    default:
      return null;
  }
}
