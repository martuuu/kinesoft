/**
 * [VX2-a] Botones sociales del login/signup y qué proveedores se muestran (D-VX16).
 *
 * Símbolos reales: `SocialButtons` (render SSR) y `visibleOAuthProviders` → `isProviderEnabled` de `lib/oauth-start`.
 * Solo se reemplaza la red (`fetch` a `/auth/v1/settings` de GoTrue), con la cache de settings vaciada en cada caso.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// `env` se arma al importar: Supabase tiene que estar "configurado" para que se consulte `/auth/v1/settings`.
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

import { renderToStaticMarkup } from "react-dom/server";
import { SocialButtons, oauthStartAction } from "@/components/auth/social-buttons";
import { visibleOAuthProviders, visibleProvidersFrom } from "@/lib/oauth-providers-public";
import { __resetOAuthSettingsCacheForTests } from "@/lib/oauth-start";

type Settings = { status: number; body: unknown } | "throw" | "hang";
let settings: Settings = { status: 200, body: { external: { google: true, facebook: true } } };
let hits = 0;

beforeEach(() => {
  __resetOAuthSettingsCacheForTests();
  hits = 0;
  settings = { status: 200, body: { external: { google: true, facebook: true } } };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.endsWith("/auth/v1/settings")) throw new Error(`fetch inesperado: ${u}`);
    hits += 1;
    if (settings === "throw") throw new Error("network down");
    if (settings === "hang") {
      // Como un GoTrue colgado: solo termina cuando corta el AbortSignal de `isProviderEnabled`.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return new Response(JSON.stringify(settings.body), { status: settings.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[VX2-a] SocialButtons", () => {
  it("un form POST por proveedor a /api/auth/oauth/<p>, con `next` codificado y el texto «Continuar con …»", () => {
    const html = renderToStaticMarkup(<SocialButtons providers={["google", "facebook"]} next="/onboarding" />);
    expect(html).toContain('method="post" action="/api/auth/oauth/google?next=%2Fonboarding"');
    expect(html).toContain('method="post" action="/api/auth/oauth/facebook?next=%2Fonboarding"');
    expect(html).toMatch(/<button type="submit" class="k-btn-social">[\s\S]*?Continuar con Google<\/button>/);
    expect(html).toMatch(/<button type="submit" class="k-btn-social">[\s\S]*?Continuar con Facebook<\/button>/);
    // Íconos decorativos: el nombre accesible es el texto.
    expect((html.match(/<svg[^>]*aria-hidden="true"/g) ?? []).length).toBe(2);
    // Nunca el alias viejo.
    expect(html).not.toContain("/api/auth/google");
  });

  it("sin `next` no agrega query; sin proveedores no pinta nada", () => {
    expect(oauthStartAction("google")).toBe("/api/auth/oauth/google");
    expect(renderToStaticMarkup(<SocialButtons providers={[]} />)).toBe("");
  });
});

describe("[VX2-a · D-VX16] visibleOAuthProviders", () => {
  it("los dos prendidos → Google y Facebook, en ese orden, con UNA sola consulta a GoTrue", async () => {
    expect(await visibleOAuthProviders()).toEqual(["google", "facebook"]);
    expect(hits).toBe(1);
  });

  it("Facebook apagado en Supabase → solo Google", async () => {
    settings = { status: 200, body: { external: { google: true, facebook: false } } };
    expect(await visibleOAuthProviders()).toEqual(["google"]);
  });

  it("no se pudo saber (red caída, 500, forma rara) → se muestran todos (null ≠ apagado)", async () => {
    settings = "throw";
    expect(await visibleOAuthProviders()).toEqual(["google", "facebook"]);
    __resetOAuthSettingsCacheForTests();
    settings = { status: 500, body: {} };
    expect(await visibleOAuthProviders()).toEqual(["google", "facebook"]);
    __resetOAuthSettingsCacheForTests();
    settings = { status: 200, body: { nope: 1 } };
    expect(await visibleOAuthProviders()).toEqual(["google", "facebook"]);
  });

  it("GoTrue colgado → el login no espera más que el tope y muestra todos", async () => {
    settings = "hang";
    const t0 = Date.now();
    expect(await visibleOAuthProviders(50)).toEqual(["google", "facebook"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("puro: solo `false` esconde", () => {
    expect(visibleProvidersFrom({ google: null, facebook: false })).toEqual(["google"]);
    expect(visibleProvidersFrom({})).toEqual(["google", "facebook"]);
    expect(visibleProvidersFrom({ google: false, facebook: false })).toEqual([]);
  });
});
