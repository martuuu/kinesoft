import { describe, it, expect, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// CF3 (SD-U): el sitemap suma las sedes prendidas (lectura de la base); acá sin sedes (las fija cf3-sede-sitemap).
vi.mock("@/lib/clinic-site-internal", () => ({ listEnabledSiteSlugs: async () => [] }));
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";

/**
 * [BO1-D] robots.txt y sitemap.xml (AUDIT `sin-sitemap-robots`). Se llama a las funciones reales de
 * `app/robots.ts` / `app/sitemap.ts` (las que Next sirve como /robots.txt y /sitemap.xml).
 */
const BASE = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

/**
 * [CF3-SDR] Matcher de robots.txt con la semántica de Google (RFC 9309 + `$`/`*`): gana la regla más larga que matchea;
 * empate → allow. Se evalúa el path real en vez de buscar strings en la lista, porque desde CF3 las reglas son exactas
 * (`/tv$`, `/tv/`, `/tv?`) y lo que importa es qué URL queda bloqueada, no cómo está escrita la regla.
 */
function ruleRe(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}
function isAllowed(path: string, allow: string[], disallow: string[]): boolean {
  const best = (rules: string[]) =>
    Math.max(-1, ...rules.filter((r) => r !== "" && ruleRe(r).test(path)).map((r) => r.length));
  return best(allow) >= best(disallow);
}

describe("robots", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  const star = rules.find((x) => x.userAgent === "*")!;
  const allow = ([] as string[]).concat(star.allow ?? []);
  const disallow = ([] as string[]).concat(star.disallow ?? []);
  const allowed = (p: string) => isAllowed(p, allow, disallow);

  it("permite la landing y el turnero público", () => {
    expect(allow).toEqual(expect.arrayContaining(["/", "/c/"]));
    for (const p of ["/", "/c/movare/booking", "/c/movare/booking?pro=abc"]) expect(allowed(p), p).toBe(true);
  });

  it.each([
    "/plataforma",
    "/api/",
    "/portal",
    "/dashboard",
    "/agenda",
    "/pacientes",
    "/sala",
    "/configuracion",
    "/planes",
    "/diagnostico",
    "/reportes",
    "/invite/",
    "/auth/",
    "/onboarding",
    "/reset",
    "/booking/",
    "/elegir-consultorio",
  ])("bloquea %s", (p) => {
    expect(allowed(p), p).toBe(false);
  });

  it("no bloquea por accidente la landing, el login ni el turnero", () => {
    for (const p of ["/", "/login", "/c/"]) {
      expect(disallow).not.toContain(p);
      expect(allowed(p), p).toBe(true);
    }
  });

  // [TP-3i] §25.2 hallazgo 14: el link de pago lleva un token en la URL (como `/invite/` y `/booking/`); la página
  // además lleva `noindex`. `/cobros` (TP-3g) es un segmento nuevo de la app.
  it("[TP-3i] bloquea /pagar/ y /cobros", () => {
    expect(allowed("/pagar/tok123")).toBe(false);
    expect(allowed("/cobros")).toBe(false);
  });

  // [TP-3i] La lista de la app se mantenía a mano («si se agrega un segmento nuevo, sumarlo acá»): ahora se afirma
  // contra el árbol real de `app/(app)/*`, así un segmento nuevo que nadie sume al disallow rompe acá.
  it("[TP-3i] todo segmento de app/(app)/* está bloqueado (exacto, subrutas y con query)", () => {
    const dir = join(process.cwd(), "app", "(app)");
    const segments = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory() && !f.startsWith("("));
    expect(segments.length).toBeGreaterThan(5);
    for (const seg of [...segments, "cobros"])
      for (const p of [`/${seg}`, `/${seg}/x`, `/${seg}?d=2026-11-04`]) expect(allowed(p), p).toBe(false);
  });

  // [TV-1c] Las pantallas de sala (`/tv`) muestran nombres de pacientes con una cookie de dispositivo: un buscador no
  // tiene nada que hacer ahí (la página además lleva `noindex`).
  it("[TV-1c] bloquea /tv", () => {
    expect(allowed("/tv")).toBe(false);
  });

  // [CF3-SDR] §30 D-CF3-10: la sede digital vive en `/<slug>`. Con el disallow por prefijo, `/tv` bloqueaba `/tvsalud`
  // y `/sala` bloqueaba `/salamanca-kine`: la sede de esos consultorios nunca se indexaba. Las reglas pasan a exactas.
  it("[CF3-SDR] /tv y /tv/x bloqueados; las sedes que empiezan igual que una ruta, permitidas", () => {
    for (const p of ["/tv", "/tv/", "/tv/vincular", "/tv?x=1", "/sala", "/sala/1", "/cuenta", "/cuenta/seguridad",
      "/cuenta-desactivada", "/plataforma", "/plataforma/consultorios", "/plataforma-mfa/verificar", "/reset", "/portal/me"])
      expect(allowed(p), p).toBe(false);
    for (const p of ["/tvsalud", "/salamanca-kine", "/agendas-kine", "/cajal-kine", "/portales-del-sur", "/reseteo",
      "/planeta-salud", "/cuentas-claras", "/tmp", "/movare"])
      expect(allowed(p), p).toBe(true);
  });

  it("[CF3-SDR] el matcher del test hace lo que dice (sin falso verde)", () => {
    expect(isAllowed("/tvsalud", ["/"], ["/tv"])).toBe(false); // prefijo pelado: el bug de antes
    expect(isAllowed("/tvsalud", ["/"], ["/tv$", "/tv/"])).toBe(true);
    expect(isAllowed("/tv", ["/"], ["/tv$"])).toBe(false);
    expect(isAllowed("/c/x", ["/", "/c/"], ["/c"])).toBe(true); // más larga gana
    expect(isAllowed("/a.b", ["/"], ["/a*b$"])).toBe(false);
  });

  it("apunta al sitemap absoluto del dominio de la app", () => {
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
  });
});

describe("sitemap", () => {
  it("lista la landing, /login, los legales y /contacto (sin parámetros), con URLs absolutas", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${BASE}/`, `${BASE}/login`, `${BASE}/terminos`, `${BASE}/privacidad`, `${BASE}/contacto`]);
    expect(urls.some((u) => u.includes("?"))).toBe(false);
  });
});
