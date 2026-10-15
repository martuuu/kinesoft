/**
 * M8 `20261015180000_pl_accounts_billing` · bloque PL del §20, ola PL-0 (plan §20.5.1 y §20.5.12; brief PL «M8»).
 *
 * Qué se prueba:
 *   1. Objetos (catálogo de Postgres, por el owner): enums, columnas nuevas con tipo/nulabilidad/default, CHECKs,
 *      índices (el PARCIAL de TwoFactorChallenge incluido), RLS ENABLE + FORCE y las policies EXACTAS por categoría,
 *      triggers de solo inserción y las 4 filas de SaasPlanConfig con precios NULL.
 *   2. Backfill: se re-ejecutan los UPDATE de backfill LEÍDOS DEL migration.sql REAL (no una copia) sobre filas
 *      armadas en el estado «previo a M8», dentro de una tx que termina en ROLLBACK: mapeo PL-D2, override desde
 *      seatLimitOverride, clinical/grantSettings/disabledReason, Practitioner.publicBookingEnabled → true, y que
 *      `Tenant.updatedAt` no se toca.
 *   3. Comportamiento: CHECKs en la base (23514), FKs compuestas (23503), únicos (23505), triggers (P0001 también
 *      para el owner; `appliedAt` NULL → valor permitido), índice parcial (dos desafíos abiertos → 23505) y, con el
 *      rol de la APP (`SET LOCAL ROLE kinesoft_app` dentro de una tx del owner, así corre igual en
 *      `test:integration` y en `:owner`): lee SaasPlanConfig y no lo escribe; ve solo SU suscripción/cargos/pagos y
 *      no los escribe; crea hilos y mensajes TENANT pero no forja PLATFORM ni escribe en otro consultorio; no ve
 *      los leads; no ve ni escribe las tablas de 2FA, el historial de precios ni el registro de seguridad.
 *   4. `deleteTenantDeep` borra un consultorio con filas en todas las tablas nuevas (incluido el registro de solo
 *      inserción, en modo réplica).
 *
 * Casi todo corre dentro de txs con ROLLBACK (`inTx`): las tablas de solo inserción no se pueden limpiar después.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION = join(process.cwd(), "prisma/migrations/20261015180000_pl_accounts_billing/migration.sql");

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde platform-backoffice-m7.test.ts). */
async function sqlError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      return { code: code ?? m?.[1] ?? m?.[2] ?? e.code, message: e.message };
    }
    return { code: "?", message: String(e) };
  }
  return { code: "OK", message: "" };
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/**
 * Corre `fn` en una tx del owner que SIEMPRE termina en ROLLBACK y devuelve lo que `fn` devolvió; re-tira cualquier
 * error de `fn`. `asApp(tx, tenantId)` baja la tx a `kinesoft_app` y fija el GUC como `runWithRls` (desde ahí, todo
 * lo que sigue en la tx corre como la app).
 */
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

async function asApp(tx: Prisma.TransactionClient, tenantId: string | null) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

const count = async (tx: Prisma.TransactionClient, table: string) =>
  Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0].n);

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
async function columns(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

const NEW_TABLES = [
  "SaasPlanConfig",
  "SaasPlanPriceChange",
  "SaasSubscription",
  "SaasCharge",
  "SaasPayment",
  "SupportThread",
  "SupportMessage",
  "SupportThreadRead",
  "TwoFactorChallenge",
  "TwoFactorRecoveryCode",
  "UserSecurityEvent",
] as const;
const SERVICE_ONLY = ["SaasPlanPriceChange", "TwoFactorChallenge", "TwoFactorRecoveryCode", "UserSecurityEvent"];
const TENANT_READONLY = ["SaasSubscription", "SaasCharge", "SaasPayment"];

describe.skipIf(!RUN)("M8 pl_accounts_billing · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("enums con sus valores en orden", async () => {
    const rows = await db.$queryRaw<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('SaasPlan','SaasChargeStatus','SaasPaymentSource','SaasPaymentStatus','SupportThreadKind',
                          'SupportThreadStatus','SupportAuthorKind','TwoFactorPurpose')
      GROUP BY t.typname`;
    expect(Object.fromEntries(rows.map((r) => [r.typname, r.labels]))).toEqual({
      SaasPlan: ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"],
      SaasChargeStatus: ["OPEN", "PAID", "VOID", "WAIVED"],
      SaasPaymentSource: ["MP_AUTO", "MP_CHECKOUT", "MANUAL"],
      SaasPaymentStatus: ["PENDING_REVIEW", "APPROVED", "REJECTED", "REFUNDED"],
      SupportThreadKind: ["TENANT", "LEAD"],
      SupportThreadStatus: ["OPEN", "CLOSED"],
      SupportAuthorKind: ["TENANT", "PLATFORM", "LEAD"],
      TwoFactorPurpose: ["LOGIN", "STEP_UP", "ENROLL_EMAIL"],
    });
  });

  it("columnas nuevas en Tenant, Membership, Practitioner y UserProfile", async () => {
    const t = await columns(db, "Tenant");
    expect({
      saasPlan: t.saasPlan,
      maxUsersOverride: t.maxUsersOverride,
      maxProfessionalsOverride: t.maxProfessionalsOverride,
      maxStaffOverride: t.maxStaffOverride,
    }).toEqual({
      saasPlan: `SaasPlan NO 'INDIVIDUAL'::"SaasPlan"`,
      maxUsersOverride: "int4 YES",
      maxProfessionalsOverride: "int4 YES",
      maxStaffOverride: "int4 YES",
    });
    // El legado sigue: el código viejo lo lee (expand/contract).
    expect(t.plan).toBe(`TenantPlan NO 'FREE'::"TenantPlan"`);
    expect(t.seatLimitOverride).toBe("int4 YES");
    const m = await columns(db, "Membership");
    expect({
      clinical: m.clinical,
      grantSettings: m.grantSettings,
      grantBilling: m.grantBilling,
      disabledReason: m.disabledReason,
    }).toEqual({
      clinical: "bool NO true",
      grantSettings: "bool NO false",
      grantBilling: "bool NO false",
      disabledReason: "text YES",
    });
    expect((await columns(db, "Practitioner")).publicBookingEnabled).toBe("bool NO false");
    const u = await columns(db, "UserProfile");
    expect({ e: u.twoFactorEmail, t: u.twoFactorTotp, at: u.twoFactorUpdatedAt }).toEqual({
      e: "bool NO false",
      t: "bool NO false",
      at: "timestamp YES",
    });
  });

  it("SaasPlanConfig: las 4 filas con límites PL-D3, 14 días de prueba en Individual y precios NULL", async () => {
    const rows = await db.saasPlanConfig.findMany({ orderBy: { sortOrder: "asc" } });
    expect(
      rows.map((r) => [r.plan, r.label, r.priceCents, r.maxUsers, r.maxProfessionals, r.maxStaff, r.trialDays, r.isPublic, r.sortOrder])
    ).toEqual([
      ["INDIVIDUAL", "Individual", null, 1, 1, 1, 14, true, 1],
      ["CONSULTORIO", "Consultorio", null, 5, 4, 1, 0, true, 2],
      ["CLINICA", "Clínica", null, 10, null, null, 0, true, 3],
      ["LIBRE", "Libre", null, null, null, null, 0, true, 4],
    ]);
  });

  it("CHECKs y FKs compuestas presentes con su nombre (drift aceptado)", async () => {
    const rows = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('c','f')`;
    const names = new Set(rows.map((r) => r.conname));
    for (const c of [
      "Tenant_maxUsersOverride_check",
      "Tenant_maxProfessionalsOverride_check",
      "Tenant_maxStaffOverride_check",
      "Membership_disabledReason_check",
      "SaasPlanConfig_label_check",
      "SaasPlanConfig_priceCents_check",
      "SaasPlanConfig_limits_check",
      "SaasPlanConfig_trialDays_check",
      "SaasPlanPriceChange_priceCents_check",
      "SaasPlanPriceChange_note_check",
      "SaasSubscription_anchorDay_check",
      "SaasSubscription_amounts_check",
      "SaasCharge_amountCents_check",
      "SaasCharge_period_check",
      "SaasCharge_paid_check",
      "SaasCharge_note_check",
      "SaasPayment_amountCents_check",
      "SaasPayment_source_mp_check",
      "SaasPayment_receipt_check",
      "SaasPayment_notes_check",
      "SupportThread_subject_check",
      "SupportThread_kind_check",
      "SupportThread_lead_fields_check",
      "SupportMessage_body_check",
      "SupportMessage_author_check",
      "TwoFactorChallenge_attempts_check",
      "TwoFactorChallenge_expiry_check",
      "TwoFactorChallenge_closed_check",
      "UserSecurityEvent_kind_check",
      "SaasPayment_chargeId_tenantId_fkey",
      "SupportMessage_threadId_fkey",
      "SupportMessage_threadId_tenantId_fkey",
      "SupportThreadRead_threadId_tenantId_fkey",
    ]) {
      expect(names.has(c), c).toBe(true);
    }
  });

  it("índices: únicos de idempotencia y el PARCIAL de TwoFactorChallenge", async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]})`;
    const idx = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(idx.TwoFactorChallenge_one_open).toMatch(
      /^CREATE UNIQUE INDEX "TwoFactorChallenge_one_open" ON public\."TwoFactorChallenge" USING btree \("userId", purpose, "sessionId"\) WHERE \("closedAt" IS NULL\)$/
    );
    expect(idx.SaasCharge_tenantId_periodStart_key).toMatch(/UNIQUE INDEX .* \("tenantId", "periodStart"\)$/);
    expect(idx.SaasCharge_id_tenantId_key).toMatch(/UNIQUE INDEX .* \(id, "tenantId"\)$/);
    expect(idx.SaasPayment_mpPaymentId_key).toMatch(/UNIQUE INDEX .* \("mpPaymentId"\)$/);
    expect(idx.SaasPayment_mpAuthorizedPaymentId_key).toMatch(/UNIQUE INDEX .* \("mpAuthorizedPaymentId"\)$/);
    expect(idx.SaasSubscription_mpPreapprovalId_key).toMatch(/UNIQUE INDEX .* \("mpPreapprovalId"\)$/);
    expect(idx.SupportThread_id_tenantId_key).toMatch(/UNIQUE INDEX .* \(id, "tenantId"\)$/);
    expect(idx.TwoFactorRecoveryCode_userId_codeHash_key).toMatch(/UNIQUE INDEX .* \("userId", "codeHash"\)$/);
  });

  it("RLS: ENABLE + FORCE en las 11; policies exactas por categoría", async () => {
    const rel = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...NEW_TABLES]})`;
    expect(rel).toHaveLength(NEW_TABLES.length);
    for (const r of rel) expect([r.relname, r.rls, r.force]).toEqual([r.relname, true, true]);

    const pol = await db.$queryRaw<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]}) ORDER BY tablename, policyname`;
    expect(pol.map((p) => [p.tablename, p.policyname, p.cmd])).toEqual([
      ["SaasCharge", "SaasCharge_tenant_read", "SELECT"],
      ["SaasPayment", "SaasPayment_tenant_read", "SELECT"],
      ["SaasPlanConfig", "SaasPlanConfig_read", "SELECT"],
      ["SaasSubscription", "SaasSubscription_tenant_read", "SELECT"],
      ["SupportMessage", "SupportMessage_tenant_insert", "INSERT"],
      ["SupportMessage", "SupportMessage_tenant_read", "SELECT"],
      ["SupportThread", "SupportThread_tenant_insert", "INSERT"],
      ["SupportThread", "SupportThread_tenant_read", "SELECT"],
      ["SupportThreadRead", "SupportThreadRead_tenant_isolation", "ALL"],
    ]);
    // Ninguna SERVICE_ONLY con policy.
    expect(pol.filter((p) => SERVICE_ONLY.includes(p.tablename))).toEqual([]);
    for (const p of pol.filter((x) => TENANT_READONLY.includes(x.tablename))) {
      expect(p.qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    }
    const ins = Object.fromEntries(pol.filter((p) => p.cmd === "INSERT").map((p) => [p.policyname, p.with_check]));
    expect(ins.SupportThread_tenant_insert).toMatch(/"tenantId" = app_current_tenant_id\(\)\) AND \(kind = 'TENANT'/);
    expect(ins.SupportMessage_tenant_insert).toMatch(/"tenantId" = app_current_tenant_id\(\)\) AND \("authorKind" = 'TENANT'/);
  });

  it("triggers de solo inserción habilitados (O) en SaasPlanPriceChange y UserSecurityEvent", async () => {
    const trg = await db.$queryRaw<{ rel: string; tgname: string; enabled: string; def: string }[]>`
      SELECT tgrelid::regclass::text AS rel, tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('"SaasPlanPriceChange"', '"UserSecurityEvent"')
      ORDER BY 1, 2`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([
      ["SaasPlanPriceChange_guard", "O"],
      ["SaasPlanPriceChange_no_truncate", "O"],
      ["UserSecurityEvent_append_only", "O"],
      ["UserSecurityEvent_no_truncate", "O"],
    ]);
    expect(trg[0].def).toMatch(/BEFORE DELETE OR UPDATE .* FOR EACH ROW EXECUTE FUNCTION saas_plan_price_change_guard\(\)/);
    expect(trg[2].def).toMatch(/BEFORE DELETE OR UPDATE .* FOR EACH ROW EXECUTE FUNCTION kinesoft_append_only\(\)/);
  });

  it("privilegios: kinesoft_app por DEFAULT PRIVILEGES; anon/authenticated nada (guard 3c)", async () => {
    for (const t of NEW_TABLES) {
      const [p] = await db.$queryRaw<{ sel: boolean; ins: boolean }[]>`
        SELECT has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'SELECT') AS sel,
               has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'INSERT') AS ins`;
      // Con grant: lo que bloquea es RLS (lo prueban los tests de la app abajo).
      expect(p, t).toEqual({ sel: true, ins: true });
    }
    const rows = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ANY(${[...NEW_TABLES]}) AND grantee IN ('anon', 'authenticated')`;
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!RUN)("M8 pl_accounts_billing · backfill (UPDATEs del migration.sql real, en ROLLBACK)", () => {
  let db: PrismaClient;
  // Los UPDATE de backfill, tal cual están en el archivo (sin comentarios).
  const BACKFILL = readFileSync(MIGRATION, "utf8")
    .replace(/--[^\n]*/g, "")
    .match(/UPDATE\s+"(?:Tenant|Membership|Practitioner)"\s+SET[\s\S]*?;/g);

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("el archivo tiene exactamente los 5 UPDATE de backfill esperados", () => {
    expect(BACKFILL?.map((s) => /UPDATE\s+"(\w+)"/.exec(s)?.[1])).toEqual([
      "Tenant",
      "Membership",
      "Membership",
      "Membership",
      "Practitioner",
    ]);
  });

  it("mapeo PL-D2, override desde seatLimitOverride, membresías, profesionales; updatedAt intacto", async () => {
    const s = uniqueSuffix();
    const old = new Date("2020-01-01T00:00:00.000Z");
    const plans = ["FREE", "STARTER", "PRO", "ENTERPRISE"] as const;
    const out = await inTx(db, async (tx) => {
      // Filas en el estado «previo a M8»: saasPlan en su default, overrides NULL, membresías todas clínicas.
      for (const [i, plan] of plans.entries()) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Tenant" (id, slug, name, plan, "seatLimitOverride", "updatedAt")
           VALUES ($1, $2, 'M8 backfill', $3::"TenantPlan", $4, $5)`,
          `m8-t-${i}-${s}`,
          `test-m8-${i}-${s}`,
          plan,
          i === 1 ? 3 : null,
          old
        );
      }
      const tid = `m8-t-0-${s}`;
      const roles = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"] as const;
      for (const role of roles) {
        const uid = `test-user-m8-${role}-${s}`;
        await tx.$executeRaw`INSERT INTO "UserProfile" (id, email) VALUES (${uid}, ${`${uid}@test.local`})`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "Membership" (id, "userId", "tenantId", role, "disabledAt") VALUES ($1, $2, $3, $4::"Role", $5)`,
          `m8-m-${role}-${s}`,
          uid,
          tid,
          role,
          role === "PRACTITIONER" ? new Date() : null
        );
      }
      await tx.$executeRaw`INSERT INTO "Practitioner" (id, "tenantId", "userId") VALUES (${`m8-p-${s}`}, ${tid}, ${`test-user-m8-PRACTITIONER-${s}`})`;

      for (const stmt of BACKFILL ?? []) await tx.$executeRawUnsafe(stmt);

      const tenants = await tx.$queryRaw<{ plan: string; saasPlan: string; mpo: number | null; updatedAt: Date }[]>`
        SELECT plan::text, "saasPlan"::text AS "saasPlan", "maxProfessionalsOverride" AS mpo, "updatedAt"
        FROM "Tenant" WHERE id LIKE ${`m8-t-%-${s}`} ORDER BY id`;
      const members = await tx.$queryRaw<{ role: string; clinical: boolean; gs: boolean; gb: boolean; dr: string | null }[]>`
        SELECT role::text, clinical, "grantSettings" AS gs, "grantBilling" AS gb, "disabledReason" AS dr
        FROM "Membership" WHERE "tenantId" = ${tid} ORDER BY role`;
      const pract = await tx.$queryRaw<{ on: boolean }[]>`
        SELECT "publicBookingEnabled" AS on FROM "Practitioner" WHERE id = ${`m8-p-${s}`}`;
      return { tenants, members, pract };
    });

    expect(out.tenants.map((t) => [t.plan, t.saasPlan, t.mpo])).toEqual([
      ["FREE", "INDIVIDUAL", null],
      ["STARTER", "CONSULTORIO", 3],
      ["PRO", "CLINICA", null],
      ["ENTERPRISE", "LIBRE", null],
    ]);
    for (const t of out.tenants) expect(t.updatedAt.toISOString()).toBe(old.toISOString());
    expect(out.members.map((m) => [m.role, m.clinical, m.gs, m.gb, m.dr])).toEqual([
      // ORDER BY role::text = alfabético.
      ["ADMIN", true, true, false, null],
      ["ASSISTANT", false, false, false, null],
      ["BILLING", false, false, false, null],
      ["OWNER", true, false, false, null],
      ["PRACTITIONER", true, false, false, "MANUAL"],
    ]);
    expect(out.pract).toEqual([{ on: true }]);
  });

  it("Practitioner nuevo nace fuera del turnero (default false, opt-in)", async () => {
    const s = uniqueSuffix();
    const on = await inTx(db, async (tx) => {
      await tx.$executeRaw`INSERT INTO "Tenant" (id, slug, name, "updatedAt") VALUES (${`m8-tp-${s}`}, ${`test-m8-tp-${s}`}, 'x', now())`;
      await tx.$executeRaw`INSERT INTO "UserProfile" (id, email) VALUES (${`test-user-m8p-${s}`}, ${`m8p-${s}@test.local`})`;
      await tx.$executeRaw`INSERT INTO "Practitioner" (id, "tenantId", "userId") VALUES (${`m8-pp-${s}`}, ${`m8-tp-${s}`}, ${`test-user-m8p-${s}`})`;
      return tx.$queryRaw<{ on: boolean }[]>`SELECT "publicBookingEnabled" AS on FROM "Practitioner" WHERE id = ${`m8-pp-${s}`}`;
    });
    expect(on).toEqual([{ on: false }]);
  });
});

describe.skipIf(!RUN)("M8 pl_accounts_billing · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  const charge = (tx: Prisma.TransactionClient, tenantId: string, periodStart = "2026-10-01") => {
    const id = `m8-c-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "SaasCharge" (id, "tenantId", plan, "periodStart", "periodEnd", "dueDate", "amountCents")
      VALUES (${id}, ${tenantId}, 'CONSULTORIO', ${periodStart}::date, (${periodStart}::date + 30), (${periodStart}::date + 5), 1500000)`.then(
      () => id
    );
  };
  const payment = (
    tx: Prisma.TransactionClient,
    p: { tenantId: string; chargeId?: string | null; source?: string; mpPaymentId?: string | null; mime?: string | null }
  ) => {
    const id = `m8-pay-${uniqueSuffix()}`;
    return tx.$executeRawUnsafe(
      `INSERT INTO "SaasPayment" (id, "tenantId", "chargeId", source, status, "amountCents", "mpPaymentId",
                                  "receiptPath", "receiptMimeType", "receiptSizeBytes")
       VALUES ($1, $2, $3, $4::"SaasPaymentSource", 'APPROVED', 1500000, $5, $6, $7, $8)`,
      id,
      p.tenantId,
      p.chargeId ?? null,
      p.source ?? "MANUAL",
      p.mpPaymentId ?? null,
      p.mime ? "receipts/x" : null,
      p.mime ?? null,
      p.mime ? 1000 : null
    ).then(() => id);
  };
  const thread = (tx: Prisma.TransactionClient, tenantId: string, subject = "No me llega el mail") => {
    const id = `m8-th-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "SupportThread" (id, kind, "tenantId", subject, "updatedAt")
      VALUES (${id}, 'TENANT', ${tenantId}, ${subject}, now())`.then(() => id);
  };
  const message = (
    tx: Prisma.TransactionClient,
    p: { threadId: string; tenantId: string | null; authorKind: string; authorUserId?: string | null; body?: string }
  ) => {
    const id = `m8-msg-${uniqueSuffix()}`;
    return tx.$executeRawUnsafe(
      `INSERT INTO "SupportMessage" (id, "threadId", "tenantId", "authorKind", "authorUserId", body)
       VALUES ($1, $2, $3, $4::"SupportAuthorKind", $5, $6)`,
      id,
      p.threadId,
      p.tenantId,
      p.authorKind,
      p.authorUserId === undefined ? "u" : p.authorUserId,
      p.body ?? "Hola"
    ).then(() => id);
  };
  const lead = (tx: Prisma.TransactionClient) => {
    const id = `m8-lead-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "SupportThread" (id, kind, subject, "leadName", "leadEmail", "leadPlanInterest", "updatedAt")
      VALUES (${id}, 'LEAD', 'Quiero el plan Clínica', 'Ana', 'ana@test.local', 'CLINICA', now())`.then(() => id);
  };
  const challenge = (tx: Prisma.TransactionClient, userId: string, sessionId: string) => {
    const id = `m8-ch-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "TwoFactorChallenge" (id, "userId", purpose, "sessionId", "codeHash", "expiresAt")
      VALUES (${id}, ${userId}, 'STEP_UP', ${sessionId}, 'hash', now() + interval '10 minutes')`.then(() => id);
  };
  const priceChange = (tx: Prisma.TransactionClient) => {
    const id = `m8-pc-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "SaasPlanPriceChange" (id, plan, "priceCents", "effectiveFrom", note)
      VALUES (${id}, 'CONSULTORIO', 1500000, now() + interval '1 day', 'Aumento')`.then(() => id);
  };
  const securityEvent = (tx: Prisma.TransactionClient, userId: string, tenantId: string | null) => {
    const id = `m8-se-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "UserSecurityEvent" (id, "userId", "tenantId", kind) VALUES (${id}, ${userId}, ${tenantId}, '2fa.enabled')`.then(
      () => id
    );
  };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  // ── CHECKs ──────────────────────────────────────────────────────────
  it("CHECKs de Tenant y Membership: overrides fuera de rango y motivo desconocido → 23514", async () => {
    for (const sql of [
      `UPDATE "Tenant" SET "maxUsersOverride" = 0 WHERE id = $1`,
      `UPDATE "Tenant" SET "maxProfessionalsOverride" = -1 WHERE id = $1`,
      `UPDATE "Tenant" SET "maxStaffOverride" = -1 WHERE id = $1`,
      `UPDATE "Membership" SET "disabledReason" = 'OTRO' WHERE "tenantId" = $1`,
    ]) {
      const r = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(sql, A.tenantId)));
      expect(r.code, sql).toBe("23514");
    }
    // Bordes que entran: total 1, por tipo 0, y los tres motivos.
    const ok = await inTx(db, async (tx) => [
      await tx.$executeRaw`UPDATE "Tenant" SET "maxUsersOverride" = 1, "maxProfessionalsOverride" = 0, "maxStaffOverride" = 0 WHERE id = ${A.tenantId}`,
      await tx.$executeRaw`UPDATE "Membership" SET "disabledReason" = 'PLAN_DOWNGRADE' WHERE "tenantId" = ${A.tenantId}`,
      await tx.$executeRaw`UPDATE "Membership" SET "disabledReason" = 'PLATFORM' WHERE "tenantId" = ${A.tenantId}`,
    ]);
    expect(ok).toEqual([1, 1, 1]);
  });

  it("CHECKs de cobros: MANUAL con id de MP, MP sin ids, comprobante inválido, PAID sin fecha, período al revés → 23514", async () => {
    const cases: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      ["MANUAL con mpPaymentId", (tx) => payment(tx, { tenantId: A.tenantId, source: "MANUAL", mpPaymentId: "123" })],
      ["MP_AUTO sin ids", (tx) => payment(tx, { tenantId: A.tenantId, source: "MP_AUTO" })],
      ["comprobante .exe", (tx) => payment(tx, { tenantId: A.tenantId, mime: "application/x-msdownload" })],
      [
        "comprobante > 4 MB",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SaasPayment" (id, "tenantId", source, status, "amountCents", "receiptPath", "receiptMimeType", "receiptSizeBytes")
            VALUES (${`m8-pay-${uniqueSuffix()}`}, ${A.tenantId}, 'MANUAL', 'PENDING_REVIEW', 100, 'r', 'application/pdf', 4194305)`,
      ],
      // Regresión: con `mime IN (…)` sin IS NOT NULL, una ruta sin tipo ni tamaño pasaba (NULL en un CHECK = pasa).
      [
        "comprobante con ruta y sin tipo ni tamaño",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SaasPayment" (id, "tenantId", source, status, "amountCents", "receiptPath")
            VALUES (${`m8-pay-${uniqueSuffix()}`}, ${A.tenantId}, 'MANUAL', 'PENDING_REVIEW', 100, 'r')`,
      ],
      [
        "monto 0",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SaasPayment" (id, "tenantId", source, status, "amountCents")
            VALUES (${`m8-pay-${uniqueSuffix()}`}, ${A.tenantId}, 'MANUAL', 'PENDING_REVIEW', 0)`,
      ],
      [
        "PAID sin paidAt",
        async (tx) => {
          const c = await charge(tx, A.tenantId);
          await tx.$executeRaw`UPDATE "SaasCharge" SET status = 'PAID' WHERE id = ${c}`;
        },
      ],
      [
        "período al revés",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SaasCharge" (id, "tenantId", plan, "periodStart", "periodEnd", "dueDate", "amountCents")
            VALUES (${`m8-c-${uniqueSuffix()}`}, ${A.tenantId}, 'INDIVIDUAL', '2026-10-01', '2026-10-01', '2026-10-05', 100)`,
      ],
      [
        "anchorDay 29",
        (tx) => tx.$executeRaw`INSERT INTO "SaasSubscription" ("tenantId", "anchorDay") VALUES (${A.tenantId}, 29)`,
      ],
      [
        "precio negativo en SaasPlanConfig",
        (tx) => tx.$executeRaw`UPDATE "SaasPlanConfig" SET "priceCents" = -1 WHERE plan = 'INDIVIDUAL'`,
      ],
    ];
    for (const [name, fn] of cases) {
      const r = await sqlError(inTx(db, fn));
      expect(r.code, name).toBe("23514");
    }
    // Lo válido entra: MANUAL con comprobante PDF; MP_CHECKOUT con id; PAID con fecha.
    const ok = await inTx(db, async (tx) => {
      const c = await charge(tx, A.tenantId);
      await payment(tx, { tenantId: A.tenantId, chargeId: c, mime: "application/pdf" });
      await payment(tx, { tenantId: A.tenantId, chargeId: c, source: "MP_CHECKOUT", mpPaymentId: `mp-${uniqueSuffix()}` });
      return tx.$executeRaw`UPDATE "SaasCharge" SET status = 'PAID', "paidAt" = now() WHERE id = ${c}`;
    });
    expect(ok).toBe(1);
  });

  it("cobros: un cargo por período (23505), id de MP único (23505) y el pago no se cuelga del cargo de OTRO consultorio (23503)", async () => {
    const dupPeriod = await sqlError(
      inTx(db, async (tx) => {
        await charge(tx, A.tenantId, "2026-11-01");
        await charge(tx, A.tenantId, "2026-11-01");
      })
    );
    expect(dupPeriod.code).toBe("23505");
    const mp = `mp-${uniqueSuffix()}`;
    const dupMp = await sqlError(
      inTx(db, async (tx) => {
        await payment(tx, { tenantId: A.tenantId, source: "MP_AUTO", mpPaymentId: mp });
        await payment(tx, { tenantId: B.tenantId, source: "MP_AUTO", mpPaymentId: mp });
      })
    );
    expect(dupMp.code).toBe("23505");
    const cross = await sqlError(
      inTx(db, async (tx) => {
        const cB = await charge(tx, B.tenantId);
        await payment(tx, { tenantId: A.tenantId, chargeId: cB });
      })
    );
    expect(cross.code).toBe("23503");
  });

  it("CHECKs de mensajes: hilo TENANT con datos de lead, LEAD con consultorio, asunto vacío, cuerpo > 5000, LEAD con autor → 23514", async () => {
    const cases: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "TENANT con leadEmail",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SupportThread" (id, kind, "tenantId", subject, "leadEmail", "updatedAt")
            VALUES (${`m8-th-${uniqueSuffix()}`}, 'TENANT', ${A.tenantId}, 'x', 'a@b.c', now())`,
      ],
      [
        "LEAD con tenantId",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SupportThread" (id, kind, "tenantId", subject, "leadName", "leadEmail", "updatedAt")
            VALUES (${`m8-th-${uniqueSuffix()}`}, 'LEAD', ${A.tenantId}, 'x', 'Ana', 'a@b.c', now())`,
      ],
      [
        "LEAD sin email",
        (tx) =>
          tx.$executeRaw`INSERT INTO "SupportThread" (id, kind, subject, "leadName", "updatedAt")
            VALUES (${`m8-th-${uniqueSuffix()}`}, 'LEAD', 'x', 'Ana', now())`,
      ],
      ["asunto en blanco", (tx) => thread(tx, A.tenantId, "   ")],
      ["asunto de 201", (tx) => thread(tx, A.tenantId, "x".repeat(201))],
      [
        "cuerpo de 5001",
        async (tx) => message(tx, { threadId: await thread(tx, A.tenantId), tenantId: A.tenantId, authorKind: "TENANT", body: "x".repeat(5001) }),
      ],
      [
        "TENANT sin autor",
        async (tx) => message(tx, { threadId: await thread(tx, A.tenantId), tenantId: A.tenantId, authorKind: "TENANT", authorUserId: null }),
      ],
      [
        "LEAD con autor",
        async (tx) => message(tx, { threadId: await lead(tx), tenantId: null, authorKind: "LEAD", authorUserId: "u" }),
      ],
    ];
    for (const [name, fn] of cases) {
      const r = await sqlError(inTx(db, fn));
      expect(r.code, name).toBe("23514");
    }
    // El mensaje con tenantId de A no se cuelga del hilo de B (FK compuesta).
    const cross = await sqlError(
      inTx(db, async (tx) => message(tx, { threadId: await thread(tx, B.tenantId), tenantId: A.tenantId, authorKind: "TENANT" }))
    );
    expect(cross.code).toBe("23503");
    // Bordes que entran: asunto de 200, cuerpo de 5000, lead con su mensaje.
    const ok = await inTx(db, async (tx) => {
      const th = await thread(tx, A.tenantId, "x".repeat(200));
      await message(tx, { threadId: th, tenantId: A.tenantId, authorKind: "TENANT", body: "y".repeat(5000) });
      const l = await lead(tx);
      return message(tx, { threadId: l, tenantId: null, authorKind: "LEAD", authorUserId: null });
    });
    expect(ok).toMatch(/^m8-msg-/);
  });

  // ── App: SaasPlanConfig (GLOBAL_READONLY) ───────────────────────────
  it("app: lee SaasPlanConfig (con o sin GUC) y no la escribe", async () => {
    const out = await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const read = await tx.saasPlanConfig.findMany({ select: { plan: true }, orderBy: { sortOrder: "asc" } });
      const upd = await tx.$executeRaw`UPDATE "SaasPlanConfig" SET "priceCents" = 1 WHERE plan = 'INDIVIDUAL'`;
      const del = await tx.$executeRaw`DELETE FROM "SaasPlanConfig" WHERE plan = 'LIBRE'`;
      return { read: read.map((r) => r.plan), upd, del };
    });
    expect(out).toEqual({ read: ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"], upd: 0, del: 0 });
    const noGuc = await inTx(db, async (tx) => {
      await asApp(tx, null);
      return count(tx, "SaasPlanConfig");
    });
    expect(noGuc).toBe(4);
    const ins = await sqlError(
      inTx(db, async (tx) => {
        await tx.$executeRaw`DELETE FROM "SaasPlanConfig" WHERE plan = 'LIBRE'`; // owner: deja el lugar libre
        await asApp(tx, A.tenantId);
        await tx.$executeRaw`INSERT INTO "SaasPlanConfig" (plan, label) VALUES ('LIBRE', 'Trucho')`;
      })
    );
    expect(ins.code).toBe("42501");
  });

  // ── App: cobros (TENANT_READONLY) ───────────────────────────────────
  it("app: ve solo SU suscripción, cargos y pagos; no inserta, no edita ni borra", async () => {
    const out = await inTx(db, async (tx) => {
      await tx.$executeRaw`INSERT INTO "SaasSubscription" ("tenantId") VALUES (${A.tenantId}), (${B.tenantId})`;
      const cA = await charge(tx, A.tenantId);
      const cB = await charge(tx, B.tenantId);
      const pA = await payment(tx, { tenantId: A.tenantId, chargeId: cA });
      await payment(tx, { tenantId: B.tenantId, chargeId: cB });
      await asApp(tx, A.tenantId);
      const subs = await tx.saasSubscription.findMany({ select: { tenantId: true } });
      const charges = await tx.saasCharge.findMany({ select: { id: true } });
      const pays = await tx.saasPayment.findMany({ select: { id: true } });
      const updCharge = await tx.$executeRaw`UPDATE "SaasCharge" SET status = 'WAIVED'`;
      const updPay = await tx.$executeRaw`UPDATE "SaasPayment" SET status = 'REFUNDED'`;
      const updSub = await tx.$executeRaw`UPDATE "SaasSubscription" SET "autoDebitAllowed" = true`;
      const delPay = await tx.$executeRaw`DELETE FROM "SaasPayment"`;
      return { subs, charges: charges.map((c) => c.id), pays: pays.map((p) => p.id), cA, pA, updCharge, updPay, updSub, delPay };
    });
    expect(out.subs).toEqual([{ tenantId: A.tenantId }]);
    expect(out.charges).toEqual([out.cA]);
    expect(out.pays).toEqual([out.pA]);
    expect([out.updCharge, out.updPay, out.updSub, out.delPay]).toEqual([0, 0, 0, 0]);

    for (const [name, fn] of [
      ["pago", (tx: Prisma.TransactionClient) => payment(tx, { tenantId: A.tenantId })],
      ["cargo", (tx: Prisma.TransactionClient) => charge(tx, A.tenantId)],
      ["suscripción", (tx: Prisma.TransactionClient) => tx.$executeRaw`INSERT INTO "SaasSubscription" ("tenantId") VALUES (${A.tenantId})`],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          await asApp(tx, A.tenantId);
          await fn(tx);
        })
      );
      expect(r.code, name).toBe("42501");
    }
  });

  // ── App: mensajes ───────────────────────────────────────────────────
  it("app: crea hilo y mensaje TENANT en SU consultorio y ve la respuesta de Plataforma; no ve los de otro ni los leads", async () => {
    const out = await inTx(db, async (tx) => {
      const thB = await thread(tx, B.tenantId);
      await message(tx, { threadId: thB, tenantId: B.tenantId, authorKind: "TENANT" });
      const l = await lead(tx);
      await message(tx, { threadId: l, tenantId: null, authorKind: "LEAD", authorUserId: null });
      const thA0 = await thread(tx, A.tenantId);
      await message(tx, { threadId: thA0, tenantId: A.tenantId, authorKind: "PLATFORM", authorUserId: "super" });
      await asApp(tx, A.tenantId);
      const th = await thread(tx, A.tenantId);
      await message(tx, { threadId: th, tenantId: A.tenantId, authorKind: "TENANT", authorUserId: A.userId });
      await tx.supportThreadRead.create({ data: { threadId: th, userId: A.userId, tenantId: A.tenantId } });
      const threads = await tx.supportThread.findMany({ select: { id: true }, orderBy: { id: "asc" } });
      const msgs = await tx.supportMessage.findMany({ select: { authorKind: true }, orderBy: { authorKind: "asc" } });
      const close = await tx.$executeRaw`UPDATE "SupportThread" SET status = 'CLOSED', "platformReadAt" = now()`;
      const delMsg = await tx.$executeRaw`DELETE FROM "SupportMessage"`;
      const reads = await count(tx, "SupportThreadRead");
      return { threads: threads.map((t) => t.id).sort(), expected: [thA0, th].sort(), msgs: msgs.map((m) => m.authorKind), close, delMsg, reads };
    });
    expect(out.threads).toEqual(out.expected);
    expect(out.msgs).toEqual(["TENANT", "PLATFORM"]);
    expect([out.close, out.delMsg, out.reads]).toEqual([0, 0, 1]);
  });

  it("app: no forja una respuesta de Plataforma ni escribe en otro consultorio (42501)", async () => {
    const cases: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "mensaje PLATFORM",
        async (tx) => {
          const th = await thread(tx, A.tenantId);
          await asApp(tx, A.tenantId);
          await message(tx, { threadId: th, tenantId: A.tenantId, authorKind: "PLATFORM" });
        },
      ],
      [
        "hilo en otro consultorio",
        async (tx) => {
          await asApp(tx, A.tenantId);
          await thread(tx, B.tenantId);
        },
      ],
      [
        "mensaje con tenantId de otro",
        async (tx) => {
          const th = await thread(tx, B.tenantId);
          await asApp(tx, A.tenantId);
          await message(tx, { threadId: th, tenantId: B.tenantId, authorKind: "TENANT" });
        },
      ],
      [
        "hilo LEAD",
        async (tx) => {
          await asApp(tx, A.tenantId);
          await lead(tx);
        },
      ],
      [
        "marca de leído en otro consultorio",
        async (tx) => {
          const th = await thread(tx, B.tenantId);
          await asApp(tx, A.tenantId);
          await tx.$executeRaw`INSERT INTO "SupportThreadRead" ("threadId", "userId", "tenantId") VALUES (${th}, ${A.userId}, ${B.tenantId})`;
        },
      ],
    ];
    for (const [name, fn] of cases) {
      const r = await sqlError(inTx(db, fn));
      expect(r.code, name).toBe("42501");
    }
  });

  it("app: los leads (tenantId NULL) son invisibles con cualquier GUC y sin GUC", async () => {
    for (const guc of [A.tenantId, null]) {
      const n = await inTx(db, async (tx) => {
        const l = await lead(tx);
        await message(tx, { threadId: l, tenantId: null, authorKind: "LEAD", authorUserId: null });
        await message(tx, { threadId: l, tenantId: null, authorKind: "PLATFORM", authorUserId: "super" });
        await asApp(tx, guc);
        return [await count(tx, "SupportThread"), await count(tx, "SupportMessage")];
      });
      expect(n, String(guc)).toEqual([0, 0]);
    }
  });

  // ── App: SERVICE_ONLY ───────────────────────────────────────────────
  it("app: 2FA, historial de precios y registro de seguridad invisibles e inescribibles", async () => {
    const seen = await inTx(db, async (tx) => {
      await challenge(tx, A.userId, "sess-1");
      await tx.$executeRaw`INSERT INTO "TwoFactorRecoveryCode" (id, "userId", "codeHash") VALUES (${`m8-rc-${uniqueSuffix()}`}, ${A.userId}, 'h')`;
      await securityEvent(tx, A.userId, A.tenantId);
      await priceChange(tx);
      await asApp(tx, A.tenantId);
      const n: Record<string, number> = {};
      for (const t of SERVICE_ONLY) n[t] = await count(tx, t);
      n.updChallenge = await tx.$executeRaw`UPDATE "TwoFactorChallenge" SET attempts = 0`;
      return n;
    });
    expect(seen).toEqual({
      SaasPlanPriceChange: 0,
      TwoFactorChallenge: 0,
      TwoFactorRecoveryCode: 0,
      UserSecurityEvent: 0,
      updChallenge: 0,
    });
    for (const [name, fn] of [
      ["TwoFactorChallenge", (tx: Prisma.TransactionClient) => challenge(tx, A.userId, "sess-app")],
      [
        "TwoFactorRecoveryCode",
        (tx: Prisma.TransactionClient) =>
          tx.$executeRaw`INSERT INTO "TwoFactorRecoveryCode" (id, "userId", "codeHash") VALUES (${`m8-rc-${uniqueSuffix()}`}, ${A.userId}, 'h')`,
      ],
      ["UserSecurityEvent", (tx: Prisma.TransactionClient) => securityEvent(tx, A.userId, A.tenantId)],
      ["SaasPlanPriceChange", (tx: Prisma.TransactionClient) => priceChange(tx)],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          await asApp(tx, A.tenantId);
          await fn(tx);
        })
      );
      expect(r.code, name).toBe("42501");
    }
  });

  // ── Triggers ────────────────────────────────────────────────────────
  it("UserSecurityEvent: UPDATE, DELETE y TRUNCATE rechazados también para el owner (P0001)", async () => {
    for (const [op, sql] of [
      ["UPDATE", `UPDATE "UserSecurityEvent" SET kind = 'otro' WHERE id = $1`],
      ["DELETE", `DELETE FROM "UserSecurityEvent" WHERE id = $1`],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          const id = await securityEvent(tx, A.userId, null);
          await tx.$executeRawUnsafe(sql, id);
        })
      );
      expect(r.code, op).toBe("P0001");
      expect(r.message).toMatch(new RegExp(`UserSecurityEvent es solo inserción: ${op} rechazado`));
    }
    const t = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "UserSecurityEvent"`)));
    expect(t.message).toMatch(/UserSecurityEvent es solo inserción: TRUNCATE rechazado/);
  });

  it("SaasPlanPriceChange: solo appliedAt NULL → valor; cualquier otra edición, re-aplicar o borrar → P0001", async () => {
    const applied = await inTx(db, async (tx) => {
      const id = await priceChange(tx);
      const n = await tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = now() WHERE id = ${id}`;
      const row = await tx.$queryRaw<{ applied: boolean }[]>`SELECT "appliedAt" IS NOT NULL AS applied FROM "SaasPlanPriceChange" WHERE id = ${id}`;
      return [n, row[0].applied];
    });
    expect(applied).toEqual([1, true]);

    const rejected: [string, (tx: Prisma.TransactionClient, id: string) => Promise<unknown>][] = [
      ["cambiar el precio", (tx, id) => tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "priceCents" = 1 WHERE id = ${id}`],
      [
        "appliedAt + otra columna",
        (tx, id) => tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = now(), note = 'otra' WHERE id = ${id}`,
      ],
      [
        "re-aplicar",
        async (tx, id) => {
          await tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = now() WHERE id = ${id}`;
          await tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = now() + interval '1 hour' WHERE id = ${id}`;
        },
      ],
      [
        "des-aplicar",
        async (tx, id) => {
          await tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = now() WHERE id = ${id}`;
          await tx.$executeRaw`UPDATE "SaasPlanPriceChange" SET "appliedAt" = NULL WHERE id = ${id}`;
        },
      ],
      ["borrar", (tx, id) => tx.$executeRaw`DELETE FROM "SaasPlanPriceChange" WHERE id = ${id}`],
    ];
    for (const [name, fn] of rejected) {
      const r = await sqlError(inTx(db, async (tx) => fn(tx, await priceChange(tx))));
      expect(r.code, name).toBe("P0001");
    }
    const t = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "SaasPlanPriceChange"`)));
    expect(t.code).toBe("P0001");
  });

  // ── Índice parcial ──────────────────────────────────────────────────
  it("TwoFactorChallenge: dos abiertos (usuario+propósito+sesión) → 23505; otra sesión u otro propósito entra; cerrado libera", async () => {
    const dup = await sqlError(
      inTx(db, async (tx) => {
        await challenge(tx, A.userId, "sess-1");
        await challenge(tx, A.userId, "sess-1");
      })
    );
    expect(dup.code).toBe("23505");
    const ok = await inTx(db, async (tx) => {
      const first = await challenge(tx, A.userId, "sess-1");
      await challenge(tx, A.userId, "sess-2");
      await tx.$executeRaw`
        INSERT INTO "TwoFactorChallenge" (id, "userId", purpose, "sessionId", "codeHash", "expiresAt")
        VALUES (${`m8-ch-${uniqueSuffix()}`}, ${A.userId}, 'LOGIN', 'sess-1', 'h', now() + interval '10 minutes')`;
      await tx.$executeRaw`UPDATE "TwoFactorChallenge" SET "closedAt" = now(), "closedReason" = 'REPLACED' WHERE id = ${first}`;
      await challenge(tx, A.userId, "sess-1");
      return count(tx, "TwoFactorChallenge");
    });
    expect(ok).toBeGreaterThanOrEqual(4);
    // Cerrado sin motivo / motivo desconocido → 23514.
    for (const reason of [null, "OTRO"]) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          const id = await challenge(tx, A.userId, "sess-9");
          await tx.$executeRaw`UPDATE "TwoFactorChallenge" SET "closedAt" = now(), "closedReason" = ${reason} WHERE id = ${id}`;
        })
      );
      expect(r.code, String(reason)).toBe("23514");
    }
  });
});

describe.skipIf(!RUN)("M8 pl_accounts_billing · deleteTenantDeep", () => {
  it("borra un consultorio con suscripción, cargo, pago, hilo, mensajes, marca de leído y registro de seguridad", async () => {
    const db = ownerClient();
    try {
      const C = await createEphemeralTenant(db);
      const s = uniqueSuffix();
      await db.saasSubscription.create({ data: { tenantId: C.tenantId } });
      const ch = await db.saasCharge.create({
        data: {
          tenantId: C.tenantId,
          plan: "INDIVIDUAL",
          periodStart: new Date("2026-10-01T00:00:00.000Z"),
          periodEnd: new Date("2026-11-01T00:00:00.000Z"),
          dueDate: new Date("2026-10-05T00:00:00.000Z"),
          amountCents: 100,
        },
      });
      await db.saasPayment.create({
        data: { tenantId: C.tenantId, chargeId: ch.id, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 100 },
      });
      const th = await db.supportThread.create({ data: { kind: "TENANT", tenantId: C.tenantId, subject: "Hola" } });
      await db.supportMessage.create({ data: { threadId: th.id, tenantId: C.tenantId, authorKind: "TENANT", authorUserId: C.userId, body: "Hola" } });
      await db.supportMessage.create({ data: { threadId: th.id, tenantId: C.tenantId, authorKind: "PLATFORM", authorUserId: "super", body: "Chau" } });
      await db.supportThreadRead.create({ data: { threadId: th.id, userId: C.userId, tenantId: C.tenantId } });
      await db.userSecurityEvent.create({ data: { id: `m8-se-${s}`, userId: C.userId, tenantId: C.tenantId, kind: "2fa.enabled" } });
      await db.twoFactorRecoveryCode.create({ data: { userId: C.userId, codeHash: `h-${s}` } });

      await C.cleanup();

      expect(await db.tenant.count({ where: { id: C.tenantId } })).toBe(0);
      expect(await db.supportThread.count({ where: { id: th.id } })).toBe(0);
      expect(await db.saasCharge.count({ where: { id: ch.id } })).toBe(0);
      expect(await db.userSecurityEvent.count({ where: { id: `m8-se-${s}` } })).toBe(0);
      expect(await db.twoFactorRecoveryCode.count({ where: { userId: C.userId } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
