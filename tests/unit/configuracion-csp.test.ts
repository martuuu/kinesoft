/**
 * [INT] CSP Report-Only de /configuracion para el alta embebida de WhatsApp (WA-U1, plan §26.3 fila INT).
 *
 * Por qué: en `sandbox`/`live` la pestaña WhatsApp carga el SDK de Facebook y abre el Embedded Signup. El plan pide
 * habilitar esos hosts SOLO en /configuracion (no en la global que reciben el portal, el turnero y la agenda) y sin
 * `Cross-Origin-Opener-Policy: same-origin`, que cortaría el `postMessage` del popup de Meta. Importa el
 * `next.config.mjs` real (molde de tests/unit/csp-public.test.ts).
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
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
  const mod = await import("../../next.config.mjs");
  return (mod.default as { headers: () => Promise<Rule[]> }).headers();
}

function directive(csp: string, name: string): string[] {
  const d = csp.split("; ").find((x) => x.startsWith(`${name} `) || x === name);
  return d ? d.split(" ").slice(1) : [];
}

const reportOnlyOf = (r: Rule) => r.headers.find((h) => h.key === "Content-Security-Policy-Report-Only")?.value;

describe("[INT] next.config.mjs · CSP de /configuracion (alta embebida de WhatsApp)", () => {
  it("/configuracion y sus subrutas tienen su propia Report-Only, posterior a la global (la reemplaza)", async () => {
    const r = await rules();
    const sources = r.filter((x) => reportOnlyOf(x)).map((x) => x.source);
    expect(sources[0]).toBe("/(.*)");
    expect(sources).toEqual(expect.arrayContaining(["/configuracion", "/configuracion/:path*"]));
  });

  it("suma el SDK, los frames y la Graph API de Facebook sin perder nada de la global", async () => {
    const r = await rules();
    const global = reportOnlyOf(r[0])!;
    const conf = reportOnlyOf(r.find((x) => x.source === "/configuracion")!)!;
    expect(directive(conf, "script-src")).toEqual([...directive(global, "script-src"), "https://connect.facebook.net"]);
    expect(directive(conf, "frame-src")).toEqual(
      expect.arrayContaining([
        ...directive(global, "frame-src"),
        "https://www.facebook.com",
        "https://web.facebook.com",
        "https://staticxx.facebook.com",
      ]),
    );
    for (const d of ["connect-src", "img-src"]) {
      expect(directive(conf, d)).toEqual(
        expect.arrayContaining([...directive(global, d), "https://graph.facebook.com", "https://www.facebook.com"]),
      );
    }
    // El resto de las directivas queda idéntico a la global.
    const others = (csp: string) =>
      csp.split("; ").filter((x) => !/^(script|frame|connect|img)-src /.test(x));
    expect(others(conf)).toEqual(others(global));
  });

  it("la global NO habilita el SDK ni los frames de Facebook (solo /configuracion)", async () => {
    const r = await rules();
    const global = reportOnlyOf(r[0])!;
    expect(global).not.toContain("connect.facebook.net");
    expect(directive(global, "frame-src").some((h) => h.includes("facebook"))).toBe(false);
  });

  it("ninguna entrada manda Cross-Origin-Opener-Policy (rompería el popup de Meta)", async () => {
    const r = await rules();
    for (const rule of r) {
      expect(rule.headers.some((h) => h.key.toLowerCase() === "cross-origin-opener-policy")).toBe(false);
    }
  });
});
