/**
 * IN-S (§27, IN): piezas puras del cliente (`components/layout/idle-logout.tsx`) y el guard de imports `[IN-6]`.
 * Símbolos reales: el componente importa `next/dynamic` y React, que en node cargan sin DOM.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";
import { IDLE_DEFAULT_MINUTES, serializeIdleCookie } from "@/lib/idle-logout";
import {
  IDLE_ACTIVITY_EVENTS,
  IDLE_MOVE_THROTTLE_MS,
  IDLE_TICK_MS,
  IDLE_TICK_WARNING_MS,
  IDLE_WRITE_EVERY_MS,
  clockOffsetMs,
  countsAsActivity,
  idleTick,
  readCookieValue,
  shouldWriteIdleCookie,
} from "@/components/layout/idle-logout";
import { idleLiveMessage } from "@/components/layout/idle-warning-modal";

const TAG = "a1b2c3d4e5f6";
const LAST = Date.UTC(2026, 9, 27, 15, 0, 0);
const MIN = IDLE_DEFAULT_MINUTES;
const T = LAST + MIN * 60_000;

describe("[IN-1c] cliente: reloj del server, throttle y escrituras", () => {
  it("offset = serverNowMs − Date.now() al montar; la cookie sale en hora del server", () => {
    // PC atrasada 7 minutos: el server dice 15:07, el equipo 15:00.
    const server = LAST + 7 * 60_000;
    const offset = clockOffsetMs(server, LAST);
    expect(offset).toBe(7 * 60_000);
    const lastServerMs = LAST + 1_000 + offset;
    expect(serializeIdleCookie(lastServerMs, MIN, TAG)).toBe(`${Math.floor((server + 1_000) / 1000)}.15.${TAG}`);
    expect(clockOffsetMs(Number.NaN, LAST)).toBe(0);
  });

  it("actividad: solo eventos confiables; pointermove con throttle de 5 s; visibilitychange y otros no", () => {
    expect(IDLE_ACTIVITY_EVENTS).toEqual(["pointerdown", "keydown", "wheel", "touchstart", "scroll"]);
    for (const t of IDLE_ACTIVITY_EVENTS) {
      expect(countsAsActivity(t, true, 1_000, 0)).toBe(true);
      expect(countsAsActivity(t, false, 1_000, 0)).toBe(false);
    }
    expect(countsAsActivity("pointermove", true, 10_000, 10_000 - IDLE_MOVE_THROTTLE_MS)).toBe(true);
    expect(countsAsActivity("pointermove", true, 10_000, 10_000 - IDLE_MOVE_THROTTLE_MS + 1)).toBe(false);
    expect(countsAsActivity("pointermove", true, 10_000, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(countsAsActivity("pointermove", false, 10_000, Number.NEGATIVE_INFINITY)).toBe(false);
    for (const t of ["visibilitychange", "focus", "message", "mousemove", "click"]) {
      expect(countsAsActivity(t, true, 1_000, 0)).toBe(false);
    }
  });

  it("la cookie se escribe como mucho cada 5 s y solo con actividad nueva", () => {
    expect(IDLE_WRITE_EVERY_MS).toBe(5_000);
    expect(shouldWriteIdleCookie(10_000, 9_000, 4_000, 4_999)).toBe(true);
    expect(shouldWriteIdleCookie(10_000, 9_000, 4_000, 5_001)).toBe(false);
    expect(shouldWriteIdleCookie(10_000, 4_000, 4_000, 0)).toBe(false);
    expect(IDLE_TICK_MS).toBe(5_000);
    expect(IDLE_TICK_WARNING_MS).toBe(1_000);
  });

  it("readCookieValue lee kine_idle entre otras cookies", () => {
    expect(readCookieValue(`a=1; kine_idle=${LAST / 1000}.15.${TAG}; b=2`, "kine_idle")).toBe(`${LAST / 1000}.15.${TAG}`);
    expect(readCookieValue("a=1; kine_idle_x=3", "kine_idle")).toBeNull();
    expect(readCookieValue("", "kine_idle")).toBeNull();
  });
});

describe("[IN-1c] cliente: tick", () => {
  const own = serializeIdleCookie(LAST, MIN, TAG);

  it("sin cookie de esta sesión y sin haberla visto → init con now (primer render después del login)", () => {
    expect(idleTick({ now: LAST, localLast: 0, cookieRaw: null, tag: TAG, minutes: MIN, seen: false })).toEqual({
      kind: "init",
      last: LAST,
    });
    const foreign = serializeIdleCookie(LAST, MIN, "otraotra0000");
    expect(idleTick({ now: LAST, localLast: 0, cookieRaw: foreign, tag: TAG, minutes: MIN, seen: false }).kind).toBe("init");
  });

  it("cookie borrada o de otra sesión DESPUÉS de verla → gone (otra pestaña cerró; nunca se re-escribe encima)", () => {
    expect(idleTick({ now: LAST, localLast: LAST, cookieRaw: null, tag: TAG, minutes: MIN, seen: true }).kind).toBe("gone");
    const foreign = serializeIdleCookie(LAST, MIN, "otraotra0000");
    expect(idleTick({ now: LAST, localLast: LAST, cookieRaw: foreign, tag: TAG, minutes: MIN, seen: true }).kind).toBe(
      "gone"
    );
  });

  it("al montar con la cookie de esta sesión NO reinicia el reloj (recargar en el borde no regala 15 min)", () => {
    const r = idleTick({ now: T + 30_000, localLast: 0, cookieRaw: own, tag: TAG, minutes: MIN, seen: false });
    expect(r).toMatchObject({ kind: "phase", phase: "expired", last: LAST });
  });

  it("bordes: T−61 activo, T−60 aviso con 60 s, T vencido; la actividad de otra pestaña (cookie) gana", () => {
    expect(idleTick({ now: T - 61_000, localLast: LAST, cookieRaw: own, tag: TAG, minutes: MIN, seen: true })).toMatchObject({
      phase: "active",
    });
    expect(idleTick({ now: T - 60_000, localLast: LAST, cookieRaw: own, tag: TAG, minutes: MIN, seen: true })).toMatchObject({
      phase: "warning",
      seconds: 60,
    });
    expect(idleTick({ now: T, localLast: LAST, cookieRaw: own, tag: TAG, minutes: MIN, seen: true })).toMatchObject({
      phase: "expired",
      seconds: 0,
    });
    const otherTab = serializeIdleCookie(T - 10_000, MIN, TAG);
    expect(idleTick({ now: T, localLast: LAST, cookieRaw: otherTab, tag: TAG, minutes: MIN, seen: true })).toMatchObject({
      phase: "active",
      last: T - 10_000,
    });
    // Actividad local más nueva que la cookie (todavía sin escribir): gana la local.
    expect(idleTick({ now: T, localLast: T - 2_000, cookieRaw: own, tag: TAG, minutes: MIN, seen: true })).toMatchObject({
      phase: "active",
      last: T - 2_000,
    });
  });

  it("aria-live solo cambia en tres escalones (60, 30, 10)", () => {
    const seen = new Set<string>();
    for (let s = 60; s >= 1; s--) seen.add(idleLiveMessage(s));
    expect([...seen]).toEqual(["Quedan 60 segundos.", "Quedan 30 segundos.", "Quedan 10 segundos."]);
    expect(idleLiveMessage(31)).toBe("Quedan 60 segundos.");
    expect(idleLiveMessage(30)).toBe("Quedan 30 segundos.");
    expect(idleLiveMessage(10)).toBe("Quedan 10 segundos.");
  });
});

// ── [IN-6] guard de imports ─────────────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCES = ["app", "components", "lib", "hooks"].flatMap((d) => walk(join(ROOT, d)));
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const importsOf = (file: string, mod: RegExp) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].some((m) => mod.test(m[1]));

describe("[IN-6] quién carga el cierre por inactividad", () => {
  it("[IN-6] solo AppShell importa idle-logout", () => {
    // El componente (`components/layout/idle-logout`), no el módulo puro `lib/idle-logout` (ese lo usan server y login).
    const resolves = (file: string, spec: string) =>
      spec === "@/components/layout/idle-logout" ||
      (spec.startsWith(".") && rel(join(file, "..", spec)) === "components/layout/idle-logout");
    const importers = SOURCES.filter((f) =>
      [...readFileSync(f, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].some((m) => resolves(f, m[1]))
    ).map(rel);
    expect(importers).toEqual(["components/layout/app-shell.tsx"]);
  });

  it("[IN-6] el modal va por next/dynamic (nadie lo importa estático) y no importa idle-logout", () => {
    const logout = src("components/layout/idle-logout.tsx");
    expect(logout).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/idle-warning-modal"\)/);
    const staticImporters = SOURCES.filter((f) =>
      [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].some((m) => /idle-warning-modal$/.test(m[1]))
    ).map(rel);
    expect(staticImporters).toEqual([]);
    expect(src("components/layout/idle-warning-modal.tsx")).not.toMatch(/from\s+["'][^"']*idle-logout["']/);
  });

  // ZF1b: Plataforma SÍ consulta el chequeo de SERVER (`lib/idle-logout-internal`, redirect con la sesión vencida); lo
  // que no puede cargar es el cliente (`components/layout/idle-logout`), el modal ni el AppShell.
  it("[IN-6] (display) (/tv), portal y Plataforma no lo importan (ni AppShell)", () => {
    const outside = SOURCES.map(rel).filter(
      (f) => f.startsWith("app/(display)/") || f.startsWith("app/(portal)/") || f.startsWith("app/(platform)/")
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const f of outside) {
      expect(importsOf(join(ROOT, f), /layout\/idle-logout$|idle-warning-modal|layout\/app-shell$/), f).toBe(false);
    }
  });

  it("[IN-6] bundle: idle-logout sin framer, sin zod y sin módulos de server", () => {
    const logout = src("components/layout/idle-logout.tsx");
    const mods = [...logout.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(mods.sort()).toEqual(["@/lib/idle-logout", "next/dynamic", "react"]);
    expect(src("lib/idle-logout.ts")).not.toMatch(/^import /m);
  });

  it("[IN-6] el layout (app) corta con redirect ANTES del actor y de los loaders (nunca `return <IdleExpired/>`)", () => {
    const layout = src("app/(app)/layout.tsx");
    // `return <IdleExpired/>` no alcanzaba: la página hija va aparte en el seedData del payload RSC y corría igual.
    const code = layout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/<IdleExpired/);
    const cut = layout.indexOf('if (idle.kind === "expired") redirect(idleLoginHref(nextPath));');
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(layout.indexOf("await tryGetActor()"));
    expect(cut).toBeLessThan(layout.indexOf("getUserPreferences()"));
    expect(layout).toContain("idle={idle.kind === \"on\" ? idle.idle : null}");
  });
});
