/**
 * [TV-2p] Protocolo postMessage del reproductor de YouTube (plan §26.4 «YouTube»): sin cargar `iframe_api`, la TV
 * habla con el iframe nocookie por JSON. Lo que importa: solo se acepta el origen EXACTO de nocookie (una pantalla
 * pública no puede reaccionar a mensajes de cualquier ventana) y los errores fatales son `[2,5,100,101,150,153]`.
 */
import { describe, expect, it } from "vitest";
import { YT_FATAL, YT_ORIGIN, parsePlayerMessage, ytCommand, ytListening } from "@/lib/youtube-player-protocol";

describe("[TV-2p] ytCommand", () => {
  it("[TV-2p] arma el JSON de comando del widget", () => {
    expect(JSON.parse(ytCommand("setVolume", [20]))).toEqual({ event: "command", func: "setVolume", args: [20] });
    expect(JSON.parse(ytCommand("mute"))).toEqual({ event: "command", func: "mute", args: [] });
  });

  it("[TV-2p] el handshake «listening» lleva id y channel widget", () => {
    expect(JSON.parse(ytListening("pip-1"))).toEqual({ event: "listening", id: "pip-1", channel: "widget" });
  });
});

describe("[TV-2p] parsePlayerMessage", () => {
  it("[TV-2p] errores fatales literales", () => {
    expect([...YT_FATAL]).toEqual([2, 5, 100, 101, 150, 153]);
    expect(YT_ORIGIN).toBe("https://www.youtube-nocookie.com");
  });

  it("[TV-2p] acepta onReady / onStateChange / onError / infoDelivery del origen nocookie", () => {
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onReady","id":"pip-1","channel":"widget"}')).toEqual({
      event: "onReady",
    });
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onStateChange","info":1}')).toEqual({
      event: "onStateChange",
      state: 1,
    });
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onError","info":150}')).toEqual({
      event: "onError",
      code: 150,
      fatal: true,
    });
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onError","info":7}')).toEqual({
      event: "onError",
      code: 7,
      fatal: false,
    });
    expect(
      parsePlayerMessage(YT_ORIGIN, '{"event":"infoDelivery","info":{"playerState":0,"volume":40,"muted":true,"x":"<b>"}}'),
    ).toEqual({ event: "infoDelivery", info: { playerState: 0, volume: 40, muted: true } });
    // initialDelivery trae la misma forma: se trata como infoDelivery.
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"initialDelivery","info":{"playerState":-1}}')).toEqual({
      event: "infoDelivery",
      info: { playerState: -1 },
    });
  });

  it("[TV-2p] ignora cualquier otro origen, aunque se parezca", () => {
    const msg = '{"event":"onError","info":150}';
    for (const o of [
      "https://www.youtube.com",
      "https://youtube-nocookie.com",
      "http://www.youtube-nocookie.com",
      "https://www.youtube-nocookie.com.evil.com",
      "https://www.youtube-nocookie.com:443",
      "https://evil.com",
      "null",
      "",
      undefined,
    ]) {
      expect(parsePlayerMessage(o, msg)).toBeNull();
    }
  });

  it("[TV-2p] basura, JSON roto, eventos desconocidos o tipos raros → null", () => {
    expect(parsePlayerMessage(YT_ORIGIN, "no json")).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, "{")).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, '"onReady"')).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, "null")).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"apiInfoDelivery"}')).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onError","info":"150"}')).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"onStateChange"}')).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, '{"event":"infoDelivery","info":[1]}')).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, 42)).toBeNull();
    expect(parsePlayerMessage(YT_ORIGIN, "x".repeat(70_000))).toBeNull();
  });

  it("[TV-2p] también acepta el objeto ya parseado (algunos navegadores lo entregan así)", () => {
    expect(parsePlayerMessage(YT_ORIGIN, { event: "onReady" })).toEqual({ event: "onReady" });
  });
});
