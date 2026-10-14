import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO1-D] Reporte de errores del navegador sin SDK de Sentry en el cliente (AUDIT §5.23).
 *
 * - `POST /api/client-errors`: se corre el handler REAL. Se mockea solo el SDK de Sentry (la red) y se
 *   captura stdout (el logger); se afirma el efecto observable: qué llega a Sentry y qué queda en el log,
 *   ya redactado, y que la respuesta no trae ningún detalle.
 * - `reportClientError`: se stubbea `navigator.sendBeacon` / `fetch` (la red del browser).
 * - `RouteError`: render sin jsdom; el `useEffect` no corre en SSR, así que el reporte se prueba aparte.
 */
const sentry = vi.hoisted(() => ({ calls: [] as Array<[unknown, unknown]> }));
vi.mock("@sentry/nextjs", () => ({
  captureException: (e: unknown, hint: unknown) => {
    sentry.calls.push([e, hint]);
  },
}));

import { POST } from "@/app/api/client-errors/route";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  reportClientError,
  buildClientErrorPayload,
  scrubTokenPaths,
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_LIMITS,
  __resetReportedForTests,
} from "@/lib/client-error-report";
import { RouteError } from "@/components/ui/route-error";

const ORIGIN = "http://localhost:3000";
let out: string[] = [];
let ipSeq = 0;

function req(body: unknown, headers: Record<string, string> = {}, ip?: string): Request {
  return new Request(`${ORIGIN}/api/client-errors`, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      origin: ORIGIN,
      "x-forwarded-for": ip ?? `10.0.0.${++ipSeq}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  sentry.calls = [];
  out = [];
  __rateLimitInternals.reset();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/client-errors", () => {
  it("acepta un reporte válido: 204 sin cuerpo, log y Sentry redactados", async () => {
    vi.stubEnv("SENTRY_DSN", "https://pk@o1.ingest.sentry.io/42");
    const res = await POST(
      req({
        message: "No se pudo cargar a ana@kine.com",
        stack: "Error: x\n at https://app.test/invite/abc123def?token=zzz:1:2",
        digest: "12345",
        path: "/invite/tok_secreto/activar?token=zzz",
        kind: "invite",
      })
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toContain("no-store");

    expect(sentry.calls).toHaveLength(1);
    const [err, hint] = sentry.calls[0] as [Error, { extra: Record<string, unknown> }];
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClientError");
    expect(err.message).toContain("[email]");
    expect(err.message).not.toContain("ana@kine.com");
    expect(err.stack).not.toContain("abc123def");
    expect(err.stack).not.toContain("zzz");
    expect(hint.extra).toMatchObject({ source: "client", kind: "invite", digest: "12345", path: "/invite/[token]/activar" });

    const log = out.join("");
    expect(log).toContain("captureException");
    expect(log).not.toContain("ana@kine.com");
    expect(log).not.toContain("tok_secreto");
    expect(log).not.toContain("abc123def");
  });

  it("recorta el stack a 4 KB y el mensaje a su tope", async () => {
    const res = await POST(req({ message: "m".repeat(2_000), stack: "s".repeat(6_000), kind: "route" }));
    expect(res.status).toBe(204);
    const line = out.find((l) => l.includes("captureException")) ?? "";
    expect(line).toContain("s".repeat(CLIENT_ERROR_LIMITS.stack));
    expect(line).not.toContain("s".repeat(CLIENT_ERROR_LIMITS.stack + 1));
    expect(line).not.toContain("m".repeat(CLIENT_ERROR_LIMITS.message + 1));
  });

  it("rechaza un Origin ajeno con 403 y no reporta", async () => {
    const res = await POST(req({ message: "x", kind: "route" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(out.join("")).not.toContain("captureException");
  });

  it("rechaza Sec-Fetch-Site cross-site sin Origin", async () => {
    const r = req({ message: "x", kind: "route" }, { "sec-fetch-site": "cross-site" });
    r.headers.delete("origin");
    const res = await POST(r);
    expect(res.status).toBe(403);
  });

  it("payload inválido o enorme: 400/413 sin detalles ni reporte", async () => {
    const bad = await POST(req("{no es json"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("");
    const wrongKind = await POST(req({ message: "x", kind: "<script>" }));
    expect(wrongKind.status).toBe(400);
    const huge = await POST(req("x".repeat(64 * 1024)));
    expect(huge.status).toBe(413);
    expect(out.join("")).not.toContain("captureException");
  });

  it("rate limit por IP: el que se pasa recibe 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await POST(req({ message: "x", kind: "route" }, {}, "10.9.9.9"))).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Otra IP no comparte el cupo.
    expect((await POST(req({ message: "x", kind: "route" }, {}, "10.9.9.10"))).status).toBe(204);
  });
});

describe("lib/client-error-report", () => {
  beforeEach(() => __resetReportedForTests());

  it("scrubTokenPaths tapa el token de /invite/<token>", () => {
    expect(scrubTokenPaths("https://x.app/invite/abc-123?x=1 y /invite/def")).toBe(
      "https://x.app/invite/[token]?x=1 y /invite/[token]"
    );
  });

  it("buildClientErrorPayload recorta y no lleva query", () => {
    const e = Object.assign(new Error("boom"), { digest: "d1" });
    e.stack = "s".repeat(10_000);
    const p = buildClientErrorPayload(e, "auth", "/login");
    expect(p).toEqual({ message: "boom", stack: "s".repeat(CLIENT_ERROR_LIMITS.stack), digest: "d1", path: "/login", kind: "auth" });
    expect(buildClientErrorPayload("raro", "global", "/x").message).toBe("raro");
  });

  it("manda un beacon text/plain al endpoint, una sola vez por error", async () => {
    const beacons: Array<[string, Blob]> = [];
    vi.stubGlobal("navigator", { sendBeacon: (u: string, b: Blob) => (beacons.push([u, b]), true) });
    vi.stubGlobal("location", { pathname: "/invite/secreto" });
    const e = new Error("boom");
    reportClientError(e, { kind: "invite" });
    reportClientError(e, { kind: "invite" });
    expect(beacons).toHaveLength(1);
    expect(beacons[0][0]).toBe(CLIENT_ERROR_ENDPOINT);
    expect(beacons[0][1].type).toContain("text/plain");
    const sent = JSON.parse(await beacons[0][1].text());
    expect(sent).toMatchObject({ message: "boom", kind: "invite", path: "/invite/[token]" });
  });

  it("sin sendBeacon cae a fetch keepalive; nunca tira aunque todo falle", () => {
    const fetches: Array<[string, RequestInit]> = [];
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("location", { pathname: "/login" });
    vi.stubGlobal("fetch", (u: string, init: RequestInit) => {
      fetches.push([u, init]);
      return Promise.reject(new Error("offline"));
    });
    expect(() => reportClientError(new Error("a"), { kind: "auth" })).not.toThrow();
    expect(fetches).toHaveLength(1);
    expect(fetches[0][1]).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" });

    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw new Error("nope");
      },
    });
    vi.stubGlobal("fetch", () => {
      throw new Error("nope");
    });
    expect(() => reportClientError(new Error("b"), { kind: "auth" })).not.toThrow();
  });

  it("en el server (sin navigator) es no-op", () => {
    vi.stubGlobal("navigator", undefined);
    expect(() => reportClientError(new Error("c"), { kind: "route" })).not.toThrow();
  });
});

describe("RouteError", () => {
  it("muestra el copy en voseo, Reintentar y el código digest; nunca el mensaje crudo", () => {
    const error = Object.assign(new Error("PrismaClientKnownRequestError: secreto"), { digest: "abc123" });
    const html = renderToStaticMarkup(createElement(RouteError, { error, reset: () => {} }));
    expect(html).toContain("Algo salió mal");
    expect(html).toContain("Probá de nuevo");
    expect(html).toContain("Reintentar");
    expect(html).toContain("abc123");
    expect(html).not.toContain("secreto");
  });

  it("sin digest no muestra la línea de código", () => {
    const html = renderToStaticMarkup(createElement(RouteError, { error: new Error("x"), reset: () => {}, title: "No pudimos cargar tu portal" }));
    expect(html).toContain("No pudimos cargar tu portal");
    expect(html).not.toContain("Código");
  });
});
