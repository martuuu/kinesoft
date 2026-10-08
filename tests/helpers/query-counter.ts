/**
 * Query / transaction counter for the perf suite (A1.2).
 *
 * `installQueryCounter()` is called from a `vi.mock("@/lib/db", …)` factory:
 * it swaps `prisma` and `prismaService` for clients that emit Prisma `query`
 * events, so EVERY statement the real code runs — including the BEGIN/COMMIT
 * of each `runWithRls` interactive transaction — is recorded. Nothing in the
 * code under test is replaced; only the clients get a listener.
 */
import { PrismaClient } from "@prisma/client";

export type QueryEvent = { query: string; params: string; durationMs: number; client: "app" | "service" };

type Recorder = { active: boolean; events: QueryEvent[] };
const g = globalThis as unknown as { __kineQueryRecorder?: Recorder };
g.__kineQueryRecorder ??= { active: false, events: [] };
const rec = g.__kineQueryRecorder;

function instrumented(url: string | undefined, client: QueryEvent["client"]): PrismaClient {
  const c = new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    log: [{ emit: "event", level: "query" }],
  });
  c.$on("query" as never, (e: { query: string; params: string; duration: number }) => {
    if (rec.active) rec.events.push({ query: e.query, params: e.params, durationMs: e.duration, client });
  });
  return c;
}

// Gate de SR (SRZ): los clientes se reusan en todo el proceso, como el
// singleton de `lib/db.ts`. Antes cada archivo que mockeaba `@/lib/db` creaba
// 2 clientes nuevos (con su pool) que nunca se cerraban; con los ~7 archivos
// de SR que miden statements (varios con tests de concurrencia, que abren
// muchas conexiones a la vez) la integración completa agotaba las 100 de
// Postgres ("remaining connection slots are reserved…") y fallaban tests ajenos.
// El recorder ya es global, así que un listener por cliente alcanza.
const clients = globalThis as unknown as {
  __kineCountedClients?: { prisma: PrismaClient; prismaService: PrismaClient };
};

export function installQueryCounter() {
  clients.__kineCountedClients ??= {
    prisma: instrumented(process.env.DATABASE_URL, "app"),
    prismaService: instrumented(
      process.env.DATABASE_URL_SERVICE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL,
      "service",
    ),
  };
  return clients.__kineCountedClients;
}

export type Measurement = {
  statements: number;
  transactions: number;
  dbMs: number;
  wallMs: number;
  byClient: { app: number; service: number };
  slowest: QueryEvent[];
};

/** Runs `fn` recording every statement; BEGIN/COMMIT/ROLLBACK are counted apart. */
export async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; m: Measurement }> {
  rec.events = [];
  rec.active = true;
  const t0 = performance.now();
  let result: T;
  try {
    result = await fn();
  } finally {
    rec.active = false;
  }
  const wallMs = performance.now() - t0;
  const ev = rec.events;
  const isTx = (q: string) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(q.trim());
  const real = ev.filter((e) => !isTx(e.query) && !/set_config\('app\.current_tenant_id'/.test(e.query));
  return {
    result: result!,
    m: {
      statements: real.length,
      transactions: ev.filter((e) => /^BEGIN\b/i.test(e.query.trim())).length,
      dbMs: Math.round(ev.reduce((a, e) => a + e.durationMs, 0)),
      wallMs: Math.round(wallMs),
      byClient: {
        app: real.filter((e) => e.client === "app").length,
        service: real.filter((e) => e.client === "service").length,
      },
      slowest: [...real].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3),
    },
  };
}
