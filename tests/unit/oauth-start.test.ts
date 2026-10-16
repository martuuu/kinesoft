/**
 * PL-2e (C-PL12) · arranque de OAuth: `POST /api/auth/oauth/[provider]` y el alias `POST /api/auth/google`.
 *
 * Handlers REALES (`lib/oauth-start.ts` detrás). Se reemplaza solo la red: el cliente de Supabase del server
 * (`signInWithOAuth`, que en la realidad arma la URL y escribe la cookie del PKCE) y `fetch` a
 * `/auth/v1/settings` de GoTrue. El rate limit es el real (en memoria, sin Upstash en unit).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// `env` se arma al importar: Supabase tiene que estar "configurado" para que se consulte `/auth/v1/settings`.
// Se restaura al final: el worker de vitest reusa `process.env` para el archivo siguiente.
const prevEnv = vi.hoisted(() => {
  const prev = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
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

const sb = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; options?: { redirectTo?: string; scopes?: string } }>,
  error: null as null | { message: string },
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      signInWithOAuth: async (args: { provider: string; options?: { redirectTo?: string } }) => {
        sb.calls.push(args);
        if (sb.error) return { data: { provider: args.provider, url: null }, error: sb.error };
        return {
          data: { provider: args.provider, url: `https://proj.supabase.test/auth/v1/authorize?provider=${args.provider}` },
          error: null,
        };
      },
    },
  }),
}));

import { POST as oauthPOST } from "@/app/api/auth/oauth/[provider]/route";
import { POST as googlePOST } from "@/app/api/auth/google/route";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  __resetOAuthSettingsCacheForTests,
  isProviderEnabled,
  OAUTH_PROVIDERS,
  parseOAuthProvider,
} from "@/lib/oauth-start";
import { env } from "@/lib/env";

const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
let ipSeq = 0;
let settings: { status: number; body: unknown } | "throw" = { status: 200, body: { external: { google: true, facebook: true } } };
let settingsHits = 0;

function req(path: string, headers: Record<string, string> = {}, ip?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": ip ?? `10.1.0.${++ipSeq}`, ...headers },
  });
}
const callOAuth = (provider: string, query = "", headers: Record<string, string> = {}, ip?: string) =>
  oauthPOST(req(`/api/auth/oauth/${provider}${query}`, headers, ip), { params: { provider } });

const loginErr = (res: Response) => {
  const u = new URL(res.headers.get("location")!);
  return { path: u.pathname, error: u.searchParams.get("error"), next: u.searchParams.get("next") };
};

beforeEach(() => {
  __rateLimitInternals.reset();
  __resetOAuthSettingsCacheForTests();
  sb.calls.length = 0;
  sb.error = null;
  settings = { status: 200, body: { external: { google: true, facebook: true } } };
  settingsHits = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (!u.endsWith("/auth/v1/settings")) throw new Error(`fetch inesperado: ${u}`);
    settingsHits += 1;
    if (settings === "throw") throw new Error("network down");
    return new Response(JSON.stringify(settings.body), { status: settings.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("allowlist de proveedores", () => {
  it("solo google y facebook", () => {
    expect([...OAUTH_PROVIDERS]).toEqual(["google", "facebook"]);
    expect(parseOAuthProvider("google")).toBe("google");
    expect(parseOAuthProvider("facebook")).toBe("facebook");
    for (const p of ["github", "Google", "", "apple", "google ", "__proto__", "constructor"]) {
      expect(parseOAuthProvider(p)).toBeNull();
    }
    expect(parseOAuthProvider(null)).toBeNull();
  });

  it("un proveedor fuera de la allowlist → 404 sin llegar a Supabase", async () => {
    for (const p of ["github", "azure", "x"]) {
      const res = await callOAuth(p);
      expect(res.status).toBe(404);
    }
    expect(sb.calls).toHaveLength(0);
  });
});

describe("POST /api/auth/oauth/[provider]", () => {
  it.each(["google", "facebook"])("%s → 303 a Supabase con redirectTo al callback propio y next saneado", async (p) => {
    const res = await callOAuth(p, `?next=${encodeURIComponent("/onboarding")}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://proj.supabase.test/auth/v1/authorize?provider=${p}`);
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0].provider).toBe(p);
    expect(sb.calls[0].options?.redirectTo).toBe(`${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=%2Fonboarding`);
    // Sin scopes propios: GoTrue ya pide `email` (sumar scopes los concatena con su separador).
    expect(sb.calls[0].options?.scopes).toBeUndefined();
  });

  it("origen ajeno → 403 sin llegar a Supabase", async () => {
    const res = await callOAuth("facebook", "", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const cross = await callOAuth("google", "", { origin: "", "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(sb.calls).toHaveLength(0);
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "@evil.com", "/%09/evil.com"])(
    "next malicioso %s → se reemplaza por /dashboard",
    async (bad) => {
      await callOAuth("facebook", `?next=${encodeURIComponent(bad)}`);
      const redirectTo = new URL(sb.calls[0].options!.redirectTo!);
      expect(redirectTo.origin).toBe(new URL(env.NEXT_PUBLIC_APP_URL).origin);
      expect(redirectTo.pathname).toBe("/auth/callback");
      const next = redirectTo.searchParams.get("next")!;
      expect(next === "/dashboard" || (next.startsWith("/") && !next.startsWith("//"))).toBe(true);
      expect(new URL(next, "http://x.invalid").origin).toBe("http://x.invalid");
    }
  );

  it("rate limit compartido entre proveedores (10/min por IP) → 303 a /login?error=rate_limited con next", async () => {
    const ip = "10.9.9.9";
    for (let i = 0; i < 5; i++) expect((await callOAuth("google", "?next=/portal", {}, ip)).status).toBe(303);
    for (let i = 0; i < 5; i++) expect((await callOAuth("facebook", "?next=/portal", {}, ip)).status).toBe(303);
    const res = await callOAuth("facebook", "?next=/portal", {}, ip);
    expect(res.status).toBe(303);
    expect(loginErr(res)).toEqual({ path: "/login", error: "rate_limited", next: "/portal" });
    expect(sb.calls).toHaveLength(10);
  });

  it("proveedor apagado en Supabase → /login?error=provider_disabled, sin signInWithOAuth", async () => {
    settings = { status: 200, body: { external: { google: true, facebook: false } } };
    const res = await callOAuth("facebook", "?next=/onboarding");
    expect(loginErr(res)).toEqual({ path: "/login", error: "provider_disabled", next: "/onboarding" });
    expect(sb.calls).toHaveLength(0);
    // Google sigue andando con la misma config (y la cache evita otra consulta).
    expect((await callOAuth("google")).headers.get("location")).toContain("provider=google");
    expect(settingsHits).toBe(1);
  });

  it("si /auth/v1/settings falla (red o 5xx) el login sigue: es UX, no un control", async () => {
    settings = "throw";
    expect((await callOAuth("facebook")).headers.get("location")).toContain("provider=facebook");
    __resetOAuthSettingsCacheForTests();
    settings = { status: 503, body: {} };
    expect((await callOAuth("facebook")).headers.get("location")).toContain("provider=facebook");
  });

  // VX-Z (B5): sin caché negativo, con GoTrue caído o lento cada render del login/signup/turnero volvía a esperar el
  // timeout de 1,5 s por proveedor (`visibleOAuthProviders` los consulta en serie).
  it.each([
    ["red", "throw" as const],
    ["5xx", { status: 503, body: {} }],
    ["forma rara", { status: 200, body: { nope: true } }],
  ])("falla (%s) → null y caché negativo de 15 s: no reconsulta hasta que vence", async (_k, cfg) => {
    settings = cfg;
    const t0 = 1_000_000;
    expect(await isProviderEnabled("google", t0)).toBeNull();
    expect(await isProviderEnabled("facebook", t0 + 14_999)).toBeNull();
    expect(settingsHits).toBe(1);
    // Vencido el caché negativo se vuelve a consultar, y una respuesta buena entra al caché normal de 60 s.
    settings = { status: 200, body: { external: { google: true, facebook: false } } };
    expect(await isProviderEnabled("google", t0 + 15_000)).toBe(true);
    expect(await isProviderEnabled("facebook", t0 + 15_001)).toBe(false);
    expect(settingsHits).toBe(2);
  });

  it("error de Supabase al armar la URL → /login?error=oauth_failed (sin el texto de Supabase)", async () => {
    sb.error = { message: "Unsupported provider <script>" };
    const res = await callOAuth("google", "?next=/c/demo/booking");
    expect(loginErr(res)).toEqual({ path: "/login", error: "oauth_failed", next: "/c/demo/booking" });
    expect(res.headers.get("location")).not.toContain("script");
  });
});

describe("alias POST /api/auth/google (portal y turnero)", () => {
  it("sigue andando: 303 a Supabase con provider google y el next del portal", async () => {
    const res = await googlePOST(req(`/api/auth/google?next=${encodeURIComponent("/portal/c/demo")}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("provider=google");
    expect(sb.calls[0].provider).toBe("google");
    expect(sb.calls[0].options?.redirectTo).toBe(`${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=%2Fportal%2Fc%2Fdemo`);
  });

  it("mismos controles: origen ajeno → 403", async () => {
    const res = await googlePOST(req("/api/auth/google", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(sb.calls).toHaveLength(0);
  });
});
