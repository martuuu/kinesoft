/**
 * [VX F-e] CSP Report-Only global (la que reciben landing, login, turnero y portal). Importa el `next.config.mjs` real
 * (molde de tests/unit/platform-csp.test.ts) y mira la entrada `[0]` de `headers()`.
 *
 * Por qué: con las fuentes en next/font (F-a) Google Fonts deja de ser un origen legítimo; si queda permitido, el día
 * que esta CSP pase a enforcing seguiría habilitando una salida a un tercero que la app ya no usa. Y el login OAuth del
 * paciente/profesional (Google y Facebook) redirige el submit vía Supabase: sin esos hosts en `form-action` el login
 * quedaría bloqueado al pasar a enforcing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@sentry/nextjs/config", () => ({ withSentryConfig: (cfg: object) => cfg }));

type HeaderEntry = { key: string; value: string };
type Rule = { source: string; headers: HeaderEntry[] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function reportOnly(): Promise<string> {
  const mod = await import("../../next.config.mjs");
  const cfg = mod.default as { headers: () => Promise<Rule[]> };
  const r = await cfg.headers();
  expect(r[0].source).toBe("/(.*)");
  return r[0].headers.find((h) => h.key === "Content-Security-Policy-Report-Only")!.value;
}

function directive(csp: string, name: string): string[] {
  const d = csp.split("; ").find((x) => x.startsWith(`${name} `) || x === name);
  return d ? d.split(" ").slice(1) : [];
}

describe("[VX F-e] next.config.mjs · CSP Report-Only pública", () => {
  it("sin Google Fonts: style-src y font-src solo same-origin", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", "production");
    const csp = await reportOnly();
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "font-src")).toEqual(["'self'", "data:"]);
  });

  it("form-action deja pasar el OAuth de Google y Facebook (vía Supabase) y el checkout de MP, sin duplicados", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    const csp = await reportOnly();
    const fa = directive(csp, "form-action");
    expect(fa).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://ref.supabase.co",
        "https://accounts.google.com",
        "https://www.facebook.com",
        "https://m.facebook.com",
        "https://*.mercadopago.com",
      ]),
    );
    expect(new Set(fa).size).toBe(fa.length);
  });

  it("ninguna directiva repite un origen", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    const csp = await reportOnly();
    for (const d of csp.split("; ")) {
      const tokens = d.split(" ").slice(1);
      // `${SUPA}` ya trae el origen concreto + el comodín *.supabase.co: distintos tokens, no duplicado.
      expect(new Set(tokens).size, d).toBe(tokens.length);
    }
  });
});
