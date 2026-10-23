/**
 * [TV-2p] Recuadro de YouTube de la TV (plan §26.4, UI «youtube-pip»).
 *
 * Sin jsdom no corren effects: el motor (`createYouTubePipEngine`) es el MISMO objeto que el componente crea en su
 * effect y se testea directo con fake timers y fakes a mano (post al iframe, recarga, visibilidad). El render estático
 * cubre el primer paint: atributos del iframe y que con `media` null o una ref inválida no se renderiza nada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PIP_BASE_VOLUME,
  PIP_DUCK_VOLUME,
  PIP_READY_TIMEOUT_MS,
  PIP_RETRY_LIVE_MS,
  PIP_RETRY_MS,
  YouTubePip,
  createYouTubePipEngine,
} from "@/components/tv/youtube-pip";
import { YT_ORIGIN } from "@/lib/youtube-player-protocol";
import { DUCK_MS } from "@/lib/reception-displays-types";

function setup(kind: "VIDEO" | "LIVE" | "PLAYLIST" | "CHANNEL_LIVE" = "VIDEO") {
  const posts: unknown[] = [];
  const visible: boolean[] = [];
  const reload = vi.fn();
  const engine = createYouTubePipEngine({
    kind,
    post: (m) => posts.push(JSON.parse(m)),
    reload,
    setVisible: (v) => visible.push(v),
  });
  const ready = () => engine.handleRaw(YT_ORIGIN, '{"event":"onReady"}');
  const cmds = () => posts.filter((p) => (p as { event: string }).event === "command");
  return { engine, posts, visible, reload, ready, cmds };
}

describe("[TV-2p] motor del pip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("[TV-2p] origen ajeno ignorado: un onError 150 de otra ventana no oculta nada", () => {
    const t = setup();
    t.engine.begin();
    t.engine.handleRaw("https://evil.com", '{"event":"onError","info":150}');
    t.engine.handleRaw("https://www.youtube.com", '{"event":"onError","info":150}');
    expect(t.visible).toEqual([]);
    t.ready();
    expect(t.visible).toEqual([]);
    t.engine.dispose();
  });

  it("[TV-2p] handshake: al cargar el iframe manda «listening» y lo repite hasta onReady", () => {
    const t = setup();
    t.engine.begin();
    t.engine.loaded();
    expect(t.posts).toContainEqual(expect.objectContaining({ event: "listening", channel: "widget" }));
    const n = t.posts.length;
    vi.advanceTimersByTime(3_000);
    expect(t.posts.length).toBeGreaterThan(n);
    t.ready();
    const m = t.posts.length;
    vi.advanceTimersByTime(3_000);
    expect(t.posts.length).toBe(m);
    t.engine.dispose();
  });

  it("[TV-2p] error 150 → oculto + reintento a los 5 min; recién vuelve a verse con el onReady", () => {
    const t = setup("VIDEO");
    t.engine.begin();
    t.ready();
    t.engine.handleRaw(YT_ORIGIN, '{"event":"onError","info":150}');
    expect(t.visible).toEqual([false]);
    expect(PIP_RETRY_MS).toBe(300_000);
    vi.advanceTimersByTime(PIP_RETRY_MS - 1);
    expect(t.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // Recargó pero todavía no está listo: sigue oculto (no parpadea el layout cada 5 min).
    expect(t.visible).toEqual([false]);
    t.engine.loaded();
    t.ready();
    expect(t.visible).toEqual([false, true]);
    t.engine.dispose();
  });

  it("[TV-2p] un error no fatal no oculta", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.handleRaw(YT_ORIGIN, '{"event":"onError","info":7}');
    expect(t.visible).toEqual([]);
    t.engine.dispose();
  });

  it("[TV-2p] sin onReady a los 20 s → oculto; un vivo reintenta cada 2 min", () => {
    const t = setup("LIVE");
    t.engine.begin();
    t.engine.loaded();
    expect(PIP_READY_TIMEOUT_MS).toBe(20_000);
    vi.advanceTimersByTime(PIP_READY_TIMEOUT_MS - 1);
    expect(t.visible).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.visible).toEqual([false]);
    expect(PIP_RETRY_LIVE_MS).toBe(120_000);
    vi.advanceTimersByTime(PIP_RETRY_LIVE_MS);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // El reintento tampoco responde: a los 20 s se vuelve a agendar otro (no queda colgado).
    vi.advanceTimersByTime(PIP_READY_TIMEOUT_MS + PIP_RETRY_LIVE_MS);
    expect(t.reload).toHaveBeenCalledTimes(2);
    t.engine.dispose();
  });

  it("[TV-2p] un vivo que termina (ENDED) se oculta y reintenta", () => {
    const t = setup("CHANNEL_LIVE");
    t.engine.begin();
    t.ready();
    t.engine.handleRaw(YT_ORIGIN, '{"event":"onStateChange","info":0}');
    expect(t.visible).toEqual([false]);
    vi.advanceTimersByTime(PIP_RETRY_LIVE_MS);
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.engine.dispose();
  });

  it("[TV-2p] desmuta solo si soundUnlocked && !muted", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.setAudio({ muted: false, soundUnlocked: false });
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "mute", args: [] });
    t.engine.setAudio({ muted: true, soundUnlocked: true });
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "mute", args: [] });
    expect(t.cmds().some((c) => (c as { func: string }).func === "unMute")).toBe(false);
    t.engine.setAudio({ muted: false, soundUnlocked: true });
    expect(t.cmds().slice(-2)).toEqual([
      { event: "command", func: "unMute", args: [] },
      { event: "command", func: "setVolume", args: [PIP_BASE_VOLUME] },
    ]);
    t.engine.dispose();
  });

  it("[TV-2p] secuencia DUCK de 12 s: baja el volumen y lo restaura a los DUCK_MS", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.setAudio({ muted: false, soundUnlocked: true });
    t.engine.call("DUCK");
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "setVolume", args: [PIP_DUCK_VOLUME] });
    expect(DUCK_MS).toBe(12_000);
    vi.advanceTimersByTime(DUCK_MS - 1);
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "setVolume", args: [PIP_DUCK_VOLUME] });
    vi.advanceTimersByTime(1);
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "setVolume", args: [PIP_BASE_VOLUME] });
    // DUCK no oculta el recuadro.
    expect(t.visible).toEqual([]);
    t.engine.dispose();
  });

  it("[TV-2p] dos llamados seguidos con DUCK extienden el agache desde el último", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.setAudio({ muted: false, soundUnlocked: true });
    t.engine.call("DUCK");
    vi.advanceTimersByTime(8_000);
    t.engine.call("DUCK");
    vi.advanceTimersByTime(DUCK_MS - 1);
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "setVolume", args: [PIP_DUCK_VOLUME] });
    vi.advanceTimersByTime(1);
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "setVolume", args: [PIP_BASE_VOLUME] });
    t.engine.dispose();
  });

  it("[TV-2p] HIDE oculta el recuadro (y lo silencia) DUCK_MS y lo vuelve a mostrar", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.setAudio({ muted: false, soundUnlocked: true });
    t.engine.call("HIDE");
    expect(t.visible).toEqual([false]);
    expect(t.cmds().at(-1)).toEqual({ event: "command", func: "mute", args: [] });
    vi.advanceTimersByTime(DUCK_MS);
    expect(t.visible).toEqual([false, true]);
    expect(t.cmds().slice(-2)).toEqual([
      { event: "command", func: "unMute", args: [] },
      { event: "command", func: "setVolume", args: [PIP_BASE_VOLUME] },
    ]);
    t.engine.dispose();
  });

  it("[TV-2p] KEEP no hace nada", () => {
    const t = setup();
    t.engine.begin();
    t.ready();
    t.engine.setAudio({ muted: false, soundUnlocked: true });
    const n = t.posts.length;
    t.engine.call("KEEP");
    vi.advanceTimersByTime(DUCK_MS);
    expect(t.posts.length).toBe(n);
    expect(t.visible).toEqual([]);
    t.engine.dispose();
  });

  it("[TV-2p] dispose corta todos los timers (no recarga un iframe desmontado)", () => {
    const t = setup();
    t.engine.begin();
    t.engine.dispose();
    vi.advanceTimersByTime(PIP_READY_TIMEOUT_MS + PIP_RETRY_MS * 2);
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.visible).toEqual([]);
  });
});

describe("[TV-2p] render", () => {
  const base = { muted: true, soundUnlocked: false, callSeq: 0, duringCall: "DUCK" as const };
  const origin = "https://app.example.com";

  it("[TV-2p] media null no renderiza nada", () => {
    expect(renderToStaticMarkup(<YouTubePip {...base} media={null} origin={origin} />)).toBe("");
  });

  it("[TV-2p] NONE, ref null o ref inválida (youtubeEmbedUrl null) no renderizan nada", () => {
    expect(renderToStaticMarkup(<YouTubePip {...base} media={{ kind: "NONE", ref: null }} origin={origin} />)).toBe("");
    expect(renderToStaticMarkup(<YouTubePip {...base} media={{ kind: "VIDEO", ref: null }} origin={origin} />)).toBe("");
    expect(
      renderToStaticMarkup(<YouTubePip {...base} media={{ kind: "VIDEO", ref: "javascript:x" }} origin={origin} />),
    ).toBe("");
  });

  it("[TV-2p] iframe nocookie con referrerPolicy, allow y title", () => {
    const html = renderToStaticMarkup(
      <YouTubePip {...base} media={{ kind: "VIDEO", ref: "dQw4w9WgXcQ" }} origin={origin} />,
    );
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?');
    expect(html).toContain("enablejsapi=1");
    expect(html).toContain("mute=1");
    expect(html).toMatch(/referrerpolicy="strict-origin-when-cross-origin"/i);
    expect(html).toContain('allow="autoplay; fullscreen; encrypted-media"');
    expect(html).toMatch(/title="[^"]+"/);
    // Nunca la API de YouTube (`iframe_api`): el control es por postMessage.
    expect(html).not.toContain("iframe_api");
  });

  it("[TV-2p] sin origin (server) no arma el iframe: el src depende del origin real del navegador", () => {
    expect(renderToStaticMarkup(<YouTubePip {...base} media={{ kind: "VIDEO", ref: "dQw4w9WgXcQ" }} />)).toBe("");
  });
});
