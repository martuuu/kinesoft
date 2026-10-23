/**
 * M16 `20261025120000_saas_mp_subscriptions` · bloque MPS (T6), ola X0, sesión MIG (brief T6+T7 §26.6 y Anexo C).
 *
 * Qué se prueba (molde tpm-m18.test.ts; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   1. Objetos (catálogo, por el owner): 2 enums, columnas nuevas de SaasSubscription/SaasCharge/SaasPayment con sus
 *      defaults (anchorDay 4 y autoDebitAllowed true: los 2 SET DEFAULT), la tabla SaasAdjustment, los 3 PARCIALES con
 *      su predicado, las FKs compuestas por tenant, los CHECKs por nombre, el CHECK relajado de SaasPayment, el guard
 *      `saas_adjustment_guard()` (2 triggers, sin SECURITY DEFINER) y RLS TENANT_READONLY en SaasAdjustment.
 *   2. CHECKs con su SQLSTATE: ajuste CREDIT positivo / DEBIT negativo → 23514; proporcional con días coherentes;
 *      desglose del cargo (amount = base + ajustes); checkout todo o nada; baja y bajada programadas coherentes.
 *   3. `saas_adjustment_guard()`: solo inserción salvo la imputación (appliedChargeId NULL → valor, nada más cambia),
 *      TAMBIÉN para el owner (BYPASSRLS no saltea triggers): UPDATE, DELETE y TRUNCATE → P0001.
 *   4. FKs compuestas cross-tenant → 23503 (imputar a un cargo ajeno, partir de un ajuste/pago ajeno).
 *   5. El CHECK relajado de SaasPayment acepta el HERMANO PARTIDO de un pago de MP (sin id de MP, con splitFromId) y
 *      sigue rechazando un pago de MP sin nada que lo ate a MP.
 *   6. RLS con `kinesoft_app`: SaasAdjustment se lee por tenant y no se escribe (ni la imputación).
 *   7. `deleteTenantDeep` con ajustes imputados y pagos partidos (el guard rechaza DELETE: modo réplica).
 */
import { randomUUID } from "node:crypto";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asApp,
  attempt,
  columns,
  constraintDefs,
  enumLabels,
  inTx,
  partialIndexes,
  rlsState,
  TENANT_QUAL,
} from "@/tests/helpers/migration-sql";
import {
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
type Db = Prisma.TransactionClient | PrismaClient;

let monthSeq = 0;
/** Cargo OPEN de un período mensual distinto en cada llamada (UNIQUE tenant + periodStart). */
async function charge(
  db: Db,
  tenantId: string,
  o: { amountCents?: number; base?: number | null; adjustments?: number } = {}
): Promise<string> {
  const id = `mpsm-ch-${uniqueSuffix()}`;
  const m = ++monthSeq;
  await db.$executeRaw`
    INSERT INTO "SaasCharge" (id, "tenantId", plan, "periodStart", "periodEnd", "dueDate", "amountCents",
      "baseAmountCents", "adjustmentsCents", "updatedAt")
    VALUES (${id}, ${tenantId}, 'INDIVIDUAL', make_date(2030, 1, 4) + make_interval(months => ${m}::int),
      make_date(2030, 2, 4) + make_interval(months => ${m}::int), make_date(2030, 1, 9) + make_interval(months => ${m}::int),
      ${o.amountCents ?? 1000}::int, ${o.base === undefined ? null : o.base}::int, ${o.adjustments ?? 0}::int, now())`;
  return id;
}

type PaymentOpts = {
  chargeId?: string | null;
  source?: "MP_AUTO" | "MP_CHECKOUT" | "MANUAL";
  mpPaymentId?: string | null;
  mpAuthorizedPaymentId?: string | null;
  mpPreapprovalId?: string | null;
  splitFromId?: string | null;
  mpPayload?: string | null;
  amountCents?: number;
};
async function payment(db: Db, tenantId: string, o: PaymentOpts = {}): Promise<string> {
  const id = `mpsm-pay-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "SaasPayment" (id, "tenantId", "chargeId", source, status, "amountCents", "paidAt", "mpPaymentId",
      "mpAuthorizedPaymentId", "mpPreapprovalId", "splitFromId", "mpPayload", "updatedAt")
    VALUES (${id}, ${tenantId}, ${o.chargeId ?? null}, ${o.source ?? "MP_CHECKOUT"}::"SaasPaymentSource", 'APPROVED',
      ${o.amountCents ?? 1000}::int, now(), ${o.mpPaymentId !== undefined ? o.mpPaymentId : null},
      ${o.mpAuthorizedPaymentId ?? null}, ${o.mpPreapprovalId ?? null}, ${o.splitFromId ?? null},
      ${o.mpPayload ?? null}::jsonb, now())`;
  return id;
}

type AdjustmentOpts = {
  kind?: "PRORATION" | "CREDIT" | "DEBIT" | "CARRYOVER";
  amountCents?: number;
  description?: string;
  days?: number | null;
  periodDays?: number | null;
  idempotencyKey?: string;
  splitFromId?: string | null;
  appliedChargeId?: string | null;
  appliedAt?: boolean;
};
async function adjustment(db: Db, tenantId: string, o: AdjustmentOpts = {}): Promise<string> {
  const id = `mpsm-adj-${uniqueSuffix()}`;
  const kind = o.kind ?? "DEBIT";
  await db.$executeRaw`
    INSERT INTO "SaasAdjustment" (id, "tenantId", kind, "amountCents", "effectiveOn", description, "planFrom", "planTo",
      days, "periodDays", "idempotencyKey", "splitFromId", "appliedChargeId", "appliedAt")
    VALUES (${id}, ${tenantId}, ${kind}::"SaasAdjustmentKind", ${o.amountCents ?? (kind === "CREDIT" ? -500 : 500)}::int,
      DATE '2030-01-04', ${o.description ?? "Ajuste de prueba"},
      ${kind === "PRORATION" ? "INDIVIDUAL" : null}::"SaasPlan", ${kind === "PRORATION" ? "CONSULTORIO" : null}::"SaasPlan",
      ${o.days !== undefined ? o.days : kind === "PRORATION" ? 10 : null}::int,
      ${o.periodDays !== undefined ? o.periodDays : kind === "PRORATION" ? 30 : null}::int,
      ${o.idempotencyKey ?? `test:${randomUUID()}`}, ${o.splitFromId ?? null}, ${o.appliedChargeId ?? null},
      CASE WHEN ${o.appliedAt ?? false} THEN now() END)`;
  return id;
}

async function subscription(db: Db, tenantId: string) {
  await db.$executeRaw`INSERT INTO "SaasSubscription" ("tenantId") VALUES (${tenantId})`;
}

// ═════════════════════════════════════════════════════════════════════
// 1. Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M16 saas_mp_subscriptions · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[MPS-M] enums y columnas nuevas (SET DEFAULT anchorDay 4 y autoDebitAllowed true); SaasAdjustment completa", async () => {
    expect(await enumLabels(db, ["SaasCollectionMethod", "SaasAdjustmentKind"])).toEqual({
      SaasCollectionMethod: ["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"],
      SaasAdjustmentKind: ["PRORATION", "CREDIT", "DEBIT", "CARRYOVER"],
    });
    expect(
      await columns(db, "SaasSubscription", [
        "anchorDay",
        "autoDebitAllowed",
        "collectionMethod",
        "billableFrom",
        "cancelAtPeriodEnd",
        "cancelEffectiveOn",
        "cancelRequestedAt",
        "cancelRequestedById",
        "pendingPlan",
        "pendingPlanEffectiveOn",
        "pendingPlanDisableIds",
        "pendingPlanRequestedById",
        "pendingPlanRequestedAt",
        "customPricePlan",
        "mpPendingPreapprovalId",
        "mpPendingInitPoint",
        "mpPendingPayerEmail",
        "mpPendingCreatedAt",
        "mpRetiredPreapprovalId",
        "mpPreapprovalNextAt",
        "mpPreapprovalSyncedAt",
      ])
    ).toEqual({
      anchorDay: "int4 NO 4",
      autoDebitAllowed: "bool NO true",
      collectionMethod: "SaasCollectionMethod YES",
      billableFrom: "date YES",
      cancelAtPeriodEnd: "bool NO false",
      cancelEffectiveOn: "date YES",
      cancelRequestedAt: "timestamp YES",
      cancelRequestedById: "text YES",
      pendingPlan: "SaasPlan YES",
      pendingPlanEffectiveOn: "date YES",
      pendingPlanDisableIds: "_text NO ARRAY[]::text[]",
      pendingPlanRequestedById: "text YES",
      pendingPlanRequestedAt: "timestamp YES",
      customPricePlan: "SaasPlan YES",
      mpPendingPreapprovalId: "text YES",
      mpPendingInitPoint: "text YES",
      mpPendingPayerEmail: "text YES",
      mpPendingCreatedAt: "timestamp YES",
      mpRetiredPreapprovalId: "text YES",
      mpPreapprovalNextAt: "timestamp YES",
      mpPreapprovalSyncedAt: "timestamp YES",
    });
    expect(
      await columns(db, "SaasCharge", ["baseAmountCents", "adjustmentsCents", "mpCheckoutExpectedCents", "mpCheckoutCreatedAt"])
    ).toEqual({
      baseAmountCents: "int4 YES",
      adjustmentsCents: "int4 NO 0",
      mpCheckoutExpectedCents: "int4 YES",
      mpCheckoutCreatedAt: "timestamp YES",
    });
    expect(await columns(db, "SaasPayment", ["mpPreapprovalId", "splitFromId", "mpPayload"])).toEqual({
      mpPreapprovalId: "text YES",
      splitFromId: "text YES",
      mpPayload: "jsonb YES",
    });
    expect(await columns(db, "SaasAdjustment")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      kind: "SaasAdjustmentKind NO",
      amountCents: "int4 NO",
      effectiveOn: "date NO",
      description: "text NO",
      planFrom: "SaasPlan YES",
      planTo: "SaasPlan YES",
      days: "int4 YES",
      periodDays: "int4 YES",
      idempotencyKey: "text NO",
      splitFromId: "text YES",
      appliedChargeId: "text YES",
      appliedAt: "timestamp YES",
      createdById: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
  });

  it("[MPS-M] parciales con su predicado, únicos, FKs compuestas y CHECKs por nombre (catálogo)", async () => {
    const tables = ["SaasSubscription", "SaasCharge", "SaasPayment", "SaasAdjustment"];
    expect(await partialIndexes(db, tables)).toEqual({
      SaasAdjustment_pending_idx: `("tenantId", "effectiveOn") WHERE ("appliedChargeId" IS NULL)`,
      SaasSubscription_cancel_idx: `("cancelEffectiveOn") WHERE "cancelAtPeriodEnd"`,
      SaasSubscription_pendingPlan_idx: `("pendingPlanEffectiveOn") WHERE ("pendingPlan" IS NOT NULL)`,
    });
    const idx = await db.$queryRaw<{ indexname: string; u: boolean }[]>`
      SELECT indexname, indexdef LIKE 'CREATE UNIQUE%' AS u FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${[
        "SaasSubscription_mpPendingPreapprovalId_key",
        "SaasPayment_id_tenantId_key",
        "SaasPayment_mpPreapprovalId_idx",
        "SaasPayment_splitFromId_idx",
        "SaasAdjustment_pkey",
        "SaasAdjustment_tenantId_idempotencyKey_key",
        "SaasAdjustment_id_tenantId_key",
        "SaasAdjustment_appliedChargeId_idx",
        "SaasCharge_id_tenantId_key",
      ]}) ORDER BY indexname`;
    expect(idx.map((i) => `${i.u ? "U" : "-"} ${i.indexname}`)).toEqual([
      "- SaasAdjustment_appliedChargeId_idx",
      "U SaasAdjustment_id_tenantId_key",
      "U SaasAdjustment_pkey",
      "U SaasAdjustment_tenantId_idempotencyKey_key",
      "U SaasCharge_id_tenantId_key", // de M8: destino de la FK compuesta de la imputación
      "U SaasPayment_id_tenantId_key",
      "- SaasPayment_mpPreapprovalId_idx",
      "- SaasPayment_splitFromId_idx",
      "U SaasSubscription_mpPendingPreapprovalId_key",
    ]);
    const fks = await constraintDefs(db, ["SaasAdjustment", "SaasPayment"], "f");
    expect(fks).toEqual({
      SaasAdjustment_charge_tenant_fkey: `FOREIGN KEY ("appliedChargeId", "tenantId") REFERENCES "SaasCharge"(id, "tenantId") ON UPDATE CASCADE ON DELETE RESTRICT`,
      SaasAdjustment_splitFrom_tenant_fkey: `FOREIGN KEY ("splitFromId", "tenantId") REFERENCES "SaasAdjustment"(id, "tenantId") ON UPDATE CASCADE`,
      SaasAdjustment_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT`,
      SaasPayment_chargeId_tenantId_fkey: `FOREIGN KEY ("chargeId", "tenantId") REFERENCES "SaasCharge"(id, "tenantId") ON UPDATE CASCADE ON DELETE RESTRICT`,
      SaasPayment_splitFrom_tenant_fkey: `FOREIGN KEY ("splitFromId", "tenantId") REFERENCES "SaasPayment"(id, "tenantId") ON UPDATE CASCADE`,
      SaasPayment_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT`,
    });
    const checks = await constraintDefs(db, tables, "c");
    expect(Object.keys(checks).filter((c) => !/_(anchorDay|amounts|amountCents|period|paid|note|notes|receipt)_check$/.test(c))).toEqual([
      "SaasAdjustment_applied_check",
      "SaasAdjustment_proration_check",
      "SaasAdjustment_sign_check",
      "SaasAdjustment_text_check",
      "SaasCharge_breakdown_check",
      "SaasCharge_checkout_check",
      "SaasPayment_mpPayload_check",
      "SaasPayment_source_mp_check",
      "SaasSubscription_cancel_check",
      "SaasSubscription_mpPending_check",
      "SaasSubscription_pendingPlan_check",
    ]);
    // El reemplazo ESTRICTAMENTE más laxo: el hermano partido (splitFromId) cuenta como «atado a MP».
    expect(checks.SaasPayment_source_mp_check).toContain(`"splitFromId" IS NOT NULL`);
    expect(checks.SaasPayment_source_mp_check).toContain(`"mpPreapprovalId" IS NULL`);
  });

  it("[MPS-M] saas_adjustment_guard: 2 triggers (fila UPDATE/DELETE y TRUNCATE), sin SECURITY DEFINER", async () => {
    const trg = await db.$queryRaw<{ tgname: string; enabled: string; def: string }[]>`
      SELECT tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = '"SaasAdjustment"'::regclass ORDER BY tgname`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([
      ["SaasAdjustment_guard", "O"],
      ["SaasAdjustment_no_truncate", "O"],
    ]);
    expect(trg[0].def).toMatch(
      /BEFORE DELETE OR UPDATE ON public\."SaasAdjustment" FOR EACH ROW EXECUTE FUNCTION saas_adjustment_guard\(\)/
    );
    expect(trg[1].def).toMatch(
      /BEFORE TRUNCATE ON public\."SaasAdjustment" FOR EACH STATEMENT EXECUTE FUNCTION saas_adjustment_guard\(\)/
    );
    const [fn] = await db.$queryRaw<{ secdef: boolean; src: string }[]>`
      SELECT prosecdef AS secdef, prosrc AS src FROM pg_proc WHERE proname = 'saas_adjustment_guard'`;
    expect(fn.secdef).toBe(false);
    expect(fn.src).toMatch(/to_jsonb\(NEW\) - 'appliedChargeId' - 'appliedAt'/);
  });

  it("[MPS-M] RLS: SaasAdjustment TENANT_READONLY (ENABLE + FORCE, una policy SELECT por tenant)", async () => {
    const { rel, pol, grants } = await rlsState(db, ["SaasAdjustment"]);
    expect(rel).toEqual([{ relname: "SaasAdjustment", rls: true, force: true }]);
    expect(pol).toEqual([
      { tablename: "SaasAdjustment", policyname: "SaasAdjustment_tenant_read", cmd: "SELECT", qual: TENANT_QUAL, with_check: null },
    ]);
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2-6. Comportamiento (todo en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M16 saas_mp_subscriptions · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

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

  it("[MPS-M] SaasSubscription: nace con anclaje 4 y débito permitido; baja, bajada y preapproval pendiente coherentes", async () => {
    await inTx(db, async (tx) => {
      await subscription(tx, A.tenantId);
      expect(
        await tx.$queryRaw`SELECT "anchorDay", "autoDebitAllowed", "cancelAtPeriodEnd", "pendingPlanDisableIds" FROM "SaasSubscription" WHERE "tenantId" = ${A.tenantId}`
      ).toEqual([{ anchorDay: 4, autoDebitAllowed: true, cancelAtPeriodEnd: false, pendingPlanDisableIds: [] }]);
      const up = (set: string) =>
        attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "SaasSubscription" SET ${set} WHERE "tenantId" = $1`, A.tenantId));
      expect((await up(`"cancelAtPeriodEnd" = true`)).code).toBe("23514");
      expect((await up(`"cancelAtPeriodEnd" = true, "cancelEffectiveOn" = DATE '2030-02-04'`)).code).toBe("OK");
      expect((await up(`"pendingPlan" = 'INDIVIDUAL'`)).code).toBe("23514");
      expect((await up(`"pendingPlanEffectiveOn" = DATE '2030-02-04'`)).code).toBe("23514");
      expect((await up(`"pendingPlanDisableIds" = ARRAY['m1']`)).code).toBe("23514"); // selección sin bajada
      expect((await up(`"pendingPlan" = 'INDIVIDUAL', "pendingPlanEffectiveOn" = DATE '2030-02-04', "pendingPlanDisableIds" = (SELECT array_agg('m' || g) FROM generate_series(1, 201) g)`)).code).toBe("23514");
      expect((await up(`"pendingPlan" = 'INDIVIDUAL', "pendingPlanEffectiveOn" = DATE '2030-02-04', "pendingPlanDisableIds" = ARRAY['m1', 'm2']`)).code).toBe("OK");
      expect((await up(`"mpPendingPreapprovalId" = 'pre-1'`)).code).toBe("23514"); // sin mpPendingCreatedAt
      expect((await up(`"mpPendingPreapprovalId" = 'pre-1', "mpPendingCreatedAt" = now(), "mpPendingInitPoint" = repeat('x', 1001)`)).code).toBe("23514");
      expect((await up(`"mpPendingPreapprovalId" = 'pre-1', "mpPendingCreatedAt" = now(), "mpPendingPayerEmail" = repeat('x', 255)`)).code).toBe("23514");
      expect((await up(`"mpPendingPreapprovalId" = 'pre-1', "mpPendingCreatedAt" = now(), "mpPendingInitPoint" = 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=pre-1', "collectionMethod" = 'AUTO_DEBIT'`)).code).toBe("OK");
      // El pendiente es único entre consultorios (el webhook lo busca sin tenant).
      await subscription(tx, B.tenantId);
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "SaasSubscription" SET "mpPendingPreapprovalId" = 'pre-1', "mpPendingCreatedAt" = now() WHERE "tenantId" = ${B.tenantId}`)).code).toBe("23505");
    });
  });

  it("[MPS-M] SaasCharge: desglose amount = base + ajustes (o legado sin desglose) y checkout todo o nada", async () => {
    await inTx(db, async (tx) => {
      const c = (o: Parameters<typeof charge>[2]) => attempt(tx, () => charge(tx, A.tenantId, o));
      expect((await c({})).code).toBe("OK"); // legado: base NULL y ajustes 0
      // Hallazgo MIG: con base NULL, `NULL >= 0 AND …` es NULL y un CHECK NULL PASA; el SQL exige la base explícita.
      expect((await c({ base: null, adjustments: 200 })).code).toBe("23514");
      expect((await c({ amountCents: 1400, base: 1000, adjustments: 500 })).code).toBe("23514");
      expect((await c({ amountCents: 1500, base: -1, adjustments: 1501 })).code).toBe("23514");
      expect((await c({ amountCents: 1500, base: 1000, adjustments: 500 })).code).toBe("OK");
      expect((await c({ amountCents: 0, base: 1000, adjustments: -1000 })).code).toBe("OK"); // crédito que cubre todo
      const id = await charge(tx, A.tenantId);
      const up = (set: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "SaasCharge" SET ${set} WHERE id = $1`, id));
      expect((await up(`"mpCheckoutPreferenceId" = 'pref-1'`)).code).toBe("23514");
      expect((await up(`"mpCheckoutPreferenceId" = 'pref-1', "mpCheckoutExpectedCents" = 1000`)).code).toBe("23514"); // sin fecha
      expect((await up(`"mpCheckoutPreferenceId" = 'pref-1', "mpCheckoutExpectedCents" = 0, "mpCheckoutCreatedAt" = now()`)).code).toBe("23514");
      expect((await up(`"mpCheckoutExpectedCents" = 1000, "mpCheckoutCreatedAt" = now()`)).code).toBe("23514"); // sin preferencia
      expect((await up(`"mpCheckoutPreferenceId" = 'pref-1', "mpCheckoutExpectedCents" = 1000, "mpCheckoutCreatedAt" = now()`)).code).toBe("OK");
    });
  });

  it("[MPS-M] SaasPayment: el CHECK relajado acepta el hermano partido (sin id de MP, con splitFromId) y nada más", async () => {
    await inTx(db, async (tx) => {
      const c1 = await charge(tx, A.tenantId);
      const c2 = await charge(tx, A.tenantId);
      const p = (o: PaymentOpts) => attempt(tx, () => payment(tx, A.tenantId, o));
      // Pago de MP sin nada que lo ate a MP: sigue rechazado (también si solo trae el preapproval).
      expect((await p({ source: "MP_CHECKOUT" })).code).toBe("23514");
      expect((await p({ source: "MP_AUTO", mpPreapprovalId: "pre-9" })).code).toBe("23514");
      // MANUAL nunca con ids de MP, tampoco el preapproval nuevo.
      expect((await p({ source: "MANUAL", mpPreapprovalId: "pre-9" })).code).toBe("23514");
      expect((await p({ source: "MANUAL", mpPaymentId: "123" })).code).toBe("23514");
      // Raíz con id de MP imputada a c1 y su hermano partido a c2 (sobrepago): el hermano NO puede repetir el id UNIQUE.
      const mpId = `${Date.now()}`;
      const root = await payment(tx, A.tenantId, { chargeId: c1, mpPaymentId: mpId });
      expect((await p({ chargeId: c2, mpPaymentId: mpId })).code).toBe("23505");
      expect((await p({ chargeId: c2, splitFromId: root })).code).toBe("OK");
      expect((await p({ source: "MP_AUTO", chargeId: null, splitFromId: root, mpPreapprovalId: "pre-9" })).code).toBe("OK"); // saldo a favor
      expect((await p({ source: "MANUAL", splitFromId: (await payment(tx, A.tenantId, { source: "MANUAL", mpPaymentId: null })) })).code).toBe("OK");
      expect((await p({ source: "MP_AUTO", mpAuthorizedPaymentId: `${Date.now()}9`, mpPreapprovalId: "pre-9" })).code).toBe("OK");
      // mpPayload: objeto ≤ 16 KiB.
      expect((await p({ mpPaymentId: `${Date.now()}1`, mpPayload: `[1, 2]` })).code).toBe("23514");
      expect((await p({ mpPaymentId: `${Date.now()}2`, mpPayload: `"texto"` })).code).toBe("23514");
      expect((await attempt(tx, () => tx.$executeRaw`
        UPDATE "SaasPayment" SET "mpPayload" = jsonb_build_object('x', (SELECT string_agg(md5(g::text), '') FROM generate_series(1, 1200) g))
        WHERE id = ${root}`)).code).toBe("23514");
      expect((await p({ mpPaymentId: `${Date.now()}3`, mpPayload: `{"status": "approved", "id": 1}` })).code).toBe("OK");
      // Auto-referencia NO ACTION: la raíz no se borra sola, con sus hermanos en la misma sentencia sí.
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "SaasPayment" WHERE id = ${root}`)).code).toBe("23503");
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "SaasPayment" WHERE id = ${root} OR "splitFromId" = ${root}`)).code).toBe("OK");
    });
  });

  it("[MPS-M] SaasAdjustment CHECKs: CREDIT positivo / DEBIT negativo → 23514; proporcional con días; imputación todo o nada", async () => {
    await inTx(db, async (tx) => {
      const a = (o: AdjustmentOpts) => attempt(tx, () => adjustment(tx, A.tenantId, o));
      expect((await a({ kind: "CREDIT", amountCents: 500 })).code).toBe("23514"); // ajuste CREDIT positivo
      expect((await a({ kind: "CREDIT", amountCents: 0 })).code).toBe("23514");
      expect((await a({ kind: "DEBIT", amountCents: -500 })).code).toBe("23514");
      expect((await a({ kind: "CARRYOVER", amountCents: -1 })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", amountCents: -1 })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", days: null })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", periodDays: 27 })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", periodDays: 32 })).code).toBe("23514");
      // Hallazgo MIG: `"days" BETWEEN 1 AND NULL` es NULL y un CHECK NULL PASA; el SQL exige periodDays explícito.
      expect((await a({ kind: "PRORATION", periodDays: null })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", days: 0 })).code).toBe("23514");
      expect((await a({ kind: "PRORATION", days: 31, periodDays: 30 })).code).toBe("23514");
      expect((await a({ description: "   " })).code).toBe("23514");
      expect((await a({ description: "x".repeat(301) })).code).toBe("23514");
      expect((await a({ idempotencyKey: "" })).code).toBe("23514");
      expect((await a({ idempotencyKey: "x".repeat(201) })).code).toBe("23514");
      const ch = await charge(tx, A.tenantId);
      expect((await a({ appliedChargeId: ch })).code).toBe("23514"); // sin appliedAt
      expect((await a({ appliedAt: true })).code).toBe("23514"); // sin cargo
      // Válidos.
      expect((await a({ kind: "CREDIT", amountCents: -500 })).code).toBe("OK");
      expect((await a({ kind: "PRORATION", days: 28, periodDays: 28 })).code).toBe("OK");
      expect((await a({ kind: "CARRYOVER" })).code).toBe("OK");
      expect((await a({ appliedChargeId: ch, appliedAt: true })).code).toBe("OK");
      expect((await a({ idempotencyKey: "stub:2030-01-04" })).code).toBe("OK");
      expect((await a({ idempotencyKey: "stub:2030-01-04" })).code).toBe("23505");
      // Otro consultorio puede repetir la clave.
      expect((await attempt(tx, () => adjustment(tx, B.tenantId, { idempotencyKey: "stub:2030-01-04" }))).code).toBe("OK");
    });
  });

  it("[MPS-M] saas_adjustment_guard (como el owner, BYPASSRLS): solo la imputación NULL → valor pasa", async () => {
    await inTx(db, async (tx) => {
      const [{ bypass }] = await tx.$queryRaw<{ bypass: boolean }[]>`
        SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
      expect(bypass).toBe(true); // el guard frena aun al owner
      const ch = await charge(tx, A.tenantId);
      const ch2 = await charge(tx, A.tenantId);
      const id = await adjustment(tx, A.tenantId);
      const up = (set: string) =>
        attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "SaasAdjustment" SET ${set} WHERE id = $1`, id));
      expect((await up(`description = 'otra'`)).code).toBe("P0001");
      expect((await up(`"amountCents" = 900`)).code).toBe("P0001");
      expect((await up(`"appliedAt" = now()`)).code).toBe("P0001"); // fecha sin cargo
      expect((await up(`"appliedChargeId" = '${ch}', "appliedAt" = now(), "amountCents" = 900`)).code).toBe("P0001"); // imputar + cambiar monto
      expect((await up(`"appliedChargeId" = '${ch}', "appliedAt" = now(), "effectiveOn" = DATE '2030-03-04'`)).code).toBe("P0001");
      const del = await attempt(tx, () => tx.$executeRaw`DELETE FROM "SaasAdjustment" WHERE id = ${id}`);
      expect(del.code).toBe("P0001");
      expect(del.message).toMatch(/SaasAdjustment es solo inserción/);
      expect((await attempt(tx, () => tx.$executeRawUnsafe(`TRUNCATE "SaasAdjustment"`))).code).toBe("P0001");
      // La imputación: NULL → cargo, con su fecha, y NADA más.
      expect((await up(`"appliedChargeId" = '${ch}', "appliedAt" = now()`)).code).toBe("OK");
      // Ya imputado: ni re-imputar a otro cargo, ni des-imputar (VOID re-pende con un ajuste NUEVO, no editando).
      expect((await up(`"appliedChargeId" = '${ch2}'`)).code).toBe("P0001");
      expect((await up(`"appliedChargeId" = NULL, "appliedAt" = NULL`)).code).toBe("P0001");
      expect((await up(`"appliedAt" = now() + interval '1 day'`)).code).toBe("P0001");
      expect(await tx.$queryRaw`SELECT "appliedChargeId" FROM "SaasAdjustment" WHERE id = ${id}`).toEqual([{ appliedChargeId: ch }]);
      // El cargo con ajustes imputados no se borra (RESTRICT).
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "SaasCharge" WHERE id = ${ch}`)).code).toBe("23503");
    });
  });

  it("[MPS-M] FKs compuestas cross-tenant → 23503: imputar a un cargo ajeno, partir de un ajuste o de un pago ajeno", async () => {
    await inTx(db, async (tx) => {
      const chB = await charge(tx, B.tenantId);
      const adjB = await adjustment(tx, B.tenantId);
      const payB = await payment(tx, B.tenantId, { mpPaymentId: `${Date.now()}7` });
      expect((await attempt(tx, () => adjustment(tx, A.tenantId, { appliedChargeId: chB, appliedAt: true }))).code).toBe("23503");
      expect((await attempt(tx, () => adjustment(tx, A.tenantId, { kind: "CREDIT", splitFromId: adjB }))).code).toBe("23503");
      expect((await attempt(tx, () => payment(tx, A.tenantId, { splitFromId: payB }))).code).toBe("23503");
      // La imputación (lo único que el guard deja) tampoco puede apuntar a un cargo ajeno.
      const adjA = await adjustment(tx, A.tenantId);
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "SaasAdjustment" SET "appliedChargeId" = ${chB}, "appliedAt" = now() WHERE id = ${adjA}`)).code).toBe("23503");
      // Con el propio, sí.
      const chA = await charge(tx, A.tenantId);
      expect((await attempt(tx, () => adjustment(tx, A.tenantId, { kind: "CREDIT", splitFromId: adjA, appliedChargeId: chA, appliedAt: true }))).code).toBe("OK");
    });
  });

  it("[MPS-M] RLS con kinesoft_app: SaasAdjustment se lee por tenant; ni INSERT, ni la imputación, ni DELETE", async () => {
    await inTx(db, async (tx) => {
      const adjA = await adjustment(tx, A.tenantId);
      const adjB = await adjustment(tx, B.tenantId);
      const chA = await charge(tx, A.tenantId);
      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      expect(await tx.$queryRaw`SELECT id FROM "SaasAdjustment" WHERE id IN (${adjA}, ${adjB})`).toEqual([{ id: adjA }]);
      expect((await attempt(tx, () => adjustment(tx, A.tenantId))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "SaasAdjustment" SET "appliedChargeId" = ${chA}, "appliedAt" = now() WHERE id = ${adjA}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "SaasAdjustment" WHERE id = ${adjA}`).toBe(0);
      // Tampoco escribe pagos partidos (SaasPayment sigue TENANT_READONLY).
      expect((await attempt(tx, () => payment(tx, A.tenantId, { mpPaymentId: `${Date.now()}8` }))).code).toBe("42501");
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SaasAdjustment" WHERE id IN (${adjA}, ${adjB})`).toEqual([{ n: 0 }]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 7. deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M16 saas_mp_subscriptions · deleteTenantDeep", () => {
  it("[MPS-M] tenant-factory limpia un consultorio con ajustes imputados/partidos y pagos partidos", async () => {
    const db = ownerClient();
    try {
      const D = await createEphemeralTenant(db);
      await subscription(db, D.tenantId);
      const ch = await charge(db, D.tenantId, { amountCents: 1500, base: 1000, adjustments: 500 });
      const root = await adjustment(db, D.tenantId, { kind: "CREDIT", amountCents: -3000 });
      await adjustment(db, D.tenantId, { kind: "CREDIT", amountCents: -1000, splitFromId: root });
      await adjustment(db, D.tenantId, { appliedChargeId: ch, appliedAt: true });
      const pay = await payment(db, D.tenantId, { chargeId: ch, mpPaymentId: `${Date.now()}5` });
      await payment(db, D.tenantId, { chargeId: null, splitFromId: pay });
      await D.cleanup();
      const left = await db.$queryRaw<{ t: string; n: number }[]>`
        SELECT 'adj' AS t, count(*)::int AS n FROM "SaasAdjustment" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'pay', count(*)::int FROM "SaasPayment" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'charge', count(*)::int FROM "SaasCharge" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'sub', count(*)::int FROM "SaasSubscription" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'tenant', count(*)::int FROM "Tenant" WHERE id = ${D.tenantId}`;
      expect(Object.fromEntries(left.map((r) => [r.t, r.n]))).toEqual({ adj: 0, pay: 0, charge: 0, sub: 0, tenant: 0 });
    } finally {
      await db.$disconnect();
    }
  });
});
