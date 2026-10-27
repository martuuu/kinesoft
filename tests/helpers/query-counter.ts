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

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * HD-17: la URL del `prismaService` contado, con la misma cadena que `lib/db.ts` (`DATABASE_URL_SERVICE` →
 * `DIRECT_URL` → `DATABASE_URL`), pero FALLA CERRADO si la que gana no es localhost. Motivo: `dotenv -e .env.local` no
 * pisa una `DATABASE_URL_SERVICE` ya exportada en la shell, y este cliente tiene BYPASSRLS (con una remota, los tests
 * que cuentan statements escribían en esa base). Ausente o que no parsea también tira: no se puede verificar. El mensaje
 * nombra la clave, nunca el valor (la URL lleva la contraseña).
 */
export function serviceDbUrlForCounter(env: Record<string, string | undefined>): string {
  const key = (["DATABASE_URL_SERVICE", "DIRECT_URL", "DATABASE_URL"] as const).find((k) => env[k]);
  if (!key) throw new Error("[query-counter] sin DATABASE_URL_SERVICE / DIRECT_URL / DATABASE_URL: no se puede verificar que sea local");
  const url = env[key]!;
  let host: string | null = null;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = null;
  }
  if (!host || !LOCAL_DB_HOSTS.has(host)) {
    throw new Error(`[query-counter] ${key} no es localhost/127.0.0.1: los tests de integración solo corren contra el Docker local`);
  }
  return url;
}

export function installQueryCounter() {
  clients.__kineCountedClients ??= {
    prisma: instrumented(process.env.DATABASE_URL, "app"),
    prismaService: instrumented(serviceDbUrlForCounter(process.env), "service"),
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

/**
 * Ping de salud del pool del query engine de Prisma (mobc), NO del código bajo test: al sacar del pool una conexión
 * que estuvo ociosa ≳ 15 s, el engine manda un `SELECT 1` pelado y lo emite como evento `query`. Medido el 19-oct
 * (FC-ZG-f) con un cliente aislado contra el Docker local: ociosa 1 s / 5 s → sin ping; 15 s / 31 s / 61 s → `SELECT 1`
 * antes de la query. Contarlo hacía flaky los techos exactos (gate T4: `getAgendaAvailability` 14 vs 13, con la sentencia
 * extra = `SELECT 1` en el cliente app fuera de la tx), según cuánto tardara lo que corrió antes en el mismo proceso.
 * Se filtra solo el texto EXACTO `SELECT 1` (el `pingDb` de lib/db-ping.ts también lo es, pero ningún camino medido lo
 * llama); un `SELECT 1 FROM …` o `EXISTS (SELECT 1 …)` del código se sigue contando.
 */
export const isPoolPing = (q: string) => q.trim() === "SELECT 1";

/** Runs `fn` recording every statement; BEGIN/COMMIT/ROLLBACK are counted apart (and pool pings are dropped). */
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
  const ev = rec.events.filter((e) => !isPoolPing(e.query));
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
