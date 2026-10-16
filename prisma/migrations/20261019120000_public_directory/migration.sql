-- M11 · public_directory (DIR-1, §20.10 del plan). Aditiva: columnas nuevas nullable o con default constante, una tabla
-- nueva, CHECKs sobre columnas nuevas (todas NULL/false al crearse: validan al instante) y un trigger.
--
-- Por qué:
--   * Tenant.directory*: opt-in del consultorio (lo escribe tenant.admin, nunca soporte) y moderación de Plataforma
--     (ocultar con motivo). El código viejo no las lee: se puede aplicar antes del deploy.
--   * Location.provinceCode: la zona del directorio sale de las sedes activas; `province` es texto libre («Bs As»,
--     «CABA») y no sirve para filtrar. 24 jurisdicciones ISO 3166-2:AR (sin el prefijo «AR-»).
--   * ProfessionalPublicProfile: perfil POR PERSONA (userId único). El consentimiento es de la persona (Ley 25.326) y
--     una persona tiene N Practitioner (IAM-1). Sin tenantId → no hay policy de tenant posible ni GUC de usuario:
--     SERVICE_ONLY (ENABLE + FORCE, cero policies), como las tablas de 2FA de M8. La app la escribe por el canal
--     service con el userId de la sesión verificada.
--   * CHECK listed ⇒ consentimiento vigente: la base no deja publicar a nadie sin consentimiento, aunque falle la app.
--   * CHECK publicName sin «@»: decisión 19 (nunca un email como nombre) también en la base.
--   * Trigger: cambiar la matrícula borra la verificación de Plataforma («verificada» solo tras verificar, DIR-D10).
--   * COALESCE((…), false) en los CHECK de matrícula y de ocultamiento (DIR-1, desvío del texto de C-DIR1): un CHECK
--     ACEPTA cuando la expresión da NULL, y `"licenseJurisdiction" IN (…)`, `"licenseNumber" ~ …` o
--     `char_length(btrim(NULL))` dan NULL. Sin el COALESCE pasaban MP sin jurisdicción, número sin tipo, MN sin
--     número y «oculto» sin motivo (lo detectó tests/integration/m11-public-directory.test.ts).
-- En la base y NO en Prisma (drift aceptado; NO borrar si `migrate dev` lo propone): todos los CHECK
-- `<Tabla>_<algo>_check` de este archivo, la función professional_public_profile_license_guard() y su trigger,
-- ENABLE/FORCE de ProfessionalPublicProfile.
SET lock_timeout = '5s';

-- 1. Tenant: opt-in + moderación + descripción pública.
ALTER TABLE "Tenant"
  ADD COLUMN "directoryListed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "directoryListedAt" TIMESTAMP(3),
  ADD COLUMN "directoryHiddenAt" TIMESTAMP(3),
  ADD COLUMN "directoryHiddenReason" TEXT,
  ADD COLUMN "directoryHiddenById" TEXT,
  ADD COLUMN "publicDescription" TEXT;

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_directoryListed_check"
  CHECK (NOT "directoryListed" OR "directoryListedAt" IS NOT NULL);
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_directoryHidden_check"
  CHECK (COALESCE(
         ("directoryHiddenAt" IS NULL AND "directoryHiddenReason" IS NULL AND "directoryHiddenById" IS NULL)
      OR ("directoryHiddenAt" IS NOT NULL AND char_length(btrim("directoryHiddenReason")) BETWEEN 3 AND 500), false));
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_publicDescription_check"
  CHECK ("publicDescription" IS NULL OR char_length("publicDescription") <= 800);

-- 2. Location: provincia normalizada (la RLS de Location no cambia).
ALTER TABLE "Location" ADD COLUMN "provinceCode" TEXT;
ALTER TABLE "Location" ADD CONSTRAINT "Location_provinceCode_check"
  CHECK ("provinceCode" IS NULL OR "provinceCode" IN
    ('C','B','K','H','U','X','W','E','P','Y','L','F','M','N','Q','R','A','J','D','Z','S','G','V','T'));

-- 3. Perfil público por persona.
CREATE TABLE "ProfessionalPublicProfile" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "publicName"          TEXT NOT NULL,
  "honorific"           TEXT,
  "licenseKind"         TEXT,
  "licenseNumber"       TEXT,
  "licenseJurisdiction" TEXT,
  "bio"                 TEXT,
  "listed"              BOOLEAN NOT NULL DEFAULT false,
  "consentAt"           TIMESTAMP(3),
  "consentVersion"      TEXT,
  "consentWithdrawnAt"  TIMESTAMP(3),
  "hiddenAt"            TIMESTAMP(3),
  "hiddenReason"        TEXT,
  "hiddenById"          TEXT,
  "licenseVerifiedAt"   TIMESTAMP(3),
  "licenseVerifiedById" TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfessionalPublicProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProfessionalPublicProfile_userId_key" ON "ProfessionalPublicProfile"("userId");
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_listed_consent_check"
  CHECK (NOT "listed" OR ("consentAt" IS NOT NULL AND "consentVersion" IS NOT NULL AND "consentWithdrawnAt" IS NULL));
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_publicName_check"
  CHECK (char_length(btrim("publicName")) BETWEEN 2 AND 120 AND position('@' in "publicName") = 0);
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_honorific_check"
  CHECK ("honorific" IS NULL OR "honorific" IN ('LIC','KLGO','KLGA','DR','DRA'));
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_license_check"
  CHECK (COALESCE(
         ("licenseKind" IS NULL AND "licenseNumber" IS NULL AND "licenseJurisdiction" IS NULL)
      OR ("licenseKind" = 'MN' AND "licenseNumber" ~ '^[0-9A-Za-z./ -]{1,20}$' AND "licenseJurisdiction" IS NULL)
      OR ("licenseKind" = 'MP' AND "licenseNumber" ~ '^[0-9A-Za-z./ -]{1,20}$' AND "licenseJurisdiction" IN
          ('C','B','K','H','U','X','W','E','P','Y','L','F','M','N','Q','R','A','J','D','Z','S','G','V','T')), false));
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_bio_check"
  CHECK ("bio" IS NULL OR char_length("bio") <= 1000);
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_hidden_check"
  CHECK (COALESCE(
         ("hiddenAt" IS NULL AND "hiddenReason" IS NULL AND "hiddenById" IS NULL)
      OR ("hiddenAt" IS NOT NULL AND char_length(btrim("hiddenReason")) BETWEEN 3 AND 500), false));
ALTER TABLE "ProfessionalPublicProfile" ADD CONSTRAINT "ProfessionalPublicProfile_verified_check"
  CHECK (("licenseVerifiedAt" IS NULL AND "licenseVerifiedById" IS NULL)
      OR ("licenseVerifiedAt" IS NOT NULL AND "licenseNumber" IS NOT NULL));

CREATE OR REPLACE FUNCTION professional_public_profile_license_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."licenseKind", NEW."licenseNumber", NEW."licenseJurisdiction")
     IS DISTINCT FROM (OLD."licenseKind", OLD."licenseNumber", OLD."licenseJurisdiction") THEN
    NEW."licenseVerifiedAt" := NULL;
    NEW."licenseVerifiedById" := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProfessionalPublicProfile_license_guard"
  BEFORE UPDATE ON "ProfessionalPublicProfile"
  FOR EACH ROW EXECUTE FUNCTION professional_public_profile_license_guard();

-- 4. RLS: SERVICE_ONLY (sin GRANT explícito: kinesoft_app/kinesoft_service los reciben por DEFAULT PRIVILEGES; sin
--    policy, kinesoft_app no ve ni escribe nada con cualquier GUC).
ALTER TABLE "ProfessionalPublicProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProfessionalPublicProfile" FORCE ROW LEVEL SECURITY;
