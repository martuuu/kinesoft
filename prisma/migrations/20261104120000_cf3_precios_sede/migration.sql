-- M22 · cf3_precios_sede (CF3, 04-nov-2026; SOLA). Plan §30.
-- Por qué: (A) precio por profesional × servicio (D-CF3-1: escalón nuevo de lib/copago.ts; NULL = hereda, idéntico a hoy);
-- (B) el profesional decide si su precio se ve en el turnero/sede (D-CF3-3; DEFAULT true = conducta de hoy);
-- (C) WhatsApp del profesional para pacientes con obra social (D-CF3-5, opt-in sobre el número con consentimiento de CF2);
-- (D) sede digital /<slug> (D-CF3-10, apagada por defecto) + frase corta.
-- ADITIVA: columnas NULL o NOT NULL con DEFAULT constante (solo catálogo), CHECKs que pasan sobre filas existentes.
-- No toca Booking. Nadie lo lee en el código anterior → ANTES del deploy. lock_timeout 5 s (Tenant/Practitioner calientes).
-- DRIFT ACEPTADO: los CHECK no van en Prisma; si `migrate dev` propone borrarlos, NO se aceptan.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PractitionerService" ADD COLUMN "priceCents" INTEGER;
ALTER TABLE "PractitionerService" ADD CONSTRAINT "PractitionerService_priceCents_check"
  CHECK ("priceCents" IS NULL OR "priceCents" BETWEEN 0 AND 100000000);
ALTER TABLE "Practitioner"
  ADD COLUMN "showPublicPrice" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showContactForInsured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_insuredContact_check" CHECK (NOT "showContactForInsured"
  OR ("contactWhatsapp" IS NOT NULL AND "contactConsentAt" IS NOT NULL AND "contactConsentVersion" IS NOT NULL));
ALTER TABLE "Tenant"
  ADD COLUMN "siteEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "siteEnabledAt" TIMESTAMP(3),
  ADD COLUMN "siteTagline" TEXT;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_siteTagline_check"
  CHECK ("siteTagline" IS NULL OR char_length("siteTagline") BETWEEN 1 AND 120);
COMMIT;
