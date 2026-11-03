-- M21 · cf2_profesional_caja (CF2, 02-nov-2026; SOLA). Plan §29.
-- Por qué: (A) anticipación del turnero por profesional (servicio > profesional > consultorio > 60');
-- (B) contacto del profesional dentro de la anticipación (opt-in + consentimiento, Ley 25.326);
-- (C) avisos de turno online por mail y push web (opt-in) + dispositivos; (D) reparto de % entre profesionales con
-- vigencia por INSTANTE (un cambio nunca altera lo ya cobrado: solo se cierra, trigger); (E) la caja filtra por
-- copagoPaidAt/insurerPaidAt, que hoy barren todos los turnos del tenant.
-- ADITIVA: 7 columnas en Practitioner (3 NOT NULL con DEFAULT constante = solo catálogo), 2 tablas, CHECKs, 1 único
-- parcial, 1 trigger, 2 índices parciales en Booking. Nadie lo lee en el código anterior → ANTES del deploy.
-- Booking es caliente: CREATE INDEX sin CONCURRENTLY (va en tx) toma SHARE; prod ~miles de filas → ms. lock_timeout 5 s.
-- PushSubscription es SERVICE_ONLY (ENABLE + FORCE, cero policies; solo el canal service con el userId de la sesión).
-- DRIFT ACEPTADO: CHECKs, únicos/índices parciales, trigger y ENABLE/FORCE no van en Prisma; si `migrate dev` propone
-- borrarlos, NO se aceptan.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Practitioner"
  ADD COLUMN "publicMinLeadMinutes"    INTEGER,
  ADD COLUMN "contactWhatsapp"         TEXT,
  ADD COLUMN "showContactInLeadWindow" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contactConsentAt"        TIMESTAMP(3),
  ADD COLUMN "contactConsentVersion"   TEXT,
  ADD COLUMN "notifyBookingEmail"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notifyBookingPush"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Practitioner"
  ADD CONSTRAINT "Practitioner_publicMinLeadMinutes_check"  CHECK ("publicMinLeadMinutes" IS NULL OR "publicMinLeadMinutes" BETWEEN 0 AND 80640),
  ADD CONSTRAINT "Practitioner_contactWhatsapp_check"       CHECK ("contactWhatsapp" IS NULL OR "contactWhatsapp" ~ '^\+549[1-9][0-9]{9}$'),
  ADD CONSTRAINT "Practitioner_contactConsentVersion_check" CHECK ("contactConsentVersion" IS NULL OR char_length("contactConsentVersion") BETWEEN 1 AND 32),
  ADD CONSTRAINT "Practitioner_leadContact_check"           CHECK (NOT "showContactInLeadWindow"
      OR ("contactWhatsapp" IS NOT NULL AND "contactConsentAt" IS NOT NULL AND "contactConsentVersion" IS NOT NULL));

CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "endpoint" TEXT NOT NULL, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL,
  "label" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastSuccessAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PushSubscription_endpoint_check" CHECK ("endpoint" ~ '^https://' AND char_length("endpoint") <= 1024),
  CONSTRAINT "PushSubscription_keys_check" CHECK ("p256dh" ~ '^[A-Za-z0-9_-]{80,100}={0,2}$' AND "auth" ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'),
  CONSTRAINT "PushSubscription_label_check" CHECK ("label" IS NULL OR char_length("label") <= 60),
  CONSTRAINT "PushSubscription_failureCount_check" CHECK ("failureCount" >= 0)
);
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" FORCE ROW LEVEL SECURITY;

CREATE TABLE "PractitionerRevenueShare" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL,
  "giverPractitionerId" TEXT NOT NULL, "receiverPractitionerId" TEXT NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "appliesManual" BOOLEAN NOT NULL, "appliesOnline" BOOLEAN NOT NULL, "appliesInsurer" BOOLEAN NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "effectiveTo" TIMESTAMP(3),
  "createdById" TEXT, "closedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PractitionerRevenueShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PractitionerRevenueShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "PractitionerRevenueShare_giver_tenant_fkey" FOREIGN KEY ("giverPractitionerId","tenantId")
    REFERENCES "Practitioner"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PractitionerRevenueShare_receiver_tenant_fkey" FOREIGN KEY ("receiverPractitionerId","tenantId")
    REFERENCES "Practitioner"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PractitionerRevenueShare_bps_check" CHECK ("shareBps" BETWEEN 1 AND 10000),
  CONSTRAINT "PractitionerRevenueShare_sources_check" CHECK ("appliesManual" OR "appliesOnline" OR "appliesInsurer"),
  CONSTRAINT "PractitionerRevenueShare_not_self_check" CHECK ("giverPractitionerId" <> "receiverPractitionerId"),
  CONSTRAINT "PractitionerRevenueShare_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);
-- PARCIAL (no borrar): una regla vigente por profesional que destina.
CREATE UNIQUE INDEX "PractitionerRevenueShare_giver_open_key" ON "PractitionerRevenueShare"("tenantId","giverPractitionerId") WHERE "effectiveTo" IS NULL;
CREATE INDEX "PractitionerRevenueShare_tenantId_giver_from_idx" ON "PractitionerRevenueShare"("tenantId","giverPractitionerId","effectiveFrom");
CREATE INDEX "PractitionerRevenueShare_tenantId_receiver_idx" ON "PractitionerRevenueShare"("tenantId","receiverPractitionerId");
-- Solo se cierra una vigente: effectiveTo NULL→valor (+closedById); el resto inmutable; nunca se reabre.
CREATE FUNCTION practitioner_revenue_share_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."effectiveTo" IS NOT NULL OR NEW."effectiveTo" IS NULL
     OR (NEW."tenantId",NEW."giverPractitionerId",NEW."receiverPractitionerId",NEW."shareBps",NEW."appliesManual",
         NEW."appliesOnline",NEW."appliesInsurer",NEW."effectiveFrom",NEW."createdById",NEW."createdAt")
        IS DISTINCT FROM
        (OLD."tenantId",OLD."giverPractitionerId",OLD."receiverPractitionerId",OLD."shareBps",OLD."appliesManual",
         OLD."appliesOnline",OLD."appliesInsurer",OLD."effectiveFrom",OLD."createdById",OLD."createdAt") THEN
    RAISE EXCEPTION 'PractitionerRevenueShare: solo se cierra una regla vigente' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PractitionerRevenueShare_guard" BEFORE UPDATE ON "PractitionerRevenueShare"
  FOR EACH ROW EXECUTE FUNCTION practitioner_revenue_share_guard();
ALTER TABLE "PractitionerRevenueShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PractitionerRevenueShare" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PractitionerRevenueShare_tenant_isolation" ON "PractitionerRevenueShare"
  USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id());

-- PARCIALES (no borrar): la caja barre por fecha de cobro.
CREATE INDEX "Booking_tenantId_copagoPaidAt_idx"  ON "Booking"("tenantId","copagoPaidAt")  WHERE "copagoPaidAt"  IS NOT NULL;
CREATE INDEX "Booking_tenantId_insurerPaidAt_idx" ON "Booking"("tenantId","insurerPaidAt") WHERE "insurerPaidAt" IS NOT NULL;
COMMIT;
