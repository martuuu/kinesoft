-- M8 · pl_accounts_billing (bloque PL del §20, ola PL-0, va SOLA; 15-oct-2026). Plan §20.5.1 (modelo), §20.5.12
--   (turnero por profesional), §20.11 PL-D1..D23; contratos del brief PL (sección «M8»).
-- Por qué:
--   • enum NUEVO "SaasPlan" (INDIVIDUAL/CONSULTORIO/CLINICA/LIBRE) + Tenant.saasPlan, en vez de renombrar los valores de
--     "TenantPlan" (PL-D1): Vercel migra en el build mientras el deploy viejo sigue sirviendo, y renombrar valores
--     rompe el login del código viejo; `ALTER TYPE … ADD VALUE` tampoco se puede usar en la misma tx. El escritor
--     único (PL-1a) escribe `saasPlan` y ESPEJA `plan` (rollback coherente). El DROP de `plan`/`TenantPlan` queda
--     para una migración posterior. Backfill PL-D2: FREE→INDIVIDUAL, STARTER→CONSULTORIO, PRO→CLINICA,
--     ENTERPRISE→LIBRE.
--   • Tenant.maxUsersOverride / maxProfessionalsOverride / maxStaffOverride: cupos a medida (Libre y excepciones,
--     PL-D3). NULL = el límite del plan (`SaasPlanConfig`). maxProfessionalsOverride se backfillea desde
--     `seatLimitOverride` (M7), que hasta hoy contaba solo a los clínicos. `seatLimitOverride` queda (lo lee el
--     código viejo; su DROP va con el de `plan`).
--   • Membership.clinical (el Titular/Admin puede NO atender, PL-D4 / decisión 8), grantSettings / grantBilling
--     (delegación de «Configuración» y de «Planes y pagos», PL-D5), disabledReason (MANUAL | PLAN_DOWNGRADE |
--     PLATFORM: bajar de plan deshabilita y subir reactiva SOLO a los PLAN_DOWNGRADE). Backfill: ASSISTANT/BILLING
--     clinical=false; ADMIN grantSettings=true (hoy ya configuran); deshabilitadas → 'MANUAL'.
--     A propósito NO hay CHECK que ate disabledReason con disabledAt: el código viejo (IAM-4c) reactiva poniendo
--     disabledAt = NULL sin conocer disabledReason, y ese CHECK lo rompería durante la ventana de deploy.
--   • Practitioner.publicBookingEnabled (decisión 20 de Martin, H-TURN): el turnero se prende por consultorio Y por
--     profesional. Nace en false (opt-in, igual que el consultorio) y se backfillea true para los profesionales
--     existentes, para no esconder a nadie de los turneros que hoy están prendidos.
--   • SaasPlanConfig: catálogo de los 4 planes (precio ARS en centavos, NULL = «Consultá», PL-D19; límites; días de
--     prueba; si se muestra; orden). Lo lee la app (catálogo público, cupos) y lo escribe solo Plataforma por el canal
--     service → GLOBAL_READONLY. Nace con las 4 filas y precios NULL.
--   • SaasPlanPriceChange: historial de precios con `effectiveFrom` (PL-D8: el cron diario los aplica y propaga a
--     MP). Solo inserción por trigger, con UNA excepción: `appliedAt` NULL → valor (el cron marca que la aplicó). Es la
--     prueba de qué precio regía cuándo. SERVICE_ONLY.
--   • Cobros (TENANT_READONLY: el consultorio ve su suscripción, cargos y pagos; escribe SOLO el canal service, así
--     ni un bug de la app ni un actor con sesión pueden marcar un cargo como pagado):
--       SaasSubscription (una por consultorio: precio a medida, día de anclaje, próximo cargo, débito automático y el
--       preapproval de MP), SaasCharge (un cargo por período; UNIQUE tenant+período = el cron es idempotente),
--       SaasPayment (MP_AUTO / MP_CHECKOUT / MANUAL; ids de MP UNIQUE = el webhook es idempotente; FK compuesta al
--       cargo con tenantId = un pago no se cuelga del cargo de otro consultorio; comprobante en bucket privado).
--       Las FKs a Tenant son RESTRICT: la plata no se borra en cascada (la baja de un consultorio es lógica).
--   • Mensajes: SupportThread (TENANT con consultorio / LEAD sin consultorio, desde la web pública) + SupportMessage
--     (autor TENANT / PLATFORM / LEAD). RLS de tenant: SELECT por consultorio e INSERT solo `kind='TENANT'` /
--     `authorKind='TENANT'`: la app no puede forjar una respuesta de Plataforma ni ver los leads (tenantId NULL no
--     iguala a ningún GUC). Sin policy de UPDATE/DELETE: cerrar/reabrir y la marca de leído de Plataforma van por el
--     canal service. La marca de leído del CONSULTORIO va en SupportThreadRead (por usuario: cada admin tiene sus no
--     leídos), con la policy normal de tenant, para no abrirle el UPDATE del hilo a la app.
--   • 2FA (SERVICE_ONLY, lo maneja el servidor por el canal service; la app no los ve nunca): UserProfile.twoFactorEmail
--     / twoFactorTotp / twoFactorUpdatedAt (qué métodos tiene prendidos; el secreto TOTP vive en Supabase MFA),
--     TwoFactorChallenge (código por email: hash, vencimiento, intentos, atado a la sesión de Supabase; índice PARCIAL
--     único = a lo sumo uno abierto por usuario+propósito+sesión), TwoFactorRecoveryCode (10 códigos, hash, PL-D12),
--     UserSecurityEvent (registro de seguridad de la cuenta; solo inserción por trigger).
--
-- ADITIVA (expand). Sin DROP, sin SET NOT NULL sobre columnas existentes. Las columnas nuevas son nullables sin default
--   o NOT NULL con default constante (Postgres 11+: solo catálogo, sin rewrite). Los backfills son UPDATE por fila de
--   tablas chicas (Tenant, Membership, Practitioner) dentro de la misma tx. NO tocan `updatedAt`: el `@updatedAt` de
--   Prisma lo pone el cliente, no hay trigger en la base, y este SQL no lo nombra.
--   Compatible hacia atrás: el código viejo no lee ninguna columna ni tabla nueva (Prisma selecciona solo lo que
--   conoce). Ventana entre M8 y el deploy de PL-1 (ver RUNBOOK «M8 en prod»): un cambio de plan hecho por el código
--   viejo no se refleja en `saasPlan`, y un profesional creado por el código viejo nace con publicBookingEnabled=false.
--   Por eso M8 va el MISMO día que el deploy, y el postcheck lo revisa.
--
-- RLS de las tablas nuevas (`npm run guard:isolation` las clasifica):
--   • GLOBAL_READONLY: SaasPlanConfig (ENABLE + FORCE + SELECT USING true; sin policy de escritura).
--   • SERVICE_ONLY (ENABLE + FORCE y CERO policies): SaasPlanPriceChange, TwoFactorChallenge, TwoFactorRecoveryCode,
--     UserSecurityEvent.
--   • TENANT_READONLY (ENABLE + FORCE + UNA policy FOR SELECT por tenant): SaasSubscription, SaasCharge, SaasPayment.
--   • Tenant normal: SupportThread / SupportMessage (SELECT por tenant + INSERT acotado), SupportThreadRead
--     (`_tenant_isolation` ALL).
--   Sin GRANT explícito: kinesoft_app y kinesoft_service los reciben por DEFAULT PRIVILEGES (prisma/roles.*.sql); los
--   roles de la Data API siguen sin nada desde M2 (guard 3c).
--
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` / `migrate diff` los propone; migrate dev
--   está prohibido en este repo):
--   • todos los CHECK de este archivo (nombres `<Tabla>_<algo>_check`);
--   • el índice PARCIAL único "TwoFactorChallenge_one_open" (WHERE "closedAt" IS NULL);
--   • las funciones kinesoft_append_only() y saas_plan_price_change_guard() y sus triggers
--     ("SaasPlanPriceChange_guard", "SaasPlanPriceChange_no_truncate", "UserSecurityEvent_append_only",
--     "UserSecurityEvent_no_truncate");
--   • la FK simple adicional "SupportMessage_threadId_fkey" convive con la compuesta (Prisma expresa una sola relación
--     por par de campos: la simple está en Prisma, la compuesta no);
--   • ENABLE/FORCE y las policies de las tablas nuevas.
--
-- Locks: ADD COLUMN + UPDATE toman ACCESS EXCLUSIVE / ROW EXCLUSIVE sobre Tenant, Membership, Practitioner y
--   UserProfile hasta el COMMIT (los lee cada request: tablas chicas, milisegundos). lock_timeout: si alguna está
--   tomada, falla rápido en vez de colgar el login (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── Enums ────────────────────────────────────────────────────────────
CREATE TYPE "SaasPlan" AS ENUM ('INDIVIDUAL', 'CONSULTORIO', 'CLINICA', 'LIBRE');
CREATE TYPE "SaasChargeStatus" AS ENUM ('OPEN', 'PAID', 'VOID', 'WAIVED');
CREATE TYPE "SaasPaymentSource" AS ENUM ('MP_AUTO', 'MP_CHECKOUT', 'MANUAL');
CREATE TYPE "SaasPaymentStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REFUNDED');
CREATE TYPE "SupportThreadKind" AS ENUM ('TENANT', 'LEAD');
CREATE TYPE "SupportThreadStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupportAuthorKind" AS ENUM ('TENANT', 'PLATFORM', 'LEAD');
CREATE TYPE "TwoFactorPurpose" AS ENUM ('LOGIN', 'STEP_UP', 'ENROLL_EMAIL');

-- ── Tenant: plan nuevo + cupos a medida ──────────────────────────────
ALTER TABLE "Tenant"
  ADD COLUMN "saasPlan" "SaasPlan" NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN "maxUsersOverride" INTEGER,
  ADD COLUMN "maxProfessionalsOverride" INTEGER,
  ADD COLUMN "maxStaffOverride" INTEGER,
  -- Drift aceptado. NULL = el límite del plan. Total ≥ 1 (el Titular); por tipo ≥ 0 (un consultorio puede no tener
  -- personal no clínico, o un Titular no clínico sin profesionales todavía).
  ADD CONSTRAINT "Tenant_maxUsersOverride_check" CHECK ("maxUsersOverride" IS NULL OR "maxUsersOverride" >= 1),
  ADD CONSTRAINT "Tenant_maxProfessionalsOverride_check" CHECK ("maxProfessionalsOverride" IS NULL OR "maxProfessionalsOverride" >= 0),
  ADD CONSTRAINT "Tenant_maxStaffOverride_check" CHECK ("maxStaffOverride" IS NULL OR "maxStaffOverride" >= 0);

-- Backfill PL-D2. Sin `updatedAt` (ver cabecera).
UPDATE "Tenant" SET
  "saasPlan" = CASE "plan"
    WHEN 'FREE' THEN 'INDIVIDUAL'::"SaasPlan"
    WHEN 'STARTER' THEN 'CONSULTORIO'::"SaasPlan"
    WHEN 'PRO' THEN 'CLINICA'::"SaasPlan"
    WHEN 'ENTERPRISE' THEN 'LIBRE'::"SaasPlan"
  END,
  "maxProfessionalsOverride" = "seatLimitOverride";

-- ── Membership: atiende / permisos delegados / motivo de la baja ─────
ALTER TABLE "Membership"
  ADD COLUMN "clinical" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "grantSettings" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "grantBilling" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "disabledReason" TEXT,
  -- Drift aceptado. Sin acoplar con disabledAt (ver cabecera).
  ADD CONSTRAINT "Membership_disabledReason_check"
    CHECK ("disabledReason" IS NULL OR "disabledReason" IN ('MANUAL', 'PLAN_DOWNGRADE', 'PLATFORM'));

UPDATE "Membership" SET "clinical" = false WHERE "role" IN ('ASSISTANT', 'BILLING');
UPDATE "Membership" SET "grantSettings" = true WHERE "role" = 'ADMIN';
UPDATE "Membership" SET "disabledReason" = 'MANUAL' WHERE "disabledAt" IS NOT NULL;

-- ── Practitioner: aparece en el turnero (decisión 20, H-TURN) ────────
ALTER TABLE "Practitioner" ADD COLUMN "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false;
-- Los actuales quedan prendidos: conserva lo que hoy se ve en los turneros abiertos. Los nuevos nacen apagados.
UPDATE "Practitioner" SET "publicBookingEnabled" = true;

-- ── UserProfile: métodos de 2FA prendidos ────────────────────────────
ALTER TABLE "UserProfile"
  ADD COLUMN "twoFactorEmail" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorTotp" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorUpdatedAt" TIMESTAMP(3);

-- ── Función genérica de solo inserción ───────────────────────────────
-- SQLSTATE P0001 (raise_exception) a propósito, como platform_audit_event_append_only() de M7: distinto del 42501 de
-- RLS. BYPASSRLS no saltea triggers: rige también para el owner. Limpiar filas de TEST requiere
-- `SET LOCAL session_replication_role = replica` (superusuario: solo el Docker local; tests/helpers/tenant-factory.ts).
CREATE FUNCTION kinesoft_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es solo inserción: % rechazado', TG_TABLE_NAME, TG_OP;
END;
$$;

-- ── SaasPlanConfig (GLOBAL_READONLY) ─────────────────────────────────
CREATE TABLE "SaasPlanConfig" (
    "plan" "SaasPlan" NOT NULL,
    "label" TEXT NOT NULL,
    "priceCents" INTEGER,
    "maxUsers" INTEGER,
    "maxProfessionals" INTEGER,
    "maxStaff" INTEGER,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- UserProfile id del superadmin; sin FK (historia, como PlatformAuditEvent.actorId).
    "updatedById" TEXT,

    CONSTRAINT "SaasPlanConfig_pkey" PRIMARY KEY ("plan"),
    -- Drift aceptado. Precio en centavos ARS; NULL = «Consultá» (PL-D19). Límites NULL = sin límite.
    CONSTRAINT "SaasPlanConfig_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 40),
    CONSTRAINT "SaasPlanConfig_priceCents_check" CHECK ("priceCents" IS NULL OR "priceCents" >= 0),
    CONSTRAINT "SaasPlanConfig_limits_check" CHECK (
      ("maxUsers" IS NULL OR "maxUsers" >= 1)
      AND ("maxProfessionals" IS NULL OR "maxProfessionals" >= 0)
      AND ("maxStaff" IS NULL OR "maxStaff" >= 0)),
    CONSTRAINT "SaasPlanConfig_trialDays_check" CHECK ("trialDays" BETWEEN 0 AND 90)
);

-- PL-D3 / PL-D10 / PL-D19: Individual 1 usuario y 14 días de prueba · Consultorio 5 = ≤4 profesionales + ≤1 no
-- clínico · Clínica 10 de cualquier tipo · Libre sin límite (lo fija Plataforma con los overrides). Precios NULL.
INSERT INTO "SaasPlanConfig" ("plan", "label", "priceCents", "maxUsers", "maxProfessionals", "maxStaff", "trialDays", "isPublic", "sortOrder") VALUES
  ('INDIVIDUAL',  'Individual',  NULL, 1,    1,    1,    14, true, 1),
  ('CONSULTORIO', 'Consultorio', NULL, 5,    4,    1,    0,  true, 2),
  ('CLINICA',     'Clínica',     NULL, 10,   NULL, NULL, 0,  true, 3),
  ('LIBRE',       'Libre',       NULL, NULL, NULL, NULL, 0,  true, 4);

-- ── SaasPlanPriceChange (SERVICE_ONLY, solo inserción salvo appliedAt) ──
CREATE TABLE "SaasPlanPriceChange" (
    "id" TEXT NOT NULL,
    "plan" "SaasPlan" NOT NULL,
    -- NULL = vuelve a «Consultá».
    "priceCents" INTEGER,
    "previousPriceCents" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasPlanPriceChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SaasPlanPriceChange_priceCents_check" CHECK (
      ("priceCents" IS NULL OR "priceCents" >= 0) AND ("previousPriceCents" IS NULL OR "previousPriceCents" >= 0)),
    CONSTRAINT "SaasPlanPriceChange_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);

CREATE INDEX "SaasPlanPriceChange_plan_effectiveFrom_idx" ON "SaasPlanPriceChange"("plan", "effectiveFrom");
-- El cron busca los pendientes vencidos (appliedAt NULL, effectiveFrom ≤ ahora).
CREATE INDEX "SaasPlanPriceChange_appliedAt_effectiveFrom_idx" ON "SaasPlanPriceChange"("appliedAt", "effectiveFrom");

ALTER TABLE "SaasPlanPriceChange" ADD CONSTRAINT "SaasPlanPriceChange_plan_fkey"
  FOREIGN KEY ("plan") REFERENCES "SaasPlanConfig"("plan") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Única excepción a «solo inserción»: marcar aplicado (appliedAt NULL → valor) sin tocar ninguna otra columna.
-- `to_jsonb(NEW) - 'appliedAt' = to_jsonb(OLD) - 'appliedAt'` compara todas las demás columnas, también las que se
-- sumen a futuro.
CREATE FUNCTION saas_plan_price_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."appliedAt" IS NULL AND NEW."appliedAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'appliedAt') = (to_jsonb(OLD) - 'appliedAt') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SaasPlanPriceChange es solo inserción (salvo appliedAt NULL → valor): % rechazado', TG_OP;
END;
$$;

CREATE TRIGGER "SaasPlanPriceChange_guard"
  BEFORE UPDATE OR DELETE ON "SaasPlanPriceChange"
  FOR EACH ROW EXECUTE FUNCTION saas_plan_price_change_guard();

CREATE TRIGGER "SaasPlanPriceChange_no_truncate"
  BEFORE TRUNCATE ON "SaasPlanPriceChange"
  FOR EACH STATEMENT EXECUTE FUNCTION saas_plan_price_change_guard();

-- ── SaasSubscription (TENANT_READONLY) ───────────────────────────────
CREATE TABLE "SaasSubscription" (
    "tenantId" TEXT NOT NULL,
    -- Precio a medida (centavos ARS); NULL = el del plan.
    "customPriceCents" INTEGER,
    -- Día del mes en que vence cada período (1..28: existe en todos los meses).
    "anchorDay" INTEGER NOT NULL DEFAULT 1,
    "nextChargeAt" TIMESTAMP(3),
    -- Plataforma habilita el débito automático; el consultorio lo prende/apaga/pausa (PL-D23).
    "autoDebitAllowed" BOOLEAN NOT NULL DEFAULT false,
    "autoDebitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mpPreapprovalId" TEXT,
    "mpPreapprovalStatus" TEXT,
    "mpPayerEmail" TEXT,
    "mpPreapprovalAmountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasSubscription_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "SaasSubscription_anchorDay_check" CHECK ("anchorDay" BETWEEN 1 AND 28),
    CONSTRAINT "SaasSubscription_amounts_check" CHECK (
      ("customPriceCents" IS NULL OR "customPriceCents" >= 0)
      AND ("mpPreapprovalAmountCents" IS NULL OR "mpPreapprovalAmountCents" >= 0))
);

CREATE UNIQUE INDEX "SaasSubscription_mpPreapprovalId_key" ON "SaasSubscription"("mpPreapprovalId");
CREATE INDEX "SaasSubscription_nextChargeAt_idx" ON "SaasSubscription"("nextChargeAt");

ALTER TABLE "SaasSubscription" ADD CONSTRAINT "SaasSubscription_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SaasCharge (TENANT_READONLY) ─────────────────────────────────────
-- Períodos en fechas civiles (DATE): un período es «el 5 de cada mes» en Argentina, no un instante UTC.
CREATE TABLE "SaasCharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    -- Foto del plan con que se generó el cargo.
    "plan" "SaasPlan" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "SaasChargeStatus" NOT NULL DEFAULT 'OPEN',
    "paidAt" TIMESTAMP(3),
    -- Quién lo anuló/condonó (superadmin) y por qué; sin FK (historia).
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" TEXT,
    "note" TEXT,
    "mpCheckoutPreferenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasCharge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SaasCharge_amountCents_check" CHECK ("amountCents" >= 0),
    CONSTRAINT "SaasCharge_period_check" CHECK ("periodEnd" > "periodStart" AND "dueDate" >= "periodStart"),
    -- PAID siempre con fecha de pago.
    CONSTRAINT "SaasCharge_paid_check" CHECK ("status" <> 'PAID' OR "paidAt" IS NOT NULL),
    CONSTRAINT "SaasCharge_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);

-- Un cargo por consultorio y período: el cron diario es idempotente.
CREATE UNIQUE INDEX "SaasCharge_tenantId_periodStart_key" ON "SaasCharge"("tenantId", "periodStart");
-- Destino de la FK compuesta de SaasPayment (el pago y el cargo son del MISMO consultorio).
CREATE UNIQUE INDEX "SaasCharge_id_tenantId_key" ON "SaasCharge"("id", "tenantId");
CREATE INDEX "SaasCharge_status_dueDate_idx" ON "SaasCharge"("status", "dueDate");

ALTER TABLE "SaasCharge" ADD CONSTRAINT "SaasCharge_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SaasPayment (TENANT_READONLY) ────────────────────────────────────
CREATE TABLE "SaasPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    -- NULL: un débito de MP que llega antes de que exista el cargo del período (se concilia después).
    "chargeId" TEXT,
    "source" "SaasPaymentSource" NOT NULL,
    "status" "SaasPaymentStatus" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "mpPaymentId" TEXT,
    "mpAuthorizedPaymentId" TEXT,
    "mpStatus" TEXT,
    -- Comprobante de transferencia (bucket PRIVADO; PL-D22: PDF/JPG/PNG/WEBP ≤ 4 MB).
    "receiptPath" TEXT,
    "receiptMimeType" TEXT,
    "receiptSizeBytes" INTEGER,
    "note" TEXT,
    -- UserProfile ids; sin FK (historia).
    "submittedById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasPayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SaasPayment_amountCents_check" CHECK ("amountCents" > 0),
    -- MANUAL nunca trae ids de MP (no se puede «convertir» un pago manual en uno de MP); MP siempre trae al menos uno.
    CONSTRAINT "SaasPayment_source_mp_check" CHECK (
      ("source" = 'MANUAL' AND "mpPaymentId" IS NULL AND "mpAuthorizedPaymentId" IS NULL)
      OR ("source" <> 'MANUAL' AND ("mpPaymentId" IS NOT NULL OR "mpAuthorizedPaymentId" IS NOT NULL))),
    -- Comprobante: los tres datos juntos o ninguno; tipo y tamaño acotados (la validación de magic bytes es del server).
    -- Los IS NOT NULL explícitos no sobran: `NULL IN (…)` da NULL y un CHECK que da NULL PASA.
    CONSTRAINT "SaasPayment_receipt_check" CHECK (
      ("receiptPath" IS NULL AND "receiptMimeType" IS NULL AND "receiptSizeBytes" IS NULL)
      OR ("receiptPath" IS NOT NULL AND "receiptMimeType" IS NOT NULL AND "receiptSizeBytes" IS NOT NULL
          AND "receiptMimeType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
          AND "receiptSizeBytes" BETWEEN 1 AND 4194304)),
    CONSTRAINT "SaasPayment_notes_check" CHECK (
      ("note" IS NULL OR length("note") <= 500) AND ("reviewNote" IS NULL OR length("reviewNote") <= 500))
);

-- Idempotencia del webhook/cron: un id de MP = un pago.
CREATE UNIQUE INDEX "SaasPayment_mpPaymentId_key" ON "SaasPayment"("mpPaymentId");
CREATE UNIQUE INDEX "SaasPayment_mpAuthorizedPaymentId_key" ON "SaasPayment"("mpAuthorizedPaymentId");
CREATE INDEX "SaasPayment_tenantId_createdAt_idx" ON "SaasPayment"("tenantId", "createdAt");
CREATE INDEX "SaasPayment_chargeId_idx" ON "SaasPayment"("chargeId");
CREATE INDEX "SaasPayment_status_createdAt_idx" ON "SaasPayment"("status", "createdAt");

ALTER TABLE "SaasPayment" ADD CONSTRAINT "SaasPayment_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Compuesta: el cargo tiene que ser del mismo consultorio (las FKs saltean RLS). MATCH SIMPLE: chargeId NULL pasa.
ALTER TABLE "SaasPayment" ADD CONSTRAINT "SaasPayment_chargeId_tenantId_fkey"
  FOREIGN KEY ("chargeId", "tenantId") REFERENCES "SaasCharge"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SupportThread / SupportMessage / SupportThreadRead ───────────────
CREATE TABLE "SupportThread" (
    "id" TEXT NOT NULL,
    "kind" "SupportThreadKind" NOT NULL,
    "tenantId" TEXT,
    "subject" TEXT NOT NULL,
    "status" "SupportThreadStatus" NOT NULL DEFAULT 'OPEN',
    -- UserProfile id de quien lo abrió (TENANT); sin FK (historia).
    "createdById" TEXT,
    -- Datos del lead (web pública, PL-D15: sin respuesta automática).
    "leadName" TEXT,
    "leadEmail" TEXT,
    "leadPhone" TEXT,
    "leadClinicName" TEXT,
    "leadPlanInterest" "SaasPlan",
    -- Marca de leído del lado de Plataforma (la del consultorio va por usuario en SupportThreadRead).
    "platformReadAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportThread_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportThread_subject_check" CHECK (length(btrim("subject")) BETWEEN 1 AND 200),
    -- TENANT: con consultorio y sin datos de lead. LEAD: sin consultorio, con nombre y email.
    CONSTRAINT "SupportThread_kind_check" CHECK (
      ("kind" = 'TENANT' AND "tenantId" IS NOT NULL
        AND "leadName" IS NULL AND "leadEmail" IS NULL AND "leadPhone" IS NULL
        AND "leadClinicName" IS NULL AND "leadPlanInterest" IS NULL)
      OR ("kind" = 'LEAD' AND "tenantId" IS NULL
        AND "leadName" IS NOT NULL AND length(btrim("leadName")) BETWEEN 1 AND 120
        AND "leadEmail" IS NOT NULL AND length("leadEmail") BETWEEN 3 AND 254)),
    CONSTRAINT "SupportThread_lead_fields_check" CHECK (
      ("leadPhone" IS NULL OR length("leadPhone") <= 40)
      AND ("leadClinicName" IS NULL OR length("leadClinicName") <= 120))
);

-- Destino de las FKs compuestas (mensaje y marca de leído del mismo consultorio que el hilo).
CREATE UNIQUE INDEX "SupportThread_id_tenantId_key" ON "SupportThread"("id", "tenantId");
CREATE INDEX "SupportThread_tenantId_createdAt_idx" ON "SupportThread"("tenantId", "createdAt");
CREATE INDEX "SupportThread_status_createdAt_idx" ON "SupportThread"("status", "createdAt");
-- Tope de leads por email por día (C-PL11: 3 por día por email).
CREATE INDEX "SupportThread_leadEmail_createdAt_idx" ON "SupportThread"("leadEmail", "createdAt");

ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    -- = el del hilo (NULL en los hilos de lead).
    "tenantId" TEXT,
    "authorKind" "SupportAuthorKind" NOT NULL,
    -- UserProfile id (TENANT/PLATFORM); NULL para LEAD. Sin FK (historia).
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportMessage_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 5000),
    CONSTRAINT "SupportMessage_author_check" CHECK (
      ("authorKind" = 'TENANT' AND "tenantId" IS NOT NULL AND "authorUserId" IS NOT NULL)
      OR ("authorKind" = 'PLATFORM')
      OR ("authorKind" = 'LEAD' AND "tenantId" IS NULL AND "authorUserId" IS NULL))
);

CREATE INDEX "SupportMessage_threadId_createdAt_idx" ON "SupportMessage"("threadId", "createdAt");
CREATE INDEX "SupportMessage_tenantId_idx" ON "SupportMessage"("tenantId");

-- Simple: todo mensaje cuelga de un hilo que existe (también los de lead, tenantId NULL).
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "SupportThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Compuesta: con tenantId, el hilo es de ese consultorio (no se cuelga un mensaje del hilo de otro). Drift aceptado.
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_threadId_tenantId_fkey"
  FOREIGN KEY ("threadId", "tenantId") REFERENCES "SupportThread"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Marca de leído del consultorio, por usuario (C-PL11 markSupportThreadRead). Upsert por la app.
CREATE TABLE "SupportThreadRead" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportThreadRead_pkey" PRIMARY KEY ("threadId", "userId")
);

CREATE INDEX "SupportThreadRead_tenantId_userId_idx" ON "SupportThreadRead"("tenantId", "userId");

ALTER TABLE "SupportThreadRead" ADD CONSTRAINT "SupportThreadRead_threadId_tenantId_fkey"
  FOREIGN KEY ("threadId", "tenantId") REFERENCES "SupportThread"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportThreadRead" ADD CONSTRAINT "SupportThreadRead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2FA (SERVICE_ONLY) ───────────────────────────────────────────────
CREATE TABLE "TwoFactorChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "TwoFactorPurpose" NOT NULL,
    -- Id de la sesión de Supabase (claim session_id): el código no sirve en otra sesión.
    "sessionId" TEXT NOT NULL,
    -- Hash del código (nunca el código).
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TwoFactorChallenge_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "TwoFactorChallenge_expiry_check" CHECK ("expiresAt" > "createdAt"),
    -- Cerrado = con motivo; abierto = sin ninguno de los dos. `closedReason IS NOT NULL` explícito: `NULL IN (…)` da
    -- NULL y el CHECK pasaría (cerrado sin motivo).
    CONSTRAINT "TwoFactorChallenge_closed_check" CHECK (
      ("closedAt" IS NULL AND "closedReason" IS NULL)
      OR ("closedAt" IS NOT NULL AND "closedReason" IS NOT NULL
          AND "closedReason" IN ('VERIFIED', 'EXPIRED', 'LOCKED', 'REPLACED')))
);

-- PARCIAL: a lo sumo UN desafío abierto por usuario + propósito + sesión (pedir otro código cierra el anterior con
-- REPLACED en la misma tx; dos pedidos simultáneos → 23505 en vez de dos códigos válidos). Prisma no lo expresa:
-- drift aceptado, NO borrar si `migrate dev` lo propone.
CREATE UNIQUE INDEX "TwoFactorChallenge_one_open" ON "TwoFactorChallenge"("userId", "purpose", "sessionId") WHERE "closedAt" IS NULL;
-- Tope de envíos por usuario y ventana.
CREATE INDEX "TwoFactorChallenge_userId_createdAt_idx" ON "TwoFactorChallenge"("userId", "createdAt");

ALTER TABLE "TwoFactorChallenge" ADD CONSTRAINT "TwoFactorChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TwoFactorRecoveryCode_userId_codeHash_key" ON "TwoFactorRecoveryCode"("userId", "codeHash");

ALTER TABLE "TwoFactorRecoveryCode" ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Registro de seguridad de la cuenta (2FA prendido/apagado, códigos de recuperación usados, reset por superadmin,
-- cambio de titularidad…). userId/tenantId SIN FK a propósito: sobrevive al usuario y al consultorio, como
-- PlatformAuditEvent.actorId. Solo inserción.
CREATE TABLE "UserSecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "tenantId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSecurityEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserSecurityEvent_kind_check" CHECK (length("kind") BETWEEN 1 AND 80)
);

CREATE INDEX "UserSecurityEvent_userId_createdAt_idx" ON "UserSecurityEvent"("userId", "createdAt");
CREATE INDEX "UserSecurityEvent_tenantId_createdAt_idx" ON "UserSecurityEvent"("tenantId", "createdAt");

CREATE TRIGGER "UserSecurityEvent_append_only"
  BEFORE UPDATE OR DELETE ON "UserSecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION kinesoft_append_only();

CREATE TRIGGER "UserSecurityEvent_no_truncate"
  BEFORE TRUNCATE ON "UserSecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION kinesoft_append_only();

-- ── RLS ──────────────────────────────────────────────────────────────
-- GLOBAL_READONLY: la app lee el catálogo de planes; nadie lo escribe por la app.
ALTER TABLE "SaasPlanConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasPlanConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SaasPlanConfig_read" ON "SaasPlanConfig" FOR SELECT USING (true);

-- SERVICE_ONLY: ENABLE + FORCE sin policies (default-deny para kinesoft_app con cualquier GUC).
ALTER TABLE "SaasPlanPriceChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasPlanPriceChange" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TwoFactorChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TwoFactorChallenge" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TwoFactorRecoveryCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TwoFactorRecoveryCode" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UserSecurityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSecurityEvent" FORCE ROW LEVEL SECURITY;

-- TENANT_READONLY: el consultorio LEE su suscripción, cargos y pagos; escribe solo el canal service.
ALTER TABLE "SaasSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SaasSubscription_tenant_read" ON "SaasSubscription"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "SaasCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasCharge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SaasCharge_tenant_read" ON "SaasCharge"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "SaasPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaasPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SaasPayment_tenant_read" ON "SaasPayment"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());

-- Mensajes: la app ve los hilos/mensajes de su consultorio (nunca los leads: tenantId NULL) y solo puede crear hilos
-- TENANT y mensajes con autor TENANT. Sin UPDATE/DELETE: cerrar y la marca de Plataforma van por el canal service.
ALTER TABLE "SupportThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportThread" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupportThread_tenant_read" ON "SupportThread"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());
CREATE POLICY "SupportThread_tenant_insert" ON "SupportThread"
  FOR INSERT WITH CHECK ("tenantId" = app_current_tenant_id() AND "kind" = 'TENANT');
ALTER TABLE "SupportMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupportMessage_tenant_read" ON "SupportMessage"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());
CREATE POLICY "SupportMessage_tenant_insert" ON "SupportMessage"
  FOR INSERT WITH CHECK ("tenantId" = app_current_tenant_id() AND "authorKind" = 'TENANT');
ALTER TABLE "SupportThreadRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportThreadRead" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupportThreadRead_tenant_isolation" ON "SupportThreadRead"
  USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id());

COMMIT;
