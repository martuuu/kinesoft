-- KineSoft — Row-Level Security policies (Ola B2, RLS wholesale).
--
-- Supersedes the old loose `prisma/migrations/policies.sql`. This is now a
-- REAL timestamped migration so `prisma migrate deploy` applies it on every
-- deploy and records it in `_prisma_migrations` (no more manual psql step).
--
-- The application sets a per-transaction GUC in `lib/rls.ts#runWithRls`:
--     SELECT set_config('app.current_tenant_id', '<tenant-uuid>', true);
-- Policies compare against that GUC via `app_current_tenant_id()`.
--
-- ENABLE + FORCE ROW LEVEL SECURITY is a NO-OP while the app connects as a
-- BYPASSRLS/superuser role, so landing this migration changes nothing until
-- the connection role is switched to `kinesoft_app` (the enforcement flip).
--
-- Service-role code (webhooks, public booking, audit-from-jobs, signup,
-- OAuth callback, portal) connects on the BYPASSRLS `prismaService` channel
-- and operates on raw rows without the GUC.
--
-- EXCLUDED from RLS by design (userId-scoped, not tenant-owned; the app's
-- `where: { userId }` is the real boundary): UserPreferences, Favorite.
-- See scripts/guard-tenant-isolation.mjs allowlist.

BEGIN;

-- ── Helper -------------------------------------------------------------
-- Returns the active tenant id from the GUC. NULL when unset, which causes
-- every policy to evaluate FALSE → no rows visible until the app sets it.
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')
$$;

-- ── Enable + FORCE RLS on every tenant-scoped table ──────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- original 17
    'Tenant', 'Membership', 'Practitioner', 'Patient', 'PatientTenantLink',
    'Coverage', 'EmergencyContact', 'Service', 'Booking', 'Payment',
    'TreatmentProgram', 'Session', 'SessionExercise', 'EvaScore',
    'ClinicalCase', 'Diagnosis', 'AuditEvent',
    -- B2: 7 new direct-tenant tables
    'PatientShare', 'PatientFile', 'Insurer', 'Invitation', 'PlanTemplate',
    'Notification', 'DismissedReminder',
    -- B2: 2 split-policy catalog tables (global rows + per-tenant overrides)
    'Condition', 'Exercise'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── Tenant — read AND update your own row ────────────────────────────
-- Read is needed for plan/settings lookups; UPDATE is needed by
-- tenant-settings.ts (business hours, sharedPatientView, basics). INSERT
-- and DELETE of tenants stay off-limits to the app role (they happen on
-- the service channel via signUpPractitioner).
DROP POLICY IF EXISTS tenant_self_read ON "Tenant";
CREATE POLICY tenant_self_read ON "Tenant"
  FOR SELECT USING (id = app_current_tenant_id());

DROP POLICY IF EXISTS tenant_self_update ON "Tenant";
CREATE POLICY tenant_self_update ON "Tenant"
  FOR UPDATE USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

-- ── Direct tenant-scoped tables (carry `tenantId`) ───────────────────
-- FOR ALL: SELECT / INSERT / UPDATE / DELETE all gated on tenantId = GUC.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Membership', 'Practitioner', 'Patient', 'PatientTenantLink', 'Service',
    'Booking', 'TreatmentProgram', 'ClinicalCase', 'AuditEvent',
    -- B2 new
    'PatientShare', 'PatientFile', 'Insurer', 'Invitation', 'PlanTemplate',
    'Notification', 'DismissedReminder'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ── Indirect tenant-scoped tables (reach tenant via a relation) ──────
-- Subqueries so the planner can use the existing FK index.

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

-- ── Split-policy catalog tables (Condition, Exercise) ────────────────
-- `tenantId IS NULL` = seeded global catalog (visible to every tenant);
-- `tenantId = <uuid>` = a tenant's private override. Read = global OR own;
-- write = own only (a tenant can never mutate the global catalog). The
-- plan-tier gating (FREE=isBasic vs PRO=full catalog) stays in the app
-- layer (lib/plan-gating.ts) — this only governs tenant isolation.

DROP POLICY IF EXISTS condition_read ON "Condition";
CREATE POLICY condition_read ON "Condition"
  FOR SELECT USING ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id());
DROP POLICY IF EXISTS condition_write ON "Condition";
CREATE POLICY condition_write ON "Condition"
  FOR ALL USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

DROP POLICY IF EXISTS exercise_read ON "Exercise";
CREATE POLICY exercise_read ON "Exercise"
  FOR SELECT USING ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id());
DROP POLICY IF EXISTS exercise_write ON "Exercise";
CREATE POLICY exercise_write ON "Exercise"
  FOR ALL USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- ── Left WITHOUT RLS (intentional) ───────────────────────────────────
--   • UserPreferences, Favorite — userId-scoped, not tenant-owned.
--   • Global catalog: Tag, AnatomicalRegion — read-only shared reference.
-- Enforced by scripts/guard-tenant-isolation.mjs (allowlist).

COMMIT;
