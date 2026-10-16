import { describe, it, expect } from "vitest";
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

  it("apunta al sitemap absoluto del dominio de la app", () => {
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
  });
});

describe("sitemap", () => {
  it("lista solo la landing y /login, con URLs absolutas", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${BASE}/`, `${BASE}/login`]);
  });
});
