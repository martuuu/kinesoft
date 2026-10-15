/**
 * [BO4] CSP en enforce SOLO en /plataforma y /plataforma-mfa (plan §19.5 fila BO4). Importa el `next.config.mjs`
 * real (molde de tests/unit/observability.test.ts) y mira las entradas de `headers()`.
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

describe("[BO4] next.config.mjs · CSP de Plataforma", () => {
  it("la global sigue siendo Report-Only (sin Content-Security-Policy enforced) en el índice 0", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    expect(r[0].source).toBe("/(.*)");
    expect(r[0].headers.find((h) => h.key === "Content-Security-Policy")).toBeUndefined();
    expect(r[0].headers.find((h) => h.key === "Content-Security-Policy-Report-Only")).toBeDefined();
  });

  it("enforced solo en /plataforma/:path* y /plataforma-mfa/:path*", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const r = await rules();
    const enforced = r.filter((x) => x.headers.some((h) => h.key === "Content-Security-Policy"));
    expect(enforced.map((x) => x.source).sort()).toEqual(["/plataforma-mfa/:path*", "/plataforma/:path*"]);
  });

  it("producción: sin unsafe-eval, sin comodines https: en img/connect, Supabase y su socket permitidos", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    const r = await rules();
    const csp = r.find((x) => x.source === "/plataforma/:path*")!.headers[0].value;
    expect(directive(csp, "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(csp, "script-src").join(" ")).not.toMatch(/mercadopago/);
    expect(directive(csp, "img-src")).not.toContain("https:");
    expect(directive(csp, "img-src")).toContain("data:"); // QR del TOTP
    expect(directive(csp, "connect-src")).not.toContain("https:");
    expect(directive(csp, "connect-src")).toEqual(expect.arrayContaining(["'self'", "https://ref.supabase.co", "wss://ref.supabase.co"]));
    expect(directive(csp, "frame-src")).toEqual(["https://www.youtube-nocookie.com"]);
    expect(directive(csp, "style-src")).toContain("https://fonts.googleapis.com");
    expect(directive(csp, "font-src")).toContain("https://fonts.gstatic.com");
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
  });

  it("dev: unsafe-eval (overlay de Next) y ws de HMR", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "development");
    const r = await rules();
    const csp = r.find((x) => x.source === "/plataforma-mfa/:path*")!.headers[0].value;
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws://localhost:*");
  });

  it("con DSN de Sentry, la enforced también reporta", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pubkey@o123.ingest.us.sentry.io/456");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = await rules();
    const csp = r.find((x) => x.source === "/plataforma/:path*")!.headers[0].value;
    expect(csp).toMatch(/report-uri https:\/\/o123\.ingest\.us\.sentry\.io\/api\/456\/security\//);
    expect(csp).toContain("report-to csp-endpoint");
  });
});
