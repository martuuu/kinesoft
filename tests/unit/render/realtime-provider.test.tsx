/**
 * [SV07b] RealtimeProvider, LiveIndicator y CSP del socket (§18.8 fila SV07b, C-SV7).
 *
 * Sin jsdom no corren effects: el render (`renderToStaticMarkup`) cubre lo que se
 * ve en el primer paint (hijos, estado inicial, indicador) y la lógica del provider
 * se testea en `createRealtimeHub`, que es el MISMO objeto que el provider usa en
 * su effect (no una copia), con un driver fake y timers fake.
 *
 * Fakes con registro a mano (brief SV): `vi.fn` que tira a través de un mock rompe
 * vitest 2.1.9.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// La action del token es "use server" (Prisma, sesión): fuera del test. El hub
// la usa solo vía `defaultLoadDriver`, que los tests no invocan.
const mint = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/realtime-token", () => ({
  mintRealtimeToken: async () => {
    mint.calls++;
    return { ok: false, error: "realtime-off" };
  },
}));
const sentry = vi.hoisted(() => ({ withSentryConfig: (cfg: object) => cfg }));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("@sentry/nextjs/config", () => sentry);

import {
  RealtimeProvider,
  initialRealtimeState,
  useRealtime,
  type RealtimeResyncReason,
} from "@/components/providers/realtime-provider";
import { createRealtimeHub } from "@/components/realtime/realtime-hub";
import { LIVE_INDICATOR_COPY, LiveIndicator, liveAnnouncement } from "@/components/realtime/live-indicator";
import type { DriverStatus, NudgeReason, RealtimeDriver, StatusInfo } from "@/lib/realtime-client-types";
import type { RealtimeAgendaMessage, RealtimeBootstrap } from "@/lib/realtime-events";
import { POLL_INTERVAL_MS, deriveConnectionState } from "@/lib/realtime-client-state";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OFF: RealtimeBootstrap = { driver: "off", tenantId: "t1" };
const LOCAL: RealtimeBootstrap = { driver: "local", tenantId: "t1" };

function msg(i: number): RealtimeAgendaMessage {
  return {
    v: 1,
    kind: "reception",
    bookingId: `b${i}`,
    practitionerId: "p1",
    day: "2026-10-13",
    at: "2026-10-13T12:00:00.000Z",
  };
}

type FakeDriver = RealtimeDriver & {
  connects: number;
  closes: number;
  nudges: NudgeReason[];
  emit(msgs: RealtimeAgendaMessage[]): void;
  status(s: DriverStatus, info?: StatusInfo): void;
};

function fakeDriver(): FakeDriver {
  const msgL = new Set<(m: RealtimeAgendaMessage[]) => void>();
  const stL = new Set<(s: DriverStatus, i?: StatusInfo) => void>();
  const d: FakeDriver = {
    connects: 0,
    closes: 0,
    nudges: [],
    async connect() {
      d.connects++;
    },
    close() {
      d.closes++;
      for (const cb of Array.from(stL)) cb("off", { failures: 0, reconnected: false });
    },
    onMessage(cb) {
      msgL.add(cb);
      return () => msgL.delete(cb);
    },
    onStatus(cb) {
      stL.add(cb);
      return () => stL.delete(cb);
    },
    nudge(r) {
      d.nudges.push(r);
    },
    emit(m) {
      for (const cb of Array.from(msgL)) cb(m);
    },
    status(s, i) {
      for (const cb of Array.from(stL)) cb(s, i);
    },
  };
  return d;
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function Probe() {
  const rt = useRealtime();
  return <span data-probe={rt.state} />;
}

describe("[SV07b] RealtimeProvider · render", () => {
  it('driver "off": renderiza los hijos, state === "off" y sin indicador', () => {
    const html = renderToStaticMarkup(
      <RealtimeProvider bootstrap={OFF}>
        <p>hijo</p>
        <Probe />
        <LiveIndicator />
      </RealtimeProvider>
    );
    expect(html).toContain("<p>hijo</p>");
    expect(html).toContain('data-probe="off"');
    expect(html).not.toContain("k-live-badge");
  });

  it("fuera del provider useRealtime() es un stub off que no tira", () => {
    let api: ReturnType<typeof useRealtime> | null = null;
    function Grab() {
      api = useRealtime();
      return null;
    }
    expect(renderToStaticMarkup(<Grab />)).toBe("");
    expect(api!.state).toBe("off");
    const unsub = api!.subscribe(() => {});
    const unres = api!.onResync(() => {});
    expect(() => {
      api!.resync();
      unsub();
      unres();
    }).not.toThrow();
  });

  it('driver "local": primer paint en "reconnecting" (no «Sin conexión» mientras carga)', () => {
    expect(initialRealtimeState(LOCAL)).toBe("reconnecting");
    const html = renderToStaticMarkup(
      <RealtimeProvider bootstrap={LOCAL}>
        <Probe />
        <LiveIndicator />
      </RealtimeProvider>
    );
    expect(html).toContain('data-probe="reconnecting"');
    expect(html).toContain('data-state="reconnecting"');
    expect(html).toContain("Reconectando…");
    // El render no dispara nada de red.
    expect(mint.calls).toBe(0);
  });
});

/**
 * [FX3] Bundle (§18.10 punto 7): el provider va en el first-load de TODAS las rutas
 * del workspace; el gate midió +11 kB gz con el hub estático. Se afirma sobre el
 * source (como `realtime-client-drivers.test.ts` con realtime-js): ningún import
 * de VALOR del hub, del estado del cliente, del schema zod ni de la action del
 * token; el hub entra solo por `import()`.
 */
function staticValueImport(src: string, mod: string): boolean {
  const m = mod.replace(/[/.@-]/g, (c) => `\\${c}`);
  const imp = new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*?from\\s+["']${m}["']`, "m");
  const reexp = new RegExp(`^\\s*export\\s+(?!type\\b)[^;]*?from\\s+["']${m}["']`, "m");
  return imp.test(src) || reexp.test(src);
}

describe("[FX3] RealtimeProvider · bundle liviano", () => {
  const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

  it("el provider y el LiveIndicator no importan estáticamente el hub ni sus dependencias", () => {
    for (const f of ["components/providers/realtime-provider.tsx", "components/realtime/live-indicator.tsx"]) {
      const src = read(f);
      for (const mod of [
        "@/components/realtime/realtime-hub",
        "@/lib/realtime-client-state",
        "@/lib/realtime-events",
        "@/lib/realtime-token",
        "@/lib/realtime-client-local",
        "@/lib/realtime-client-supabase",
      ]) {
        expect(staticValueImport(src, mod), `${f} → ${mod}`).toBe(false);
      }
    }
    expect(read("components/providers/realtime-provider.tsx")).toMatch(
      /import\(\s*["']@\/components\/realtime\/realtime-hub["']\s*\)/,
    );
  });

  it("el detector de imports estáticos no es un falso verde", () => {
    expect(staticValueImport('import { a } from "@/x/y";', "@/x/y")).toBe(true);
    expect(staticValueImport('import {\n  a,\n  b,\n} from "@/x/y";', "@/x/y")).toBe(true);
    expect(staticValueImport('export { a } from "@/x/y";', "@/x/y")).toBe(true);
    expect(staticValueImport('import type { a } from "@/x/y";', "@/x/y")).toBe(false);
    expect(staticValueImport('const m = await import("@/x/y");', "@/x/y")).toBe(false);
  });

  it("initialRealtimeState inlineado = deriveConnectionState('idle', 0, undefined)", () => {
    expect(initialRealtimeState(LOCAL)).toBe(deriveConnectionState("idle", 0, undefined));
    expect(initialRealtimeState({ driver: "supabase", tenantId: "t1" })).toBe(
      deriveConnectionState("idle", 0, undefined),
    );
    expect(initialRealtimeState(OFF)).toBe("off");
  });

  it("sin hub cargado (driver off), resync() avisa «manual» a los listeners, como el hub sin sesión", () => {
    let api: ReturnType<typeof useRealtime> | null = null;
    function Grab() {
      api = useRealtime();
      return null;
    }
    renderToStaticMarkup(
      <RealtimeProvider bootstrap={OFF}>
        <Grab />
      </RealtimeProvider>,
    );
    const got: RealtimeResyncReason[] = [];
    const unres = api!.onResync((r) => got.push(r));
    api!.resync();
    expect(got).toEqual(["manual"]);
    unres();
    api!.resync();
    expect(got).toEqual(["manual"]);
  });
});

describe("[SV07b] LiveIndicator", () => {
  it("copy y data-state por estado; el anuncio va en una región role=status aparte", () => {
    const live = renderToStaticMarkup(<LiveIndicator state="live" />);
    expect(live).toMatch(/<span class="k-live-badge" data-state="live"/);
    // [FX2b] El badge visible ya no es la región viva (anunciaba cada vaivén).
    expect(live).not.toMatch(/k-live-badge[^>]*role="status"/);
    expect(live).toMatch(/<span role="status" aria-live="polite" data-live-announce[^>]*>En vivo<\/span>/);
    expect(live).toContain('<span class="k-live-dot" aria-hidden="true"></span>En vivo');
    expect(renderToStaticMarkup(<LiveIndicator state="reconnecting" />)).toContain("Reconectando…");
    const polling = renderToStaticMarkup(<LiveIndicator state="polling" />);
    // El CSS (SV03u) pinta `offline`, no `polling`.
    expect(polling).toContain('data-state="offline"');
    expect(polling).toContain("Sin conexión en vivo · se actualiza cada 60 s");
    expect(renderToStaticMarkup(<LiveIndicator state="off" />)).toBe("");
  });

  it("compact: solo el punto, el texto en title y aria-label (role=img para que valga)", () => {
    const html = renderToStaticMarkup(<LiveIndicator state="live" compact />);
    expect(html).toContain('title="En vivo"');
    expect(html).toContain('aria-label="En vivo"');
    expect(html).toMatch(/k-live-badge[^>]*role="img"/);
    // El texto visible no está; sí el de la región viva (visualmente oculta).
    expect(html).not.toMatch(/k-live-dot" aria-hidden="true"><\/span>En vivo/);
  });

  it("[FX2b] la región viva anuncia solo live y polling; reconnecting no cambia el anuncio", () => {
    let a = "";
    const seq: string[] = [];
    for (const st of ["live", "reconnecting", "live", "reconnecting", "polling", "reconnecting", "polling", "live"] as const) {
      a = liveAnnouncement(a, st);
      seq.push(a);
    }
    expect(seq).toEqual([
      "En vivo",
      "En vivo",
      "En vivo",
      "En vivo",
      LIVE_INDICATOR_COPY.polling,
      LIVE_INDICATOR_COPY.polling,
      LIVE_INDICATOR_COPY.polling,
      "En vivo",
    ]);
    // Primer paint en reconnecting: la región arranca vacía (no hay nada estable que decir).
    const html = renderToStaticMarkup(<LiveIndicator state="reconnecting" />);
    expect(html).toContain("Reconectando…");
    expect(html).toMatch(/data-live-announce[^>]*><\/span>/);
  });
});

describe("[SV07b] createRealtimeHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(online: boolean | undefined = true) {
    const net = { online };
    const hub = createRealtimeHub({ isOnline: () => net.online });
    const d = fakeDriver();
    const batches: RealtimeAgendaMessage[][] = [];
    const resyncs: RealtimeResyncReason[] = [];
    const states: string[] = [];
    hub.subscribe((b) => batches.push(b));
    hub.onResync((r) => resyncs.push(r));
    hub.onState((s) => states.push(s));
    return { hub, d, batches, resyncs, states, net };
  }

  it('bootstrap "off": no carga driver y queda en off', async () => {
    const { hub } = setup();
    let loads = 0;
    hub.start(OFF, async () => {
      loads++;
      return fakeDriver();
    });
    await settle();
    expect(loads).toBe(0);
    expect(hub.getState()).toBe("off");
  });

  it("conecta, pasa a live y subscribe recibe UN lote coalescido (250 ms)", async () => {
    const { hub, d, batches, resyncs } = setup();
    hub.start(LOCAL, async () => d);
    await settle();
    expect(d.connects).toBe(1);
    d.status("live", { failures: 0, reconnected: false });
    expect(hub.getState()).toBe("live");
    // Primera conexión: la página llegó fresca del server, no hay resync.
    expect(resyncs).toEqual([]);
    d.emit([msg(1)]);
    d.emit([msg(2), msg(3)]);
    vi.advanceTimersByTime(249);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([[msg(1), msg(2), msg(3)]]);
  });

  it("reconexión (live con reconnected) → onResync('reconnect'); 2 fallos → polling cada 60 s", async () => {
    const { hub, d, resyncs, states } = setup();
    hub.start(LOCAL, async () => d);
    await settle();
    d.status("live", { failures: 0, reconnected: false });
    d.status("reconnecting", { failures: 1, reconnected: false });
    expect(hub.getState()).toBe("reconnecting");
    d.status("reconnecting", { failures: 2, reconnected: false });
    expect(hub.getState()).toBe("polling");
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(resyncs).toEqual(["poll"]);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(resyncs).toEqual(["poll", "poll"]);
    d.status("live", { failures: 0, reconnected: true });
    expect(hub.getState()).toBe("live");
    expect(resyncs).toEqual(["poll", "poll", "reconnect"]);
    // En vivo no hay polling.
    vi.advanceTimersByTime(5 * POLL_INTERVAL_MS);
    expect(resyncs).toHaveLength(3);
    expect(states).toEqual(["reconnecting", "live", "reconnecting", "polling", "live"]);
  });

  it("sin red (navigator.onLine false) → polling; online → nudge + resync", async () => {
    const { hub, d, resyncs, net } = setup();
    hub.start(LOCAL, async () => d);
    await settle();
    d.status("live", { failures: 0, reconnected: false });
    net.online = false;
    hub.handleOnline(false);
    expect(hub.getState()).toBe("polling");
    expect(resyncs).toEqual([]);
    net.online = true;
    hub.handleOnline(true);
    expect(d.nudges).toEqual(["online"]);
    expect(resyncs).toEqual(["online"]);
    expect(hub.getState()).toBe("live");
  });

  it("pestaña visible → nudge + resync; oculta → nada", async () => {
    const { hub, d, resyncs } = setup();
    hub.start(LOCAL, async () => d);
    await settle();
    hub.handleVisibility(false);
    expect(resyncs).toEqual([]);
    hub.handleVisibility(true);
    expect(d.nudges).toEqual(["visible"]);
    expect(resyncs).toEqual(["visible"]);
  });

  it("resync() manual descarga lo pendiente del coalescer antes de avisar", async () => {
    const { hub, d, batches, resyncs } = setup();
    const order: string[] = [];
    hub.subscribe(() => order.push("batch"));
    hub.onResync(() => order.push("resync"));
    hub.start(LOCAL, async () => d);
    await settle();
    d.status("live", { failures: 0, reconnected: false });
    d.emit([msg(1)]);
    hub.resync();
    expect(batches).toEqual([[msg(1)]]);
    expect(resyncs).toEqual(["manual"]);
    expect(order).toEqual(["batch", "resync"]);
  });

  it("stop: cierra el driver, descarta lo pendiente, sin polling ni entregas después", async () => {
    const { hub, d, batches, resyncs } = setup();
    const stop = hub.start(LOCAL, async () => d);
    await settle();
    d.status("reconnecting", { failures: 3, reconnected: false });
    d.emit([msg(1)]);
    stop();
    expect(d.closes).toBe(1);
    expect(hub.getState()).toBe("off");
    d.emit([msg(2)]);
    d.status("live", { failures: 0, reconnected: true });
    vi.advanceTimersByTime(10 * POLL_INTERVAL_MS);
    expect(batches).toEqual([]);
    expect(resyncs).toEqual([]);
    expect(hub.getState()).toBe("off");
    stop(); // idempotente
    expect(d.closes).toBe(1);
  });

  it("stop antes de que resuelva el import() del driver → el driver se cierra sin conectar", async () => {
    const { hub, d } = setup();
    let release!: (x: RealtimeDriver) => void;
    const stop = hub.start(LOCAL, () => new Promise<RealtimeDriver>((r) => (release = r)));
    stop();
    release(d);
    await settle();
    expect(d.connects).toBe(0);
    expect(d.closes).toBe(1);
  });

  it("sin transporte (loader null o que tira) → polling, no off: la sala no se congela", async () => {
    const { hub, resyncs } = setup();
    hub.start(LOCAL, async () => {
      throw new Error("ChunkLoadError");
    });
    await settle();
    expect(hub.getState()).toBe("polling");
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(resyncs).toEqual(["poll"]);
  });

  it("un consumer que tira no corta la entrega a los demás", async () => {
    const { hub, d, batches } = setup();
    hub.subscribe(() => {
      throw new Error("boom");
    });
    hub.start(LOCAL, async () => d);
    await settle();
    d.emit([msg(1)]);
    vi.advanceTimersByTime(250);
    expect(batches).toEqual([[msg(1)]]);
  });
});

describe("[SV07b] CSP connect-src", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function cspFor(url: string) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    vi.stubEnv("SENTRY_DSN", "");
    const mod = await import("../../../next.config.mjs");
    const cfg = mod.default as { headers: () => Promise<Array<{ headers: { key: string; value: string }[] }>> };
    const h = (await cfg.headers())[0].headers;
    const csp = h.find((x) => x.key === "Content-Security-Policy-Report-Only")!.value;
    return csp.split("; ").find((d) => d.startsWith("connect-src"))!;
  }

  it("wss acotado al host de Supabase; sin `wss:` pelado; sigue Report-Only", async () => {
    const cs = await cspFor("https://ref.supabase.co");
    expect(cs).toContain("wss://ref.supabase.co");
    expect(cs.split(" ")).not.toContain("wss:");
  });

  it("sin URL de Supabase: ninguna entrada ws", async () => {
    const cs = await cspFor("");
    expect(cs).not.toMatch(/wss?:/);
  });

  it("realtimeWsOrigin: https→wss, http→ws (Supabase local), basura → vacío", async () => {
    const { realtimeWsOrigin } = await import("../../../next.config.mjs");
    expect(realtimeWsOrigin("https://ref.supabase.co/")).toBe("wss://ref.supabase.co");
    expect(realtimeWsOrigin("http://127.0.0.1:54321")).toBe("ws://127.0.0.1:54321");
    expect(realtimeWsOrigin("nope")).toBe("");
    expect(realtimeWsOrigin("")).toBe("");
  });
});
