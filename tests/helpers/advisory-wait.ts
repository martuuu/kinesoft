/**
 * Espera a que una transacción quede BLOQUEADA en un advisory lock concreto
 * (P0-Ct, contrato C14 de .docs/PLANES.md).
 *
 * Por qué: los tests de carrera necesitan saber que la escritura "B" ya está
 * esperando el lock que tiene tomado "A" antes de soltarlo. El patrón viejo
 * (`count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`, ver
 * bookings-availability / time-blocks) es GLOBAL: cualquier otro waiter de la
 * base (otra suite, otro lock del mismo flujo, un test que quedó colgado) lo da
 * por cumplido y el test pasa sin haber probado la carrera (falso verde). Acá se
 * filtra por la clave exacta.
 *
 * Cómo aparece una clave en `pg_locks`: los locks del repo son
 * `pg_advisory_xact_lock[_shared](hashtextextended(<clave>, 0))`, o sea la forma
 * de UN bigint. Postgres la guarda partida en dos oid sin signo:
 * `classid` = 32 bits altos, `objid` = 32 bits bajos, y `objsubid = 1` (la forma
 * de dos int4 usa `objsubid = 2`, que no usamos). Se calcula en SQL con el mismo
 * `hashtextextended` para no reimplementar el hash en JS.
 *
 * No es un `.test.ts`: el run unit nunca lo importa.
 */

/** Lo mínimo que usa el helper: sirve un PrismaClient o un tx client. */
export type RawQueryClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

/** Cuántas sesiones están esperando (NOT granted) el advisory lock de `key` en esta base. */
export async function countAdvisoryWaiters(db: RawQueryClient, key: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
    SELECT count(*)::int AS n
    FROM pg_locks l, k
    WHERE l.locktype = 'advisory'
      AND NOT l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.objsubid = 1
      AND l.classid = ((k.v >> 32) & 4294967295)::oid
      AND l.objid = (k.v & 4294967295)::oid`;
  return rows[0]?.n ?? 0;
}

/**
 * Hace polling hasta que haya al menos `minWaiters` sesiones esperando el lock
 * de `key`. Tira si no pasa en `timeoutMs`: un test de carrera que no llegó a
 * bloquearse NO probó nada y tiene que fallar, no seguir.
 */
export async function waitForAdvisoryWaiter(
  db: RawQueryClient,
  key: string,
  opts: { minWaiters?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const minWaiters = opts.minWaiters ?? 1;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    last = await countAdvisoryWaiters(db, key);
    if (last >= minWaiters) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForAdvisoryWaiter: ${last}/${minWaiters} waiters en el lock "${key}" después de ${timeoutMs} ms`,
  );
}
