/**
 * «Mantenerme conectado» (tanda B, §22.13) de punta a punta: la ruta REAL `POST /api/auth/sign-in`, el
 * `getSupabaseServerClient` real y `@supabase/ssr` real escribiendo las cookies; y el middleware real refrescando.
 *
 * Se reemplaza solo la red (`fetch` a GoTrue: `/auth/v1/token`) y la cookie store de `next/headers`. Se afirma el
 * efecto observable: con qué opciones quedó cada `Set-Cookie` de sesión.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

// supabase-js arma su cliente realtime al construirse y en Node 20 exige un `WebSocket` global (Vercel corre Node 22,
// que lo trae). Acá nunca se abre un socket: alcanza con que exista el constructor.
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

// `react.cache` (de `lib/session.ts`, que importa `lib/tenant-choice.ts`) solo existe en el build de React Server.
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

import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { middleware } from "@/middleware";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
const SB = "sb-proj-auth-token";

function gotrueSession(refresh: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: `access-${refresh}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: refresh,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      aud: "authenticated",
      role: "authenticated",
      email: "kine@test.local",
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

const realFetch = globalThis.fetch;
let tokenCalls: string[] = [];
beforeEach(() => {
  __rateLimitInternals.reset();
  jar.values.clear();
  jar.sets.length = 0;
  tokenCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/token")) {
      const grant = new URL(url).searchParams.get("grant_type") ?? "";
      tokenCalls.push(grant);
      return new Response(JSON.stringify(gotrueSession(grant === "refresh_token" ? "r-2" : "r-1")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

let ip = 0;
function loginReq(fields: Array<[string, string]>) {
  const body = new FormData();
  body.set("email", "kine@test.local");
  body.set("password", "una-clave");
  for (const [k, v] of fields) body.append(k, v);
  return new Request(`${ORIGIN}/api/auth/sign-in?next=/agenda`, {
    method: "POST",
    body,
    headers: { origin: ORIGIN, "x-forwarded-for": `10.9.0.${++ip}` },
  });
}

const sessionSets = () => jar.sets.filter((c) => c.name.startsWith(SB) && c.value !== "");
const prefSets = () => jar.sets.filter((c) => c.name === "kine_session_mode");

describe("[B5] sign-in · «Mantenerme conectado»", () => {
  it("tildado (hidden 0 + checkbox 1): cookies de sesión con maxAge (persistente) y se borra una preferencia vieja", async () => {
    jar.values.set("kine_session_mode", "ephemeral"); // otra persona, antes, en este navegador
    const res = await signIn(loginReq([["remember", "0"], ["remember", "1"]]));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/agenda");
    expect(tokenCalls).toEqual(["password"]);
    expect(sessionSets().length).toBeGreaterThan(0);
    for (const c of sessionSets()) expect(c.options.maxAge).toBe(400 * 24 * 60 * 60);
    expect(prefSets()).toEqual([{ name: "kine_session_mode", value: "", options: expect.objectContaining({ maxAge: 0 }) }]);
    expect(jar.values.has("kine_session_mode")).toBe(false);
  });

  it("destildado (solo hidden 0): cookies de sesión SIN maxAge/expires + kine_session_mode=ephemeral httpOnly", async () => {
    const res = await signIn(loginReq([["remember", "0"]]));
    expect(res.status).toBe(303);
    expect(sessionSets().length).toBeGreaterThan(0);
    for (const c of sessionSets()) {
      expect(c.options.maxAge).toBeUndefined();
      expect(c.options.expires).toBeUndefined();
      expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    }
    const [pref] = prefSets();
    expect(pref).toMatchObject({ value: "ephemeral", options: { httpOnly: true, sameSite: "lax", path: "/" } });
    expect(pref.options.maxAge).toBeUndefined();
  });

  it("sin el campo (página de login cacheada de antes del deploy) = persistente, como antes", async () => {
    await signIn(loginReq([]));
    for (const c of sessionSets()) expect(c.options.maxAge).toBe(400 * 24 * 60 * 60);
    expect(prefSets()[0]?.value).toBe("");
  });

  it("login fallido no escribe la preferencia", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const res = await signIn(loginReq([["remember", "0"]]));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_credentials");
    expect(prefSets()).toEqual([]);
    expect(sessionSets()).toEqual([]);
  });
});

/** Cookie de sesión de `@supabase/ssr` (base64url) con el access token ya vencido → el middleware refresca. */
function expiredSessionCookie(): string {
  const s = { ...gotrueSession("r-1"), expires_at: Math.floor(Date.now() / 1000) - 60 };
  return "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url");
}

function mwReq(path: string, cookies: Record<string, string>) {
  const req = new NextRequest(`${ORIGIN}${path}`);
  for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

function setCookieHeaders(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  return h.getSetCookie ? h.getSetCookie() : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/);
}

describe("[B5] middleware · el refresh respeta el modo", () => {
  it("con kine_session_mode=ephemeral el refresh reescribe la sesión SIN Max-Age/Expires", async () => {
    const res = await middleware(mwReq("/agenda", { [SB]: expiredSessionCookie(), kine_session_mode: "ephemeral" }));
    expect(tokenCalls).toEqual(["refresh_token"]);
    const sb = setCookieHeaders(res).filter((c) => c.startsWith(`${SB}=`) && !c.startsWith(`${SB}=;`));
    expect(sb.length).toBeGreaterThan(0);
    for (const c of sb) {
      expect(c).not.toMatch(/max-age/i);
      expect(c).not.toMatch(/expires=/i);
      expect(c).toMatch(/httponly/i);
    }
    // La preferencia sigue: hay sesión.
    expect(setCookieHeaders(res).some((c) => c.startsWith("kine_session_mode="))).toBe(false);
  });

  it("sin la preferencia el refresh es persistente (Max-Age de 400 días), como antes", async () => {
    const res = await middleware(mwReq("/agenda", { [SB]: expiredSessionCookie() }));
    const sb = setCookieHeaders(res).filter((c) => c.startsWith(`${SB}=`) && !c.startsWith(`${SB}=;`));
    expect(sb.length).toBeGreaterThan(0);
    for (const c of sb) expect(c).toMatch(/max-age=34560000/i);
  });

  it("preferencia sin sesión (cerró sesión sin cerrar el navegador) → se borra en la próxima navegación", async () => {
    const res = await middleware(mwReq("/login", { kine_session_mode: "ephemeral" }));
    const pref = setCookieHeaders(res).filter((c) => c.startsWith("kine_session_mode="));
    expect(pref).toHaveLength(1);
    expect(pref[0]).toMatch(/max-age=0/i);
    // En las rutas de auth no: ahí escribe la misma respuesta del handler.
    for (const p of ["/api/auth/sign-in", "/auth/callback"]) {
      const r = await middleware(mwReq(p, { kine_session_mode: "ephemeral" }));
      expect(setCookieHeaders(r).some((c) => c.startsWith("kine_session_mode="))).toBe(false);
    }
  });

  it("AUDIT §5.3 intacto: strip de x-tenant-* del cliente y x-request-id en la respuesta", async () => {
    const req = new NextRequest(`${ORIGIN}/agenda`, { headers: { "x-tenant-id": "evil", "x-tenant-slug": "evil" } });
    req.cookies.set(SB, expiredSessionCookie());
    req.cookies.set("kine_session_mode", "ephemeral");
    const res = await middleware(req);
    expect(res.headers.get("x-request-id")).toMatch(/^[a-zA-Z0-9_-]{8,64}$/);
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBeNull();
  });
});
