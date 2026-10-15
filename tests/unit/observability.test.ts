import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// [A3b-S-obs] Sentry: no-op sin DSN, captureException real (redactado) con DSN,
// y la config de Next (CSP/HSTS/allowedOrigins/withSentryConfig) por entorno.
// Se mockea el SDK (la red), nunca lib/observability ni next.config.

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
  withSentryConfig: vi.fn((cfg: object, opts: object) => ({ ...cfg, __sentry: opts })),
}));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("@sentry/nextjs/config", () => ({ withSentryConfig: sentry.withSentryConfig }));

beforeEach(() => {
  vi.resetModules();
  sentry.captureException.mockClear();
  sentry.init.mockClear();
  sentry.withSentryConfig.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("captureException", () => {
  it("sin SENTRY_DSN: solo log, no toca Sentry", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const { captureException, isObservabilityEnabled } = await import("@/lib/observability");
    expect(isObservabilityEnabled()).toBe(false);
    captureException(new Error("boom"), { scope: "x" });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("con SENTRY_DSN: llama a Sentry con el contexto redactado", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pk@o1.ingest.sentry.io/42");
    const { captureException } = await import("@/lib/observability");
    const err = new Error("boom");
    captureException(err, { scope: "notify", to: "ana@kine.com", token: "abc", tenantId: "t1" });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [e, hint] = sentry.captureException.mock.calls[0];
    expect(e).toBe(err);
    expect(hint).toEqual({ extra: { scope: "notify", to: "[email]", token: "[redacted]", tenantId: "t1" } });
  });

  it("si el SDK tira, no propaga", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pk@o1.ingest.sentry.io/42");
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error("sdk");
    });
    const { captureException } = await import("@/lib/observability");
    expect(() => captureException("x")).not.toThrow();
  });
});

describe("instrumentation.register", () => {
  it("sin DSN no importa ni inicializa Sentry", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("@/instrumentation");
    await register();
    expect(sentry.init).not.toHaveBeenCalled();
  });
  it("con DSN inicializa con sampling bajo y beforeSend redactor", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pk@o1.ingest.sentry.io/42");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "");
    const { register } = await import("@/instrumentation");
    await register();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const opts = sentry.init.mock.calls[0][0];
    expect(opts).toMatchObject({ environment: "production", tracesSampleRate: 0.05, sendDefaultPii: false });
    const ev = opts.beforeSend({ message: "x@y.com", request: { headers: { cookie: "a" } } });
    expect(ev).toEqual({ message: "[email]", request: { headers: { cookie: "[redacted]" } } });
  });
});

describe("sentryBaseOptions", () => {
  it("null sin DSN; sample rate configurable y acotado a [0,1]", async () => {
    const { sentryBaseOptions, parseSampleRate } = await import("@/lib/observability-config");
    expect(sentryBaseOptions({})).toBeNull();
    expect(sentryBaseOptions({ SENTRY_DSN: "https://k@h/1", NODE_ENV: "development" })?.tracesSampleRate).toBe(0);
    expect(sentryBaseOptions({ SENTRY_DSN: "https://k@h/1", SENTRY_TRACES_SAMPLE_RATE: "0.2" })?.tracesSampleRate).toBe(0.2);
    expect(parseSampleRate("7", 0)).toBe(1);
    expect(parseSampleRate("-1", 0)).toBe(0);
    expect(parseSampleRate("abc", 0.05)).toBe(0.05);
  });
});

type HeaderEntry = { key: string; value: string };
async function loadNextConfig() {
  const mod = await import("../../next.config.mjs");
  const cfg = mod.default as {
    experimental: { serverActions: { allowedOrigins: string[] }; instrumentationHook: boolean };
    headers: () => Promise<Array<{ headers: HeaderEntry[] }>>;
    __sentry?: Record<string, unknown>;
  };
  const headers = (await cfg.headers())[0].headers;
  const h = (k: string) => headers.find((x) => x.key === k)?.value;
  return { cfg, h, mod };
}

describe("next.config.mjs", () => {
  it("local sin DSN: sin withSentryConfig, sin HSTS, localhost permitido, CSP sin report-uri", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    const { cfg, h } = await loadNextConfig();
    expect(sentry.withSentryConfig).not.toHaveBeenCalled();
    expect(cfg.__sentry).toBeUndefined();
    expect(cfg.experimental.instrumentationHook).toBe(true);
    expect(cfg.experimental.serverActions.allowedOrigins).toContain("localhost:3000");
    expect(h("Strict-Transport-Security")).toBeUndefined();
    const csp = h("Content-Security-Policy-Report-Only")!;
    expect(csp).not.toMatch(/report-uri/);
    // VX F-e: fuentes por next/font (same-origin), sin Google Fonts.
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
    expect(csp).toMatch(/form-action [^;]*https:\/\/ref\.supabase\.co[^;]*https:\/\/accounts\.google\.com/);
    expect(h("Content-Security-Policy")).toBeUndefined(); // sigue Report-Only
  });

  it("Production con DSN: HSTS, sin localhost, report-uri/report-to de Sentry, withSentryConfig sin sourcemaps sin token", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pubkey@o123.ingest.us.sentry.io/456");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.kinesoft.com.ar");
    const { cfg, h } = await loadNextConfig();
    expect(h("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(cfg.experimental.serverActions.allowedOrigins).toEqual(["app.kinesoft.com.ar"]);
    const uri = "https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=pubkey&sentry_environment=production";
    const csp = h("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain(`report-uri ${uri}`);
    expect(csp).toContain("report-to csp-endpoint");
    expect(h("Reporting-Endpoints")).toBe(`csp-endpoint="${uri}"`);
    expect(sentry.withSentryConfig).toHaveBeenCalledTimes(1);
    expect(cfg.__sentry).toMatchObject({ sourcemaps: { disable: true }, release: { create: false } });
  });

  it("Preview: sin HSTS y con localhost (dev contra Preview)", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { cfg, h } = await loadNextConfig();
    expect(h("Strict-Transport-Security")).toBeUndefined();
    expect(cfg.experimental.serverActions.allowedOrigins).toContain("localhost:3000");
  });

  it("sentryCspReportUri: DSN inválido o sin key → vacío", async () => {
    const { mod } = await loadNextConfig();
    const f = (mod as unknown as { sentryCspReportUri: (d: string, e?: string) => string }).sentryCspReportUri;
    expect(f("", "production")).toBe("");
    expect(f("no-es-url", "production")).toBe("");
    expect(f("https://o1.ingest.sentry.io/42", "production")).toBe("");
    expect(f("https://k@sentry.example.com/prefix/7", "")).toBe("https://sentry.example.com/prefix/api/7/security/?sentry_key=k");
  });
});
