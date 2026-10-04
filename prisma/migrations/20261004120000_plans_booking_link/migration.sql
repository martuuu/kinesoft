-- plans_booking_link · Planes P1-S10. EXPAND (ADR-001 ACCEPTED enmendado + ADR-003), firmado por Martin el 03-oct.
-- Por qué: FK turno↔plan (D25), cuota por sesión (I6), disciplina (D10), responsable (D17), archivar (I7),
-- idempotencia por tenant (A2), autorización de la OS con historial (PQ-01 = sí, PD-16), pedidos de cambio del
-- portal sin tocar la ficha (E3) y una cuenta del portal con fichas en N consultorios (PD-14).
-- TABLAS NUEVAS: "ProgramAuthorization" y "PatientChangeRequest", cada una con RLS ENABLE + FORCE + policy
--   "<tabla>_tenant_isolation" (mismo DO-block que agenda_foundations; las verifica `npm run guard:isolation`).
-- EXCEPCIÓN a "todo aditivo", APROBADA POR MARTIN EL 03-OCT: DROP INDEX "Patient_userId_key" (UNIQUE global),
--   reemplazado por "Patient_tenantId_userId_key". Solo RELAJA la unicidad: el código vivo busca por userId con
--   findFirst (callback, accept-action, patients.ts) y lo tolera. El down-script lo recrea solo si no hay repetidos.
-- Fuera de eso: sin DROP, sin SET NOT NULL sobre datos, sin UPDATE sobre "Booking" ni "Patient"
--   (§5.30: no se toca updatedAt = optimistic lock).
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` los propone; migrate dev está prohibido):
--   únicos parciales Session_programId_index_live_key, Booking_session_active_key,
--   ProgramAuthorization_programId_current_key y PatientChangeRequest_patient_pending_key;
--   FKs compuestas Booking_plan_tenant_fkey / Booking_plan_patient_fkey / Booking_session_program_fkey
--   (y las de las tablas nuevas si Prisma no las expresa igual, ver "Prisma"); todos los CHECK; las 2 policies RLS.
-- Precheck BLOQUEANTE (2): duplicados (programId,index) => el único parcial aborta. Se resuelven ANTES con
-- scripts/plans-dedupe-session-index.ts (escrito en ES1; dry-run -> backup -> --apply). Esta migración NO muta datos legacy.
BEGIN;
SET LOCAL lock_timeout = '5s';   -- si "Booking" está tomada, falla rápido (no cuelga la agenda). Ver RUNBOOK P3009.

CREATE TYPE "Discipline" AS ENUM ('KINESIOLOGY','OSTEOPATHY');
CREATE TYPE "ProgramPricingMode" AS ENUM ('PER_SESSION','PACKAGE');

ALTER TABLE "Service" ADD COLUMN "discipline" "Discipline";

ALTER TABLE "TreatmentProgram"
  ADD COLUMN "discipline" "Discipline", ADD COLUMN "practitionerId" TEXT, ADD COLUMN "serviceId" TEXT,
  ADD COLUMN "locationId" TEXT, ADD COLUMN "templateId" TEXT, ADD COLUMN "durationMin" INTEGER,
  ADD COLUMN "schedule" JSONB, ADD COLUMN "pricingMode" "ProgramPricingMode",
  ADD COLUMN "pricePerSessionCents" INTEGER, ADD COLUMN "totalPriceCents" INTEGER, ADD COLUMN "notes" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- default constante: sin rewrite
  ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TreatmentProgram"
  ADD CONSTRAINT "TreatmentProgram_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_serviceId_fkey"  FOREIGN KEY ("serviceId")  REFERENCES "Service"("id")  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE, -- null=principal; SET NULL movería el plan en silencio
  ADD CONSTRAINT "TreatmentProgram_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PlanTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_pricing_check" CHECK (   -- IS NOT DISTINCT FROM, no "=": con modo NULL, "=" da NULL (3VL), el disyunto queda NULL y el CHECK pasaría con precio. Sin modo = sin precio.
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL)),
  ADD CONSTRAINT "TreatmentProgram_price_nonneg_check" CHECK (COALESCE("pricePerSessionCents",0) >= 0 AND COALESCE("totalPriceCents",0) >= 0),
  ADD CONSTRAINT "TreatmentProgram_duration_check" CHECK ("durationMin" IS NULL OR "durationMin" BETWEEN 15 AND 240), -- = zod de turnos (15..240) y BOOKING_LOOKBACK_MIN
  ADD CONSTRAINT "TreatmentProgram_schedule_check" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object');
CREATE UNIQUE INDEX "TreatmentProgram_tenantId_idempotencyKey_key" ON "TreatmentProgram"("tenantId","idempotencyKey"); -- NO global (fuga A2)
CREATE UNIQUE INDEX "TreatmentProgram_id_tenantId_key"  ON "TreatmentProgram"("id","tenantId");   -- destino FK compuesta
CREATE UNIQUE INDEX "TreatmentProgram_id_patientId_key" ON "TreatmentProgram"("id","patientId");  -- destino FK compuesta
CREATE INDEX "TreatmentProgram_tenantId_discipline_status_idx" ON "TreatmentProgram"("tenantId","discipline","status");
CREATE INDEX "TreatmentProgram_practitionerId_idx" ON "TreatmentProgram"("practitionerId");
CREATE INDEX "TreatmentProgram_serviceId_idx"      ON "TreatmentProgram"("serviceId");
CREATE INDEX "TreatmentProgram_locationId_idx"     ON "TreatmentProgram"("locationId");
CREATE INDEX "TreatmentProgram_templateId_idx"     ON "TreatmentProgram"("templateId");

-- Autorización de la OS (PQ-01 = sí, PD-16, PQ-15). Tabla con historial: renovar = supersededAt + INSERT.
-- Fechas de calendario en DATE (vence 30/11 = el 30/11 AR entero; se leen con dbDateToDayKey).
CREATE TABLE "ProgramAuthorization" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "programId" TEXT NOT NULL,
  "code" TEXT, "authorizedSessions" INTEGER, "startsOn" DATE NOT NULL, "expiresOn" DATE,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "ProgramAuthorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgramAuthorization_sessions_check" CHECK ("authorizedSessions" IS NULL OR "authorizedSessions" BETWEEN 1 AND 200),
  CONSTRAINT "ProgramAuthorization_code_check" CHECK ("code" IS NULL OR char_length("code") BETWEEN 1 AND 64),
  CONSTRAINT "ProgramAuthorization_dates_check" CHECK ("expiresOn" IS NULL OR "expiresOn" >= "startsOn"),
  CONSTRAINT "ProgramAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProgramAuthorization_program_tenant_fkey" FOREIGN KEY ("programId","tenantId") REFERENCES "TreatmentProgram"("id","tenantId") ON DELETE RESTRICT);
-- PARCIAL (no lo expresa Prisma; NO borrar): PQ-15 = 1 vigente por plan. "Órdenes múltiples" (C1) = relajar este índice, sin migrar datos.
CREATE UNIQUE INDEX "ProgramAuthorization_programId_current_key" ON "ProgramAuthorization"("programId") WHERE "supersededAt" IS NULL;
CREATE INDEX "ProgramAuthorization_tenantId_expiresOn_idx" ON "ProgramAuthorization"("tenantId","expiresOn");

ALTER TABLE "Session"
  ADD COLUMN "title" TEXT, ADD COLUMN "priceCents" INTEGER, ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "Session_priceCents_check" CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
CREATE UNIQUE INDEX "Session_id_programId_key" ON "Session"("id","programId");   -- destino FK compuesta
-- PARCIAL (no lo expresa Prisma; NO borrar). Index estable: archivar NO renumera.
CREATE UNIQUE INDEX "Session_programId_index_live_key" ON "Session"("programId","index") WHERE "archivedAt" IS NULL;

ALTER TABLE "Booking"
  ADD COLUMN "programId" TEXT, ADD COLUMN "sessionId" TEXT,
  ADD COLUMN "pricedByPlan" BOOLEAN NOT NULL DEFAULT false;   -- default constante: sin rewrite
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_programId_fkey" FOREIGN KEY ("programId") REFERENCES "TreatmentProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- FKs COMPUESTAS (drift aceptado): las FK saltean RLS y prod es BYPASSRLS => I1/I4 garantizados en la base
  ADD CONSTRAINT "Booking_plan_tenant_fkey"     FOREIGN KEY ("programId","tenantId")  REFERENCES "TreatmentProgram"("id","tenantId")  ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_plan_patient_fkey"    FOREIGN KEY ("programId","patientId") REFERENCES "TreatmentProgram"("id","patientId") ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_session_program_fkey" FOREIGN KEY ("sessionId","programId") REFERENCES "Session"("id","programId")           ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_plan_link_check"      CHECK (("programId" IS NULL) = ("sessionId" IS NULL)),
  ADD CONSTRAINT "Booking_plan_patient_check"   CHECK ("programId" IS NULL OR "patientId" IS NOT NULL),   -- un guest no es turno de plan
  ADD CONSTRAINT "Booking_priced_by_plan_check" CHECK (NOT "pricedByPlan" OR ("programId" IS NOT NULL AND "copagoCents" IS NOT NULL));
CREATE INDEX "Booking_tenantId_programId_idx" ON "Booking"("tenantId","programId");
CREATE INDEX "Booking_sessionId_idx" ON "Booking"("sessionId");   -- chequeo RESTRICT y "sin turno" derivado
-- I2 + D1 · PARCIAL (NO borrar). Distinto del índice paciente-instante (ese excluye solo CANCELLED y NO se toca).
CREATE UNIQUE INDEX "Booking_session_active_key" ON "Booking"("sessionId")
  WHERE "sessionId" IS NOT NULL AND "status" NOT IN ('CANCELLED','NO_SHOW');

ALTER TABLE "PlanTemplate"
  ADD COLUMN "discipline" "Discipline", ADD COLUMN "serviceId" TEXT, ADD COLUMN "durationMin" INTEGER,
  ADD COLUMN "schedule" JSONB, ADD COLUMN "pricingMode" "ProgramPricingMode", ADD COLUMN "pricePerSessionCents" INTEGER,
  ADD COLUMN "totalPriceCents" INTEGER, ADD COLUMN "notes" TEXT, ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PlanTemplate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE, -- SET NULL: deleteTenantDeep borra Service antes del cascade
  ADD CONSTRAINT "PlanTemplate_pricing_check" CHECK (   -- IS NOT DISTINCT FROM, no "=": con modo NULL, "=" da NULL (3VL), el disyunto queda NULL y el CHECK pasaría con precio. Sin modo = sin precio.
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL)),
  ADD CONSTRAINT "PlanTemplate_price_nonneg_check" CHECK (COALESCE("pricePerSessionCents",0) >= 0 AND COALESCE("totalPriceCents",0) >= 0),
  ADD CONSTRAINT "PlanTemplate_duration_check" CHECK ("durationMin" IS NULL OR "durationMin" BETWEEN 15 AND 240),
  ADD CONSTRAINT "PlanTemplate_schedule_check" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object');
CREATE INDEX "PlanTemplate_serviceId_idx" ON "PlanTemplate"("serviceId");
CREATE INDEX "PlanTemplate_tenantId_discipline_idx" ON "PlanTemplate"("tenantId","discipline");

ALTER TABLE "EvaScore" ADD COLUMN "note" TEXT, ADD COLUMN "sessionId" TEXT,
  ADD CONSTRAINT "EvaScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EvaScore_sessionId_idx" ON "EvaScore"("sessionId");   -- reemplaza el string ambiguo; las escrituras nuevas llenan ambos

-- Identidad del portal (PD-14) y pedidos de cambio "Mis datos" (E3).
CREATE UNIQUE INDEX "Patient_id_tenantId_key" ON "Patient"("id","tenantId");   -- destino de FK compuesta; el CREATE toma SHARE (bloquea escrituras, no lecturas), pero el DROP INDEX de abajo toma ACCESS EXCLUSIVE sobre Patient (bloquea también lecturas) hasta el COMMIT de M1
-- EXCEPCIÓN aprobada por Martin (03-oct): relaja la unicidad global de userId a una por consultorio. Ver cabecera.
CREATE UNIQUE INDEX "Patient_tenantId_userId_key" ON "Patient"("tenantId","userId");
DROP INDEX "Patient_userId_key";

CREATE TYPE "PatientChangeRequestStatus" AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TABLE "PatientChangeRequest" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "status" "PatientChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedByUserId" TEXT, "decidedById" TEXT, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientChangeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatientChangeRequest_changes_check" CHECK (jsonb_typeof("changes")='object' AND octet_length("changes"::text) <= 4096),
  CONSTRAINT "PatientChangeRequest_decided_check" CHECK (("status"='PENDING') = ("decidedAt" IS NULL)),
  CONSTRAINT "PatientChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PatientChangeRequest_patient_tenant_fkey" FOREIGN KEY ("patientId","tenantId") REFERENCES "Patient"("id","tenantId") ON DELETE CASCADE);
-- PARCIAL (no lo expresa Prisma; NO borrar): 1 pedido pendiente por paciente.
CREATE UNIQUE INDEX "PatientChangeRequest_patient_pending_key" ON "PatientChangeRequest"("patientId") WHERE "status"='PENDING';
CREATE INDEX "PatientChangeRequest_tenantId_status_idx" ON "PatientChangeRequest"("tenantId","status");

-- ── RLS: las 2 tablas nuevas con tenantId ───────────────────────────
-- Mismo loop y mismo nombre de policy que 20260725120000_rls_policies y agenda_foundations.
-- app_current_tenant_id() devuelve NULL sin GUC → ninguna fila visible y ningún INSERT pasa el WITH CHECK
-- fuera de runWithRls. Las FKs compuestas son la red bajo BYPASSRLS (prod): el tenantId de la fila nueva es
-- el del plan o el de la ficha.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProgramAuthorization', 'PatientChangeRequest']
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

-- >>> BACKFILL plans_booking_link BEGIN
-- Idempotente y re-ejecutable. El test lee este bloque literal (mismo patrón que agenda_foundations).
-- Guarda: con row_security=off, un rol SIN BYPASSRLS falla fuerte (FORCE RLS en TreatmentProgram) en vez de backfillear 0 filas.
SET LOCAL row_security = off;
UPDATE "TreatmentProgram" p SET "practitionerId" = f."practitionerId"
FROM (SELECT DISTINCT ON (s."programId") s."programId", s."practitionerId" FROM "Session" s ORDER BY s."programId", s."index", s."id") f
WHERE f."programId" = p."id" AND p."practitionerId" IS NULL
  AND EXISTS (SELECT 1 FROM "Practitioner" pr WHERE pr."id" = f."practitionerId" AND pr."tenantId" = p."tenantId")
  AND (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR p."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')));
-- Catálogo global (D21): 2 tags DISCIPLINE (staging = prod sin seeds). Precheck (11): slug libre o ya DISCIPLINE.
INSERT INTO "Tag" ("id","slug","label","kind") VALUES
  ('tag_discipline_kinesiologia','kinesiologia','Kinesiología','DISCIPLINE'),
  ('tag_discipline_osteopatia','osteopatia','Osteopatía','DISCIPLINE')
ON CONFLICT ("slug") DO NOTHING;
-- <<< BACKFILL plans_booking_link END
COMMIT;
