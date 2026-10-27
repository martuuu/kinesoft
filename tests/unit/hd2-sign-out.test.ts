/**
 * HD-2 (§27 E) e IN-3 (§27 C): la ruta REAL `POST /api/auth/sign-out`, con el `getSupabaseServerClient` real y
 * `@supabase/ssr` real (mismo harness que `sign-in-session-mode.test.ts`).
 *
 * Se reemplaza solo la red (`fetch` a GoTrue: `/auth/v1/logout`), la cookie store de `next/headers` y el cierre del
 * soporte (`endSupportSession`, que va a la base y no es lo que se prueba). Se afirma el efecto observable: qué
 * `Set-Cookie` quedaron y adónde redirige.
 *
 * HD-2: con GoTrue caído (`/logout` 500) supabase-js devuelve `{ error }` y NO borra la sesión local (`_signOut` solo
 * sigue de largo con 401/403/404): antes la persona tocaba «Cerrar sesión», volvía al login… y seguía logueada.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

vi.hoisted(() => {
  const g = globalThis as { WebSocket?: unknown };
  if (!g.WebSocket) g.WebSocket = class {};
});

const prevEnv = vi.hoisted(() => {
  const prev = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  return prev;
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = prevEnv.key;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T extends (...a: never[]) => unknown>(fn: T) => fn };
});

type Opts = Record<string, unknown>;
const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  sets: [] as Array<{ name: string; value: string; options: Opts }>,
}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    getAll: () => [...jar.values].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.values.has(name),
    set: (name: string, value: string, options: Opts = {}) => {
      jar.sets.push({ name, value, options });
      if (options.maxAge === 0) jar.values.delete(name);
      else jar.values.set(name, value);
    },
    delete: (name: string) => jar.values.delete(name),
  }),
  headers: () => new Headers(),
}));
vi.mock("@/lib/support-session-internal", () => ({ endSupportSession: async () => {} }));

import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { IDLE_COOKIE, idleSignOutAction } from "@/lib/idle-logout";

const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
const SB = "sb-proj-auth-token";

/** Sesión vigente en el formato de `@supabase/ssr` (base64url), partida en `.0`/`.1` como hace con tokens largos. */
function seedChunkedSession() {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: "access-r-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "r-1",
    user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "k@t.local" },
  };
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const cut = Math.floor(raw.length / 2);
  jar.values.set(`${SB}.0`, raw.slice(0, cut));
  jar.values.set(`${SB}.1`, raw.slice(cut));
  // El verificador del PKCE de un OAuth a medias también es `sb-*` y tampoco tiene que quedar.
  jar.values.set(`${SB}-code-verifier`, "verifier");
  // Ajenas a Supabase: no se tocan por ser `sb-*` (no lo son).
  jar.values.set("kine_theme", "x");
}

const realFetch = globalThis.fetch;
let logoutStatus = 204;
let logoutCalls = 0;
beforeEach(() => {
  jar.values.clear();
  jar.sets.length = 0;
  logoutCalls = 0;
  logoutStatus = 204;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/logout")) {
      logoutCalls++;
      if (logoutStatus === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ code: "unexpected_failure", msg: "boom" }), {
        status: logoutStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const req = (path = "/api/auth/sign-out") => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN } });
const clearedSb = () => jar.sets.filter((c) => c.name.startsWith("sb-") && c.options.maxAge === 0).map((c) => c.name);

describe("[HD-2] sign-out con GoTrue caído", () => {
  it("[HD-2] /auth/v1/logout 500 → todas las sb-* con Max-Age 0, warn y 303 al login", async () => {
    seedChunkedSession();
    const warn = vi.spyOn(logger, "warn");
    logoutStatus = 500;
    const res = await signOut(req());
    expect(logoutCalls).toBeGreaterThan(0);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(new Set(clearedSb())).toEqual(new Set([`${SB}.0`, `${SB}.1`, `${SB}-code-verifier`]));
    // Con las mismas opciones con que se escribieron (si no coinciden path/flags, el navegador no las pisa).
    for (const c of jar.sets.filter((s) => s.name.startsWith("sb-"))) {
      expect(c.options).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
    }
    expect([...jar.values.keys()].filter((n) => n.startsWith("sb-"))).toEqual([]);
    expect(jar.values.get("kine_theme")).toBe("x");
    expect(warn).toHaveBeenCalledWith("auth.sign_out_failed", expect.objectContaining({ status: 500 }));
    // Nunca el token en el log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("access-r-1");
  });

  it("[HD-2] signOut que TIRA (red caída) → mismo resultado, sin 500", async () => {
    seedChunkedSession();
    const warn = vi.spyOn(logger, "warn");
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await signOut(req());
    expect(res.status).toBe(303);
    expect([...jar.values.keys()].filter((n) => n.startsWith("sb-"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith("auth.sign_out_failed", expect.anything());
  });

  it("[HD-2] control: /logout 204 → igual que hoy (supabase borra su sesión, sin warn, 303)", async () => {
    seedChunkedSession();
    const warn = vi.spyOn(logger, "warn");
    const res = await signOut(req());
    expect(logoutCalls).toBe(1);
    expect(res.status).toBe(303);
    expect([...jar.values.keys()].filter((n) => n.startsWith("sb-") && !n.endsWith("code-verifier"))).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith("auth.sign_out_failed", expect.anything());
    // Lo de siempre: preferencia de sesión borrada.
    expect(jar.sets.some((c) => c.name === "kine_session_mode" && c.options.maxAge === 0)).toBe(true);
  });
});

describe("[IN-3] sign-out y el cierre por inactividad", () => {
  it("[IN-3] borra kine_idle (mismo path) y conserva el next interno de /login?reason=idle&next=…", async () => {
    seedChunkedSession();
    jar.values.set(IDLE_COOKIE, "1793113200.15.a1b2c3d4e5f6");
    const action = idleSignOutAction("/agenda?fecha=2026-10-27&vista=dia");
    const res = await signOut(req(action));
    expect(res.status).toBe(303);
    const idle = jar.sets.filter((c) => c.name === IDLE_COOKIE);
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ value: "", options: { path: "/", maxAge: 0, sameSite: "lax" } });
    // El cliente la escribe legible por JS: el borrado no puede ser httpOnly-only distinto en path/flags relevantes.
    expect(idle[0].options.httpOnly).toBeFalsy();
    expect(jar.values.has(IDLE_COOKIE)).toBe(false);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("reason")).toBe("idle");
    expect(loc.searchParams.get("next")).toBe("/agenda?fecha=2026-10-27&vista=dia");
  });

  it("[IN-3] mismo chequeo de Origin: un POST de otro sitio no desloguea ni borra nada", async () => {
    jar.values.set(IDLE_COOKIE, "1793113200.15.a1b2c3d4e5f6");
    const res = await signOut(
      new Request(`${ORIGIN}${idleSignOutAction("/agenda")}`, { method: "POST", headers: { origin: "https://evil.test" } })
    );
    expect(res.status).toBe(403);
    expect(jar.sets).toEqual([]);
    expect(logoutCalls).toBe(0);
  });
});
