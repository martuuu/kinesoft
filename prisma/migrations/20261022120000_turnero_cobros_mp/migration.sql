-- M18 · turnero_cobros_mp (bloque TP, tanda T5; va SOLA y encabeza T5b; 22-oct-2026). Plan §22.5, §22.14 (TP-D20/D21),
--   §23.1 #1/#5, §23.12 y §25 (decisiones del 19-oct: cuenta del consultorio solo Titular + step-up; reintegros desde MP;
--   links siempre de un paciente; fake local); contratos C-TP* (wip-20/brief-t5.md).
-- Por qué:
--   • Decisiones 4/5 del 18-oct + TP-D20: cada consultorio elige si el turnero cobra online (OFF/OPTIONAL/REQUIRED) y
--     cuánto (valor del turno con el MISMO resolver que la agenda, seña fija o %); cada profesional cobra en SU cuenta de
--     Mercado Pago (OAuth). NUNCA la de la plataforma (cierra AUDIT turnero-mp-cuenta-plataforma / H-TP1).
--   • "BookingPaymentPolicy" (1:1 con Tenant): la política sin tocar Tenant (se lee en cada request).
--   • "MpAccount" (TENANT_READONLY): cuenta conectada (de un profesional, o del consultorio con practitionerId NULL).
--     El consultorio la LEE; la escriben solo el callback OAuth, desconectar, la delegación y el cron por el canal service
--     con tenantId e id a mano (ADR-026, precedente ADR-024). "webhookRef" = 128 bits opacos que viajan en la
--     notification_url (?acct=) y eligen la cuenta en el webhook. Una cuenta viva por profesional y una por consultorio
--     (únicos PARCIALES). Desconectar no borra: la fila sigue siendo la cuenta de los cobros viejos.
--   • "MpCredential" (SERVICE_ONLY): tokens SELLADOS (lib/secret-box.ts, AES-256-GCM, AAD por cuenta y campo). La app no
--     la ve con ningún GUC. Se purga (DELETE) 7 días después de desconectar.
--   • "OnlineCharge": UN cobro online = UNA preferencia de MP con el token del vendedor. Turnero (FULL/DEPOSIT, siempre
--     con turno) y links de pago (con turno: FULL = restante/total o DEPOSIT; sin turno: FREE), SIEMPRE de un paciente.
--     Es el comprobante imputado al turno (TP-D20): número de operación, fecha, monto, medio, estado.
--     "Payment" (1:1 con Booking, bookingId UNIQUE) NO se toca: es el checkout legado de la plataforma (AUDIT §5.4). Un
--     turno ahora puede tener seña + link del restante, y ensanchar Payment exigía soltar el UNIQUE que el código viejo usa
--     en upsert/findUnique durante el deploy.
--   • "Booking"."onlineDepositCents": Σ de las señas PAID del turno, en la MISMA fila que lee la agenda (/sala, drawer,
--     Facturación, portal y los predicados de «tiene plata» con 0 sentencias nuevas; listAgendaBookings está a un techo
--     de +10 %). La escribe SOLO el trigger online_charge_sync_booking(): no hay dos fuentes de verdad.
-- Triggers (BYPASSRLS no saltea triggers; SQLSTATE P0001):
--   • online_charge_guard(): DELETE/TRUNCATE siempre rechazados. INSERT nace ACTIVE, sin preferencia ni comprobante,
--     sobre una cuenta ACTIVE de ESTE consultorio que es del profesional imputado o la del consultorio, y (con turno) el
--     turno es de ese profesional. UPDATE: identidad y monto inmutables; transiciones permitidas; preferencia y
--     comprobante una vez (el reintegro solo suma refundedAt y el estado de MP); anulación una vez.
--     Transiciones: ACTIVE→AUTHORIZED|PAID|REFUNDED|EXPIRED|CANCELLED · AUTHORIZED→ACTIVE|PAID|REFUNDED ·
--     EXPIRED→PAID|REFUNDED · CANCELLED→PAID|REFUNDED · PAID→REFUNDED · REFUNDED terminal. Un pago aprobado SIEMPRE se
--     registra (la plata existe): un link anulado o vencido puede pasar a PAID, y la app avisa.
--   • online_charge_sync_booking() (AFTER UPDATE OF status; solo DEPOSIT con turno y solo si entra o sale de PAID):
--     recalcula Booking.onlineDepositCents y mueve "updatedAt" (quien cobra con la versión vieja recibe «stale» y ve la
--     seña antes de cobrar). Orden de locks: el webhook toma Booking FOR UPDATE y después el cobro; este trigger escribe
--     Booking con ese lock ya tomado. Nadie toma cobro → turno al revés.
-- Nunca se le pone a la base una regla que la realidad de MP pueda romper (sin único sobre PAID, sin topes a lo que manda
-- MP): un CHECK violado convierte el webhook en 500 y MP reintenta días. La app sanea antes de escribir.
-- FKs compuestas RESTRICT (FK saltea RLS; prod es BYPASSRLS): OnlineCharge → MpAccount, Practitioner, Patient y
--   (bookingId, tenantId, patientId) → Booking (el cobro es del paciente de ESE turno; cambiar el paciente de un turno con
--   cobros da 23503 y la app lo frena antes con mensaje); MpAccount → Practitioner; MpCredential → MpAccount (CASCADE: un
--   secreto no frena nada).
-- RLS: BookingPaymentPolicy y OnlineCharge → ENABLE + FORCE + "<T>_tenant_isolation". MpAccount → ENABLE + FORCE + UNA
--   policy FOR SELECT por tenant. MpCredential → ENABLE + FORCE, CERO policies. Sin GRANT (DEFAULT PRIVILEGES de
--   prisma/roles.*.sql). OJO: SELECT … FOR SHARE/UPDATE exige pasar policies de UPDATE. Sobre MpAccount (sin policy de
--   escritura) la app no ve ninguna fila con lock: el guard la consulta SIN lock.
-- ADITIVA: 7 enums, 4 tablas, UNA columna en Booking con DEFAULT constante (PG ≥ 11: solo metadatos, no reescribe),
--   CHECKs que validan al instante, funciones y triggers sobre tablas nuevas. Sin DROP, sin SET NOT NULL de columnas
--   existentes, sin backfill, sin tocar "Payment". Compatible con el código anterior (no lee nada nuevo; su INSERT de
--   Booking toma el DEFAULT 0) → ANTES del deploy de T5.
-- Locks: ADD COLUMN/ADD CONSTRAINT de Booking toman ACCESS EXCLUSIVE hasta el COMMIT (instantáneo con los volúmenes de
--   prod, pero frena la agenda mientras dure la tx): van AL FINAL. lock_timeout 5 s (P3009, RUNBOOK).
-- COALESCE en los CHECK de «todo o nada» (M11/M12: un CHECK acepta NULL); CASE en el jsonb (M14).
-- DRIFT ACEPTADO (NO borrar si `migrate diff` lo propone; migrate dev prohibido): parciales
--   MpAccount_tenant_practitioner_live_key, MpAccount_tenant_clinic_live_key, MpCredential_purgeAfter_idx,
--   OnlineCharge_bookingId_turnero_key, OnlineCharge_bookingId_live_link_key, OnlineCharge_tenantId_approvedAt_paid_idx;
--   FKs compuestas *_tenant_fkey / *_tenant_patient_fkey; todos los CHECK nuevos; funciones online_charge_guard() y
--   online_charge_sync_booking() con sus triggers; policies.
-- Requiere PostgreSQL ≥ 13.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "BookingPaymentMode" AS ENUM ('OFF', 'OPTIONAL', 'REQUIRED');
CREATE TYPE "BookingChargeKind"  AS ENUM ('COPAGO', 'FIXED', 'PERCENT');
CREATE TYPE "MpAccountKind"      AS ENUM ('PRACTITIONER', 'CLINIC');
CREATE TYPE "MpAccountStatus"    AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTED');
CREATE TYPE "OnlineChargeOrigin" AS ENUM ('TURNERO', 'LINK');
CREATE TYPE "OnlineChargeKind"   AS ENUM ('FULL', 'DEPOSIT', 'FREE');
CREATE TYPE "OnlineChargeStatus" AS ENUM ('ACTIVE', 'AUTHORIZED', 'PAID', 'REFUNDED', 'EXPIRED', 'CANCELLED');

-- ── BookingPaymentPolicy (1:1 con Tenant; tenant.sensitive la escribe por runWithRls) ─────
CREATE TABLE "BookingPaymentPolicy" (
  "tenantId"         TEXT NOT NULL,
  "mode"             "BookingPaymentMode" NOT NULL DEFAULT 'OFF',
  "chargeKind"       "BookingChargeKind"  NOT NULL DEFAULT 'COPAGO',
  "fixedCents"       INTEGER,
  "percentBps"       INTEGER,
  "useClinicAccount" BOOLEAN NOT NULL DEFAULT false,
  "cancellationNote" TEXT,
  "updatedByUserId"  TEXT,            -- sin FK: rastro (como Booking.copagoCollectedById)
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingPaymentPolicy_pkey" PRIMARY KEY ("tenantId"),
  -- $1..$1.000.000 (TP-D13); % en puntos básicos (1 = 0,01 %).
  CONSTRAINT "BookingPaymentPolicy_amount_check" CHECK (COALESCE(
      ("chargeKind" = 'COPAGO'  AND "fixedCents" IS NULL AND "percentBps" IS NULL)
   OR ("chargeKind" = 'FIXED'   AND "fixedCents" BETWEEN 100 AND 100000000 AND "percentBps" IS NULL)
   OR ("chargeKind" = 'PERCENT' AND "percentBps" BETWEEN 1 AND 10000 AND "fixedCents" IS NULL), false)),
  CONSTRAINT "BookingPaymentPolicy_note_check" CHECK ("cancellationNote" IS NULL
      OR char_length(btrim("cancellationNote")) BETWEEN 1 AND 280),
  CONSTRAINT "BookingPaymentPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── MpAccount (TENANT_READONLY) ─────────────────────────────────────
CREATE TABLE "MpAccount" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "practitionerId"       TEXT,
  "kind"                 "MpAccountKind" NOT NULL,
  "mpUserId"             TEXT NOT NULL,
  "mpNickname"           TEXT,           -- de /users/me al conectar: el Titular ve A QUÉ cuenta entra la plata
  "liveMode"             BOOLEAN NOT NULL,
  "publicKey"            TEXT,           -- no es secreto
  "webhookRef"           TEXT NOT NULL,
  "linksDelegated"       BOOLEAN NOT NULL DEFAULT false,
  "status"               "MpAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "connectedByUserId"    TEXT NOT NULL,  -- sin FK: rastro
  "connectedAt"          TIMESTAMP(3) NOT NULL,
  "reauthRequiredAt"     TIMESTAMP(3),
  "disconnectedAt"       TIMESTAMP(3),
  "disconnectedByUserId" TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MpAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MpAccount_kind_check" CHECK (("kind" = 'CLINIC') = ("practitionerId" IS NULL)),
  CONSTRAINT "MpAccount_mpUserId_check" CHECK ("mpUserId" ~ '^[0-9]{1,20}$'),
  CONSTRAINT "MpAccount_text_check" CHECK (("mpNickname" IS NULL OR char_length("mpNickname") BETWEEN 1 AND 100)
      AND ("publicKey" IS NULL OR char_length("publicKey") BETWEEN 1 AND 200)),
  CONSTRAINT "MpAccount_webhookRef_check" CHECK ("webhookRef" ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT "MpAccount_status_check" CHECK (COALESCE(
      ("status" = 'ACTIVE'          AND "disconnectedAt" IS NULL AND "disconnectedByUserId" IS NULL)
   OR ("status" = 'REAUTH_REQUIRED' AND "reauthRequiredAt" IS NOT NULL AND "disconnectedAt" IS NULL AND "disconnectedByUserId" IS NULL)
   OR ("status" = 'DISCONNECTED'    AND "disconnectedAt" IS NOT NULL AND "linksDelegated" = false), false)),
  CONSTRAINT "MpAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MpAccount_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MpAccount_practitioner_tenant_fkey" FOREIGN KEY ("practitionerId", "tenantId") REFERENCES "Practitioner"("id", "tenantId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "MpAccount_webhookRef_key"   ON "MpAccount"("webhookRef");
CREATE UNIQUE INDEX "MpAccount_id_tenantId_key"  ON "MpAccount"("id", "tenantId");      -- destino de FK compuesta
CREATE INDEX "MpAccount_tenantId_status_idx"     ON "MpAccount"("tenantId", "status");
CREATE INDEX "MpAccount_practitionerId_idx"      ON "MpAccount"("practitionerId");      -- M10: FK con índice
-- PARCIALES (NO borrar): a lo sumo UNA cuenta no desconectada por profesional y UNA del consultorio.
CREATE UNIQUE INDEX "MpAccount_tenant_practitioner_live_key" ON "MpAccount"("tenantId", "practitionerId")
  WHERE "practitionerId" IS NOT NULL AND "status" <> 'DISCONNECTED';
CREATE UNIQUE INDEX "MpAccount_tenant_clinic_live_key" ON "MpAccount"("tenantId")
  WHERE "practitionerId" IS NULL AND "status" <> 'DISCONNECTED';

-- ── MpCredential (SERVICE_ONLY) ─────────────────────────────────────
CREATE TABLE "MpCredential" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "mpAccountId"     TEXT NOT NULL,
  "accessTokenBox"  TEXT NOT NULL,
  "refreshTokenBox" TEXT NOT NULL,
  "keyId"           TEXT NOT NULL,
  "accessExpiresAt" TIMESTAMP(3) NOT NULL,
  "version"         INTEGER NOT NULL DEFAULT 1,     -- CAS del refresh (refresh token rotativo)
  "lastRefreshedAt" TIMESTAMP(3),
  "refreshFailures" INTEGER NOT NULL DEFAULT 0,
  "purgeAfter"      TIMESTAMP(3),                   -- desconectar: +7 días (conciliar)
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MpCredential_pkey" PRIMARY KEY ("id"),
  -- Formato de lib/secret-box.ts: v1.<kid>.<iv 12 B>.<ciphertext>.<tag 16 B> en base64url. Nunca un token en claro;
  -- los dos sobres con la MISMA clave (la rotación re-sella los dos juntos).
  CONSTRAINT "MpCredential_box_check" CHECK (
        "accessTokenBox"  ~ '^v1\.[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND "refreshTokenBox" ~ '^v1\.[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND char_length("accessTokenBox") <= 4096 AND char_length("refreshTokenBox") <= 4096
    AND split_part("accessTokenBox", '.', 2) = "keyId" AND split_part("refreshTokenBox", '.', 2) = "keyId"),
  CONSTRAINT "MpCredential_keyId_check" CHECK ("keyId" ~ '^[a-z0-9_-]{1,16}$'),
  CONSTRAINT "MpCredential_counters_check" CHECK ("version" >= 1 AND "refreshFailures" >= 0),
  CONSTRAINT "MpCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MpCredential_mpAccountId_fkey" FOREIGN KEY ("mpAccountId") REFERENCES "MpAccount"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "MpCredential_account_tenant_fkey" FOREIGN KEY ("mpAccountId", "tenantId") REFERENCES "MpAccount"("id", "tenantId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "MpCredential_mpAccountId_key"  ON "MpCredential"("mpAccountId");
CREATE INDEX "MpCredential_tenantId_idx"            ON "MpCredential"("tenantId");
CREATE INDEX "MpCredential_accessExpiresAt_idx"     ON "MpCredential"("accessExpiresAt");   -- cron: refresh < 30 d
CREATE INDEX "MpCredential_purgeAfter_idx"          ON "MpCredential"("purgeAfter") WHERE "purgeAfter" IS NOT NULL;  -- PARCIAL

-- ── OnlineCharge (turnero + links; nunca se borra) ──────────────────
CREATE TABLE "OnlineCharge" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "origin"            "OnlineChargeOrigin" NOT NULL,
  "kind"              "OnlineChargeKind" NOT NULL,
  "status"            "OnlineChargeStatus" NOT NULL DEFAULT 'ACTIVE',
  "mpAccountId"       TEXT NOT NULL,
  "practitionerId"    TEXT NOT NULL,      -- a quién se imputa (el del turno, o «a nombre de» en un link sin turno)
  "patientId"         TEXT NOT NULL,      -- decisión del 19-oct: siempre de un paciente
  "bookingId"         TEXT,
  "amountCents"       INTEGER NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'ARS',
  "copagoBasisCents"  INTEGER,            -- FULL con turno: el copago con el que se calculó (se congela al pagar)
  "concept"           TEXT,
  "publicToken"       TEXT,               -- LINK: /pagar/<token>; 128 bits; en claro para re-compartir (ver brief)
  "expiresAt"         TIMESTAMP(3) NOT NULL,  -- = expiration_date_to de la preferencia
  "preferenceId"      TEXT,
  "checkoutUrl"       TEXT,
  "idempotencyKey"    TEXT NOT NULL,      -- turnero: turnero:<bookingId>; link: link:<uuid del drawer>
  "createdByUserId"   TEXT,               -- LINK: quién lo generó (sin FK)
  -- Comprobante (TP-D20): se escribe al pasar a PAID (o REFUNDED directo) y no cambia.
  "mpPaymentId"       TEXT,
  "mpStatus"          TEXT,
  "mpStatusDetail"    TEXT,
  "paymentMethodId"   TEXT,
  "paymentTypeId"     TEXT,
  "installments"      INTEGER,
  "paidAmountCents"   INTEGER,
  "approvedAt"        TIMESTAMP(3),       -- date_approved de MP (bucket de ingresos)
  "settledAt"         TIMESTAMP(3),       -- reloj NUESTRO al registrar el PAID (comparación con copagoPaidAt)
  "refundedAt"        TIMESTAMP(3),
  "cancelledAt"       TIMESTAMP(3),
  "cancelledByUserId" TEXT,
  "cancelReason"      TEXT,
  "rawPayload"        JSONB,              -- allow-list redactada + attempts (≤ 20) + flags
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OnlineCharge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OnlineCharge_amount_check" CHECK ("amountCents" BETWEEN 100 AND 100000000 AND "currency" = 'ARS'),
  CONSTRAINT "OnlineCharge_shape_check" CHECK (COALESCE(
      ("origin" = 'TURNERO' AND "kind" IN ('FULL', 'DEPOSIT') AND "bookingId" IS NOT NULL
         AND "publicToken" IS NULL AND "concept" IS NULL AND "createdByUserId" IS NULL)
   OR ("origin" = 'LINK' AND "publicToken" IS NOT NULL AND "concept" IS NOT NULL AND "createdByUserId" IS NOT NULL
         AND (("kind" = 'FREE' AND "bookingId" IS NULL) OR ("kind" IN ('FULL', 'DEPOSIT') AND "bookingId" IS NOT NULL))), false)),
  CONSTRAINT "OnlineCharge_basis_check" CHECK ("copagoBasisCents" IS NULL
      OR ("kind" = 'FULL' AND "bookingId" IS NOT NULL AND "copagoBasisCents" BETWEEN 0 AND 100000000)),
  CONSTRAINT "OnlineCharge_concept_check" CHECK ("concept" IS NULL OR char_length(btrim("concept")) BETWEEN 3 AND 120),
  CONSTRAINT "OnlineCharge_token_check" CHECK ("publicToken" IS NULL OR "publicToken" ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT "OnlineCharge_expires_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '31 days'),
  CONSTRAINT "OnlineCharge_preference_check" CHECK (COALESCE(
      ("preferenceId" IS NULL AND "checkoutUrl" IS NULL)
   OR ("preferenceId" IS NOT NULL AND char_length("preferenceId") BETWEEN 1 AND 100
       AND "checkoutUrl" ~ '^https?://' AND char_length("checkoutUrl") <= 500), false)),
  CONSTRAINT "OnlineCharge_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 120),
  CONSTRAINT "OnlineCharge_receipt_check" CHECK (COALESCE(
      ("status" IN ('PAID', 'REFUNDED') AND "mpPaymentId" ~ '^[0-9]{1,20}$' AND "paidAmountCents" >= 0
         AND "approvedAt" IS NOT NULL AND "settledAt" IS NOT NULL AND "mpStatus" IS NOT NULL)
   OR ("status" NOT IN ('PAID', 'REFUNDED') AND "mpPaymentId" IS NULL AND "paidAmountCents" IS NULL
         AND "approvedAt" IS NULL AND "settledAt" IS NULL), false)),
  CONSTRAINT "OnlineCharge_refund_check" CHECK (("status" = 'REFUNDED') = ("refundedAt" IS NOT NULL)),
  -- Anulado ⇒ fecha y motivo. Un anulado que igual se paga (PAID tardío) conserva el rastro de la anulación.
  CONSTRAINT "OnlineCharge_cancel_check" CHECK (COALESCE(
      ("cancelledAt" IS NULL AND "cancelledByUserId" IS NULL AND "cancelReason" IS NULL AND "status" <> 'CANCELLED')
   OR ("cancelledAt" IS NOT NULL AND "cancelReason" IN
        ('manual', 'collected', 'preference_failed', 'account_disconnected', 'booking_cancelled')), false)),
  CONSTRAINT "OnlineCharge_mpStatus_check" CHECK ("mpStatus" IS NULL OR "mpStatus" IN
      ('approved', 'authorized', 'pending', 'in_process', 'in_mediation', 'rejected', 'cancelled', 'refunded', 'charged_back')),
  CONSTRAINT "OnlineCharge_mpText_check" CHECK (("mpStatusDetail" IS NULL OR char_length("mpStatusDetail") <= 64)
      AND ("paymentMethodId" IS NULL OR char_length("paymentMethodId") <= 40)
      AND ("paymentTypeId" IS NULL OR char_length("paymentTypeId") <= 40)
      AND ("installments" IS NULL OR "installments" BETWEEN 1 AND 72)),
  CONSTRAINT "OnlineCharge_rawPayload_check" CHECK ("rawPayload" IS NULL OR CASE
      WHEN jsonb_typeof("rawPayload") = 'object' THEN octet_length("rawPayload"::text) <= 65536
      ELSE false END),
  CONSTRAINT "OnlineCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "OnlineCharge_mpAccountId_fkey" FOREIGN KEY ("mpAccountId") REFERENCES "MpAccount"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "OnlineCharge_account_tenant_fkey" FOREIGN KEY ("mpAccountId", "tenantId") REFERENCES "MpAccount"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "OnlineCharge_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "OnlineCharge_practitioner_tenant_fkey" FOREIGN KEY ("practitionerId", "tenantId") REFERENCES "Practitioner"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "OnlineCharge_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "OnlineCharge_patient_tenant_fkey" FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "OnlineCharge_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "OnlineCharge_booking_tenant_patient_fkey" FOREIGN KEY ("bookingId", "tenantId", "patientId") REFERENCES "Booking"("id", "tenantId", "patientId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "OnlineCharge_tenantId_idempotencyKey_key" ON "OnlineCharge"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "OnlineCharge_publicToken_key"  ON "OnlineCharge"("publicToken");
CREATE INDEX "OnlineCharge_tenantId_createdAt_idx"  ON "OnlineCharge"("tenantId", "createdAt" DESC);   -- /cobros
CREATE INDEX "OnlineCharge_status_expiresAt_idx"    ON "OnlineCharge"("status", "expiresAt");          -- cron (cruza consultorios)
CREATE INDEX "OnlineCharge_bookingId_idx"           ON "OnlineCharge"("bookingId");                    -- M10: FKs con índice
CREATE INDEX "OnlineCharge_patientId_idx"           ON "OnlineCharge"("patientId");
CREATE INDEX "OnlineCharge_practitionerId_idx"      ON "OnlineCharge"("practitionerId");
CREATE INDEX "OnlineCharge_mpAccountId_idx"         ON "OnlineCharge"("mpAccountId");
-- PARCIALES (NO borrar):
--   un cobro del turnero por turno (el replay con la misma key lo reencuentra);
CREATE UNIQUE INDEX "OnlineCharge_bookingId_turnero_key" ON "OnlineCharge"("bookingId") WHERE "origin" = 'TURNERO';
--   a lo sumo UN link vivo por turno (dos links vivos cobrarían dos veces). PAID no entra: un pago tardío nunca choca;
CREATE UNIQUE INDEX "OnlineCharge_bookingId_live_link_key" ON "OnlineCharge"("bookingId")
  WHERE "origin" = 'LINK' AND "bookingId" IS NOT NULL AND "status" IN ('ACTIVE', 'AUTHORIZED');
--   ingresos por fecha de aprobación.
CREATE INDEX "OnlineCharge_tenantId_approvedAt_paid_idx" ON "OnlineCharge"("tenantId", "approvedAt") WHERE "status" = 'PAID';

CREATE FUNCTION online_charge_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'OnlineCharge no se borra nunca (se anula o vence): % rechazado', TG_OP;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."preferenceId" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."refundedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'OnlineCharge %: nace ACTIVE, sin preferencia, anulación ni reintegro; INSERT rechazado', NEW."id";
    END IF;
    -- Cuenta ACTIVA, de ESTE consultorio, del profesional imputado o la del consultorio. SIN FOR SHARE a propósito: con
    -- RLS un SELECT con lock exige policy de UPDATE y MpAccount (TENANT_READONLY) no tiene; la app no vería la fila y
    -- todo link fallaría. La carrera con «desconectar» la cierra la app (desconectar anula los ACTIVE de la cuenta).
    PERFORM 1 FROM public."MpAccount" a
     WHERE a."id" = NEW."mpAccountId" AND a."tenantId" = NEW."tenantId" AND a."status" = 'ACTIVE'
       AND (a."practitionerId" = NEW."practitionerId" OR a."practitionerId" IS NULL);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OnlineCharge %: la cuenta % no está activa o no es del profesional; INSERT rechazado', NEW."id", NEW."mpAccountId";
    END IF;
    IF NEW."bookingId" IS NOT NULL THEN
      PERFORM 1 FROM public."Booking" b
       WHERE b."id" = NEW."bookingId" AND b."tenantId" = NEW."tenantId" AND b."practitionerId" = NEW."practitionerId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'OnlineCharge %: el turno % no es del profesional imputado; INSERT rechazado', NEW."id", NEW."bookingId";
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF (NEW."id", NEW."tenantId", NEW."origin", NEW."kind", NEW."mpAccountId", NEW."practitionerId", NEW."patientId",
      NEW."bookingId", NEW."amountCents", NEW."currency", NEW."copagoBasisCents", NEW."concept", NEW."publicToken",
      NEW."expiresAt", NEW."idempotencyKey", NEW."createdByUserId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."origin", OLD."kind", OLD."mpAccountId", OLD."practitionerId", OLD."patientId",
      OLD."bookingId", OLD."amountCents", OLD."currency", OLD."copagoBasisCents", OLD."concept", OLD."publicToken",
      OLD."expiresAt", OLD."idempotencyKey", OLD."createdByUserId", OLD."createdAt") THEN
    RAISE EXCEPTION 'OnlineCharge %: identidad y monto inmutables, UPDATE rechazado', OLD."id";
  END IF;

  IF OLD."preferenceId" IS NOT NULL
     AND (NEW."preferenceId", NEW."checkoutUrl") IS DISTINCT FROM (OLD."preferenceId", OLD."checkoutUrl") THEN
    RAISE EXCEPTION 'OnlineCharge %: la preferencia ya se creó, UPDATE rechazado', OLD."id";
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'ACTIVE'     AND NEW."status" IN ('AUTHORIZED', 'PAID', 'REFUNDED', 'EXPIRED', 'CANCELLED'))
    OR (OLD."status" = 'AUTHORIZED' AND NEW."status" IN ('ACTIVE', 'PAID', 'REFUNDED'))
    OR (OLD."status" IN ('EXPIRED', 'CANCELLED') AND NEW."status" IN ('PAID', 'REFUNDED'))
    OR (OLD."status" = 'PAID'       AND NEW."status" = 'REFUNDED')) THEN
    RAISE EXCEPTION 'OnlineCharge %: transición % → % no permitida', OLD."id", OLD."status", NEW."status";
  END IF;

  -- Comprobante: número, monto, fechas y medio se escriben una vez.
  IF OLD."mpPaymentId" IS NOT NULL
     AND (NEW."mpPaymentId", NEW."paidAmountCents", NEW."approvedAt", NEW."settledAt", NEW."paymentMethodId",
          NEW."paymentTypeId", NEW."installments")
     IS DISTINCT FROM (OLD."mpPaymentId", OLD."paidAmountCents", OLD."approvedAt", OLD."settledAt", OLD."paymentMethodId",
          OLD."paymentTypeId", OLD."installments") THEN
    RAISE EXCEPTION 'OnlineCharge %: el comprobante es inalterable, UPDATE rechazado', OLD."id";
  END IF;
  -- El estado de MP del comprobante solo cambia con el reintegro (approved → refunded/charged_back).
  IF OLD."status" IN ('PAID', 'REFUNDED') AND NEW."status" = OLD."status"
     AND (NEW."mpStatus", NEW."mpStatusDetail") IS DISTINCT FROM (OLD."mpStatus", OLD."mpStatusDetail") THEN
    RAISE EXCEPTION 'OnlineCharge %: el estado del comprobante solo cambia con el reintegro, UPDATE rechazado', OLD."id";
  END IF;
  IF OLD."refundedAt" IS NOT NULL AND NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt" THEN
    RAISE EXCEPTION 'OnlineCharge %: el reintegro ya se registró, UPDATE rechazado', OLD."id";
  END IF;
  IF OLD."cancelledAt" IS NOT NULL
     AND (NEW."cancelledAt", NEW."cancelledByUserId", NEW."cancelReason")
     IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledByUserId", OLD."cancelReason") THEN
    RAISE EXCEPTION 'OnlineCharge %: la anulación ya se registró, UPDATE rechazado', OLD."id";
  END IF;
  IF OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'OnlineCharge %: anular deja el cobro CANCELLED, UPDATE rechazado', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION online_charge_sync_booking() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  total integer;
BEGIN
  -- TP-D7: la seña no marca el copago; solo cambia «lo cobrado de antemano». Solo DEPOSIT con turno que entra o sale de PAID.
  IF NEW."bookingId" IS NULL OR NEW."kind" <> 'DEPOSIT' OR NOT (OLD."status" = 'PAID' OR NEW."status" = 'PAID') THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(c."amountCents"), 0)::integer INTO total
    FROM public."OnlineCharge" c
   WHERE c."tenantId" = NEW."tenantId" AND c."bookingId" = NEW."bookingId" AND c."kind" = 'DEPOSIT' AND c."status" = 'PAID';
  -- clock_timestamp (no now()): now() es el inicio de la tx y podría repetir un updatedAt anterior.
  UPDATE public."Booking"
     SET "onlineDepositCents" = total,
         "updatedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
   WHERE "id" = NEW."bookingId" AND "tenantId" = NEW."tenantId" AND "onlineDepositCents" IS DISTINCT FROM total;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "OnlineCharge_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "OnlineCharge"
  FOR EACH ROW EXECUTE FUNCTION online_charge_guard();
CREATE TRIGGER "OnlineCharge_no_truncate"
  BEFORE TRUNCATE ON "OnlineCharge"
  FOR EACH STATEMENT EXECUTE FUNCTION online_charge_guard();
CREATE TRIGGER "OnlineCharge_sync_booking"
  AFTER UPDATE OF "status" ON "OnlineCharge"
  FOR EACH ROW EXECUTE FUNCTION online_charge_sync_booking();

-- ── RLS ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BookingPaymentPolicy', 'OnlineCharge']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

ALTER TABLE "MpAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MpAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "MpAccount_tenant_read" ON "MpAccount"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());

ALTER TABLE "MpCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MpCredential" FORCE ROW LEVEL SECURITY;

-- ── Booking AL FINAL (tabla caliente de la agenda) ───────────────────
-- Sin tope superior a propósito: la escribe el trigger con lo que MP acreditó; un CHECK violado sería un webhook en 500.
ALTER TABLE "Booking" ADD COLUMN "onlineDepositCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_onlineDepositCents_check" CHECK ("onlineDepositCents" >= 0);

COMMIT;
