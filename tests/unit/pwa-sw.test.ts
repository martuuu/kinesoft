/**
 * [MB-0a] Service worker (`public/sw.js`) y página sin conexión (`public/offline.html`), contrato C-MB5.
 *
 * Por qué importa: un SW «estándar» (cache-first de navegaciones) dejaría HTML con datos de pacientes en el disco de
 * una PC compartida de recepción. El contrato es: precachea solo `offline.html` + un ícono, NO guarda nada al navegar,
 * y solo intercepta navegaciones GET del mismo origen (para mostrar «Sin conexión» si la red falla).
 *
 * Se carga el archivo REAL en un `vm` con `self`/`caches`/`fetch` falsos (no hay runtime de SW en node) y se disparan
 * los eventos como los dispararía el navegador. Lo observable: qué se abrió/guardó/borró en CacheStorage y si el SW
 * respondió (`respondWith`) o dejó pasar el request a la red.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SW_SRC = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const OFFLINE_HTML = readFileSync(resolve(process.cwd(), "public/offline.html"), "utf8");
const ORIGIN = "https://app.kinesoft.test";

type Listener = (event: unknown) => void;

function loadSw(opts: { fetchImpl?: (req: unknown) => Promise<unknown>; existingKeys?: string[] } = {}) {
  const listeners: Record<string, Listener> = {};
  const log = {
    opened: [] as string[],
    added: [] as string[][],
    put: [] as unknown[],
    deleted: [] as string[],
    matched: [] as string[],
    fetched: [] as unknown[],
    skipWaiting: 0,
    claim: 0,
  };
  const OFFLINE_RESPONSE = { offline: true };
  const cache = {
    addAll: async (urls: string[]) => void log.added.push([...urls]),
    put: async (...args: unknown[]) => void log.put.push(args),
    add: async (url: string) => void log.put.push([url]),
  };
  const caches = {
    open: async (name: string) => {
      log.opened.push(name);
      return cache;
    },
    keys: async () => [...(opts.existingKeys ?? [])],
    delete: async (name: string) => {
      log.deleted.push(name);
      return true;
    },
    match: async (url: string) => {
      log.matched.push(url);
      return url === "/offline.html" ? OFFLINE_RESPONSE : undefined;
    },
  };
  const self: Record<string, unknown> = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: async () => void log.skipWaiting++,
    clients: { claim: async () => void log.claim++ },
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    Promise,
    fetch: (req: unknown) => {
      log.fetched.push(req);
      return opts.fetchImpl ? opts.fetchImpl(req) : Promise.resolve({ network: true });
    },
  });
  vm.runInContext(SW_SRC, context, { filename: "sw.js" });
  return { listeners, log, OFFLINE_RESPONSE };
}

function extendable() {
  const waits: Promise<unknown>[] = [];
  return { event: { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, done: () => Promise.all(waits) };
}

function fetchEvent(url: string, init: { method?: string; mode?: string } = {}) {
  let responded: Promise<unknown> | null = null;
  const request = { url: new URL(url, ORIGIN).href, method: init.method ?? "GET", mode: init.mode ?? "navigate" };
  const event = {
    request,
    respondWith: (p: Promise<unknown>) => {
      responded = p;
    },
  };
  return { event, responded: () => responded };
}

describe("[MB-0a] public/sw.js", () => {
  let sw: ReturnType<typeof loadSw>;
  beforeEach(() => {
    sw = loadSw();
  });

  it("registra install, activate y fetch (y nada de sync/push/message)", () => {
    expect(Object.keys(sw.listeners).sort()).toEqual(["activate", "fetch", "install"]);
  });

  it("install precachea EXACTAMENTE offline.html + el ícono 192 y hace skipWaiting", async () => {
    const { event, done } = extendable();
    sw.listeners.install(event);
    await done();
    expect(sw.log.opened).toEqual(["ks-sw-v2"]);
    expect(sw.log.added).toEqual([["/offline.html", "/icons/icon-192.png"]]);
    expect(sw.log.put).toEqual([]);
    expect(sw.log.skipWaiting).toBe(1);
  });

  it("activate borra las cachés de otras versiones (no la propia) y toma los clientes", async () => {
    sw = loadSw({ existingKeys: ["ks-sw-v0", "ks-sw-v1", "ks-sw-v2", "workbox-precache-v2"] });
    const { event, done } = extendable();
    sw.listeners.activate(event);
    await done();
    expect(sw.log.deleted.sort()).toEqual(["ks-sw-v0", "ks-sw-v1", "workbox-precache-v2"]);
    expect(sw.log.claim).toBe(1);
  });

  it("navegación online: responde la red tal cual y NO guarda nada en CacheStorage", async () => {
    const f = fetchEvent("/pacientes/abc");
    sw.listeners.fetch(f.event);
    expect(f.responded()).not.toBeNull();
    await expect(f.responded()).resolves.toEqual({ network: true });
    expect(sw.log.fetched).toHaveLength(1);
    expect(sw.log.opened).toEqual([]);
    expect(sw.log.put).toEqual([]);
    expect(sw.log.matched).toEqual([]);
  });

  it("navegación offline: responde offline.html desde la caché", async () => {
    sw = loadSw({ fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) });
    const f = fetchEvent("/agenda");
    sw.listeners.fetch(f.event);
    await expect(f.responded()).resolves.toBe(sw.OFFLINE_RESPONSE);
    expect(sw.log.matched).toEqual(["/offline.html"]);
    expect(sw.log.put).toEqual([]);
  });

  it.each([
    ["POST de una server action", "/agenda", { method: "POST", mode: "cors" }],
    ["POST navegación (form)", "/login", { method: "POST", mode: "navigate" }],
    ["fetch a /api", "/api/health", { mode: "cors" }],
    ["RSC (?_rsc)", "/agenda?_rsc=1x2y3", { mode: "cors" }],
    ["estático de /_next/static", "/_next/static/chunks/main-abc.js", { mode: "no-cors" }],
    ["imagen", "/icons/icon-512.png", { mode: "no-cors" }],
    ["navegación a otro origen", "https://www.mercadopago.com.ar/checkout", { mode: "navigate" }],
  ])("%s: no llama respondWith (va directo a la red, sin pasar por el SW)", (_label, url, init) => {
    const f = fetchEvent(url, init);
    sw.listeners.fetch(f.event);
    expect(f.responded()).toBeNull();
    expect(sw.log.fetched).toEqual([]);
    expect(sw.log.opened).toEqual([]);
  });

  it("el código no tiene ninguna escritura de caché fuera del precache de install", () => {
    expect(SW_SRC).not.toMatch(/\.put\(/);
    expect(SW_SRC).not.toMatch(/\.add\(/);
    expect(SW_SRC.match(/addAll\(/g)).toHaveLength(1);
    expect(SW_SRC).not.toMatch(/importScripts|workbox/i);
  });
});

describe("[MB-0a] public/offline.html", () => {
  it("es autocontenido: sin scripts externos, sin hojas externas, sin assets de Next", () => {
    expect(OFFLINE_HTML).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(OFFLINE_HTML).not.toMatch(/<link\b[^>]*rel=["']?stylesheet/i);
    expect(OFFLINE_HTML).not.toMatch(/_next\//);
    expect(OFFLINE_HTML).not.toMatch(/\b(?:src|href)=["']https?:/i);
  });

  it("idioma, viewport con viewport-fit=cover y sin bloquear el zoom", () => {
    expect(OFFLINE_HTML).toMatch(/<html[^>]*lang="es-AR"/);
    expect(OFFLINE_HTML).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    );
    expect(OFFLINE_HTML).not.toMatch(/maximum-scale|user-scalable/);
  });

  it("copy del contrato: título, aviso de que no se guardan datos y botón Reintentar", () => {
    expect(OFFLINE_HTML.match(/<h1\b/g)).toHaveLength(1);
    expect(OFFLINE_HTML).toMatch(/<h1[^>]*>Sin conexión<\/h1>/);
    expect(OFFLINE_HTML).toContain(
      "Revisá tu conexión a internet. Los datos del consultorio no se guardan en este dispositivo.",
    );
    expect(OFFLINE_HTML).toMatch(/<button[^>]*type="button"[^>]*onclick="location\.reload\(\)"[^>]*>Reintentar<\/button>/);
  });
});
