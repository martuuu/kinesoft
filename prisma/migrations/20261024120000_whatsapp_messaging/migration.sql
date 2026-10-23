-- M15 · whatsapp_messaging (WA, T6; SOLA). §21.6 + §26.5; ADR-029.
-- ADITIVA: 10 enums, 2 valores de NotificationKind, 5 tablas, columnas NULL sin DEFAULT en Patient (6) y Booking (3)
--   (solo metadatos). Sin backfill (WA-D17). El código viejo no lee nada nuevo → ANTES del deploy.
--   Con WHATSAPP_MODE=off nadie escribe los valores nuevos del enum (rollback seguro).
-- RLS: Account/Template/Message/Inbound TENANT_READONLY (escritor único por canal service, precedente ADR-026);
--   Credential SERVICE_ONLY.
-- DRIFT ACEPTADO (no borrar si migrate diff lo propone): parciales *_live_key, WhatsAppMessage_due_idx,
--   Patient_tenantId_waPhoneE164_idx; FKs compuestas; CHECKs; policies.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'BOOKING_PATIENT_REPLY';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'WHATSAPP_ACCOUNT';
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TYPE "WhatsAppAccountStatus"  AS ENUM ('SETUP','ACTIVE','REAUTH_REQUIRED','DISCONNECTED');
CREATE TYPE "WhatsAppSetupStep"      AS ENUM ('TOKEN','SUBSCRIBED','REGISTERED','TEMPLATES','DONE');
CREATE TYPE "WhatsAppTemplateKey"    AS ENUM ('BOOKING_CREATED','BOOKING_MOVED','BOOKINGS_UPDATED','BOOKING_REMINDER','DOCUMENT_SHARED');
CREATE TYPE "WhatsAppTemplateStatus" AS ENUM ('NOT_SUBMITTED','PENDING','APPROVED','REJECTED','PAUSED','DISABLED');
CREATE TYPE "WhatsAppMessageKind"    AS ENUM ('BOOKING_CREATED','BOOKING_MOVED','BOOKINGS_UPDATED','BOOKING_REMINDER','DOCUMENT_SHARED','TEST','REPLY');
CREATE TYPE "WhatsAppMessageTrigger" AS ENUM ('AUTO','CRON','MANUAL','INBOUND');
CREATE TYPE "WhatsAppMessageStatus"  AS ENUM ('QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','SKIPPED','CANCELLED','EXPIRED');
CREATE TYPE "WhatsAppInboundKind"    AS ENUM ('CONFIRM','CANCEL_REQUEST','OPT_OUT','OPT_IN','TEXT','OTHER');
CREATE TYPE "WhatsAppConsentStatus"  AS ENUM ('GRANTED','REVOKED');
CREATE TYPE "WhatsAppConsentSource"  AS ENUM ('STAFF','TURNERO','PORTAL','WHATSAPP');

CREATE TABLE "WhatsAppAccount" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "mode" TEXT NOT NULL,
  "wabaId" TEXT NOT NULL, "phoneNumberId" TEXT NOT NULL, "businessId" TEXT,
  "displayPhone" TEXT, "verifiedName" TEXT, "nameStatus" TEXT, "qualityRating" TEXT, "messagingLimit" TEXT,
  "status" "WhatsAppAccountStatus" NOT NULL DEFAULT 'SETUP', "setupStep" "WhatsAppSetupStep" NOT NULL DEFAULT 'TOKEN',
  "autoBookingNotice" BOOLEAN NOT NULL DEFAULT true, "autoReminder" BOOLEAN NOT NULL DEFAULT true,
  "autoReplyText" BOOLEAN NOT NULL DEFAULT true,
  "paymentIssueAt" TIMESTAMP(3), "lastErrorCode" TEXT, "lastErrorAt" TIMESTAMP(3), "lastWebhookAt" TIMESTAMP(3),
  "connectedByUserId" TEXT NOT NULL, "connectedAt" TIMESTAMP(3) NOT NULL, "reauthRequiredAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3), "disconnectedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsAppAccount_mode_check" CHECK ("mode" IN ('fake','sandbox','live')),
  CONSTRAINT "WhatsAppAccount_ids_check" CHECK ("wabaId" ~ '^[0-9]{5,25}$' AND "phoneNumberId" ~ '^[0-9]{5,25}$'
      AND ("businessId" IS NULL OR "businessId" ~ '^[0-9]{5,25}$')),
  -- Lo que manda Meta, solo con tope de largo: un CHECK de valores convierte el webhook en 500 (lección M18).
  CONSTRAINT "WhatsAppAccount_text_check" CHECK (COALESCE(char_length("displayPhone"),0) <= 32
      AND COALESCE(char_length("verifiedName"),0) <= 120 AND COALESCE(char_length("nameStatus"),0) <= 40
      AND COALESCE(char_length("qualityRating"),0) <= 20 AND COALESCE(char_length("messagingLimit"),0) <= 40
      AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z_]{1,40}(:[0-9]{1,7})?$')),
  CONSTRAINT "WhatsAppAccount_status_check" CHECK (COALESCE(
      ("status" = 'SETUP' AND "disconnectedAt" IS NULL)
   OR ("status" = 'ACTIVE' AND "setupStep" = 'DONE' AND "disconnectedAt" IS NULL)
   OR ("status" = 'REAUTH_REQUIRED' AND "reauthRequiredAt" IS NOT NULL AND "disconnectedAt" IS NULL)
   OR ("status" = 'DISCONNECTED' AND "disconnectedAt" IS NOT NULL), false)),
  CONSTRAINT "WhatsAppAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "WhatsAppAccount_id_tenantId_key" ON "WhatsAppAccount"("id","tenantId");
CREATE INDEX "WhatsAppAccount_tenantId_status_idx" ON "WhatsAppAccount"("tenantId","status");
-- PARCIALES: una cuenta viva por consultorio; un número/WABA vivo en UN consultorio (el webhook rutea por phone_number_id).
CREATE UNIQUE INDEX "WhatsAppAccount_tenant_live_key" ON "WhatsAppAccount"("tenantId") WHERE "status" <> 'DISCONNECTED';
CREATE UNIQUE INDEX "WhatsAppAccount_phone_live_key" ON "WhatsAppAccount"("phoneNumberId") WHERE "status" <> 'DISCONNECTED';
CREATE UNIQUE INDEX "WhatsAppAccount_waba_live_key" ON "WhatsAppAccount"("wabaId") WHERE "status" <> 'DISCONNECTED';

CREATE TABLE "WhatsAppCredential" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "tokenBox" TEXT NOT NULL, "pinBox" TEXT NOT NULL, "keyId" TEXT NOT NULL, "tokenExpiresAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsAppCredential_box_check" CHECK (
        "tokenBox" ~ '^v1\.[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND "pinBox"   ~ '^v1\.[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND char_length("tokenBox") <= 4096 AND char_length("pinBox") <= 1024
    AND split_part("tokenBox",'.',2) = "keyId" AND split_part("pinBox",'.',2) = "keyId" AND "version" >= 1),
  CONSTRAINT "WhatsAppCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppCredential_account_tenant_fkey" FOREIGN KEY ("accountId","tenantId")
    REFERENCES "WhatsAppAccount"("id","tenantId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WhatsAppCredential_accountId_key" ON "WhatsAppCredential"("accountId");
CREATE INDEX "WhatsAppCredential_tenantId_idx" ON "WhatsAppCredential"("tenantId");

CREATE TABLE "WhatsAppTemplate" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "accountId" TEXT NOT NULL, "key" "WhatsAppTemplateKey" NOT NULL,
  "name" TEXT NOT NULL, "language" TEXT NOT NULL DEFAULT 'es_AR', "specVersion" INTEGER NOT NULL, "metaTemplateId" TEXT,
  "status" "WhatsAppTemplateStatus" NOT NULL DEFAULT 'NOT_SUBMITTED', "rejectedReason" TEXT,
  "submittedAt" TIMESTAMP(3), "statusAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsAppTemplate_check" CHECK ("name" ~ '^[a-z0-9_]{1,100}$' AND "language" ~ '^[a-z]{2}(_[A-Z]{2})?$'
    AND "specVersion" >= 1 AND COALESCE(char_length("rejectedReason"),0) <= 200),
  CONSTRAINT "WhatsAppTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppTemplate_account_tenant_fkey" FOREIGN KEY ("accountId","tenantId")
    REFERENCES "WhatsAppAccount"("id","tenantId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WhatsAppTemplate_accountId_key_key" ON "WhatsAppTemplate"("accountId","key");
CREATE INDEX "WhatsAppTemplate_tenantId_idx" ON "WhatsAppTemplate"("tenantId");

-- Cola + registro SIN cuerpo: el texto se re-arma de la plantilla; el teléfono, HMAC + máscara.
CREATE TABLE "WhatsAppMessage" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "kind" "WhatsAppMessageKind" NOT NULL, "trigger" "WhatsAppMessageTrigger" NOT NULL,
  "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'QUEUED', "idempotencyKey" TEXT NOT NULL,
  "patientId" TEXT, "bookingId" TEXT, "bookingScheduledFor" TIMESTAMP(3), "documentId" TEXT, "seriesCount" INTEGER,
  "templateName" TEXT, "toHash" TEXT NOT NULL, "toMasked" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3), "lockedUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "wamid" TEXT, "errorCode" TEXT, "skipReason" TEXT, "createdByUserId" TEXT,
  "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "readAt" TIMESTAMP(3), "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsAppMessage_key_check" CHECK ("idempotencyKey" ~ '^[a-z]{1,8}:[A-Za-z0-9:._-]{1,180}$'),
  CONSTRAINT "WhatsAppMessage_to_check" CHECK ("toHash" ~ '^[0-9a-f]{64}$' AND char_length("toMasked") BETWEEN 4 AND 32),
  CONSTRAINT "WhatsAppMessage_refs_check" CHECK (
        ("kind" NOT IN ('BOOKING_CREATED','BOOKING_MOVED','BOOKINGS_UPDATED','BOOKING_REMINDER')
           OR ("patientId" IS NOT NULL AND "bookingScheduledFor" IS NOT NULL))
    AND ("kind" <> 'DOCUMENT_SHARED' OR ("patientId" IS NOT NULL AND "documentId" IS NOT NULL))
    -- IS NOT NULL explícito: `NULL BETWEEN 2 AND 500` es NULL y un CHECK NULL PASA (hallazgo MIG, test wa-m15).
    AND ("kind" <> 'BOOKINGS_UPDATED' OR ("seriesCount" IS NOT NULL AND "seriesCount" BETWEEN 2 AND 500))
    AND (("kind" = 'REPLY') = ("templateName" IS NULL))),
  CONSTRAINT "WhatsAppMessage_state_check" CHECK ("attempts" BETWEEN 0 AND 20
    AND ("status" NOT IN ('SENT','DELIVERED','READ') OR "wamid" IS NOT NULL)
    AND ("status" <> 'FAILED' OR ("failedAt" IS NOT NULL AND "errorCode" IS NOT NULL))
    AND ("status" <> 'SKIPPED' OR "skipReason" IS NOT NULL)
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z_]{1,40}(:[0-9]{1,7})?$')
    AND ("skipReason" IS NULL OR "skipReason" ~ '^[a-z_]{1,40}$')),
  CONSTRAINT "WhatsAppMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppMessage_account_tenant_fkey" FOREIGN KEY ("accountId","tenantId")
    REFERENCES "WhatsAppAccount"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppMessage_patient_tenant_fkey" FOREIGN KEY ("patientId","tenantId")
    REFERENCES "Patient"("id","tenantId") ON DELETE RESTRICT,
  -- Un turno borrado no arrastra su historial (rastro); bookingScheduledFor queda.
  CONSTRAINT "WhatsAppMessage_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "WhatsAppMessage_tenantId_idempotencyKey_key" ON "WhatsAppMessage"("tenantId","idempotencyKey");
CREATE UNIQUE INDEX "WhatsAppMessage_wamid_key" ON "WhatsAppMessage"("wamid");
CREATE INDEX "WhatsAppMessage_tenantId_bookingId_createdAt_idx" ON "WhatsAppMessage"("tenantId","bookingId","createdAt");
CREATE INDEX "WhatsAppMessage_tenantId_createdAt_idx" ON "WhatsAppMessage"("tenantId","createdAt");
CREATE INDEX "WhatsAppMessage_accountId_createdAt_idx" ON "WhatsAppMessage"("accountId","createdAt");
CREATE INDEX "WhatsAppMessage_patientId_idx" ON "WhatsAppMessage"("patientId");
CREATE INDEX "WhatsAppMessage_bookingId_idx" ON "WhatsAppMessage"("bookingId");
CREATE INDEX "WhatsAppMessage_due_idx" ON "WhatsAppMessage"("nextAttemptAt") WHERE "status" IN ('QUEUED','SENDING'); -- PARCIAL

CREATE TABLE "WhatsAppInbound" (   -- SIN texto: solo qué fue y qué se hizo
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "accountId" TEXT NOT NULL, "wamid" TEXT NOT NULL,
  "kind" "WhatsAppInboundKind" NOT NULL, "fromHash" TEXT NOT NULL, "contextWamid" TEXT, "messageId" TEXT,
  "bookingId" TEXT, "outcome" TEXT NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsAppInbound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsAppInbound_check" CHECK ("fromHash" ~ '^[0-9a-f]{64}$' AND "outcome" ~ '^[a-z_]{1,32}$'),
  CONSTRAINT "WhatsAppInbound_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppInbound_account_tenant_fkey" FOREIGN KEY ("accountId","tenantId")
    REFERENCES "WhatsAppAccount"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "WhatsAppInbound_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "WhatsAppInbound_wamid_key" ON "WhatsAppInbound"("wamid");
CREATE INDEX "WhatsAppInbound_tenantId_bookingId_receivedAt_idx" ON "WhatsAppInbound"("tenantId","bookingId","receivedAt");
CREATE INDEX "WhatsAppInbound_tenantId_createdAt_idx" ON "WhatsAppInbound"("tenantId","createdAt");
CREATE INDEX "WhatsAppInbound_accountId_idx" ON "WhatsAppInbound"("accountId");
CREATE INDEX "WhatsAppInbound_messageId_idx" ON "WhatsAppInbound"("messageId");

ALTER TABLE "WhatsAppAccount" ENABLE ROW LEVEL SECURITY;  ALTER TABLE "WhatsAppAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "WhatsAppAccount_tenant_read" ON "WhatsAppAccount" FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "WhatsAppTemplate" ENABLE ROW LEVEL SECURITY; ALTER TABLE "WhatsAppTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "WhatsAppTemplate_tenant_read" ON "WhatsAppTemplate" FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "WhatsAppMessage" ENABLE ROW LEVEL SECURITY;  ALTER TABLE "WhatsAppMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "WhatsAppMessage_tenant_read" ON "WhatsAppMessage" FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "WhatsAppInbound" ENABLE ROW LEVEL SECURITY;  ALTER TABLE "WhatsAppInbound" FORCE ROW LEVEL SECURITY;
CREATE POLICY "WhatsAppInbound_tenant_read" ON "WhatsAppInbound" FOR SELECT USING ("tenantId" = app_current_tenant_id());
ALTER TABLE "WhatsAppCredential" ENABLE ROW LEVEL SECURITY; ALTER TABLE "WhatsAppCredential" FORCE ROW LEVEL SECURITY;

-- ── Patient y Booking AL FINAL (tablas calientes) ──
ALTER TABLE "Patient" ADD COLUMN "waConsent" "WhatsAppConsentStatus", ADD COLUMN "waConsentAt" TIMESTAMP(3),
  ADD COLUMN "waConsentSource" "WhatsAppConsentSource", ADD COLUMN "waConsentByUserId" TEXT,
  ADD COLUMN "waConsentVersion" TEXT, ADD COLUMN "waPhoneE164" TEXT;
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_wa_consent_check" CHECK (COALESCE(
    ("waConsent" IS NULL AND "waConsentAt" IS NULL AND "waConsentSource" IS NULL AND "waPhoneE164" IS NULL)
 OR ("waConsent" = 'GRANTED' AND "waConsentAt" IS NOT NULL AND "waConsentSource" IS NOT NULL
     AND "waConsentVersion" ~ '^[a-z0-9.-]{1,32}$' AND "waPhoneE164" IS NOT NULL)
 OR ("waConsent" = 'REVOKED' AND "waConsentAt" IS NOT NULL AND "waConsentSource" IS NOT NULL), false)
 AND ("waPhoneE164" IS NULL OR "waPhoneE164" ~ '^\+[1-9][0-9]{7,14}$'));
CREATE INDEX "Patient_tenantId_waPhoneE164_idx" ON "Patient"("tenantId","waPhoneE164") WHERE "waPhoneE164" IS NOT NULL;
-- La respuesta del paciente NO mueve updatedAt (WA-D22); patientReplyFor = el horario al que respondió.
ALTER TABLE "Booking" ADD COLUMN "patientConfirmedAt" TIMESTAMP(3), ADD COLUMN "patientCancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "patientReplyFor" TIMESTAMP(3);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_patient_reply_check"
  CHECK ("patientReplyFor" IS NOT NULL OR ("patientConfirmedAt" IS NULL AND "patientCancelRequestedAt" IS NULL));
COMMIT;
