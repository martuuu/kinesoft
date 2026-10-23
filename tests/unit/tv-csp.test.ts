/**
 * [TV-1c] CSP enforced y Permissions-Policy de las pantallas de sala (`/tv`, plan §26.4, D9). Importa el
 * `next.config.mjs` real (molde de tests/unit/platform-csp.test.ts) y mira las entradas de `headers()`.
 *
 * Por qué una enforced acá: `/tv` corre sin Actor en una tele del consultorio, con una cookie de dispositivo que
 * vale 180 días y muestra nombres de pacientes. No tiene Mercado Pago, ni OAuth, ni formularios a terceros: solo el
 * feed same-origin, el socket de Supabase y el reproductor de YouTube nocookie. Se puede bloquear de verdad.
 *
 * Por qué la Permissions-Policy repite las globales: en Next, cuando dos entradas de `headers()` matchean y ponen la
 * misma clave, gana la última; si `/tv` mandara solo `autoplay=…`, la tele perdería `camera=()` y compañía.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

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

const tvRule = (r: Rule[]) => r.find((x) => x.source === "/tv/:path*");
const header = (rule: Rule | undefined, key: string) => rule?.headers.find((h) => h.key === key)?.value;

const GLOBAL_PP = "camera=(), microphone=(), geolocation=()";
const TV_PP = `${GLOBAL_PP}, autoplay=(self "https://www.youtube-nocookie.com"), fullscreen=(self), screen-wake-lock=(self)`;

describe("[TV-1c] next.config.mjs · CSP y Permissions-Policy de /tv", () => {
  it("[TV-1c] la global sigue en el índice 0 (Report-Only) y /tv va después", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    expect(r[0].source).toBe("/(.*)");
    expect(header(r[0], "Content-Security-Policy")).toBeUndefined();
    expect(header(r[0], "Permissions-Policy")).toBe(GLOBAL_PP);
    const idx = r.findIndex((x) => x.source === "/tv/:path*");
    expect(idx).toBeGreaterThan(0);
  });

  it("[TV-1c] enforced = plataforma + tv, nada más", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    const enforced = r.filter((x) => x.headers.some((h) => h.key === "Content-Security-Policy"));
    expect(enforced.map((x) => x.source).sort()).toEqual(["/plataforma-mfa/:path*", "/plataforma/:path*", "/tv/:path*"]);
  });

  it("[TV-1c] producción: directivas literales de §26.4, sin comodines ni Mercado Pago", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    const csp = header(tvRule(await rules()), "Content-Security-Policy")!;
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directive(csp, "media-src")).toEqual(["'self'"]);
    expect(directive(csp, "connect-src")).toEqual(
      expect.arrayContaining(["'self'", "https://ref.supabase.co", "wss://ref.supabase.co"]),
    );
    expect(directive(csp, "connect-src")).not.toContain("https:");
    expect(directive(csp, "connect-src")).not.toContain("ws://localhost:*");
    expect(directive(csp, "frame-src")).toEqual(["https://www.youtube-nocookie.com"]);
    expect(directive(csp, "font-src")).toEqual(["'self'", "data:"]);
    expect(directive(csp, "manifest-src")).toEqual(["'self'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(csp).not.toMatch(/mercadopago|mercadolibre|fonts\.(googleapis|gstatic)\.com/);
    expect(csp).not.toMatch(/report-uri/);
  });

  it("[TV-1c] dev: unsafe-eval (overlay de Next) y ws de HMR, como Plataforma", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "development");
    const csp = header(tvRule(await rules()), "Content-Security-Policy")!;
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws://localhost:*");
  });

  it("[TV-1c] con DSN de Sentry, la enforced de /tv también reporta", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pubkey@o123.ingest.us.sentry.io/456");
    vi.stubEnv("VERCEL_ENV", "production");
    const csp = header(tvRule(await rules()), "Content-Security-Policy")!;
    expect(csp).toMatch(/report-uri https:\/\/o123\.ingest\.us\.sentry\.io\/api\/456\/security\//);
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("[TV-1c] Permissions-Policy de /tv repite las globales y suma autoplay, fullscreen y wake lock", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const tv = tvRule(await rules());
    expect(header(tv, "Permissions-Policy")).toBe(TV_PP);
  });

  it("[TV-1c] /tv NO pisa el Referrer-Policy (YouTube da error 153 sin Referer)", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    expect(header(tvRule(r), "Referrer-Policy")).toBeUndefined();
    expect(header(r[0], "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("[TV-1c] Report-Only global · Mercado Pago Argentina (AUDIT t5-csp-com-ar)", () => {
  it("[TV-1c] *.mercadopago.com.ar junto a cada *.mercadopago.com (script, connect, frame, form-action)", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    const ro = header(r[0], "Content-Security-Policy-Report-Only")!;
    for (const d of ["script-src", "connect-src", "frame-src", "form-action"]) {
      const tokens = directive(ro, d);
      expect(tokens, d).toContain("https://*.mercadopago.com");
      expect(tokens, d).toContain("https://*.mercadopago.com.ar");
    }
  });
});
