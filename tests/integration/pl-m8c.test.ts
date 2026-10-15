/**
 * M8c `20261016120000_saas_payment_method` · PL-F0 (decisión de Martin del 16-oct: el medio de pago de la
 * suscripción va en una columna propia, no en la nota).
 *
 * Qué se prueba:
 *   1. Forma del archivo: una tx con lock_timeout, exactamente un CREATE TYPE y un ADD COLUMN, nada destructivo ni
 *      de backfill (los pagos existentes quedan en NULL = «sin informar»).
 *   2. Objetos: enum con los 6 valores en orden; columna `method` nullable, sin default; RLS de "SaasPayment" igual
 *      que en M8 (ENABLE + FORCE + UNA policy FOR SELECT por tenant) y sus CHECKs intactos.
 *   3. Datos (tx del owner que termina en ROLLBACK): acepta NULL y los 6 valores, rechaza uno inválido (22P02), y el
 *      cliente de Prisma generado lee/escribe el campo.
 *   4. Con el rol de la APP (`SET LOCAL ROLE kinesoft_app` dentro de la tx del owner, así corre igual en
 *      `test:integration` y en `:owner`): ve `method` solo de SU consultorio y sigue sin poder insertar ni editar
 *      (TENANT_READONLY: la columna nueva no abre escritura).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient, SaasPaymentMethod } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION = join(process.cwd(), "prisma/migrations/20261016120000_saas_payment_method/migration.sql");
const SQL = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
const METHODS = ["TRANSFER", "CASH", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"] as const;

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK (molde pl-m8.test.ts). */
async function inTx<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
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

async function asApp(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

/** Captura el error de Postgres de una tx que se espera que falle (el ROLLBACK lo hace la propia falla). */
async function pgError(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  try {
    await inTx(db, fn);
  } catch (e) {
    const meta = (e as { meta?: { code?: string } }).meta;
    return { code: meta?.code ?? (e as { code?: string }).code, message: String((e as Error).message) };
  }
  throw new Error("no falló");
}

const insertPayment = (tx: Prisma.TransactionClient, tenantId: string, method: string | null) =>
  tx.$executeRawUnsafe(
    `INSERT INTO "SaasPayment" (id, "tenantId", source, status, "amountCents", method)
     VALUES ($1, $2, 'MANUAL', 'PENDING_REVIEW', 100, $3::"SaasPaymentMethod")`,
    `m8c-${uniqueSuffix()}`,
    tenantId,
    method
  );

describe("M8c saas_payment_method · forma del archivo", () => {
  it("una tx con lock_timeout, un CREATE TYPE y un ADD COLUMN nullable, sin backfill", () => {
    expect(SQL).toMatch(/BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
    expect(SQL.trim().endsWith("COMMIT;")).toBe(true);
    expect(SQL).toMatch(
      /CREATE TYPE "SaasPaymentMethod" AS ENUM \('TRANSFER', 'CASH', 'CARD', 'WALLET', 'MERCADO_PAGO', 'OTHER'\);/
    );
    expect(SQL).toMatch(/ALTER TABLE "SaasPayment" ADD COLUMN "method" "SaasPaymentMethod";/);
    expect(SQL.match(/\b(CREATE|ALTER)\b/g)).toHaveLength(2);
    expect(SQL).not.toMatch(/\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE|NOT NULL|DEFAULT|CHECK|POLICY)\b/i);
  });
});

describe.skipIf(!RUN)("M8c saas_payment_method · objetos y datos", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  it("enum con los 6 valores en orden", async () => {
    const rows = await db.$queryRaw<{ v: string }[]>`
      SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'SaasPaymentMethod' ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.v)).toEqual([...METHODS]);
    // El código Prisma generado coincide con la base (el schema no quedó desfasado del SQL).
    expect(Object.values(SaasPaymentMethod)).toEqual([...METHODS]);
  });

  it("columna method: tipo SaasPaymentMethod, nullable, sin default", async () => {
    const col = await db.$queryRaw<{ udt_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'SaasPayment' AND column_name = 'method'`;
    expect(col).toEqual([{ udt_name: "SaasPaymentMethod", is_nullable: "YES", column_default: null }]);
  });

  it("RLS y CHECKs de SaasPayment iguales que en M8", async () => {
    const rel = await db.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = 'SaasPayment'`;
    expect(rel).toEqual([{ rls: true, force: true }]);
    const pol = await db.$queryRaw<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SaasPayment'`;
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ policyname: "SaasPayment_tenant_read", cmd: "SELECT", with_check: null });
    expect(pol[0].qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    const checks = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"SaasPayment"'::regclass AND contype = 'c' ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual([
      "SaasPayment_amountCents_check",
      "SaasPayment_notes_check",
      "SaasPayment_receipt_check",
      "SaasPayment_source_mp_check",
    ]);
    const priv = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT has_type_privilege('kinesoft_app', '"SaasPaymentMethod"', 'USAGE') AS ok`;
    expect(priv).toEqual([{ ok: true }]);
  });

  it("acepta NULL y los 6 valores; Prisma lo lee y lo escribe", async () => {
    const out = await inTx(db, async (tx) => {
      await insertPayment(tx, A.tenantId, null);
      for (const m of METHODS) await insertPayment(tx, A.tenantId, m);
      const viaPrisma = await tx.saasPayment.create({
        data: { tenantId: A.tenantId, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 100, method: "CASH" },
        select: { id: true, method: true },
      });
      const sinInformar = await tx.saasPayment.create({
        data: { tenantId: A.tenantId, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 100 },
        select: { method: true },
      });
      const rows = await tx.saasPayment.findMany({ where: { tenantId: A.tenantId }, select: { method: true } });
      return { viaPrisma, sinInformar, methods: rows.map((r) => r.method) };
    });
    expect(out.viaPrisma.method).toBe("CASH");
    expect(out.sinInformar.method).toBeNull(); // sin default: no informar = NULL
    expect(out.methods.filter((m) => m === null)).toHaveLength(2);
    expect(new Set(out.methods.filter((m) => m !== null))).toEqual(new Set(METHODS));
  });

  it("rechaza un valor fuera del enum", async () => {
    const err = await pgError(db, (tx) => insertPayment(tx, A.tenantId, "CHEQUE"));
    expect(err.message).toMatch(/invalid input value for enum "SaasPaymentMethod": "CHEQUE"|22P02/);
  });

  it("app: ve method solo de SU consultorio; no inserta ni edita (TENANT_READONLY)", async () => {
    const out = await inTx(db, async (tx) => {
      await insertPayment(tx, A.tenantId, "TRANSFER");
      await insertPayment(tx, B.tenantId, "CARD");
      await asApp(tx, A.tenantId);
      const pays = await tx.saasPayment.findMany({ select: { tenantId: true, method: true } });
      const upd = await tx.$executeRaw`UPDATE "SaasPayment" SET method = 'OTHER'`;
      return { pays, upd };
    });
    expect(out.pays).toEqual([{ tenantId: A.tenantId, method: "TRANSFER" }]);
    expect(out.upd).toBe(0);

    const ins = await pgError(db, async (tx) => {
      await asApp(tx, A.tenantId);
      await insertPayment(tx, A.tenantId, "CASH");
    });
    expect(ins.message).toMatch(/42501|row-level security|permission denied/);
  });
});
