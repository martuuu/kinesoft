/**
 * OPS-1b · conexión al pgbouncer local del perfil `pooler` (docker-compose.yml) para `tests/integration/pooler.test.ts`.
 *
 * Por qué: prod usa el pooler de Supabase en modo TRANSACCIÓN (6543, `pgbouncer=true&connection_limit`), y toda la
 * suite de integración corre contra Postgres directo (:5433), donde una conexión es una sesión. Lo que el código
 * supone del pooler (GUC de `runWithRls` local a la tx, advisory locks xact-level, `SET LOCAL`,
 * `transaction_read_only`) nunca se había probado con un pooler de verdad en el medio.
 *
 * Las URLs se derivan de las del rol que esté corriendo (`DATABASE_URL` = kinesoft_app en `test:integration`, owner
 * en `test:integration:owner`), cambiando solo host, puerto y base del pgbouncer: el usuario y la contraseña son los
 * mismos (el pgbouncer los valida contra `pg_shadow` con `auth_query`). Nunca se imprime una URL.
 *
 * NO es un `.test.ts`: el run unit nunca lo importa.
 */
import { PrismaClient } from "@prisma/client";

/** Bases del `[databases]` del pgbouncer local (docker-compose.yml). */
export type PoolerDb =
  /** pool de 3 conexiones al server por usuario (= `connection_limit=3` de prod, plan §21.3 OPS-3). */
  | "kinesoft"
  /** pool de UNA conexión: toda transacción reusa el mismo backend, los chequeos de fuga son deterministas. */
  | "kinesoft_single";

/** Tamaños de pool del pgbouncer local (docker-compose.yml). Los tests los usan para afirmar el multiplexado. */
export const POOLER_POOL_SIZE: Record<PoolerDb, number> = { kinesoft: 3, kinesoft_single: 1 };

export function poolerUrl(baseUrl: string, db: PoolerDb, connectionLimit: number): string {
  const u = new URL(baseUrl);
  u.hostname = process.env.POOLER_HOST?.trim() || "127.0.0.1";
  u.port = process.env.POOLER_PORT?.trim() || "6433";
  u.pathname = `/${db}`;
  // Lo mismo que prod: Prisma sin prepared statements con nombre (el pooler en modo transacción no los sigue entre
  // transacciones) y un tope de conexiones del lado del cliente.
  u.searchParams.set("pgbouncer", "true");
  u.searchParams.set("connection_limit", String(connectionLimit));
  u.searchParams.set("connect_timeout", "3");
  u.searchParams.set("pool_timeout", "20");
  return u.toString();
}

export function poolerClient(baseUrl: string, db: PoolerDb, connectionLimit: number): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: poolerUrl(baseUrl, db, connectionLimit) } } });
}

/**
 * ¿Está arriba el pooler local? `null` = sí; si no, un motivo corto (código de Prisma, nunca la URL ni la contraseña).
 */
export async function probePooler(baseUrl: string | undefined): Promise<string | null> {
  if (!baseUrl) return "sin DATABASE_URL";
  const c = poolerClient(baseUrl, "kinesoft", 1);
  try {
    await c.$queryRaw`SELECT 1`;
    return null;
  } catch (err) {
    const code = (err as { errorCode?: string; code?: string }).errorCode ?? (err as { code?: string }).code;
    return code ? `Prisma ${code}` : "no conecta";
  } finally {
    await c.$disconnect().catch(() => {});
  }
}

/**
 * El cliente al que apunta el `prisma` mockeado de `@/lib/db` en pooler.test.ts. Un holder (y no un valor fijo)
 * para que cada test elija el pool: el principal para concurrencia, el de una conexión para reuso determinista.
 */
export const poolerHolder: { current: PrismaClient | null } = { current: null };
