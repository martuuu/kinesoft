/**
 * [TV-2u2] Pantalla de la sala (`components/tv/tv-screen.tsx`) + modo kiosco (`components/tv/use-kiosk.ts`).
 * Render con `renderToStaticMarkup` (entorno node, como el resto de `tests/unit/render`): es el primer render, el del
 * SSR. Los efectos (polling, kiosco) se prueban con sus controladores reales y fake timers. Solo se mockean
 * `next/navigation` y las actions del dispositivo (red/server).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/display-device", () => ({ getDisplayFeed: vi.fn() }));
vi.mock("@/lib/realtime-display-token", () => ({ mintDisplayRealtimeToken: vi.fn() }));

import {
  TvScreen,
  agoLabel,
  callAnnouncement,
  clinicInitials,
  clockText,
  destinationPhrase,
  heroModeFor,
  mediaOf,
  screenLayout,
} from "@/components/tv/tv-screen";
import { CURSOR_IDLE_MS, createKiosk, msUntilNextDailyReload, type KioskDeps } from "@/components/tv/use-kiosk";
import type { DisplayConfig, DisplayFeed, DisplayFeedItem } from "@/lib/reception-displays-types";
import { BRAND_NAME } from "@/lib/brand";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

const NOW = "2026-10-22T13:42:00.000Z"; // 10:42 AR

const cfg = (over: Partial<DisplayConfig> = {}): DisplayConfig => ({
  nameMode: "SHORT_NAME",
  theme: "DARK",
  mediaKind: "NONE",
  mediaRef: null,
  mediaLayout: "SIDE",
  mediaMuted: true,
  mediaDuringCall: "DUCK",
  ...over,
});

const it_ = (key: string, label: string, over: Partial<DisplayFeedItem> = {}): DisplayFeedItem => ({
  key: key.padEnd(16, "x").slice(0, 16),
  label,
  room: "Consultorio 2",
  practitioner: "Lic. Ríos",
  calledAt: null,
  ...over,
});

function feed(over: Partial<DisplayFeed> = {}): DisplayFeed {
  return {
    v: 1,
    serverNow: NOW,
    dayKey: "2026-10-22",
    clinicName: "Kinesio Centro",
    locationName: null,
    config: cfg(),
    hero: null,
    recent: [],
    waiting: [],
    waitingCount: 0,
    ...over,
  };
}

const render = (f: DisplayFeed) => renderToStaticMarkup(<TvScreen initialFeed={f} bootstrap={null} />);

describe("[TV-2u2] hero", () => {
  it("[TV-2u2] hero vacío: «Te damos la bienvenida.» sin el bloque de llamado", () => {
    const html = render(feed());
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Te damos la bienvenida.");
    expect(html).toContain("Cuando sea tu turno, vas a ver tu nombre en esta pantalla con el consultorio al que pasás.");
    expect(html).not.toContain('data-state="call"');
    expect(html).toContain('data-layout="none"');
  });

  it("[TV-2u2] hero con llamado: nombre corto, sala con ícono de puerta, profesional y «Pasá al …»", () => {
    const html = render(
      feed({ hero: it_("H1", "Laura P.", { calledAt: "2026-10-22T13:41:00.000Z" }) }),
    );
    expect(html).toContain('data-state="call"');
    expect(html).toContain(">Llamado</span>");
    expect(html).toMatch(/data-len="s"[^>]*>Laura P\.<\/p>/);
    expect(html).toMatch(/<span class="[^"]*"><svg[^>]*>.*?<\/svg>Consultorio 2<\/span>/);
    expect(html).toContain("Lic. Ríos");
    expect(html).toContain("Pasá al consultorio 2.");
    expect(html).toContain(">10:41<"); // hora del llamado en AR, no la del host
    expect(html).not.toContain("Te damos la bienvenida.");
    // El primer render (SSR) nunca anima ni anuncia: el llamado ya estaba en pantalla.
    expect(html).not.toContain('data-anim="new"');
    expect(html).toMatch(/aria-live="assertive" aria-atomic="true"><\/p>/);
  });

  it("[TV-2u2] los nombres largos arrancan más chicos (después se ajusta midiendo)", () => {
    expect(render(feed({ hero: it_("H", "María José G.") }))).toContain('data-len="m"');
    expect(render(feed({ hero: it_("H", "Turno de las 10:30") }))).toContain('data-len="l"');
  });

  it("[TV-2u2] destino y anuncio", () => {
    expect(destinationPhrase({ room: "Gimnasio", practitioner: null })).toBe("Pasá al gimnasio.");
    expect(destinationPhrase({ room: "Sala B", practitioner: null })).toBe("Pasá a Sala B.");
    expect(destinationPhrase({ room: null, practitioner: "Dra. Sosa" })).toBe("Te espera Dra. Sosa.");
    expect(destinationPhrase({ room: null, practitioner: null })).toBe("Acercate a recepción.");
    expect(callAnnouncement(it_("H", "Laura P."))).toBe("Llamado: Laura P. Pasá al consultorio 2. Con Lic. Ríos.");
  });
});

describe("[TV-2u2] columna", () => {
  it("[TV-2u2] «Próximos (N esperando)» con el total aunque la lista venga cortada", () => {
    const waiting = Array.from({ length: 12 }, (_, i) => it_(`W${i}`, `Paciente ${i}.`));
    const html = render(feed({ waiting, waitingCount: 15 }));
    expect(html).toMatch(/Próximos <span data-testid="tv-waiting-count">15 esperando<\/span>/);
    expect(html.match(/Paciente \d+\./g)).toHaveLength(12);
  });

  it("[TV-2u2] sin espera: «Nadie más esperando.» y sin conteo", () => {
    const html = render(feed());
    expect(html).toContain("Nadie más esperando.");
    expect(html).not.toContain("tv-waiting-count");
  });

  it("[TV-2u2] «Recién llamados» con «hace N min»", () => {
    const html = render(
      feed({ recent: [it_("R1", "Martín S.", { room: "Consultorio 1", calledAt: "2026-10-22T13:23:00.000Z" })] }),
    );
    expect(html).toContain("Recién llamados");
    expect(html).toContain("Martín S.<span> · Consultorio 1</span>");
    expect(html).toContain("hace 19 min");
    expect(agoLabel("2026-10-22T13:41:30.000Z", Date.parse(NOW))).toBe("recién");
  });
});

describe("[TV-2u2] encabezado, pie y tema", () => {
  it("[TV-2u2] consultorio + reloj/fecha AR + pie «¿Llegaste y no te anunciaste?…» + «En vivo»", () => {
    const html = render(feed({ locationName: "Sede Centro" }));
    expect(html).toContain(">Kinesio Centro</h1>");
    expect(html).toContain("Sede Centro · Sala de espera");
    expect(html).toContain(">KC</span>");
    expect(html).toContain(">10:42<");
    expect(html).toContain("jueves 22 de octubre");
    expect(html).toContain("¿Llegaste y no te anunciaste? Acercate a recepción.");
    expect(html).toContain("En vivo");
    expect(html).toContain(`con <b>${BRAND_NAME}</b>`);
  });

  it("[TV-2u2] reloj en hora AR en cualquier TZ del host", () => {
    expect(clockText(Date.parse("2026-10-23T02:30:00.000Z"))).toEqual({ time: "23:30", date: "jueves 22 de octubre" });
    expect(clinicInitials("Centro de Kinesiología del Sur")).toBe("CD");
    expect(clinicInitials("  ")).toBe("·");
  });

  it("[TV-2u2] tema oscuro por defecto; claro con LIGHT", () => {
    expect(render(feed())).toContain('data-theme="dark"');
    expect(render(feed({ config: cfg({ theme: "LIGHT" }) }))).toContain('data-theme="light"');
  });

  it("[TV-2u2] overlay de sonido «Tocá OK para activar el sonido» en el primer render", () => {
    const html = render(feed());
    expect(html).toContain('data-testid="tv-sound-hint"');
    expect(html).toContain("Tocá <b>OK</b> para activar el sonido");
  });
});

describe("[TV-2u2] layouts de video", () => {
  const VIDEO = { mediaKind: "VIDEO" as const, mediaRef: "dQw4w9WgXcQ" };

  it("[TV-2u2] sin media → layout del prototype; ref inválida = sin media", () => {
    expect(screenLayout(cfg(), true)).toBe("none");
    expect(mediaOf(cfg({ mediaKind: "VIDEO", mediaRef: "no valida!" }))).toBeNull();
    expect(screenLayout(cfg({ mediaKind: "VIDEO", mediaRef: "<script>" }), true)).toBe("none");
  });

  it("[TV-2u2] SIDE: recuadro de video en la columna; el reproductor oculto vuelve al prototype", () => {
    expect(screenLayout(cfg({ ...VIDEO, mediaLayout: "SIDE" }), true)).toBe("side");
    expect(screenLayout(cfg({ ...VIDEO, mediaLayout: "SIDE" }), false)).toBe("none");
    const html = render(feed({ config: cfg({ ...VIDEO, mediaLayout: "SIDE" }) }));
    expect(html).toContain('data-layout="side"');
    expect(html).toContain('data-visible="true"');
    // Sin recientes en SIDE no se pinta la línea vacía bajo el hero.
    expect(html).not.toContain("Recién llamados");
  });

  it("[TV-2u2] HERO_IDLE: video en el hero sin llamado; un llamado nuevo lo interrumpe", () => {
    const hero = it_("H", "Laura P.");
    expect(heroModeFor("hero-idle", null, false)).toBe("media");
    expect(heroModeFor("hero-idle", hero, false)).toBe("media");
    expect(heroModeFor("hero-idle", hero, true)).toBe("call");
    expect(heroModeFor("side", hero, false)).toBe("call");
    expect(heroModeFor("none", null, false)).toBe("idle");

    const idle = render(feed({ config: cfg({ ...VIDEO, mediaLayout: "HERO_IDLE" }) }));
    expect(idle).toContain('data-layout="hero-idle"');
    expect(idle).toContain('data-hero="media"');
    expect(idle).not.toContain("Te damos la bienvenida.");

    // Recién cargada con un llamado de hace 5 s: se muestra lo que queda de HERO_IDLE_CALL_MS.
    const fresh = render(
      feed({
        config: cfg({ ...VIDEO, mediaLayout: "HERO_IDLE" }),
        hero: it_("H", "Laura P.", { calledAt: "2026-10-22T13:41:55.000Z" }),
      }),
    );
    expect(fresh).toContain('data-hero="call"');
    const old = render(
      feed({
        config: cfg({ ...VIDEO, mediaLayout: "HERO_IDLE" }),
        hero: it_("H", "Laura P.", { calledAt: "2026-10-22T13:40:00.000Z" }),
      }),
    );
    expect(old).toContain('data-hero="media"');
  });
});

describe("[TV-2u2] motion y superficie pública", () => {
  const css = src("components/tv/tv.module.css");

  it("[TV-2u2] reduced motion: todas las animaciones se apagan y los keyframes solo tienen `from` (estado final natural)", () => {
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const sel of ['.hero[data-anim="new"]', '.hero[data-anim="new"] .heroName', '.hero[data-anim="new"] .room', ".q", ".r", ".soundHint"]) {
      expect(rm).toContain(sel);
    }
    expect(rm).toMatch(/animation:\s*none;/);
  });

  it("[TV-2u2] animaciones ≤ 600 ms y solo transform/opacity", () => {
    for (const m of css.matchAll(/animation:\s*\w+\s+(\d+)ms/g)) expect(Number(m[1])).toBeLessThanOrEqual(600);
    expect(css).not.toMatch(/infinite/);
    for (const m of css.matchAll(/@keyframes\s+\w+\s*\{([\s\S]*?)\}\s*\}?/g)) {
      const props = Array.from(m[1]!.matchAll(/([a-z-]+)\s*:/g), (p) => p[1]);
      for (const p of props) expect(["opacity", "transform"]).toContain(p);
    }
  });

  it("[TV-2u2] sin framer, toast, drawer, modal ni el hub de realtime de la app; realtime-js solo por import()", () => {
    for (const f of ["components/tv/tv-screen.tsx", "components/tv/use-display-live.ts", "components/tv/use-kiosk.ts"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/from ["'](framer-motion|motion\/react)["']/);
      expect(s, f).not.toMatch(/components\/ui\/(toast|drawer|modal|use-confirm)/i);
      expect(s, f).not.toMatch(/realtime-hub|realtime-provider|@\/lib\/realtime-token["']/);
      expect(s, f).not.toMatch(/^import[^;]*realtime-client-supabase/m);
    }
    expect(src("components/tv/use-display-live.ts")).toContain('import("@/lib/realtime-client-supabase")');
    expect(src("components/tv/tv-screen.tsx")).toContain('import("./youtube-pip")');
  });
});

describe("[TV-2u2] kiosco", () => {
  type L = () => void;
  function target() {
    const map = new Map<string, Set<L>>();
    return {
      map,
      addEventListener: (t: string, fn: L) => void (map.get(t) ?? map.set(t, new Set()).get(t)!).add(fn),
      removeEventListener: (t: string, fn: L) => void map.get(t)?.delete(fn),
      fire: (t: string) => [...(map.get(t) ?? [])].forEach((fn) => fn()),
    };
  }

  function setup(over: Partial<KioskDeps> = {}) {
    const win = target();
    const doc = Object.assign(target(), { visibilityState: "visible" });
    const release = vi.fn(async () => {});
    const deps = {
      win,
      doc,
      requestWakeLock: vi.fn(async () => ({ release })),
      requestFullscreen: vi.fn(async () => {}),
      unlockChime: vi.fn(),
      reload: vi.fn(),
      onCursorHidden: vi.fn(),
      onSoundUnlocked: vi.fn(),
      now: () => Date.now(),
      random: () => 0,
      ...over,
    };
    const kiosk = createKiosk(deps);
    return { kiosk, win, doc, deps, release };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("[TV-2u2] cursor oculto a los 3 s sin movimiento; un movimiento lo muestra y re-arma", async () => {
    const { kiosk, win, deps } = setup();
    kiosk.start();
    await vi.advanceTimersByTimeAsync(CURSOR_IDLE_MS - 1);
    expect(deps.onCursorHidden).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onCursorHidden).toHaveBeenLastCalledWith(true);
    win.fire("mousemove");
    expect(deps.onCursorHidden).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(CURSOR_IDLE_MS - 1);
    expect(deps.onCursorHidden).toHaveBeenCalledTimes(2);
    win.fire("mousemove"); // sigue visible: no repite el aviso
    expect(deps.onCursorHidden).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CURSOR_IDLE_MS);
    expect(deps.onCursorHidden).toHaveBeenLastCalledWith(true);
    kiosk.stop();
  });

  it("[TV-2u2] overlay de sonido: la primera tecla (OK) desbloquea una vez y pide pantalla completa", async () => {
    const { kiosk, win, deps } = setup();
    kiosk.start();
    expect(deps.unlockChime).toHaveBeenCalledTimes(1); // instalado antes del gesto
    win.fire("keydown");
    win.fire("pointerdown");
    expect(deps.onSoundUnlocked).toHaveBeenCalledTimes(1);
    expect(deps.requestFullscreen).toHaveBeenCalledTimes(1);
    kiosk.stop();
  });

  it("[TV-2u2] un fullscreen negado no rompe el desbloqueo", async () => {
    const { kiosk, win, deps } = setup({ requestFullscreen: vi.fn(() => Promise.reject(new Error("denied"))) });
    kiosk.start();
    win.fire("pointerdown");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onSoundUnlocked).toHaveBeenCalledTimes(1);
    kiosk.stop();
  });

  it("[TV-2u2] wakeLock al arrancar y re-adquirido al volver a visible", async () => {
    const { kiosk, doc, deps, release } = setup();
    kiosk.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.requestWakeLock).toHaveBeenCalledTimes(1);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.requestWakeLock).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.requestWakeLock).toHaveBeenCalledTimes(2);
    kiosk.stop();
    expect(release).toHaveBeenCalled();
  });

  it("[TV-2u2] sin wakeLock en el navegador, sigue andando", () => {
    const { kiosk, deps } = setup({ requestWakeLock: null });
    expect(() => kiosk.start()).not.toThrow();
    expect(deps.onSoundUnlocked).not.toHaveBeenCalled();
    kiosk.stop();
  });

  it("[TV-2u2] recarga diaria a las 04:00 AR", async () => {
    // 10:42 AR → 04:00 AR de mañana = 17 h 18 min.
    expect(msUntilNextDailyReload(Date.parse(NOW))).toBe((17 * 60 + 18) * 60_000);
    // 03:59 AR → 1 min; 04:00 AR exacto → la de mañana.
    expect(msUntilNextDailyReload(Date.parse("2026-10-22T06:59:00.000Z"))).toBe(60_000);
    expect(msUntilNextDailyReload(Date.parse("2026-10-22T07:00:00.000Z"))).toBe(86_400_000);
    // 23:30 AR (02:30 UTC del día siguiente) → 4 h 30 min.
    expect(msUntilNextDailyReload(Date.parse("2026-10-23T02:30:00.000Z"))).toBe(4.5 * 3_600_000);

    const { kiosk, deps } = setup();
    kiosk.start();
    await vi.advanceTimersByTimeAsync((17 * 60 + 18) * 60_000 - 1);
    expect(deps.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    kiosk.stop();
  });
});
