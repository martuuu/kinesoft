/**
 * MIG (T6+T7, X0): helpers compartidos por los tests de migración M17 / M15 / M16
 * (`tests/integration/{tv-m17,wa-m15,mps-m16}.test.ts`).
 *
 * Por qué un archivo aparte: tpm-m18.test.ts tiene estos mismos helpers inline; con tres migraciones en la misma ola
 * copiarlos tres veces era invitar a que diverjan (un `attempt` sin SAVEPOINT aborta la tx y el resto del test da
 * falsos rojos/verdes). Todo es SQL crudo con columnas explícitas: los tests no dependen del cliente generado, así que
 * prueban la BASE (lo que corre en prod con BYPASSRLS) y no el schema de Prisma.
 *
 * NO es un `.test.ts`: la corrida unit nunca lo importa.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde pl-m8 / tpm-m18). */
export function codeOf(e: unknown): { code: string; message: string } {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (e.meta as { code?: string } | undefined)?.code;
    const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"|Code: `([0-9A-Z]{5})`/.exec(e.message);
    return { code: code ?? m?.[1] ?? m?.[2] ?? m?.[3] ?? e.code, message: e.message };
  }
  return { code: "?", message: String(e) };
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK; devuelve lo que `fn` devolvió y re-tira cualquier error de `fn`. */
export async function inTx<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: unknown;
  await db
    .$transaction(async (tx) => {
      throw new Done(await fn(tx));
    }, { timeout: 60_000 })
    .catch((e: unknown) => {
      out = e;
    });
  if (out instanceof Done) return out.value as T;
  throw out ?? new Error("la transacción commiteó (no debía)");
}

let spSeq = 0;
/** Corre `fn` dentro de un SAVEPOINT: si falla, vuelve atrás SOLO eso y la tx sigue viva. Devuelve el SQLSTATE u OK. */
export async function attempt(
  tx: Prisma.TransactionClient,
  fn: () => Promise<unknown>
): Promise<{ code: string; message: string }> {
  const sp = `mig_sp_${++spSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return { code: "OK", message: "" };
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    return codeOf(e);
  }
}

/** Baja la tx a `kinesoft_app` y fija el GUC como `runWithRls` (desde ahí, todo corre como la app). */
export async function asApp(tx: Prisma.TransactionClient, tenantId: string | null) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
/** `{ columna: "udt NULLABLE [default]" }` desde information_schema (opcionalmente solo `only`). */
export async function columns(db: PrismaClient, table: string, only?: string[]): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows
      .filter((r) => !only || only.includes(r.column_name))
      .map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

/** Etiquetas de cada enum, en orden de declaración. */
export async function enumLabels(db: PrismaClient, names: string[]): Promise<Record<string, string[]>> {
  const rows = await db.$queryRaw<{ t: string; labels: string[] }[]>`
    SELECT t.typname AS t, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = ANY(${names}) GROUP BY t.typname`;
  return Object.fromEntries(rows.map((r) => [r.t, r.labels]));
}

/** `{ indexname: "(cols) WHERE …" }` de los índices PARCIALES de las tablas (lo que Prisma no expresa). */
export async function partialIndexes(db: PrismaClient, tables: string[]): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<{ indexname: string; def: string }[]>`
    SELECT indexname, indexdef AS def FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY(${tables}) AND indexdef LIKE '% WHERE %' ORDER BY indexname`;
  return Object.fromEntries(rows.map((i) => [i.indexname, i.def.replace(/^.* USING btree /, "")]));
}

/** Nombres de todos los índices de las tablas (parciales o no), ordenados. */
export async function indexNames(db: PrismaClient, tables: string[]): Promise<string[]> {
  const rows = await db.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(${tables}) ORDER BY indexname`;
  return rows.map((r) => r.indexname);
}

/** `{ conname: pg_get_constraintdef }` de las constraints de tipo `type` ('f' FK, 'c' CHECK) de las tablas. */
export async function constraintDefs(db: PrismaClient, tables: string[], type: "f" | "c"): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<{ conname: string; def: string }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE contype = ${type}::"char" AND conrelid::regclass::text = ANY(${tables.map((t) => `"${t}"`)}) ORDER BY conname`;
  return Object.fromEntries(rows.map((r) => [r.conname, r.def]));
}

/** ENABLE/FORCE de RLS y las policies (cmd, qual, with_check) de las tablas. */
export async function rlsState(db: PrismaClient, tables: string[]) {
  const rel = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
    SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${tables}) ORDER BY relname`;
  const pol = await db.$queryRaw<
    { tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]
  >`
    SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(${tables}) ORDER BY tablename, policyname`;
  const grants = await db.$queryRaw<{ grantee: string; table_name: string }[]>`
    SELECT DISTINCT grantee, table_name FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = ANY(${tables}) AND grantee IN ('anon', 'authenticated')`;
  return { rel, pol, grants };
}

/** Lo que devuelve pg_policies.qual para la policy por tenant. */
export const TENANT_QUAL = `("tenantId" = app_current_tenant_id())`;
