/**
 * Helper for running a tenant-scoped transaction with RLS enforced.
 *
 * Wraps a Prisma `$transaction` and sets the `app.current_tenant_id` GUC
 * so any RLS policy compiled by `prisma/migrations/policies.sql` sees the
 * active tenant. Because prod uses Supavisor transaction-mode pooling, the
 * GUC MUST be transaction-local — so EVERY RLS-governed read and write has
 * to run inside a `runWithRls` transaction. This is the sole GUC setter.
 *
 * Example:
 *
 *     await runWithRls(tenantId, async (tx) => {
 *       return tx.patient.findMany({});
 *     });
 */
import { prisma, prismaService } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getRequestContext } from "@/lib/request-context";
import { ReadOnlyModeError, SUPPORT_READ_ONLY_MESSAGE, isReadOnlyViolation } from "@/lib/tenant-access";
import { beginTx, perfTimingEnabled, recordStatement } from "@/lib/server-timing";

/**
 * PF-0a (H-SLOW): con `PERF_TIMING=1` se cuenta y se cronometra cada op de Prisma de los dos canales (también las de
 * adentro de las tx interactivas, que el middleware de Prisma ve) y se atribuye al request en curso
 * (`lib/server-timing.ts`). `$use` y no el evento `query`: el evento sale del engine sin el contexto async del
 * request, así que no se puede saber de qué request es. Apagado no se instala nada: cero costo y mismo cliente.
 */
const perfClients = globalThis as unknown as { __kinePerfUse?: boolean };
if (perfTimingEnabled() && !perfClients.__kinePerfUse) {
  perfClients.__kinePerfUse = true;
  for (const c of [prisma, prismaService]) {
    c.$use(async (params, next) => {
      const t0 = performance.now();
      try {
        return await next(params);
      } finally {
        recordStatement(performance.now() - t0);
      }
    });
  }
}

/**
 * A Prisma client usable for tenant-scoped work: either the base client
 * (`prisma`) or a `$transaction` client (`tx`). `Prisma.TransactionClient`
 * is the common surface — the base `PrismaClient` is assignable to it.
 */
export type DbClient = Prisma.TransactionClient;

/**
 * Opciones de la transacción interactiva (Planes P0-Ck, C8; aditivo). Solo
 * `timeout` y `maxWait`, a propósito: el nivel de aislamiento queda en el
 * default de siempre (cambiarlo alteraría la semántica de los locks).
 * Sin `opts`, Prisma usa sus defaults (5 s de timeout, 2 s de maxWait): el
 * commit de un plan (≤ 60 statements para 20 filas) pide más, p. ej.
 * `{ timeout: 15000, maxWait: 5000 }`. Al vencer, Prisma aborta la tx con
 * P2028 y revierte todo.
 */
export type RlsTxOptions = {
  /** ms máximos de la tx completa antes de abortar (P2028). */
  timeout?: number;
  /** ms máximos esperando una conexión del pool para arrancar. */
  maxWait?: number;
};

export async function runWithRls<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: RlsTxOptions
): Promise<T> {
  // Se copian solo las dos claves: así un caller no puede colar
  // `isolationLevel` u otra opción por un objeto más ancho.
  const txOpts = opts ? { timeout: opts.timeout, maxWait: opts.maxWait } : undefined;
  const readOnly = isReadOnlyFor(tenantId);
  // PF-0a: null con PERF_TIMING apagado (sin tomar tiempos).
  const endTx = beginTx();
  try {
    return await prisma.$transaction(async (tx) => {
      // `set_config('app.current_tenant_id', $1, true)` — `true` makes it
      // local to the transaction, so the GUC is automatically reset when
      // the connection returns to the pool.
      //
      // BO1-A (C-BO3): en modo lectura, la MISMA sentencia pone la transacción
      // en `transaction_read_only` (= SET LOCAL transaction_read_only). Va en
      // la misma sentencia a propósito: no suma un round-trip (el techo de
      // createBooking es 34, tests/integration/bookings-rooms.test.ts). Pasar
      // a read-only está permitido en cualquier punto de la tx (lo prohibido es
      // volver a read-write después de una query). Postgres rechaza después
      // TODO write con 25006 — incluidos los que una action haga por un camino
      // no previsto — y deja leer: la HC nunca se bloquea.
      await tx.$executeRawUnsafe(
        readOnly
          ? `SELECT set_config('app.current_tenant_id', $1, true), set_config('transaction_read_only', 'on', true)`
          : `SELECT set_config('app.current_tenant_id', $1, true)`,
        tenantId
      );
      return fn(tx);
    }, txOpts);
  } catch (err) {
    // El 25006 sale de Prisma como error crudo del conector: se traduce a un error con copy en voseo que las
    // actions pueden mostrar tal cual. BO2-E: si el read-only viene de una sesión de soporte (no del consultorio),
    // el copy del consultorio («Escribinos para reactivarlo») confundiría al superadmin: va el de soporte.
    if (readOnly && isReadOnlyViolation(err)) {
      throw new ReadOnlyModeError(getRequestContext()?.supportSessionId ? SUPPORT_READ_ONLY_MESSAGE : undefined);
    }
    throw err;
  } finally {
    endTx?.();
  }
}

/**
 * ¿Esta transacción va en solo lectura? Solo si el contexto del request es del MISMO tenant (una superficie sin
 * Actor —webhook de MP, turnero, cron— no tiene contexto y nunca se bloquea) y no es una action de soporte
 * habilitada (`supportWritable`, C-BO4).
 *
 * PL-1e (C-PL10): tampoco si es una action de cuenta (`accountWritable`: pagar, cambiar de plan, mensajes a
 * soporte) de un actor que NO es soporte: un consultorio en solo lectura por deuda tiene que poder pagar. En una
 * sesión de soporte (`supportSessionId`) `accountWritable` no cuenta: el superadmin no paga ni cambia el plan
 * desde la app del consultorio.
 */
export function isReadOnlyFor(tenantId: string): boolean {
  const ctx = getRequestContext();
  if (!ctx || ctx.tenantId !== tenantId) return false;
  return !!ctx.readOnly && !ctx.supportWritable && !(ctx.accountWritable && !ctx.supportSessionId);
}

/**
 * Thread-or-prime helper for SHARED functions that run either standalone
 * (server component / `unstable_cache` body) or inside an existing
 * `runWithRls` transaction:
 *
 *   - Pass the caller's `tx` as `db` when already inside a transaction —
 *     the query joins that transaction (avoids nesting, which Prisma
 *     forbids and which would throw even on the current bypass role).
 *   - Pass `undefined` (the default) to open a fresh tenant-scoped
 *     transaction here.
 *
 * This keeps Phase-1 wrapping inert on the bypass role: a standalone call
 * opens exactly one transaction; an in-tx call reuses the caller's.
 */
export async function withTenantDb<T>(
  tenantId: string,
  db: DbClient | undefined,
  fn: (db: DbClient) => Promise<T>
): Promise<T> {
  return db ? fn(db) : runWithRls(tenantId, fn);
}
