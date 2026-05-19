-- KineSoft — Row-Level Security policies.
--
-- Apply AFTER `prisma migrate dev`. Idempotent — uses
-- `CREATE POLICY IF NOT EXISTS`-style guards.
--
-- The application sets a GUC per transaction:
--
--     SET LOCAL app.current_tenant_id = '<tenant-uuid>';
--
-- Policies compare against that GUC. The Prisma client extension in
-- `lib/db.ts` injects `tenantId` filters defensively at the ORM layer; RLS
-- is the second-line guard so a misconfigured query cannot leak data.
--
-- Service-role code (webhooks, background jobs, seed) connects as a role
-- that has BYPASSRLS and operates on the raw rows.

BEGIN;

-- ── Helper -------------------------------------------------------------
-- Returns the active tenant id from the GUC. NULL when unset, which causes
-- every policy to evaluate FALSE → no rows visible until the app sets it.
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')
$$;

-- ── Enable RLS on tenant-scoped tables ───────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Tenant',
    'Membership',
    'Practitioner',
    'Patient',
    'PatientTenantLink',
    'Coverage',
    'EmergencyContact',
    'Service',
    'Booking',
    'Payment',
    'TreatmentProgram',
    'Session',
    'SessionExercise',
    'EvaScore',
    'ClinicalCase',
    'Diagnosis',
    'AuditEvent'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── Tenant — read your own row, no one creates tenants via RLS ──
DROP POLICY IF EXISTS tenant_self_read ON "Tenant";
CREATE POLICY tenant_self_read ON "Tenant"
  FOR SELECT USING (id = app_current_tenant_id());

-- ── Direct tenant-scoped tables ────────────────────────────────────
-- These all carry `tenantId` directly.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Membership',
    'Practitioner',
    'Patient',
    'PatientTenantLink',
    'Service',
    'Booking',
    'TreatmentProgram',
    'ClinicalCase',
    'AuditEvent'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ── Indirect tenant-scoped tables ──────────────────────────────────
-- These don't have `tenantId` but reach it through a relation. We use
-- subqueries so the planner can use the existing FK index.

DROP POLICY IF EXISTS coverage_tenant_isolation ON "Coverage";
CREATE POLICY coverage_tenant_isolation ON "Coverage"
  USING (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "Coverage"."patientId" AND p."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "Coverage"."patientId" AND p."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS emergency_tenant_isolation ON "EmergencyContact";
CREATE POLICY emergency_tenant_isolation ON "EmergencyContact"
  USING (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "EmergencyContact"."patientId" AND p."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "EmergencyContact"."patientId" AND p."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS payment_tenant_isolation ON "Payment";
CREATE POLICY payment_tenant_isolation ON "Payment"
  USING (EXISTS (
    SELECT 1 FROM "Booking" b
    WHERE b.id = "Payment"."bookingId" AND b."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Booking" b
    WHERE b.id = "Payment"."bookingId" AND b."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS session_tenant_isolation ON "Session";
CREATE POLICY session_tenant_isolation ON "Session"
  USING (EXISTS (
    SELECT 1 FROM "TreatmentProgram" p
    WHERE p.id = "Session"."programId" AND p."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "TreatmentProgram" p
    WHERE p.id = "Session"."programId" AND p."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS session_exercise_tenant_isolation ON "SessionExercise";
CREATE POLICY session_exercise_tenant_isolation ON "SessionExercise"
  USING (EXISTS (
    SELECT 1
    FROM "Session" s
    JOIN "TreatmentProgram" p ON p.id = s."programId"
    WHERE s.id = "SessionExercise"."sessionId" AND p."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "Session" s
    JOIN "TreatmentProgram" p ON p.id = s."programId"
    WHERE s.id = "SessionExercise"."sessionId" AND p."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS eva_tenant_isolation ON "EvaScore";
CREATE POLICY eva_tenant_isolation ON "EvaScore"
  USING (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "EvaScore"."patientId" AND p."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Patient" p
    WHERE p.id = "EvaScore"."patientId" AND p."tenantId" = app_current_tenant_id()
  ));

DROP POLICY IF EXISTS diagnosis_tenant_isolation ON "Diagnosis";
CREATE POLICY diagnosis_tenant_isolation ON "Diagnosis"
  USING (EXISTS (
    SELECT 1 FROM "ClinicalCase" c
    WHERE c.id = "Diagnosis"."caseId" AND c."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "ClinicalCase" c
    WHERE c.id = "Diagnosis"."caseId" AND c."tenantId" = app_current_tenant_id()
  ));

-- ── Global catalog tables stay readable to everyone ────────────────
-- (No RLS — `Tag`, `Condition`, `Exercise`, `AnatomicalRegion`, etc.)

COMMIT;
