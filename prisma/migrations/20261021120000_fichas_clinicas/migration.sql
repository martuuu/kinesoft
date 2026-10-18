-- M14 · fichas_clinicas (bloque FC, tanda T4; va SOLA y encabeza FC-0; 19/21-oct-2026). Plan §21.5, §23.12 y §24
--   (FC-D1..D32); contratos C-FC* (wip-20/brief-t4.md).
-- Por qué:
--   • FC-D1: la ficha EVOLUCIONA ClinicalNote (M9): ya es una por consulta, inalterable a las 24 h por trigger (ADR-020),
--     con gate único, enmienda, anulación, impresión y export.
--   • ClinicalNote."bodyDoc" (jsonb): JSON del editor (subconjunto ProseMirror de lib/hc-doc.ts). "body" sigue siendo
--     texto plano DERIVADO en el server (hcDocToPlainText): tope de 20.000, CHECK, búsqueda, impresión y guards siguen
--     sobre "body". Nunca HTML. Notas viejas: NULL.
--   • ClinicalNote."diagnoses" (jsonb): snapshot CONGELADO de 1..5 (el primero = principal); el server re-lee código,
--     título y URI. CIE-11 MMS (OMS, CC BY-ND 3.0 IGO §1.2.3 «code, title and URI»): el CHECK exige código y URI.
--   • "authorLicense" (matrícula con la que firmó) e "importSource" (ficha importada de Word, «carga tardía», Ley 26.529):
--     IDENTIDAD → inmutables por trigger. Sin backfill (FC-D24).
--   • ClinicalNoteRevision."bodyDoc"/"diagnoses": contenido; editarlos copia la versión anterior y respeta 24 h + 10 min.
--   • "DiagnosisCode": CIE-11 MMS en español. GLOBAL_READONLY: lo escribe solo scripts/diagnosis-import.ts (owner).
--     Nunca se borra: se RETIRA. "title" es el oficial sin tocar; "searchText" es NUESTRO (campo agregado, no OMS).
--   • "TenantDiagnosis" (propios) y "DiagnosisFavorite" (por usuario y consultorio): RLS por tenant.
--   • "PatientDocument": lo COMPARTIDO con el paciente = foto HcPrintable v1 + PDF (bucket privado patient-documents).
--     Uno VIVO por ficha; volver a compartir revoca el anterior (REPLACED); anular la ficha lo revoca EN LA BASE
--     (NOTE_VOIDED). Nunca se borra; solo se revoca, una vez. El portal lee SOLO esta tabla (EV2-D5 revocado acotado).
--   • Tenant."logo*", Practitioner."honorific"/"signature*" (decisión 2 del 19-oct): membrete y firma del PDF.
-- Triggers (BYPASSRLS no saltea triggers; SQLSTATE P0001):
--   • clinical_note_guard() se REEMPLAZA línea por línea sobre M9: mismas excepciones y texto (los tests las matchean),
--     mismo search_path, sin SECURITY DEFINER. authorLicense/importSource a identidad; bodyDoc/diagnoses a contenido y
--     revisión; la rama de anulación revoca los PatientDocument vivos de la nota (revokedAt = NEW.voidedAt).
--   • patient_document_guard(): DELETE/TRUNCATE siempre rechazados; INSERT nace vigente y solo de una RAÍZ VIVA del mismo
--     paciente y consultorio, con FOR SHARE sobre la nota (serializa contra la anulación); UPDATE solo NULL → revocado.
--   • Orden de locks (hallazgo 8): quien comparte bloquea la NOTA antes de tocar documentos; anular bloquea la nota y
--     después revoca. Mismo orden nota → documentos: sin deadlock.
-- FKs compuestas RESTRICT (FK saltea RLS; prod es BYPASSRLS): PatientDocument → Patient, ClinicalNote (raíz del mismo
--   paciente), Practitioner (quien compartió); DiagnosisFavorite → TenantDiagnosis (CASCADE: un favorito no es HC).
-- RLS: TenantDiagnosis, DiagnosisFavorite, PatientDocument → ENABLE + FORCE + "<T>_tenant_isolation". DiagnosisCode →
--   ENABLE + FORCE + FOR SELECT USING (true), sin escritura. Sin GRANT (DEFAULT PRIVILEGES de prisma/roles.*.sql).
-- ADITIVA: 3 enums, 4 tablas, columnas NULLABLE sin default, CHECKs que validan al instante (todo NULL), funciones y
--   triggers. Sin DROP, sin SET NOT NULL, sin backfill, sin tocar updatedAt. Compatible con el código anterior → ANTES del
--   deploy de FC.
-- Locks: ADD COLUMN toma ACCESS EXCLUSIVE en ClinicalNote, ClinicalNoteRevision, Practitioner y Tenant hasta el COMMIT.
--   Tenant se lee en CADA request: su ALTER va AL FINAL. lock_timeout 5 s (P3009, RUNBOOK).
-- CHECKs jsonb con CASE (no AND): el orden de un AND no está garantizado y jsonb_array_length TIRA sobre un no-array.
--   Lección de M11/M12: COALESCE en los CHECK de «todo o nada».
-- DRIFT ACEPTADO (NO borrar si `migrate diff` lo propone; migrate dev prohibido): parciales
--   PatientDocument_noteId_live_key y TenantDiagnosis_tenantId_title_active_key; FKs compuestas PatientDocument_*_fkey
--   (patient_tenant, note_tenant_patient, sharer_tenant) y DiagnosisFavorite_tenantDiagnosis_tenant_fkey; todos los CHECK
--   nuevos; funciones clinical_note_guard() (reemplazada) y patient_document_guard() con sus triggers; policies.
-- clinical_note_guard() de M14 vs la de M9 (20261017120000_clinical_notes), diferencia por diferencia (todo lo demás es
--   idéntico, texto de las excepciones incluido: los tests de M9 las matchean; md5(prosrc) de M9 local =
--   0a87f3688a5002c59a7b5238e2ae8a44, es el precheck de prod):
--   1. Rama de identidad: + `OR NEW."authorLicense" IS DISTINCT FROM OLD."authorLicense"` y
--      `OR NEW."importSource" IS DISTINCT FROM OLD."importSource"` (con su comentario): son parte de lo firmado.
--   2. content_changed: + `bodyDoc` y `diagnoses` (con su comentario): jsonb compara por valor, otro orden de claves
--      no crea revisión.
--   3. Rama de anulación: + el UPDATE de "PatientDocument" vivos de la nota (NOTE_VOIDED, revokedAt = NEW.voidedAt,
--      revokedByUserId = NEW.voidedByUserId) antes del RETURN NEW. Va DESPUÉS del chequeo «anular no edita» (si
--      falla, no se revoca nada) y con el lock de la nota ya tomado (orden nota → documentos, hallazgo 8). Si el CHECK
--      ClinicalNote_void_check rechaza la anulación, la sentencia entera (revocación incluida) vuelve atrás.
--   4. INSERT de la revisión: + columnas "bodyDoc", "diagnoses" con OLD."bodyDoc", OLD."diagnoses".
--   Iguales: firma, LANGUAGE, `SET search_path = pg_catalog, public`, SIN SECURITY DEFINER (el UPDATE de documentos y
--   el INSERT de la revisión corren con el rol y el GUC de quien edita: pasan por RLS), los dos triggers de M9 (CREATE
--   OR REPLACE no los toca). Rollback de la función = el cuerpo de M9 (RUNBOOK «M14 en prod»).
-- Requiere PostgreSQL ≥ 13.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "DiagnosisSystem" AS ENUM ('ICD11_MMS');
CREATE TYPE "PatientDocumentKind" AS ENUM ('FICHA');
CREATE TYPE "PatientDocumentRevokeReason" AS ENUM ('REPLACED', 'NOTE_VOIDED', 'MANUAL');

-- ── DiagnosisCode (CIE-11 MMS, global, solo lectura para la app) ──────
CREATE TABLE "DiagnosisCode" (
  "id"               TEXT NOT NULL,
  "system"           "DiagnosisSystem" NOT NULL DEFAULT 'ICD11_MMS',
  "code"             TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "uri"              TEXT NOT NULL,
  "foundationUri"    TEXT,
  "chapter"          TEXT,
  "isLeaf"           BOOLEAN NOT NULL DEFAULT true,
  "isResidual"       BOOLEAN NOT NULL DEFAULT false,
  "release"          TEXT NOT NULL,
  "language"         TEXT NOT NULL DEFAULT 'es',
  "searchText"       TEXT NOT NULL,
  "retiredAt"        TIMESTAMP(3),
  "retiredInRelease" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiagnosisCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DiagnosisCode_code_check" CHECK ("code" ~ '^[0-9A-Z]{4}(\.[0-9A-Z]{1,3})?$'),
  CONSTRAINT "DiagnosisCode_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 500),
  CONSTRAINT "DiagnosisCode_uri_check" CHECK ("uri" ~ '^https?://id\.who\.int/icd/' AND char_length("uri") <= 300),
  CONSTRAINT "DiagnosisCode_release_check" CHECK ("release" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "DiagnosisCode_language_check" CHECK ("language" = 'es'),
  CONSTRAINT "DiagnosisCode_searchText_check" CHECK (char_length("searchText") BETWEEN 1 AND 1200),
  CONSTRAINT "DiagnosisCode_retired_check" CHECK (("retiredAt" IS NULL) = ("retiredInRelease" IS NULL))
);
CREATE UNIQUE INDEX "DiagnosisCode_system_code_key" ON "DiagnosisCode"("system", "code");

-- ── TenantDiagnosis (propios del consultorio) ─────────────────────────
CREATE TABLE "TenantDiagnosis" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "code"            TEXT,
  "searchText"      TEXT NOT NULL,
  "createdByUserId" TEXT,            -- sin FK: rastro para «editar el propio» (FC-D22)
  "archivedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantDiagnosis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantDiagnosis_title_check" CHECK (char_length(btrim("title")) BETWEEN 2 AND 200),
  CONSTRAINT "TenantDiagnosis_code_check" CHECK ("code" IS NULL OR char_length(btrim("code")) BETWEEN 1 AND 20),
  CONSTRAINT "TenantDiagnosis_searchText_check" CHECK (char_length("searchText") BETWEEN 1 AND 400),
  CONSTRAINT "TenantDiagnosis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantDiagnosis_id_tenantId_key" ON "TenantDiagnosis"("id", "tenantId");
CREATE INDEX "TenantDiagnosis_tenantId_idx" ON "TenantDiagnosis"("tenantId");
-- PARCIAL + expresión (Prisma no lo expresa; NO se borra si migrate dev lo propone): un nombre vivo por consultorio, sin distinguir mayúsculas.
CREATE UNIQUE INDEX "TenantDiagnosis_tenantId_title_active_key"
  ON "TenantDiagnosis"("tenantId", lower(btrim("title"))) WHERE "archivedAt" IS NULL;

-- ── DiagnosisFavorite (por usuario y consultorio; exactamente un destino) ─
CREATE TABLE "DiagnosisFavorite" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "diagnosisCodeId"   TEXT,
  "tenantDiagnosisId" TEXT,
  "conditionId"       TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiagnosisFavorite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DiagnosisFavorite_target_check" CHECK (num_nonnulls("diagnosisCodeId", "tenantDiagnosisId", "conditionId") = 1),
  CONSTRAINT "DiagnosisFavorite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DiagnosisFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DiagnosisFavorite_diagnosisCodeId_fkey" FOREIGN KEY ("diagnosisCodeId") REFERENCES "DiagnosisCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DiagnosisFavorite_tenantDiagnosisId_fkey" FOREIGN KEY ("tenantDiagnosisId") REFERENCES "TenantDiagnosis"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DiagnosisFavorite_tenantDiagnosis_tenant_fkey" FOREIGN KEY ("tenantDiagnosisId", "tenantId") REFERENCES "TenantDiagnosis"("id", "tenantId") ON DELETE CASCADE,
  -- Condition puede ser global (tenantId NULL) o propia: la app valida «global o de este consultorio».
  CONSTRAINT "DiagnosisFavorite_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Condition"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DiagnosisFavorite_tenantId_userId_diagnosisCodeId_key" ON "DiagnosisFavorite"("tenantId", "userId", "diagnosisCodeId");
CREATE UNIQUE INDEX "DiagnosisFavorite_tenantId_userId_tenantDiagnosisId_key" ON "DiagnosisFavorite"("tenantId", "userId", "tenantDiagnosisId");
CREATE UNIQUE INDEX "DiagnosisFavorite_tenantId_userId_conditionId_key" ON "DiagnosisFavorite"("tenantId", "userId", "conditionId");
CREATE INDEX "DiagnosisFavorite_userId_idx" ON "DiagnosisFavorite"("userId");                       -- M10: FK con índice
CREATE INDEX "DiagnosisFavorite_diagnosisCodeId_idx" ON "DiagnosisFavorite"("diagnosisCodeId");
CREATE INDEX "DiagnosisFavorite_tenantDiagnosisId_idx" ON "DiagnosisFavorite"("tenantDiagnosisId");
CREATE INDEX "DiagnosisFavorite_conditionId_idx" ON "DiagnosisFavorite"("conditionId");

-- ── ClinicalNote: formato, diagnósticos, matrícula, importación ───────
ALTER TABLE "ClinicalNote"
  ADD COLUMN "bodyDoc"       JSONB,
  ADD COLUMN "diagnoses"     JSONB,
  ADD COLUMN "authorLicense" TEXT,
  ADD COLUMN "importSource"  JSONB;
-- jsonb::text agrega espacios: el tope de la base (400.000) es más laxo que el de la app (262.144 compacto).
ALTER TABLE "ClinicalNote"
  ADD CONSTRAINT "ClinicalNote_bodyDoc_check" CHECK ("bodyDoc" IS NULL OR CASE
      WHEN jsonb_typeof("bodyDoc") = 'object'
        THEN ("bodyDoc"->>'type') IS NOT DISTINCT FROM 'doc' AND octet_length("bodyDoc"::text) <= 400000
      ELSE false END),
  ADD CONSTRAINT "ClinicalNote_diagnoses_check" CHECK ("diagnoses" IS NULL OR CASE
      WHEN jsonb_typeof("diagnoses") = 'array'
        THEN jsonb_array_length("diagnoses") BETWEEN 1 AND 5
         AND octet_length("diagnoses"::text) <= 10000
         AND NOT jsonb_path_exists("diagnoses",
               '$[*] ? (@.type() != "object" || !(exists(@.title)) || @.title.type() != "string"
                        || (@.source == "icd11" && (!(exists(@.code)) || !(exists(@.uri)) || @.uri.type() != "string")))')
      ELSE false END),
  ADD CONSTRAINT "ClinicalNote_authorLicense_check" CHECK ("authorLicense" IS NULL OR char_length(btrim("authorLicense")) BETWEEN 1 AND 60),
  -- Una importada no va atada a un turno ni es enmienda (FC-D10).
  ADD CONSTRAINT "ClinicalNote_importSource_check" CHECK ("importSource" IS NULL OR CASE
      WHEN jsonb_typeof("importSource") = 'object'
        THEN ("importSource"->>'kind') IS NOT DISTINCT FROM 'docx' AND octet_length("importSource"::text) <= 2000
         AND "bookingId" IS NULL AND "amendsNoteId" IS NULL
      ELSE false END);

ALTER TABLE "ClinicalNoteRevision"
  ADD COLUMN "bodyDoc"   JSONB,
  ADD COLUMN "diagnoses" JSONB;

-- ── PatientDocument (lo compartido; inalterable salvo la revocación) ──
CREATE TABLE "PatientDocument" (
  "id"                     TEXT NOT NULL,
  "tenantId"               TEXT NOT NULL,
  "patientId"              TEXT NOT NULL,
  "kind"                   "PatientDocumentKind" NOT NULL DEFAULT 'FICHA',
  "noteId"                 TEXT NOT NULL,
  "noteRevision"           INTEGER NOT NULL,
  "sourceDigest"           TEXT NOT NULL,   -- sha256(hcSourceVersion(raíz, enmiendas)): si cambia → «desactualizada»
  "title"                  TEXT NOT NULL,
  "occurredAt"             TIMESTAMP(3) NOT NULL,
  "snapshot"               JSONB NOT NULL,
  "snapshotVersion"        INTEGER NOT NULL DEFAULT 1,
  "snapshotSha256"         TEXT NOT NULL,
  "pdfStorageKey"          TEXT NOT NULL,   -- «stub:<id>» sin Storage (dev/tests), como PatientFile
  "pdfSha256"              TEXT NOT NULL,
  "pdfSizeBytes"           INTEGER NOT NULL,
  "sharedByUserId"         TEXT NOT NULL,
  "sharedByPractitionerId" TEXT NOT NULL,
  "sharedAt"               TIMESTAMP(3) NOT NULL,
  "revokedAt"              TIMESTAMP(3),
  "revokedByUserId"        TEXT,
  "revokeReason"           "PatientDocumentRevokeReason",
  "idempotencyKey"         TEXT NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatientDocument_noteRevision_check" CHECK ("noteRevision" >= 1),
  CONSTRAINT "PatientDocument_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "PatientDocument_snapshotVersion_check" CHECK ("snapshotVersion" = 1),
  CONSTRAINT "PatientDocument_snapshot_check" CHECK (CASE
      WHEN jsonb_typeof("snapshot") = 'object'
        THEN ("snapshot"->>'v') IS NOT DISTINCT FROM ("snapshotVersion"::text) AND octet_length("snapshot"::text) <= 2000000
      ELSE false END),
  CONSTRAINT "PatientDocument_digests_check" CHECK ("snapshotSha256" ~ '^[0-9a-f]{64}$' AND "pdfSha256" ~ '^[0-9a-f]{64}$'
      AND "sourceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PatientDocument_pdf_check" CHECK (char_length("pdfStorageKey") BETWEEN 1 AND 300
      AND "pdfSizeBytes" BETWEEN 1 AND 10485760),
  CONSTRAINT "PatientDocument_revoke_check" CHECK (COALESCE(
      ("revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revokeReason" IS NULL)
   OR ("revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND "revokeReason" IS NOT NULL), false)),
  CONSTRAINT "PatientDocument_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 100),
  CONSTRAINT "PatientDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PatientDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PatientDocument_patient_tenant_fkey" FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "PatientDocument_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PatientDocument_note_tenant_patient_fkey" FOREIGN KEY ("noteId", "tenantId", "patientId") REFERENCES "ClinicalNote"("id", "tenantId", "patientId") ON DELETE RESTRICT,
  CONSTRAINT "PatientDocument_sharedByPractitionerId_fkey" FOREIGN KEY ("sharedByPractitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "PatientDocument_sharer_tenant_fkey" FOREIGN KEY ("sharedByPractitionerId", "tenantId") REFERENCES "Practitioner"("id", "tenantId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "PatientDocument_tenantId_idempotencyKey_key" ON "PatientDocument"("tenantId", "idempotencyKey");
CREATE INDEX "PatientDocument_tenantId_patientId_sharedAt_idx" ON "PatientDocument"("tenantId", "patientId", "sharedAt" DESC);
CREATE INDEX "PatientDocument_patientId_idx" ON "PatientDocument"("patientId");
CREATE INDEX "PatientDocument_noteId_idx" ON "PatientDocument"("noteId");
CREATE INDEX "PatientDocument_sharedByPractitionerId_idx" ON "PatientDocument"("sharedByPractitionerId");
-- PARCIAL (Prisma no lo expresa; NO se borra si migrate dev lo propone): a lo sumo UN documento vivo por ficha; lo usa también el LATERAL de la timeline.
CREATE UNIQUE INDEX "PatientDocument_noteId_live_key" ON "PatientDocument"("noteId") WHERE "revokedAt" IS NULL;

CREATE FUNCTION patient_document_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'PatientDocument no se borra nunca (se revoca): % rechazado', TG_OP;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PatientDocument %: nace vigente, INSERT rechazado', NEW."id";
    END IF;
    -- Solo de una RAÍZ VIVA del mismo paciente y consultorio. FOR SHARE: una anulación concurrente espera a este INSERT
    -- (o este INSERT a ella y re-evalúa). Nunca queda una anulada con documento vivo.
    PERFORM 1 FROM public."ClinicalNote" n
     WHERE n."id" = NEW."noteId" AND n."tenantId" = NEW."tenantId" AND n."patientId" = NEW."patientId"
       AND n."amendsNoteId" IS NULL AND n."voidedAt" IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PatientDocument: la ficha % no es una raíz vigente, INSERT rechazado', NEW."noteId";
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PatientDocument %: revocado = congelado, UPDATE rechazado', OLD."id";
  END IF;
  IF NEW."revokedAt" IS NULL THEN
    RAISE EXCEPTION 'PatientDocument %: solo se puede revocar, UPDATE rechazado', OLD."id";
  END IF;
  IF (NEW."id", NEW."tenantId", NEW."patientId", NEW."kind", NEW."noteId", NEW."noteRevision", NEW."sourceDigest",
      NEW."title", NEW."occurredAt", NEW."snapshot", NEW."snapshotVersion", NEW."snapshotSha256", NEW."pdfStorageKey",
      NEW."pdfSha256", NEW."pdfSizeBytes", NEW."sharedByUserId", NEW."sharedByPractitionerId", NEW."sharedAt",
      NEW."idempotencyKey", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."patientId", OLD."kind", OLD."noteId", OLD."noteRevision", OLD."sourceDigest",
      OLD."title", OLD."occurredAt", OLD."snapshot", OLD."snapshotVersion", OLD."snapshotSha256", OLD."pdfStorageKey",
      OLD."pdfSha256", OLD."pdfSizeBytes", OLD."sharedByUserId", OLD."sharedByPractitionerId", OLD."sharedAt",
      OLD."idempotencyKey", OLD."createdAt") THEN
    RAISE EXCEPTION 'PatientDocument %: el documento compartido es inalterable, UPDATE rechazado', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PatientDocument_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "PatientDocument"
  FOR EACH ROW EXECUTE FUNCTION patient_document_guard();
CREATE TRIGGER "PatientDocument_no_truncate"
  BEFORE TRUNCATE ON "PatientDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION patient_document_guard();

-- ── clinical_note_guard(): reemplazo línea por línea de M9 ────────────
CREATE OR REPLACE FUNCTION clinical_note_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  content_changed boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ClinicalNote no se borra nunca (se anula con motivo): % rechazado', TG_OP;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ClinicalNote %: anulada = congelada, UPDATE rechazado', OLD."id";
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."amendsNoteId" IS DISTINCT FROM OLD."amendsNoteId"
     OR NEW."authorUserId" IS DISTINCT FROM OLD."authorUserId"
     OR NEW."authorPractitionerId" IS DISTINCT FROM OLD."authorPractitionerId"
     OR NEW."authorName" IS DISTINCT FROM OLD."authorName"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     -- M14 (FC): la matrícula con la que firmó y el origen de una importación son parte de lo firmado (Ley 26.529).
     OR NEW."authorLicense" IS DISTINCT FROM OLD."authorLicense"
     OR NEW."importSource" IS DISTINCT FROM OLD."importSource" THEN
    RAISE EXCEPTION 'ClinicalNote %: columnas de identidad inmutables, UPDATE rechazado', OLD."id";
  END IF;

  -- M14: bodyDoc y diagnoses son contenido. jsonb compara por valor (otro orden de claves no es cambio).
  content_changed := NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
    OR NEW."bodyDoc" IS DISTINCT FROM OLD."bodyDoc"
    OR NEW."diagnoses" IS DISTINCT FROM OLD."diagnoses";

  IF NEW."voidedAt" IS NOT NULL THEN
    -- Anulación (OLD no estaba anulada): no edita contenido ni revisión. El motivo lo valida el CHECK.
    IF content_changed OR NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION 'ClinicalNote %: anular no edita el contenido, UPDATE rechazado', OLD."id";
    END IF;
    -- M14 (FC-D7): anular revoca EN LA BASE lo compartido con el paciente (prod es BYPASSRLS). Los documentos solo
    -- apuntan a raíces. revokedAt = voidedAt: mismo reloj que la anulación.
    UPDATE public."PatientDocument"
       SET "revokedAt" = NEW."voidedAt", "revokedByUserId" = NEW."voidedByUserId", "revokeReason" = 'NOTE_VOIDED'
     WHERE "tenantId" = OLD."tenantId" AND "noteId" = OLD."id" AND "revokedAt" IS NULL;
    RETURN NEW;
  END IF;

  IF NOT content_changed THEN
    IF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION 'ClinicalNote %: la revisión la sube solo el trigger, UPDATE rechazado', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- Edición de contenido. Red de las 24 h (EV2-D17: 24 h + 10 min de gracia; quién puede editar lo decide la app).
  -- `now() AT TIME ZONE 'UTC'`: las columnas son timestamp sin zona escritas en UTC por Prisma; así no depende del
  -- TimeZone de la sesión.
  IF OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '24 hours 10 minutes' THEN
    RAISE EXCEPTION 'ClinicalNote %: pasaron más de 24 h, se enmienda o se anula', OLD."id";
  END IF;

  INSERT INTO public."ClinicalNoteRevision"
    ("id", "tenantId", "noteId", "revision", "kind", "title", "body", "bodyDoc", "diagnoses", "occurredAt", "savedAt", "createdAt")
  VALUES
    (gen_random_uuid()::text, OLD."tenantId", OLD."id", OLD."revision", OLD."kind", OLD."title", OLD."body",
     OLD."bodyDoc", OLD."diagnoses", OLD."occurredAt", OLD."updatedAt", now() AT TIME ZONE 'UTC');

  NEW."revision" := OLD."revision" + 1;
  RETURN NEW;
END;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE "DiagnosisCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiagnosisCode" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DiagnosisCode_read" ON "DiagnosisCode";
CREATE POLICY "DiagnosisCode_read" ON "DiagnosisCode" FOR SELECT USING (true);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['TenantDiagnosis', 'DiagnosisFavorite', 'PatientDocument']
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

-- ── Practitioner y Tenant AL FINAL (Tenant se lee en cada request) ───
ALTER TABLE "Practitioner"
  ADD COLUMN "honorific"           TEXT,
  ADD COLUMN "signatureStorageKey" TEXT,
  ADD COLUMN "signatureUpdatedAt"  TIMESTAMP(3);
ALTER TABLE "Practitioner"
  ADD CONSTRAINT "Practitioner_honorific_check" CHECK ("honorific" IS NULL OR "honorific" IN ('LIC','KLGO','KLGA','DR','DRA')),
  ADD CONSTRAINT "Practitioner_signature_check" CHECK (COALESCE(
      ("signatureStorageKey" IS NULL AND "signatureUpdatedAt" IS NULL)
   OR ("signatureStorageKey" IS NOT NULL AND "signatureUpdatedAt" IS NOT NULL
       AND char_length("signatureStorageKey") BETWEEN 1 AND 300), false));
ALTER TABLE "Tenant"
  ADD COLUMN "logoStorageKey" TEXT,
  ADD COLUMN "logoUpdatedAt"  TIMESTAMP(3);
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_logo_check" CHECK (COALESCE(
      ("logoStorageKey" IS NULL AND "logoUpdatedAt" IS NULL)
   OR ("logoStorageKey" IS NOT NULL AND "logoUpdatedAt" IS NOT NULL AND char_length("logoStorageKey") BETWEEN 1 AND 300), false));

COMMIT;
