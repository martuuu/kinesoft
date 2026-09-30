/**
 * Presión de pool (A1.2) — SOLO MEDICIÓN.
 *
 * Por qué: cada `runWithRls` es una transacción interactiva (BEGIN +
 * set_config + queries + COMMIT) que retiene una conexión, y el dashboard abre
 * ~15 en paralelo. En Vercel cada lambda tiene un pool chico contra el pooler
 * de Supabase: si las transacciones esperan conexión más que `pool_timeout`,
 * Prisma tira P2024. Este test reproduce el peor caso (1 conexión por cliente)
 * y registra si hay timeouts y la latencia p95, sin fallar por los números.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const tight = (url: string | undefined) =>
    new PC({ datasources: { db: { url: `${url}${url?.includes("?") ? "&" : "?"}connection_limit=1&pool_timeout=5` } } });
  return {
    ...actual,
    prisma: tight(process.env.DATABASE_URL),
    prismaService: tight(process.env.DATABASE_URL_SERVICE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL),
  };
});

import { getDashboardData } from "@/lib/dashboard";
import { listBookingsInRange } from "@/lib/bookings";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { createVolumeTenant, type VolumeTenant } from "./volume-fixture";

const RUN = process.env.PERF_IT === "1";

describe.skipIf(!RUN)("presión de pool (connection_limit=1)", () => {
  let db: PrismaClient;
  let T: VolumeTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createVolumeTenant(db);
    asUser(T.userId);
  }, 600_000);

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  }, 600_000);

  it("10 dashboards + 10 agendas concurrentes: registra timeouts y p95", async () => {
    const from = new Date(Date.now() - 3 * 86_400_000);
    const to = new Date(Date.now() + 4 * 86_400_000);
    const timed = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      try {
        await fn();
        return { ms: performance.now() - t0, err: null as string | null };
      } catch (e) {
        return { ms: performance.now() - t0, err: (e as { code?: string }).code ?? String(e).slice(0, 80) };
      }
    };
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => timed(() => getDashboardData())),
      ...Array.from({ length: 10 }, () => timed(() => listBookingsInRange({ from, to }))),
    ]);
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = Math.round(ms[Math.floor(ms.length * 0.95) - 1]);
    const errors = results.filter((r) => r.err).map((r) => r.err);
    const out = { measuredAt: new Date().toISOString(), requests: results.length, p95Ms: p95, maxMs: Math.round(ms[ms.length - 1]), errors };
    writeFileSync("tests/perf/pool-pressure.json", JSON.stringify(out, null, 2) + "\n");
    console.log("[perf] pool pressure", out);
    expect(results).toHaveLength(20);
  });
});
