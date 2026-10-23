-- M16 · saas_mp_subscriptions (MPS-M, sola). Plan §20.5.6, §20.19, §21.7, §21.11 MPS-D4, §22.6 MPS-D7, §26.6; ADR-027.
-- Por qué: cobro el 4 por débito (preapproval), «Pagar con Mercado Pago» por cargo o transferencia; subida con
--   proporcional al próximo cargo; bajada programada; baja al fin del período. Ajustes en tabla propia solo-inserción.
-- ADITIVA: 2 enums, 1 tabla, columnas NULL/DEFAULT constante (PG≥11 solo metadatos), 2 SET DEFAULT, CHECKs que pasan
--   sobre filas existentes. ÚNICA excepción: SaasPayment_source_mp_check se reemplaza por uno ESTRICTAMENTE más laxo (el
--   hermano partido de un pago de MP no puede repetir el id UNIQUE de MP); el código anterior no escribe nada que el
--   nuevo rechace. Sin backfill (scripts/saas-reanchor.ts, después del deploy). → ANTES del deploy.
-- DRIFT ACEPTADO (no borrar si migrate diff lo propone): parciales SaasSubscription_pendingPlan_idx,
--   SaasSubscription_cancel_idx, SaasAdjustment_pending_idx; FKs compuestas *_tenant_fkey; CHECKs; saas_adjustment_guard().
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TYPE "SaasCollectionMethod" AS ENUM ('AUTO_DEBIT', 'MP_CHECKOUT', 'TRANSFER');
CREATE TYPE "SaasAdjustmentKind"   AS ENUM ('PRORATION', 'CREDIT', 'DEBIT', 'CARRYOVER');

ALTER TABLE "SaasSubscription"
  ALTER COLUMN "anchorDay" SET DEFAULT 4,
  ALTER COLUMN "autoDebitAllowed" SET DEFAULT true,
  ADD COLUMN "collectionMethod" "SaasCollectionMethod",
  ADD COLUMN "billableFrom" DATE,
  ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancelEffectiveOn" DATE,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedById" TEXT,
  ADD COLUMN "pendingPlan" "SaasPlan",
  ADD COLUMN "pendingPlanEffectiveOn" DATE,
  ADD COLUMN "pendingPlanDisableIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "pendingPlanRequestedById" TEXT,
  ADD COLUMN "pendingPlanRequestedAt" TIMESTAMP(3),
  ADD COLUMN "customPricePlan" "SaasPlan",
  ADD COLUMN "mpPendingPreapprovalId" TEXT,
  ADD COLUMN "mpPendingInitPoint" TEXT,
  ADD COLUMN "mpPendingPayerEmail" TEXT,
  ADD COLUMN "mpPendingCreatedAt" TIMESTAMP(3),
  ADD COLUMN "mpRetiredPreapprovalId" TEXT,
  ADD COLUMN "mpPreapprovalNextAt" TIMESTAMP(3),
  ADD COLUMN "mpPreapprovalSyncedAt" TIMESTAMP(3),
  ADD CONSTRAINT "SaasSubscription_cancel_check" CHECK (NOT "cancelAtPeriodEnd" OR "cancelEffectiveOn" IS NOT NULL),
  ADD CONSTRAINT "SaasSubscription_pendingPlan_check" CHECK (
    ("pendingPlan" IS NULL) = ("pendingPlanEffectiveOn" IS NULL)
    AND ("pendingPlan" IS NOT NULL OR cardinality("pendingPlanDisableIds") = 0)
    AND cardinality("pendingPlanDisableIds") <= 200),
  ADD CONSTRAINT "SaasSubscription_mpPending_check" CHECK (
    ("mpPendingPreapprovalId" IS NULL) = ("mpPendingCreatedAt" IS NULL)
    AND ("mpPendingInitPoint" IS NULL OR length("mpPendingInitPoint") <= 1000)
    AND ("mpPendingPayerEmail" IS NULL OR length("mpPendingPayerEmail") <= 254));
CREATE UNIQUE INDEX "SaasSubscription_mpPendingPreapprovalId_key" ON "SaasSubscription"("mpPendingPreapprovalId");
CREATE INDEX "SaasSubscription_pendingPlan_idx" ON "SaasSubscription"("pendingPlanEffectiveOn") WHERE "pendingPlan" IS NOT NULL;
CREATE INDEX "SaasSubscription_cancel_idx" ON "SaasSubscription"("cancelEffectiveOn") WHERE "cancelAtPeriodEnd";

ALTER TABLE "SaasCharge"
  ADD COLUMN "baseAmountCents" INTEGER,
  ADD COLUMN "adjustmentsCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mpCheckoutExpectedCents" INTEGER,
  ADD COLUMN "mpCheckoutCreatedAt" TIMESTAMP(3),
  -- IS NOT NULL explícito: con base NULL, `NULL >= 0 AND …` es NULL y un CHECK NULL PASA (hallazgo MIG, mps-m16).
  ADD CONSTRAINT "SaasCharge_breakdown_check" CHECK (
    ("baseAmountCents" IS NULL AND "adjustmentsCents" = 0)
    OR ("baseAmountCents" IS NOT NULL AND "baseAmountCents" >= 0 AND "amountCents" = "baseAmountCents" + "adjustmentsCents")),
  ADD CONSTRAINT "SaasCharge_checkout_check" CHECK (
    ("mpCheckoutExpectedCents" IS NULL OR "mpCheckoutExpectedCents" > 0)
    AND (("mpCheckoutPreferenceId" IS NULL) = ("mpCheckoutExpectedCents" IS NULL))
    AND (("mpCheckoutPreferenceId" IS NULL) = ("mpCheckoutCreatedAt" IS NULL)));

ALTER TABLE "SaasPayment"
  ADD COLUMN "mpPreapprovalId" TEXT,
  ADD COLUMN "splitFromId" TEXT,
  ADD COLUMN "mpPayload" JSONB,
  ADD CONSTRAINT "SaasPayment_mpPayload_check" CHECK (
    "mpPayload" IS NULL OR (CASE WHEN jsonb_typeof("mpPayload") = 'object' THEN pg_column_size("mpPayload") <= 16384 ELSE false END));
CREATE UNIQUE INDEX "SaasPayment_id_tenantId_key" ON "SaasPayment"("id", "tenantId");
CREATE INDEX "SaasPayment_mpPreapprovalId_idx" ON "SaasPayment"("mpPreapprovalId");
CREATE INDEX "SaasPayment_splitFromId_idx" ON "SaasPayment"("splitFromId");
-- NO ACTION (no RESTRICT): auto-referencia; se chequea al fin de la sentencia.
ALTER TABLE "SaasPayment" ADD CONSTRAINT "SaasPayment_splitFrom_tenant_fkey"
  FOREIGN KEY ("splitFromId", "tenantId") REFERENCES "SaasPayment"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "SaasPayment" DROP CONSTRAINT "SaasPayment_source_mp_check";
ALTER TABLE "SaasPayment" ADD CONSTRAINT "SaasPayment_source_mp_check" CHECK (
  ("source" = 'MANUAL' AND "mpPaymentId" IS NULL AND "mpAuthorizedPaymentId" IS NULL AND "mpPreapprovalId" IS NULL)
  OR ("source" <> 'MANUAL' AND ("mpPaymentId" IS NOT NULL OR "mpAuthorizedPaymentId" IS NOT NULL OR "splitFromId" IS NOT NULL)));

CREATE TABLE "SaasAdjustment" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "kind" "SaasAdjustmentKind" NOT NULL,
  "amountCents" INTEGER NOT NULL,                                 -- con signo: CREDIT < 0, el resto > 0
  "effectiveOn" DATE NOT NULL,                                    -- se imputa a cargos con periodStart >= effectiveOn
  "description" TEXT NOT NULL,                                    -- lo ve el consultorio
  "planFrom" "SaasPlan", "planTo" "SaasPlan", "days" INTEGER, "periodDays" INTEGER,
  "idempotencyKey" TEXT NOT NULL, "splitFromId" TEXT, "appliedChargeId" TEXT, "appliedAt" TIMESTAMP(3),
  "createdById" TEXT,                                             -- sin FK (historia); NULL = sistema
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaasAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SaasAdjustment_sign_check" CHECK (("kind" = 'CREDIT' AND "amountCents" < 0) OR ("kind" <> 'CREDIT' AND "amountCents" > 0)),
  CONSTRAINT "SaasAdjustment_applied_check" CHECK (("appliedChargeId" IS NULL) = ("appliedAt" IS NULL)),
  -- "periodDays" IS NOT NULL explícito: `BETWEEN 28 AND 31` sobre NULL es NULL y un CHECK NULL PASA (hallazgo MIG).
  CONSTRAINT "SaasAdjustment_proration_check" CHECK ("kind" <> 'PRORATION' OR ("days" IS NOT NULL AND "periodDays" IS NOT NULL
    AND "periodDays" BETWEEN 28 AND 31 AND "days" BETWEEN 1 AND "periodDays")),
  CONSTRAINT "SaasAdjustment_text_check" CHECK (length(btrim("description")) BETWEEN 1 AND 300 AND length("idempotencyKey") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "SaasAdjustment_tenantId_idempotencyKey_key" ON "SaasAdjustment"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "SaasAdjustment_id_tenantId_key" ON "SaasAdjustment"("id", "tenantId");
CREATE INDEX "SaasAdjustment_appliedChargeId_idx" ON "SaasAdjustment"("appliedChargeId");
CREATE INDEX "SaasAdjustment_pending_idx" ON "SaasAdjustment"("tenantId", "effectiveOn") WHERE "appliedChargeId" IS NULL;
ALTER TABLE "SaasAdjustment" ADD CONSTRAINT "SaasAdjustment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaasAdjustment" ADD CONSTRAINT "SaasAdjustment_charge_tenant_fkey" FOREIGN KEY ("appliedChargeId", "tenantId") REFERENCES "SaasCharge"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaasAdjustment" ADD CONSTRAINT "SaasAdjustment_splitFrom_tenant_fkey" FOREIGN KEY ("splitFromId", "tenantId") REFERENCES "SaasAdjustment"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Solo inserción salvo la imputación (molde saas_plan_price_change_guard; BYPASSRLS no saltea triggers).
CREATE FUNCTION saas_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."appliedChargeId" IS NULL AND NEW."appliedChargeId" IS NOT NULL
     AND (to_jsonb(NEW) - 'appliedChargeId' - 'appliedAt') = (to_jsonb(OLD) - 'appliedChargeId' - 'appliedAt') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SaasAdjustment es solo inserción (salvo appliedChargeId NULL → valor): % rechazado', TG_OP;
END; $$;
CREATE TRIGGER "SaasAdjustment_guard" BEFORE UPDATE OR DELETE ON "SaasAdjustment" FOR EACH ROW EXECUTE FUNCTION saas_adjustment_guard();
CREATE TRIGGER "SaasAdjustment_no_truncate" BEFORE TRUNCATE ON "SaasAdjustment" FOR EACH STATEMENT EXECUTE FUNCTION saas_adjustment_guard();
ALTER TABLE "SaasAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasAdjustment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SaasAdjustment_tenant_read" ON "SaasAdjustment" FOR SELECT USING ("tenantId" = app_current_tenant_id());
COMMIT;
