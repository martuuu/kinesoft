/**
 * CF3 (SD-M, §30 D-CF3-11): subdominio de la sede digital dormido detrás de `SITE_ROOT_DOMAIN`.
 * Pure (`lib/site-host.ts`) + el `middleware` real (sin mocks: sin las variables de Supabase el refresh no corre).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { normalizeSiteRootDomain, siteHostDecision, siteSlugFromHost } from "@/lib/site-host";
import { middleware } from "@/middleware";
import { parseEnv } from "@/lib/env";

const ROOT = "consultorio-online.com";

describe("[CF3-SDM-1] siteSlugFromHost: solo <slug>.<rootDomain> exacto", () => {
  it("hosts válidos → slug (minúsculas, con puerto o punto final)", () => {
    expect(siteSlugFromHost("kine-norte.consultorio-online.com", ROOT)).toBe("kine-norte");
    expect(siteSlugFromHost("Kine-Norte.Consultorio-Online.com:443", ROOT)).toBe("kine-norte");
    expect(siteSlugFromHost("osteo123.consultorio-online.com.", ROOT)).toBe("osteo123");
    expect(siteSlugFromHost("kine-norte.consultorio-online.com", " Consultorio-Online.com. ")).toBe("kine-norte");
  });

  it("www/app/api y reservados del onboarding → null", () => {
    for (const l of ["www", "app", "api", "agenda", "login", "c", "caja", "plataforma", "sitemap"]) {
      expect(siteSlugFromHost(`${l}.${ROOT}`, ROOT)).toBeNull();
    }
  });

  it("forma de slug inválida, varias etiquetas, el dominio raíz pelado y otros dominios → null", () => {
    expect(siteSlugFromHost(`ab.${ROOT}`, ROOT)).toBeNull(); // < 3 caracteres
    expect(siteSlugFromHost(`-kine.${ROOT}`, ROOT)).toBeNull();
    expect(siteSlugFromHost(`${"a".repeat(41)}.${ROOT}`, ROOT)).toBeNull();
    expect(siteSlugFromHost(`a.b.${ROOT}`, ROOT)).toBeNull();
    expect(siteSlugFromHost(`kine.norte.${ROOT}`, ROOT)).toBeNull();
    expect(siteSlugFromHost(ROOT, ROOT)).toBeNull();
    expect(siteSlugFromHost(`kine-norte.otro-dominio.com`, ROOT)).toBeNull();
    expect(siteSlugFromHost(`kine-norte.xconsultorio-online.com`, ROOT)).toBeNull();
    expect(siteSlugFromHost(`kine-norte.consultorio-online.com.ar`, ROOT)).toBeNull();
    expect(siteSlugFromHost("", ROOT)).toBeNull();
    expect(siteSlugFromHost(null, ROOT)).toBeNull();
  });

  it("*.vercel.app nunca es una sede, ni como host ni como dominio raíz", () => {
    expect(siteSlugFromHost("kinesoft-git-develop-martuuu.vercel.app", ROOT)).toBeNull();
    expect(siteSlugFromHost("kinesoft.vercel.app", "vercel.app")).toBeNull();
    expect(siteSlugFromHost("kine-norte.kinesoft.vercel.app", "kinesoft.vercel.app")).toBeNull();
    expect(normalizeSiteRootDomain("vercel.app")).toBeNull();
    expect(normalizeSiteRootDomain("x.vercel.app")).toBeNull();
  });

  it("sin rootDomain (o inválido) = apagado", () => {
    for (const r of [undefined, null, "", "  ", "localhost", "https://consultorio-online.com", "con espacio.com", "*.x.com"]) {
      expect(siteSlugFromHost("kine-norte.consultorio-online.com", r)).toBeNull();
    }
    expect(normalizeSiteRootDomain(" Consultorio-Online.COM. ")).toBe(ROOT);
  });
});

describe("[CF3-SDM-2] siteHostDecision", () => {
  const base = { host: `kine-norte.${ROOT}`, search: "", rootDomain: ROOT, appUrl: `https://app.${ROOT}` };

  it("/ → rewrite a /<slug>; /logo → /<slug>/logo", () => {
    expect(siteHostDecision({ ...base, pathname: "/" })).toEqual({ kind: "rewrite", slug: "kine-norte", pathname: "/kine-norte" });
    expect(siteHostDecision({ ...base, pathname: "/logo" })).toEqual({
      kind: "rewrite",
      slug: "kine-norte",
      pathname: "/kine-norte/logo",
    });
  });

  it("el resto → redirect al host principal con path y query", () => {
    expect(siteHostDecision({ ...base, pathname: "/c/kine-norte/booking", search: "?pro=x" })).toEqual({
      kind: "redirect",
      slug: "kine-norte",
      url: `https://app.${ROOT}/c/kine-norte/booking?pro=x`,
    });
    expect(siteHostDecision({ ...base, pathname: "/logo/x" }).kind).toBe("redirect");
    expect(siteHostDecision({ ...base, pathname: "/kine-norte" }).kind).toBe("redirect");
  });

  it("sin appUrl, inválida o apuntando a una sede (loop) → https://<rootDomain>", () => {
    for (const appUrl of [undefined, "", "no-es-url", `https://kine-norte.${ROOT}`, "ftp://x.com"]) {
      const d = siteHostDecision({ ...base, appUrl, pathname: "/login" });
      expect(d).toEqual({ kind: "redirect", slug: "kine-norte", url: `https://${ROOT}/login` });
    }
  });

  it("host principal o apagado → none", () => {
    expect(siteHostDecision({ ...base, host: `app.${ROOT}`, pathname: "/" }).kind).toBe("none");
    expect(siteHostDecision({ ...base, host: ROOT, pathname: "/" }).kind).toBe("none");
    expect(siteHostDecision({ ...base, rootDomain: undefined, pathname: "/" }).kind).toBe("none");
  });
});

/** Respuesta → lo observable que importa: status, destino, rewrite y headers que el middleware pasa downstream. */
async function observe(url: string, headers: Record<string, string> = {}) {
  // `new NextRequest(url)` no arma el header Host (el que lee el middleware, como en Vercel): se pasa a mano.
  const res = await middleware(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } }));
  return {
    status: res.status,
    location: res.headers.get("location"),
    rewrite: res.headers.get("x-middleware-rewrite"),
    tenantSlug: res.headers.get("x-middleware-request-x-tenant-slug"),
    tenantId: res.headers.get("x-middleware-request-x-tenant-id"),
    requestIdOk: /^[a-zA-Z0-9_-]{8,64}$/.test(res.headers.get("x-request-id") ?? ""),
    next: res.headers.get("x-middleware-next"),
  };
}

describe("[CF3-SDM-3] middleware con SITE_ROOT_DOMAIN", () => {
  let prev: { root?: string; app?: string };
  beforeEach(() => {
    prev = { root: process.env.SITE_ROOT_DOMAIN, app: process.env.NEXT_PUBLIC_APP_URL };
  });
  afterEach(() => {
    if (prev.root === undefined) delete process.env.SITE_ROOT_DOMAIN;
    else process.env.SITE_ROOT_DOMAIN = prev.root;
    if (prev.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prev.app;
  });

  it("apagado: un host de 3 etiquetas (incluido *.vercel.app) ya no setea x-tenant-slug; idéntico al host principal", async () => {
    delete process.env.SITE_ROOT_DOMAIN;
    for (const h of ["https://kinesoft-git-develop-martuuu.vercel.app", `https://kine-norte.${ROOT}`, "http://localhost:3000"]) {
      for (const p of ["/", "/agenda", "/logo"]) {
        const o = await observe(`${h}${p}`, { "x-tenant-slug": "evil", "x-tenant-id": "evil" });
        expect(o).toMatchObject({ status: 200, location: null, rewrite: null, tenantSlug: null, tenantId: null, requestIdOk: true });
        expect(o.next).toBe("1");
      }
    }
    // /c/<slug> sigue como antes.
    expect((await observe("https://app.example.com/c/Kine-Norte/booking")).tenantSlug).toBe("kine-norte");
  });

  it("prendido: el host principal y vercel.app siguen idénticos", async () => {
    process.env.SITE_ROOT_DOMAIN = ROOT;
    process.env.NEXT_PUBLIC_APP_URL = `https://${ROOT}`;
    for (const h of [`https://${ROOT}`, `https://www.${ROOT}`, "https://kinesoft-git-develop-martuuu.vercel.app"]) {
      const o = await observe(`${h}/`, { "x-tenant-slug": "evil" });
      expect(o).toMatchObject({ status: 200, location: null, rewrite: null, tenantSlug: null, requestIdOk: true });
    }
  });

  it("prendido: / en el subdominio → rewrite a /<slug>, con el strip §5.3 y el request-id", async () => {
    process.env.SITE_ROOT_DOMAIN = ROOT;
    process.env.NEXT_PUBLIC_APP_URL = `https://${ROOT}`;
    const o = await observe(`https://kine-norte.${ROOT}/?utm_source=ig`, { "x-tenant-slug": "evil", "x-tenant-id": "evil" });
    expect(o.status).toBe(200);
    expect(o.location).toBeNull();
    expect(o.rewrite).toBe(`https://kine-norte.${ROOT}/kine-norte?utm_source=ig`);
    expect(o.tenantSlug).toBeNull();
    expect(o.tenantId).toBeNull();
    expect(o.requestIdOk).toBe(true);
    const logo = await observe(`https://kine-norte.${ROOT}/logo?v=123`);
    expect(logo.rewrite).toBe(`https://kine-norte.${ROOT}/kine-norte/logo?v=123`);
  });

  it("prendido: otro path en el subdominio → 308 al host principal (cookies host-only)", async () => {
    process.env.SITE_ROOT_DOMAIN = ROOT;
    process.env.NEXT_PUBLIC_APP_URL = `https://${ROOT}`;
    for (const p of ["/c/kine-norte/booking?pro=abc", "/login", "/agenda", "/api/health"]) {
      const o = await observe(`https://kine-norte.${ROOT}${p}`);
      expect(o.status).toBe(308);
      expect(o.location).toBe(`https://${ROOT}${p}`);
      expect(o.rewrite).toBeNull();
      expect(o.requestIdOk).toBe(true);
    }
  });

  it("prendido: un subdominio reservado (agenda.) no es sede", async () => {
    process.env.SITE_ROOT_DOMAIN = ROOT;
    const o = await observe(`https://agenda.${ROOT}/`);
    expect(o).toMatchObject({ status: 200, rewrite: null, location: null });
  });
});

describe("[CF3-SDM-4] lib/env.ts: SITE_ROOT_DOMAIN", () => {
  it("vacío = apagado; un dominio pasa; esquema, basura o vercel.app frenan el deploy", () => {
    expect(parseEnv({ SITE_ROOT_DOMAIN: "" }).SITE_ROOT_DOMAIN).toBeUndefined();
    expect(parseEnv({}).SITE_ROOT_DOMAIN).toBeUndefined();
    expect(parseEnv({ SITE_ROOT_DOMAIN: " consultorio-online.com\n" }).SITE_ROOT_DOMAIN).toBe("consultorio-online.com");
    for (const bad of ["https://consultorio-online.com", "localhost", "kinesoft.vercel.app", "*.x.com"]) {
      expect(() => parseEnv({ SITE_ROOT_DOMAIN: bad })).toThrow();
    }
  });
});
