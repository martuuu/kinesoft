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

type FakeClient = {
  url: string;
  focus: () => Promise<FakeClient>;
  navigate: (url: string) => Promise<FakeClient | null>;
};

function loadSw(
  opts: {
    fetchImpl?: (req: unknown) => Promise<unknown>;
    existingKeys?: string[];
    // [CF2-SE] Ventanas abiertas que devuelve `clients.matchAll` (para `notificationclick`).
    windows?: FakeClient[];
  } = {},
) {
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
    notifications: [] as Array<{ title: string; options: Record<string, unknown> }>,
    matchAll: [] as unknown[],
    openedWindows: [] as string[],
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
    clients: {
      claim: async () => void log.claim++,
      matchAll: async (o: unknown) => {
        log.matchAll.push(o);
        return [...(opts.windows ?? [])];
      },
      openWindow: async (url: string) => void log.openedWindows.push(url),
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) =>
        void log.notifications.push({ title, options }),
    },
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

  // [CF2-SE] Desde CF2 (D-CF2-11) también `push` y `notificationclick` (avisos de turnos online). Sigue sin sync,
  // periodicsync ni message: nada que guarde o traiga datos en segundo plano.
  it("registra install, activate, fetch, push y notificationclick (y nada de sync/message)", () => {
    expect(Object.keys(sw.listeners).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  });

  it("install precachea EXACTAMENTE offline.html + el ícono 192 y hace skipWaiting", async () => {
    const { event, done } = extendable();
    sw.listeners.install(event);
    await done();
    expect(sw.log.opened).toEqual(["ks-sw-v2"]);
    // [CF-UI1 · H] Con `?v=2`, igual que el manifest: URL nueva = PNG con la marca actual, sin tocar `VERSION`.
    expect(sw.log.added).toEqual([["/offline.html", "/icons/icon-192.png?v=2"]]);
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

/**
 * [CF2-SE] Avisos push de turnos online (plan §29, D-CF2-11). Contrato del SW:
 *  - `push`: SIEMPRE muestra una notificación, aunque el payload venga roto. Chrome y Safari exigen
 *    `userVisibleOnly`: un push sin notificación visible lo penalizan (Chrome muestra un genérico «se actualizó en
 *    segundo plano» y Safari revoca la suscripción después de varios). Título y cuerpo recortados.
 *  - La URL del payload solo si es un path del mismo origen (`/…`, no `//…` ni `/\…`, que el navegador lee como otro
 *    host); si no, `/dashboard`. Un payload adulterado no puede mandar al profesional a una página de phishing.
 *  - `notificationclick`: cierra, enfoca una ventana del mismo origen y la navega; si no hay, abre una.
 *  - Nada de caché nueva ni `VERSION` nueva ([BR-9]): lo fija el bloque de arriba.
 */
function pushEvent(data: unknown, mode: "json" | "text" | "none" = "json") {
  const waits: Promise<unknown>[] = [];
  const event = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    data:
      mode === "none"
        ? null
        : {
            json: () => (mode === "json" ? data : JSON.parse(String(data))),
            text: () => String(data),
          },
  };
  return { event, done: () => Promise.all(waits) };
}

function clickEvent(data: unknown) {
  const waits: Promise<unknown>[] = [];
  const log = { closed: 0 };
  const event = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    notification: { data, close: () => void log.closed++ },
  };
  return { event, log, done: () => Promise.all(waits) };
}

function fakeWindow(url: string, opts: { navigateFails?: boolean } = {}) {
  const calls = { focus: 0, navigate: [] as string[] };
  const client: FakeClient = {
    url,
    focus: async () => {
      calls.focus++;
      return client;
    },
    navigate: async (to: string) => {
      calls.navigate.push(to);
      if (opts.navigateFails) throw new TypeError("not controlled");
      return client;
    },
  };
  return { client, calls };
}

describe("[CF2-SE] public/sw.js · push", () => {
  it("[CF2-SE1] payload del server: muestra título, cuerpo, ícono, tag y la URL en `data`", async () => {
    const sw = loadSw();
    const e = pushEvent({
      title: "Nuevo turno online",
      body: "lun 9/11 · 10:30 · Kinesio Sur",
      url: "/agenda?date=2026-11-09&view=timeline",
      tag: "booking-bk_1",
    });
    sw.listeners.push(e.event);
    await e.done();
    expect(sw.log.notifications).toEqual([
      {
        title: "Nuevo turno online",
        options: {
          body: "lun 9/11 · 10:30 · Kinesio Sur",
          icon: "/icons/icon-192.png?v=2",
          tag: "booking-bk_1",
          data: { url: "/agenda?date=2026-11-09&view=timeline" },
        },
      },
    ]);
  });

  it.each([
    ["JSON roto", "{no es json", "text" as const],
    ["sin data", null, "none" as const],
    ["JSON que no es objeto", 42, "json" as const],
    ["null", null, "json" as const],
  ])("[CF2-SE2] %s: igual muestra una notificación genérica que abre /dashboard", async (_l, data, mode) => {
    const sw = loadSw();
    const e = pushEvent(data, mode);
    sw.listeners.push(e.event);
    await e.done();
    expect(sw.log.notifications).toHaveLength(1);
    const n = sw.log.notifications[0];
    expect(n.title.length).toBeGreaterThan(0);
    expect(n.options.data).toEqual({ url: "/dashboard" });
    expect(n.options).not.toHaveProperty("tag");
  });

  it.each([
    ["absoluta a otro host", "https://evil.test/login"],
    ["protocol-relative", "//evil.test/login"],
    ["barra invertida", "/\\evil.test/login"],
    ["javascript:", "javascript:alert(1)"],
    ["relativa sin barra", "agenda"],
    ["con salto de línea", "/agenda\n//evil.test"],
    ["no string", { href: "/agenda" }],
  ])("[CF2-SE3] URL %s → /dashboard", async (_l, url) => {
    const sw = loadSw();
    const e = pushEvent({ title: "T", body: "B", url });
    sw.listeners.push(e.event);
    await e.done();
    expect(sw.log.notifications[0].options.data).toEqual({ url: "/dashboard" });
  });

  it("[CF2-SE4] título y cuerpo en una línea y recortados (80 y 160) con «…»; título vacío → genérico", async () => {
    const sw = loadSw();
    const e = pushEvent({ title: `Nuevo\n${"t".repeat(200)}`, body: "b".repeat(500), url: "/agenda" });
    sw.listeners.push(e.event);
    await e.done();
    const n = sw.log.notifications[0];
    expect(n.title).not.toMatch(/\n/);
    expect(n.title.length).toBeLessThanOrEqual(80);
    expect(n.title.endsWith("…")).toBe(true);
    expect(String(n.options.body).length).toBeLessThanOrEqual(160);
    const blank = pushEvent({ title: "   ", body: 7, url: "/agenda" });
    sw.listeners.push(blank.event);
    await blank.done();
    expect(sw.log.notifications[1].title.trim().length).toBeGreaterThan(0);
    expect(sw.log.notifications[1].options.body).toBe("");
  });

  it("[CF2-SE5] un push no toca CacheStorage ni la red", async () => {
    const sw = loadSw();
    const e = pushEvent({ title: "T", body: "B", url: "/agenda" });
    sw.listeners.push(e.event);
    await e.done();
    expect(sw.log.opened).toEqual([]);
    expect(sw.log.fetched).toEqual([]);
  });
});

describe("[CF2-SE] public/sw.js · notificationclick", () => {
  it("[CF2-SE6] cierra, enfoca la ventana del mismo origen y la navega a la URL del aviso", async () => {
    const other = fakeWindow("https://www.mercadopago.com.ar/checkout");
    const own = fakeWindow(`${ORIGIN}/pacientes`);
    const sw = loadSw({ windows: [other.client, own.client] });
    const e = clickEvent({ url: "/agenda?date=2026-11-09&view=timeline" });
    sw.listeners.notificationclick(e.event);
    await e.done();
    expect(e.log.closed).toBe(1);
    expect(sw.log.matchAll).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(other.calls).toEqual({ focus: 0, navigate: [] });
    expect(own.calls).toEqual({ focus: 1, navigate: ["/agenda?date=2026-11-09&view=timeline"] });
    expect(sw.log.openedWindows).toEqual([]);
  });

  it("[CF2-SE7] sin ventana del mismo origen: abre una nueva", async () => {
    const other = fakeWindow("https://www.mercadopago.com.ar/checkout");
    const sw = loadSw({ windows: [other.client] });
    const e = clickEvent({ url: "/agenda" });
    sw.listeners.notificationclick(e.event);
    await e.done();
    expect(sw.log.openedWindows).toEqual(["/agenda"]);
    expect(other.calls.focus).toBe(0);
  });

  it("[CF2-SE8] si la ventana no se deja navegar (no controlada), abre una nueva con la URL", async () => {
    const own = fakeWindow(`${ORIGIN}/agenda`, { navigateFails: true });
    const sw = loadSw({ windows: [own.client] });
    const e = clickEvent({ url: "/agenda?date=2026-11-09&view=timeline" });
    sw.listeners.notificationclick(e.event);
    await e.done();
    expect(sw.log.openedWindows).toEqual(["/agenda?date=2026-11-09&view=timeline"]);
  });

  it.each([
    ["sin data", undefined],
    ["URL a otro host", { url: "https://evil.test" }],
    ["protocol-relative", { url: "//evil.test" }],
  ])("[CF2-SE9] %s → navega a /dashboard (se vuelve a sanear al click)", async (_l, data) => {
    const sw = loadSw({ windows: [] });
    const e = clickEvent(data);
    sw.listeners.notificationclick(e.event);
    await e.done();
    expect(sw.log.openedWindows).toEqual(["/dashboard"]);
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

  // [CF-UI1 · H] El logo es el «A · Sello C» (la C + el punto lima), no la figura vieja de BR-a para atrás.
  it("[CF-H2] logo = sello C", () => {
    expect(OFFLINE_HTML).toContain('d="M30.88 14.17 A12 12 0 1 0 30.88 33.83"');
    expect(OFFLINE_HTML).toContain('fill="#c8f564"');
    expect(OFFLINE_HTML).not.toContain("M6 9.5C6 12 7.5 13 8 14.5L6 21");
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
