/**
 * YouTube para las pantallas de Sala de espera (T7 · TV-1a, contrato C-TV «YouTube», plan §26.4).
 *
 * Puro y apto para cliente: lo usan el drawer «Pantallas» (lectura en vivo del link mientras se tipea), el server al
 * guardar (`DisplayUpsertSchema` recibe el `mediaUrl` crudo y lo pasa por acá) y la TV al armar el iframe.
 *
 * Por qué la base guarda `mediaKind` + `mediaRef` y NUNCA la URL que pegó el staff: la URL cruda es texto libre que
 * terminaría en el `src` de un iframe en una pantalla pública. Guardando solo el id canónico, el iframe lo arma
 * siempre `youtubeEmbedUrl` sobre `youtube-nocookie.com`, y el CHECK `ReceptionDisplay_media_check` de M17 frena en la
 * base cualquier ref que no tenga la forma de un id. `MEDIA_REF_RE` son EXACTAMENTE esas regex (test de paridad en
 * tests/unit/youtube.test.ts, que lee el SQL real): si el parser aceptara algo que el CHECK no, el alta reventaría
 * con un 500 en vez de mostrar el error con copy.
 *
 * `@handle/live` no se resuelve: pasar de handle a `UC…` exige la Data API (clave + red desde el server) y un vivo
 * por handle cambia de id en cada transmisión. Se le pide al staff el link del vivo o el del canal.
 */

export type YouTubeMediaKind = "VIDEO" | "LIVE" | "PLAYLIST" | "CHANNEL_LIVE";
export type YouTubeMedia = { kind: YouTubeMediaKind; ref: string };
export type ParseYouTubeResult = { ok: true; media: YouTubeMedia } | { ok: false; error: string };

/** Iguales al CHECK `ReceptionDisplay_media_check` de M17 (sin flags: el `~` de Postgres distingue mayúsculas). */
export const MEDIA_REF_RE: Record<YouTubeMediaKind, RegExp> = {
  VIDEO: /^[A-Za-z0-9_-]{11}$/,
  LIVE: /^[A-Za-z0-9_-]{11}$/,
  PLAYLIST: /^(PL|UU|OL|FL)[A-Za-z0-9_-]{10,62}$/,
  CHANNEL_LIVE: /^UC[A-Za-z0-9_-]{22}$/,
};

/** Tope de entrada: una URL real de YouTube no llega ni a 300; más que esto es basura o un intento de abuso. */
const MAX_INPUT = 2048;

const ERR_EMPTY = "Pegá un link de YouTube.";
const ERR_NOT_YT = "Ese link no es de YouTube. Pegá un link de youtube.com o youtu.be.";
const ERR_UNKNOWN =
  "No reconocemos ese link de YouTube. Pegá el link de un video, una lista, un vivo o un canal.";
const ERR_HANDLE =
  "Pegá el link del video en vivo (youtube.com/live/…) o del canal (youtube.com/channel/UC…)";

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const NOCOOKIE_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

const fail = (error: string): ParseYouTubeResult => ({ ok: false, error });
const ok = (kind: YouTubeMediaKind, ref: string): ParseYouTubeResult =>
  MEDIA_REF_RE[kind].test(ref) ? { ok: true, media: { kind, ref } } : fail(ERR_UNKNOWN);

/**
 * Un `?list=` acompañando a un video gana si es una lista guardable: quien pega el link «viendo la lista» quiere la
 * lista en la TV. Los mixes automáticos (`RD…`) no cumplen el CHECK y se quedan con el video.
 */
function videoOrList(id: string | null | undefined, list: string | null): ParseYouTubeResult {
  if (list && MEDIA_REF_RE.PLAYLIST.test(list)) return ok("PLAYLIST", list);
  if (!id) return fail(ERR_UNKNOWN);
  return ok("VIDEO", id);
}

export function parseYouTubeUrl(input: string): ParseYouTubeResult {
  if (typeof input !== "string") return fail(ERR_EMPTY);
  if (input.length > MAX_INPUT) return fail(ERR_UNKNOWN);
  const raw = input.trim();
  if (!raw) return fail(ERR_EMPTY);

  // Sin esquema («youtu.be/…», «www.youtube.com/…») se asume https. Cualquier otro esquema (javascript:, data:,
  // ftp:…) se rechaza ANTES de parsear: `new URL("javascript:…")` es válido y no hay que darle chance.
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return fail(ERR_NOT_YT);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return fail(ERR_NOT_YT);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail(ERR_NOT_YT);
  // `https://www.youtube.com@evil.com` deja `youtube.com` como usuario: el host real es evil.com y cae abajo, pero
  // las credenciales y los puertos no tienen uso legítimo en un link de YouTube y se cortan explícitamente.
  if (url.username || url.password || url.port) return fail(ERR_NOT_YT);

  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter(Boolean);
  const q = url.searchParams;

  if (SHORT_HOSTS.has(host)) {
    if (segs.length !== 1) return fail(ERR_UNKNOWN);
    return videoOrList(segs[0], q.get("list"));
  }

  const isNoCookie = NOCOOKIE_HOSTS.has(host);
  if (!YT_HOSTS.has(host) && !isNoCookie) return fail(ERR_NOT_YT);

  const [first, second, third] = segs;
  const head = (first ?? "").toLowerCase();

  if (head === "embed") {
    if (segs.length !== 2) return fail(ERR_UNKNOWN);
    if (second === "videoseries") return ok("PLAYLIST", q.get("list") ?? "");
    if (second === "live_stream") return ok("CHANNEL_LIVE", q.get("channel") ?? "");
    return videoOrList(second, q.get("list"));
  }
  // nocookie solo sirve embeds: cualquier otra ruta ahí no es un link que alguien copie de YouTube.
  if (isNoCookie) return fail(ERR_UNKNOWN);

  if (first?.startsWith("@") || head === "c" || head === "user") return fail(ERR_HANDLE);

  switch (head) {
    case "watch":
      if (segs.length !== 1) return fail(ERR_UNKNOWN);
      return videoOrList(q.get("v"), q.get("list"));
    case "playlist":
      if (segs.length !== 1) return fail(ERR_UNKNOWN);
      return ok("PLAYLIST", q.get("list") ?? "");
    case "shorts":
    case "v":
      if (segs.length !== 2) return fail(ERR_UNKNOWN);
      return ok("VIDEO", second);
    case "live":
      if (segs.length !== 2) return fail(ERR_UNKNOWN);
      return ok("LIVE", second);
    case "live_stream":
      if (segs.length !== 1) return fail(ERR_UNKNOWN);
      return ok("CHANNEL_LIVE", q.get("channel") ?? "");
    case "channel": {
      // /channel/UC…, /channel/UC…/live y /channel/UC…/streams: en la TV es siempre «el vivo del canal».
      if (segs.length === 2 || (segs.length === 3 && (third === "live" || third === "streams"))) {
        return ok("CHANNEL_LIVE", second);
      }
      return fail(ERR_UNKNOWN);
    }
    default:
      return fail(ERR_UNKNOWN);
  }
}

/**
 * URL del iframe. Siempre `youtube-nocookie.com` (sin cookies de seguimiento hasta que el video se reproduce; la CSP
 * de `/tv` solo permite ese origen en `frame-src`).
 *  - `mute=1` siempre: los navegadores bloquean el autoplay con sonido; el sonido se activa por la JS API
 *    (`enablejsapi=1`) después del toque «Tocá OK para activar el sonido» del kiosco.
 *  - `origin=` es obligatorio con `enablejsapi`: el reproductor solo le manda `postMessage` a ese origen.
 *  - VIDEO repite con `loop=1&playlist=<id>` (YouTube ignora `loop` en un video suelto sin `playlist`).
 *  - LIVE no lleva loop (un vivo que termina muestra el aviso de YouTube; el reintento es de `youtube-pip`).
 * Devuelve `null` si la ref no cumple `MEDIA_REF_RE` (no debería pasar: el CHECK de M17 lo impide) o si el origin no es
 * http(s): la TV oculta el recuadro en vez de embeber algo armado con basura.
 */
export function youtubeEmbedUrl(media: YouTubeMedia, opts: { origin: string }): string | null {
  const re = MEDIA_REF_RE[media?.kind];
  if (!re || typeof media.ref !== "string" || !re.test(media.ref)) return null;
  let origin: string;
  try {
    const o = new URL(opts.origin);
    if (o.protocol !== "https:" && o.protocol !== "http:") return null;
    origin = o.origin;
  } catch {
    return null;
  }

  const params = new URLSearchParams();
  let path: string;
  if (media.kind === "PLAYLIST") {
    path = "videoseries";
    params.set("list", media.ref);
  } else if (media.kind === "CHANNEL_LIVE") {
    path = "live_stream";
    params.set("channel", media.ref);
  } else {
    path = media.ref;
  }
  params.set("autoplay", "1");
  params.set("mute", "1");
  params.set("playsinline", "1");
  params.set("controls", "0");
  params.set("rel", "0");
  params.set("enablejsapi", "1");
  params.set("origin", origin);
  if (media.kind === "VIDEO") {
    params.set("loop", "1");
    params.set("playlist", media.ref);
  }
  return `https://www.youtube-nocookie.com/embed/${path}?${params.toString()}`;
}

/** Etiqueta para el drawer (chip debajo del campo del link). */
export function mediaKindLabel(kind: YouTubeMediaKind | "NONE"): string {
  switch (kind) {
    case "VIDEO":
      return "Video · se repite";
    case "LIVE":
      return "En vivo";
    case "PLAYLIST":
      return "Lista";
    case "CHANNEL_LIVE":
      return "En vivo del canal";
    default:
      return "Sin video";
  }
}
