import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";

/**
 * [BO1-D] robots.txt y sitemap.xml (AUDIT `sin-sitemap-robots`). Se llama a las funciones reales de
 * `app/robots.ts` / `app/sitemap.ts` (las que Next sirve como /robots.txt y /sitemap.xml).
 */
const BASE = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

describe("robots", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  const star = rules.find((x) => x.userAgent === "*")!;
  const allow = ([] as string[]).concat(star.allow ?? []);
  const disallow = ([] as string[]).concat(star.disallow ?? []);

  it("permite la landing y el turnero público", () => {
    expect(allow).toEqual(expect.arrayContaining(["/", "/c/"]));
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
    expect(disallow).toContain(p);
  });

  it("no bloquea por accidente la landing, el login ni el turnero", () => {
    for (const p of ["/", "/login", "/c/"]) expect(disallow).not.toContain(p);
  });

  // [TP-3i] §25.2 hallazgo 14: el link de pago lleva un token en la URL (como `/invite/` y `/booking/`); la página
  // además lleva `noindex`. `/cobros` (TP-3g) es un segmento nuevo de la app.
  it("[TP-3i] bloquea /pagar/ y /cobros", () => {
    expect(disallow).toContain("/pagar/");
    expect(disallow).toContain("/cobros");
  });

  // [TP-3i] La lista de la app se mantenía a mano («si se agrega un segmento nuevo, sumarlo acá»): ahora se afirma
  // contra el árbol real de `app/(app)/*`, así un segmento nuevo que nadie sume al disallow rompe acá.
  it("[TP-3i] todo segmento de app/(app)/* está en el disallow", () => {
    const dir = join(process.cwd(), "app", "(app)");
    const segments = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory() && !f.startsWith("("));
    expect(segments.length).toBeGreaterThan(5);
    for (const seg of [...segments, "cobros"]) expect(disallow, seg).toContain(`/${seg}`);
  });

  // [TV-1c] Las pantallas de sala (`/tv`) muestran nombres de pacientes con una cookie de dispositivo: un buscador no
  // tiene nada que hacer ahí (la página además lleva `noindex`).
  it("[TV-1c] bloquea /tv", () => {
    expect(disallow).toContain("/tv");
  });

  it("apunta al sitemap absoluto del dominio de la app", () => {
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
  });
});

describe("sitemap", () => {
  it("lista solo la landing y /login, con URLs absolutas", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${BASE}/`, `${BASE}/login`, `${BASE}/terminos`, `${BASE}/privacidad`]);
  });
});
