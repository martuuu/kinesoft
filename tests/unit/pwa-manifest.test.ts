/**
 * [MB-0b] PWA instalable (C-MB5): manifest, íconos, matcher del middleware, headers de `/sw.js` y CSP.
 *
 * Por qué cada bloque:
 *   - Manifest: Chromium no ofrece instalar si `start_url` cae fuera de `scope`, si faltan los PNG de 192/512 o si
 *     `display` no es standalone; el nombre sale de `BRAND_NAME` para que el rename de marca sea una constante.
 *   - Matcher: con el matcher viejo `/sw.js`, el manifest y los íconos pasaban por el refresh de Supabase (con cookie
 *     salían `private, no-store`) y con `MAINTENANCE_MODE=on` se reescribían a la página de mantenimiento con 503 → el
 *     SW no se actualiza y la instalación falla. Se compila con el MISMO `getMiddlewareMatchers` que usa el build de
 *     Next (anti-false-green: no una regex copiada a mano).
 *   - Headers/CSP: `/sw.js` sin caché HTTP (un SW viejo pegado después de un deploy es el riesgo 1 del brief) y
 *     `worker-src`/`manifest-src` explícitos en las dos CSP para que un cambio futuro de `script-src` no rompa el SW.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getMiddlewareMatchers } from "next/dist/build/analysis/get-page-static-info";
import manifest from "@/app/manifest";
import { BRAND_NAME } from "@/lib/brand";
import { config as middlewareConfig } from "@/middleware";
import { GET as iconGET, generateStaticParams, dynamic as iconDynamic } from "@/app/icons/[name]/route";

vi.mock("@sentry/nextjs/config", () => ({ withSentryConfig: (cfg: object) => cfg }));

type HeaderEntry = { key: string; value: string };
type Rule = { source: string; headers: HeaderEntry[] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function rules(): Promise<Rule[]> {
  const mod = await import("../../next.config.mjs");
  const cfg = mod.default as { headers: () => Promise<Rule[]> };
  return cfg.headers();
}

function directive(csp: string, name: string): string[] {
  const d = csp.split("; ").find((x) => x.startsWith(`${name} `) || x === name);
  return d ? d.split(" ").slice(1) : [];
}

describe("[MB-0b] app/manifest.ts", () => {
  const m = manifest();

  it("nombre de la marca, standalone, es-AR", () => {
    expect(m.name).toBe(BRAND_NAME);
    expect(m.short_name).toBe(BRAND_NAME);
    expect(m.display).toBe("standalone");
    expect(m.lang).toBe("es-AR");
    expect(m.id).toBe("/");
  });

  it("start_url y los shortcuts caen dentro de scope", () => {
    const scope = m.scope!;
    expect(m.start_url).toBe("/dashboard");
    expect(m.start_url!.startsWith(scope)).toBe(true);
    for (const s of m.shortcuts ?? []) expect(s.url.startsWith(scope)).toBe(true);
  });

  it("íconos 192 y 512 (any) + maskable 512, todos servidos por app/icons/[name]", async () => {
    const icons = m.icons ?? [];
    expect(icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ src: "/icons/maskable-512.png", sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    const served = (await generateStaticParams()).map((p) => `/icons/${p.name}`);
    for (const i of icons) expect(served).toContain(i.src);
  });

  it("colores como hex (un manifest no acepta degradés ni variables CSS)", () => {
    expect(m.background_color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(m.theme_color).toBe("#1F4FBE");
  });
});

describe("[MB-0b] app/icons/[name]/route.tsx", () => {
  it("estático y con los tres nombres del manifest", async () => {
    expect(iconDynamic).toBe("force-static");
    expect((await generateStaticParams()).map((p) => p.name).sort()).toEqual([
      "icon-192.png",
      "icon-512.png",
      "maskable-512.png",
    ]);
  });

  it("nombre desconocido → 404", async () => {
    const res = await iconGET(new Request("http://localhost/icons/x.png"), { params: { name: "x.png" } });
    expect(res.status).toBe(404);
  });

  it("nombre conocido → PNG", async () => {
    const res = await iconGET(new Request("http://localhost/icons/icon-192.png"), { params: { name: "icon-192.png" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("[MB-0b] middleware.ts · matcher", () => {
  const [compiled] = getMiddlewareMatchers(middlewareConfig.matcher, {} as never);
  const re = new RegExp(compiled.regexp);

  it.each(["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/maskable-512.png", "/offline.html"])(
    "no pasa por el middleware: %s",
    (p) => {
      expect(re.test(p)).toBe(false);
    },
  );

  it.each(["/dashboard", "/c/x/booking", "/agenda", "/api/health", "/plataforma", "/"])("sí pasa: %s", (p) => {
    expect(re.test(p)).toBe(true);
  });

  it("los estáticos de Next y los favicons siguen afuera", () => {
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/icon.svg", "/apple-icon.png"]) {
      expect(re.test(p)).toBe(false);
    }
  });
});

describe("[MB-0b] next.config.mjs · /sw.js y CSP", () => {
  it("/sw.js sin caché HTTP y como JavaScript; la global sigue en el índice 0", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    expect(r[0].source).toBe("/(.*)");
    const sw = r.find((x) => x.source === "/sw.js");
    expect(sw?.headers).toEqual([
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { key: "Content-Type", value: "application/javascript; charset=utf-8" },
    ]);
  });

  it("worker-src y manifest-src 'self' en la Report-Only global y en la enforced de Plataforma", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "production");
    const r = await rules();
    const reportOnly = r[0].headers.find((h) => h.key === "Content-Security-Policy-Report-Only")!.value;
    const enforced = r.find((x) => x.source === "/plataforma/:path*")!.headers[0].value;
    for (const csp of [reportOnly, enforced]) {
      expect(directive(csp, "worker-src")).toEqual(["'self'"]);
      expect(directive(csp, "manifest-src")).toEqual(["'self'"]);
    }
  });
});
