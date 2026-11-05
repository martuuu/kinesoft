-- M23 · cf3_co_titular (CF3b, 05-nov-2026; SOLA). Va con M22 en el MISMO `db:prod:deploy`. Decisión de Martin del 05-nov.
-- Por qué:
--   (A) «Co-titular»: el Titular principal (OWNER) se lo da a otro PROFESIONAL (role PRACTITIONER, que siempre atiende:
--       lib/roles-core.ts isClinicalMember). Tiene lo del Titular salvo tocar rol/permisos/cuenta del principal,
--       transferir la titularidad, dar o quitar «Co-titular» y todo lo de la suscripción al SaaS (sin account.billing).
--       Es una delegación más de Membership, molde de grantSettings/grantBilling (M8): BOOLEAN NOT NULL DEFAULT false, sin
--       backfill (nadie es co-titular sin que el Titular lo decida). Las capacidades las calcula el código, no la base.
--       CHECK Membership_coOwner_role_check: solo PRACTITIONER. OWNER ya es el principal; ADMIN, ASSISTANT y BILLING no
--       atienden y Martin lo pidió para «otro profesional». Consecuencia buscada: cambiarle el rol a un co-titular (a
--       ADMIN, a Secretaria, o transferirle la titularidad: pasa a OWNER) exige grantCoOwner = false EN LA MISMA
--       escritura; si no, 23514 y la tx se revierte. La base no deja un co-titular colgado de otro rol aunque falle la app.
--   (B) Matrícula de la PERSONA (opcional) como dato de seguridad: número + dónde está registrada (MN = nacional, sin
--       jurisdicción; MP = provincial, con la provincia). Va en UserProfile y NO en:
--       * ProfessionalPublicProfile (M11): la fila exige publicName NOT NULL (2..120, sin «@»), que no tenemos para todos
--         (fullName puede ser NULL o un email, decisión 19); es el contenido del directorio PÚBLICO (escritor único
--         lib/public-profile.ts, solo para quien atiende); y es SERVICE_ONLY (ENABLE + FORCE, cero policies): leerla
--         desde Usuarios del consultorio, con Actor, pediría prismaService, que AGENTS.md §4 reserva a superficies sin
--         Actor.
--       * Practitioner.licenseNumber: es por consultorio, texto libre histórico y PÚBLICO (el turnero y la sede lo
--         muestran, la firma de la ficha lo congela en ClinicalNote.authorLicense).
--       Mismo dominio que el directorio (M11): MN | MP y las 24 jurisdicciones ISO 3166-2:AR sin «AR-» (=
--       Location.provinceCode). Número 1..30, empieza y termina con letra o dígito, en el medio también espacio, «.», «/»
--       y «-» (la app normaliza antes; la base frena basura y espacios sueltos).
--       COALESCE((…), false) en el CHECK de coherencia por lo mismo que M11: un CHECK ACEPTA cuando la expresión da NULL,
--       y sin él pasaba un tipo inventado o un MP sin provincia.
--       licenseUpdatedAt la pone la BASE (trigger UserProfile_license_stamp, función user_profile_license_stamp()):
--       cuándo cambió un dato de seguridad no puede depender de que el escritor se acuerde ni se puede escribir a mano
--       (un UPDATE que no cambia la matrícula conserva la fecha vieja). Borrarla también estampa: queda cuándo se borró.
--       `now() AT TIME ZONE 'UTC'`: la columna es timestamp sin zona escrito en UTC por Prisma; así no depende del
--       TimeZone de la sesión (molde de clinical_note_guard, M14).
-- ADITIVA: ADD COLUMN NULL o NOT NULL con DEFAULT constante (solo catálogo, sin reescritura), CHECKs que pasan sobre las
-- filas existentes (todas false / NULL) y un trigger nuevo. Sin backfill. Compatible con el código de prod: nadie lee ni
-- escribe las columnas nuevas, sus INSERT toman los defaults y sus UPDATE de UserProfile (login, nombre, 2FA) no nombran
-- las de matrícula, así que el trigger no se dispara. Va ANTES del deploy.
-- Sin tabla nueva → guard:isolation no cambia (Membership ya tiene su policy de tenant; UserProfile no tiene tenantId).
-- lock_timeout 5 s: Membership y UserProfile se leen en CADA request (getAccessSnapshot); ACCESS EXCLUSIVE breve.
-- DRIFT ACEPTADO (NO borrar si `migrate dev` lo propone): Membership_coOwner_role_check, UserProfile_licenseNumber_check,
-- UserProfile_licenseJurisdiction_check, UserProfile_license_check, la función user_profile_license_stamp() y su trigger.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- (A) Co-titular.
ALTER TABLE "Membership" ADD COLUMN "grantCoOwner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_coOwner_role_check"
  CHECK (NOT "grantCoOwner" OR "role" = 'PRACTITIONER');

-- (B) Matrícula de la persona.
ALTER TABLE "UserProfile"
  ADD COLUMN "licenseKind" TEXT,
  ADD COLUMN "licenseNumber" TEXT,
  ADD COLUMN "licenseJurisdiction" TEXT,
  ADD COLUMN "licenseUpdatedAt" TIMESTAMP(3);
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_licenseNumber_check"
  CHECK ("licenseNumber" IS NULL OR "licenseNumber" ~ '^[A-Za-z0-9]([A-Za-z0-9 ./-]{0,28}[A-Za-z0-9])?$');
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_licenseJurisdiction_check"
  CHECK ("licenseJurisdiction" IS NULL OR "licenseJurisdiction" IN
    ('C','B','K','H','U','X','W','E','P','Y','L','F','M','N','Q','R','A','J','D','Z','S','G','V','T'));
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_license_check"
  CHECK (COALESCE(
         ("licenseKind" IS NULL AND "licenseNumber" IS NULL AND "licenseJurisdiction" IS NULL)
      OR ("licenseKind" = 'MN' AND "licenseNumber" IS NOT NULL AND "licenseJurisdiction" IS NULL
          AND "licenseUpdatedAt" IS NOT NULL)
      OR ("licenseKind" = 'MP' AND "licenseNumber" IS NOT NULL AND "licenseJurisdiction" IS NOT NULL
          AND "licenseUpdatedAt" IS NOT NULL), false));

CREATE FUNCTION user_profile_license_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."licenseUpdatedAt" := CASE
      WHEN NEW."licenseKind" IS NULL AND NEW."licenseNumber" IS NULL AND NEW."licenseJurisdiction" IS NULL THEN NULL
      ELSE now() AT TIME ZONE 'UTC' END;
  ELSIF (NEW."licenseKind", NEW."licenseNumber", NEW."licenseJurisdiction")
        IS DISTINCT FROM (OLD."licenseKind", OLD."licenseNumber", OLD."licenseJurisdiction") THEN
    NEW."licenseUpdatedAt" := now() AT TIME ZONE 'UTC';
  ELSE
    NEW."licenseUpdatedAt" := OLD."licenseUpdatedAt";
  END IF;
  RETURN NEW;
END $$;
-- INSERT siempre (solo el alta de una cuenta); UPDATE solo si la sentencia nombra alguna de las 4 columnas.
CREATE TRIGGER "UserProfile_license_stamp"
  BEFORE INSERT OR UPDATE OF "licenseKind", "licenseNumber", "licenseJurisdiction", "licenseUpdatedAt" ON "UserProfile"
  FOR EACH ROW EXECUTE FUNCTION user_profile_license_stamp();
COMMIT;
