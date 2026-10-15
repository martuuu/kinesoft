-- M9 · clinical_notes (bloque EV2 del §20, ola EV2-0, va SOLA; 17-oct-2026). Plan §20.6 (modelo y reglas), §20.11
--   (EV2-D1..D12), §20.12; contratos del brief EV2 (wip-20/brief-ev2.md §2).
-- Por qué: decisión 13 de Martin (15-oct): «evoluciones por consulta para todas las verticales; 24 h para editar,
--   después enmienda o anulación con motivo; nunca se borra». Hasta hoy la única «evolución» era la meta de una Session
--   de kine (notas/EVA/RPE) y un consultorio General no tenía HC por consulta. Ley 26.529 (HC: integridad, inalterabilidad,
--   conservación): la inalterabilidad va EN LA BASE, no solo en la app, porque prod conecta con BYPASSRLS.
--   • enum "ClinicalNoteKind" (EVOLUTION | FIRST_VISIT | DISCHARGE, EV2-D8).
--   • "ClinicalNote": una nota por consulta. Turno opcional (una nota sin turno también es HC). `amendsNoteId` = enmienda
--     (nota nueva enlazada a la raíz, EV2-D1/D14). Autor congelado: usuario + profesional + nombre (el nombre NO se
--     recalcula si el profesional se lo cambia: es lo que firmó). `revision` la sube SOLO el trigger.
--     Anulación con motivo (EV2-D15): voidedAt + voidedByUserId + voidReason, todo o nada (CHECK).
--   • "ClinicalNoteRevision": la versión ANTERIOR de cada edición de contenido (solo inserción; la escribe solo el
--     trigger de ClinicalNote: un INSERT directo se rechaza por pg_trigger_depth()).
--   • Triggers (BYPASSRLS no saltea triggers: rigen también para el owner; SQLSTATE P0001, distinto del 42501 de RLS):
--       ClinicalNote_guard (BEFORE UPDATE OR DELETE, por fila) + ClinicalNote_no_truncate (BEFORE TRUNCATE):
--         – DELETE y TRUNCATE rechazados SIEMPRE;
--         – columnas de identidad inmutables (id, tenantId, patientId, bookingId, amendsNoteId, autor, idempotencyKey,
--           createdAt);
--         – anulada ⇒ congelada (cualquier UPDATE posterior se rechaza; no hay «des-anular»);
--         – anular no puede tocar el contenido ni la revisión;
--         – cambio de contenido (kind, title, body, occurredAt): solo si createdAt > ahora − 24 h 10 min (EV2-D17), copia
--           la versión anterior a ClinicalNoteRevision y pone NEW.revision = OLD.revision + 1;
--         – sin cambio de contenido, `revision` no se puede tocar.
--       ClinicalNoteRevision_append_only / _no_truncate con kinesoft_append_only() (de M8, no se redefine) y
--       ClinicalNoteRevision_insert_guard (solo desde el trigger).
--   • Destinos de FK compuesta NUEVOS: "Booking_id_tenantId_patientId_key" y "Practitioner_id_tenantId_key". Las FK
--     saltean RLS y prod es BYPASSRLS: las COMPUESTAS son la red de «mismo consultorio» y «mismo paciente»:
--       – (bookingId, tenantId, patientId) → Booking: la nota de un turno es del paciente de ESE turno y de este
--         consultorio. ON UPDATE NO ACTION: cambiar el paciente de un turno con evolución da 23503 (la app lo rechaza
--         antes con mensaje, EV2-D21). Un turno guest (patientId NULL) no matchea: no admite evolución.
--       – (patientId, tenantId) → Patient (destino Patient_id_tenantId_key de M1).
--       – (authorPractitionerId, tenantId) → Practitioner: el autor es profesional de ESTE consultorio.
--       – (amendsNoteId, tenantId, patientId) → ClinicalNote: la enmienda es del mismo paciente y consultorio.
--       – (noteId, tenantId) → ClinicalNote para la revisión.
--     Todas RESTRICT: nada clínico se borra en cascada. Consecuencias buscadas: un turno con evolución no se borra
--     (deleteBooking lo rechaza antes con «cancelalo», EV2-D23); un paciente, un profesional o un consultorio con
--     evoluciones no se borran en duro (la baja es lógica: archivedAt / disabledAt / status CLOSED).
--   • Único PARCIAL "ClinicalNote_bookingId_live_key": a lo sumo UNA raíz viva por turno (EV2-D2). Una anulada libera
--     el turno; las enmiendas (amendsNoteId no nulo) no cuentan.
--   • Único (tenantId, idempotencyKey): el doble envío del mismo modal no duplica (la app hace replay).
-- RLS: las DOS tablas tienen tenantId → ENABLE + FORCE + "<T>_tenant_isolation" (mismo DO-block que rooms/M4 y
--   agenda_foundations; lo verifica `npm run guard:isolation`). Sin GRANT (DEFAULT PRIVILEGES de prisma/roles.*.sql;
--   anon/authenticated siguen sin nada desde M2, guard 3c).
-- ADITIVA (expand): un CREATE TYPE, dos tablas nuevas, dos CREATE UNIQUE INDEX sobre tablas existentes (sobre `id`, que
--   ya es PK: no pueden fallar por datos), funciones y triggers sobre las tablas nuevas. Sin ALTER de columnas existentes,
--   sin backfill, sin tocar `updatedAt` de nadie. Compatible con el código anterior: no lee ni escribe nada nuevo, y
--   mientras no haya evoluciones ningún RESTRICT nuevo puede dispararse → se puede aplicar ANTES del deploy de EV2.
-- Requiere PostgreSQL ≥ 13 (gen_random_uuid() nativo en pg_catalog). Precheck `SELECT version()` en el RUNBOOK.
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` / `migrate diff` los propone; migrate dev
--   está prohibido en este repo):
--   • único PARCIAL ClinicalNote_bookingId_live_key;
--   • FKs compuestas ClinicalNote_patient_tenant_fkey, ClinicalNote_booking_tenant_patient_fkey,
--     ClinicalNote_author_tenant_fkey, ClinicalNote_amends_tenant_patient_fkey, ClinicalNoteRevision_note_tenant_fkey;
--   • CHECKs ClinicalNote_{body,title,authorName,revision,void,amends_self,idempotencyKey}_check,
--     ClinicalNoteRevision_revision_check;
--   • funciones clinical_note_guard(), clinical_note_revision_insert_guard() y sus triggers (y los de revisión con
--     kinesoft_append_only());
--   • policies ClinicalNote_tenant_isolation, ClinicalNoteRevision_tenant_isolation.
-- Locks: los CREATE UNIQUE INDEX sobre "Booking" y "Practitioner" toman SHARE (frenan escrituras de turnos/profesionales
--   mientras se construyen: con los volúmenes de prod, < 1 s); los ADD CONSTRAINT de FKs hacia Booking/Practitioner/
--   Patient/Tenant toman SHARE ROW EXCLUSIVE hasta el COMMIT. No se usa CONCURRENTLY (no corre dentro de una tx y la
--   migración va en una). lock_timeout: si la agenda tiene tomada "Booking", falla rápido en vez de colgarla (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "ClinicalNoteKind" AS ENUM ('EVOLUTION', 'FIRST_VISIT', 'DISCHARGE');

-- ── Destinos de FK compuesta (tablas existentes) ─────────────────────
CREATE UNIQUE INDEX "Booking_id_tenantId_patientId_key" ON "Booking"("id", "tenantId", "patientId");
CREATE UNIQUE INDEX "Practitioner_id_tenantId_key" ON "Practitioner"("id", "tenantId");

-- ── ClinicalNote ─────────────────────────────────────────────────────
CREATE TABLE "ClinicalNote" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "patientId"            TEXT NOT NULL,
  "bookingId"            TEXT,
  "amendsNoteId"         TEXT,
  "kind"                 "ClinicalNoteKind" NOT NULL DEFAULT 'EVOLUTION',
  "title"                TEXT,
  "body"                 TEXT NOT NULL,
  "occurredAt"           TIMESTAMP(3) NOT NULL,
  "authorUserId"         TEXT NOT NULL,
  "authorPractitionerId" TEXT NOT NULL,
  "authorName"           TEXT NOT NULL,
  "revision"             INTEGER NOT NULL DEFAULT 1,
  "voidedAt"             TIMESTAMP(3),
  "voidedByUserId"       TEXT,
  "voidReason"           TEXT,
  "idempotencyKey"       TEXT NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClinicalNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClinicalNote_body_check" CHECK (char_length("body") BETWEEN 1 AND 20000 AND btrim("body") <> ''),
  CONSTRAINT "ClinicalNote_title_check" CHECK ("title" IS NULL OR char_length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "ClinicalNote_authorName_check" CHECK (char_length(btrim("authorName")) BETWEEN 1 AND 200),
  CONSTRAINT "ClinicalNote_revision_check" CHECK ("revision" >= 1),
  -- Anulación: todo o nada; motivo 3..500 (EV2-D15).
  CONSTRAINT "ClinicalNote_void_check" CHECK (
    ("voidedAt" IS NULL AND "voidedByUserId" IS NULL AND "voidReason" IS NULL)
    OR ("voidedAt" IS NOT NULL AND "voidedByUserId" IS NOT NULL AND "voidReason" IS NOT NULL
        AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)),
  CONSTRAINT "ClinicalNote_amends_self_check" CHECK ("amendsNoteId" IS NULL OR "amendsNoteId" <> "id"),
  CONSTRAINT "ClinicalNote_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 100),
  -- Simples (las que Prisma conoce) + compuestas (drift aceptado). Todas RESTRICT / NO ACTION en UPDATE.
  CONSTRAINT "ClinicalNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNote_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNote_patient_tenant_fkey" FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "ClinicalNote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNote_booking_tenant_patient_fkey" FOREIGN KEY ("bookingId", "tenantId", "patientId") REFERENCES "Booking"("id", "tenantId", "patientId") ON DELETE RESTRICT,
  CONSTRAINT "ClinicalNote_authorPractitionerId_fkey" FOREIGN KEY ("authorPractitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNote_author_tenant_fkey" FOREIGN KEY ("authorPractitionerId", "tenantId") REFERENCES "Practitioner"("id", "tenantId") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "ClinicalNote_id_tenantId_key"            ON "ClinicalNote"("id", "tenantId");               -- destino FK de la revisión
CREATE UNIQUE INDEX "ClinicalNote_id_tenantId_patientId_key"  ON "ClinicalNote"("id", "tenantId", "patientId");  -- destino FK de la enmienda
CREATE UNIQUE INDEX "ClinicalNote_tenantId_idempotencyKey_key" ON "ClinicalNote"("tenantId", "idempotencyKey");
-- Línea de tiempo del perfil: keyset (occurredAt DESC, id DESC) por paciente.
CREATE INDEX "ClinicalNote_tenantId_patientId_occurredAt_id_idx" ON "ClinicalNote"("tenantId", "patientId", "occurredAt" DESC, "id" DESC);
-- Chequeo del RESTRICT al borrar un turno, «tiene evolución» del drawer/Seguimiento (EXISTS en el predicado untouched).
CREATE INDEX "ClinicalNote_bookingId_idx"            ON "ClinicalNote"("bookingId");
CREATE INDEX "ClinicalNote_amendsNoteId_idx"         ON "ClinicalNote"("amendsNoteId");
CREATE INDEX "ClinicalNote_authorPractitionerId_idx" ON "ClinicalNote"("authorPractitionerId");
-- PARCIAL (no lo expresa Prisma; NO borrar): a lo sumo una raíz viva por turno (EV2-D2).
CREATE UNIQUE INDEX "ClinicalNote_bookingId_live_key" ON "ClinicalNote"("bookingId")
  WHERE "bookingId" IS NOT NULL AND "amendsNoteId" IS NULL AND "voidedAt" IS NULL;

ALTER TABLE "ClinicalNote"
  ADD CONSTRAINT "ClinicalNote_amendsNoteId_fkey" FOREIGN KEY ("amendsNoteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "ClinicalNote_amends_tenant_patient_fkey" FOREIGN KEY ("amendsNoteId", "tenantId", "patientId") REFERENCES "ClinicalNote"("id", "tenantId", "patientId") ON DELETE RESTRICT;

-- ── ClinicalNoteRevision (solo inserción, la escribe el trigger) ─────
CREATE TABLE "ClinicalNoteRevision" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "noteId"     TEXT NOT NULL,
  -- Número de la versión GUARDADA acá (la anterior a la edición).
  "revision"   INTEGER NOT NULL,
  "kind"       "ClinicalNoteKind" NOT NULL,
  "title"      TEXT,
  "body"       TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  -- Cuándo se había guardado esa versión (OLD.updatedAt).
  "savedAt"    TIMESTAMP(3) NOT NULL,
  -- Cuándo fue reemplazada (momento de la edición, UTC).
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClinicalNoteRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClinicalNoteRevision_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "ClinicalNoteRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNoteRevision_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ClinicalNoteRevision_note_tenant_fkey" FOREIGN KEY ("noteId", "tenantId") REFERENCES "ClinicalNote"("id", "tenantId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ClinicalNoteRevision_noteId_revision_key" ON "ClinicalNoteRevision"("noteId", "revision");

-- ── Triggers ─────────────────────────────────────────────────────────
-- search_path fijo: la función no depende del de la sesión; gen_random_uuid() y now() están en pg_catalog (PG ≥ 13).
CREATE FUNCTION clinical_note_guard() RETURNS trigger
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
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ClinicalNote %: columnas de identidad inmutables, UPDATE rechazado', OLD."id";
  END IF;

  content_changed := NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt";

  IF NEW."voidedAt" IS NOT NULL THEN
    -- Anulación (OLD no estaba anulada): no edita contenido ni revisión. El motivo lo valida el CHECK.
    IF content_changed OR NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION 'ClinicalNote %: anular no edita el contenido, UPDATE rechazado', OLD."id";
    END IF;
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
    ("id", "tenantId", "noteId", "revision", "kind", "title", "body", "occurredAt", "savedAt", "createdAt")
  VALUES
    (gen_random_uuid()::text, OLD."tenantId", OLD."id", OLD."revision", OLD."kind", OLD."title", OLD."body",
     OLD."occurredAt", OLD."updatedAt", now() AT TIME ZONE 'UTC');

  NEW."revision" := OLD."revision" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ClinicalNote_guard"
  BEFORE UPDATE OR DELETE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_guard();

CREATE TRIGGER "ClinicalNote_no_truncate"
  BEFORE TRUNCATE ON "ClinicalNote"
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_note_guard();

-- La revisión solo nace desde clinical_note_guard(): ahí pg_trigger_depth() = 2; un INSERT directo (app u owner) = 1.
CREATE FUNCTION clinical_note_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ClinicalNoteRevision la escribe solo el trigger de ClinicalNote: INSERT directo rechazado';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ClinicalNoteRevision_insert_guard"
  BEFORE INSERT ON "ClinicalNoteRevision"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_revision_insert_guard();

CREATE TRIGGER "ClinicalNoteRevision_append_only"
  BEFORE UPDATE OR DELETE ON "ClinicalNoteRevision"
  FOR EACH ROW EXECUTE FUNCTION kinesoft_append_only();

CREATE TRIGGER "ClinicalNoteRevision_no_truncate"
  BEFORE TRUNCATE ON "ClinicalNoteRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION kinesoft_append_only();

-- ── RLS: las dos tablas tienen tenantId ──────────────────────────────
-- Mismo loop y mismo nombre de policy que rooms (M4), agenda_foundations y M1. app_current_tenant_id() devuelve NULL sin
-- GUC → ninguna fila visible y ningún INSERT pasa el WITH CHECK fuera de runWithRls. El INSERT de la revisión que hace
-- el trigger corre con el rol y el GUC de quien edita: su tenantId = OLD.tenantId = el del GUC → pasa el WITH CHECK.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ClinicalNote', 'ClinicalNoteRevision']
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

COMMIT;
