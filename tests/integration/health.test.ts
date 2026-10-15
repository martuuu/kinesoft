/**
 * [BO1-D] `GET /api/health` contra Postgres real (los dos roles: kinesoft_app y owner BYPASSRLS).
 *
 * Es lo que mira el monitor externo (§19.9): tiene que decir la verdad sobre la base, responder rápido
 * aunque la base esté colgada (timeout de 2 s) y no filtrar nada del entorno. Se corre el handler REAL con
 * el `prisma` real; para los casos «caída» se intercepta solo `$queryRaw` (la red hacia la base), nunca el
 * handler.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/db";
import { __rateLimitInternals } from "@/lib/rate-limit";

const RUN = process.env.INTEGRATION === "1";

let ipSeq = 0;
function req(ip = `10.77.0.${++ipSeq}`): Request {
  return new Request("http://localhost:3000/api/health", { headers: { "x-forwarded-for": ip } });
}

describe.skipIf(!RUN)("GET /api/health", () => {
  beforeEach(() => __rateLimitInternals.reset());
  afterEach(() => vi.restoreAllMocks());

  it("base arriba: 200 { ok: true, db: 'ok', time } sin cache y sin datos del entorno", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["db", "maintenance", "ok", "time"]);
    expect(body.ok).toBe(true);
    expect(body.maintenance).toBe(false);
    expect(body.db).toBe("ok");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
    // Nada de versión, commit, entorno ni URLs.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/postgres|supabase|vercel|version|sha|env/i);
  });

  it("[BO5-B] con MAINTENANCE_MODE=on informa maintenance: true (el middleware deja pasar /api/health)", async () => {
    const prev = process.env.MAINTENANCE_MODE;
    process.env.MAINTENANCE_MODE = " ON ";
    try {
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect((await res.json()).maintenance).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MAINTENANCE_MODE;
      else process.env.MAINTENANCE_MODE = prev;
    }
  });

  it("la base tira: 503 { ok: false, db: 'down' } sin el mensaje del error", async () => {
    vi.spyOn(prisma, "$queryRaw").mockImplementation((() =>
      Promise.reject(new Error("connect ECONNREFUSED postgres://u:p@db:5432"))) as never);
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, db: "down" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("la base no contesta: 503 a los ~2 s (no cuelga al monitor)", async () => {
    vi.spyOn(prisma, "$queryRaw").mockImplementation((() => new Promise(() => {})) as never);
    const t0 = Date.now();
    const res = await GET(req());
    const ms = Date.now() - t0;
    expect(res.status).toBe(503);
    expect((await res.json()).db).toBe("down");
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(4000);
  });

  it("rate limit por IP: 60/min, el 61 recibe 429 y otra IP sigue pasando", async () => {
    const ip = "10.78.1.1";
    for (let i = 0; i < 60; i++) expect((await GET(req(ip))).status).toBe(200);
    const limited = await GET(req(ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await GET(req("10.78.1.2"))).status).toBe(200);
  });
});
