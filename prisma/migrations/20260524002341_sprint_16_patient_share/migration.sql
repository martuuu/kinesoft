-- CreateTable
CREATE TABLE "PatientShare" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "sharedById" TEXT,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientShare_tenantId_practitionerId_idx" ON "PatientShare"("tenantId", "practitionerId");

-- CreateIndex
CREATE INDEX "PatientShare_patientId_idx" ON "PatientShare"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientShare_patientId_practitionerId_key" ON "PatientShare"("patientId", "practitionerId");

-- AddForeignKey
ALTER TABLE "PatientShare" ADD CONSTRAINT "PatientShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientShare" ADD CONSTRAINT "PatientShare_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientShare" ADD CONSTRAINT "PatientShare_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill: every patient should now have an explicit owner.
--
--   1. Patients with assignedPractitionerId = NULL ("consultorio común"
--      legacy bucket) get assigned to the oldest Practitioner whose
--      Membership.role = OWNER for that tenant. If the tenant has no
--      OWNER (shouldn't happen), fall back to the oldest practitioner.
--
--   2. If the tenant has sharedPatientView = true (the old "everyone
--      sees everything" mode), we materialise PatientShare rows so the
--      practitioners who used to see this patient still can — preserves
--      the prior runtime behaviour even when an admin later flips the
--      switch off.
-- ─────────────────────────────────────────────────────────────────────

-- Step 1: assign NULL owners to the tenant's primary OWNER.
WITH primary_owner AS (
  SELECT DISTINCT ON (p."tenantId")
    p."tenantId" AS tenant_id,
    p."id"       AS practitioner_id
  FROM "Practitioner" p
  JOIN "Membership" m ON m."userId" = p."userId" AND m."tenantId" = p."tenantId"
  WHERE m."role" = 'OWNER' AND m."acceptedAt" IS NOT NULL
  ORDER BY p."tenantId", p."createdAt" ASC
)
UPDATE "Patient" pat
SET "assignedPractitionerId" = po.practitioner_id
FROM primary_owner po
WHERE pat."tenantId" = po.tenant_id
  AND pat."assignedPractitionerId" IS NULL;

-- Fallback for tenants without an OWNER membership: oldest practitioner.
WITH oldest_prac AS (
  SELECT DISTINCT ON (p."tenantId")
    p."tenantId" AS tenant_id,
    p."id"       AS practitioner_id
  FROM "Practitioner" p
  ORDER BY p."tenantId", p."createdAt" ASC
)
UPDATE "Patient" pat
SET "assignedPractitionerId" = op.practitioner_id
FROM oldest_prac op
WHERE pat."tenantId" = op.tenant_id
  AND pat."assignedPractitionerId" IS NULL;

-- Step 2: preserve old shared-view behaviour. For every tenant that has
-- sharedPatientView = true, grant PatientShare to every practitioner
-- other than the owner for every existing patient. Idempotent via the
-- unique (patientId, practitionerId) index.
INSERT INTO "PatientShare" ("id", "tenantId", "patientId", "practitionerId", "sharedById", "sharedAt")
SELECT
  -- cuid-shaped fallback id; the app re-uses @default(cuid()) for new rows
  'bf_' || substr(md5(random()::text || clock_timestamp()::text), 1, 22) AS id,
  pat."tenantId",
  pat."id"                 AS "patientId",
  pr."id"                  AS "practitionerId",
  NULL                     AS "sharedById",
  CURRENT_TIMESTAMP        AS "sharedAt"
FROM "Patient" pat
JOIN "Tenant" t ON t."id" = pat."tenantId" AND t."sharedPatientView" = true
JOIN "Practitioner" pr ON pr."tenantId" = pat."tenantId" AND pr."id" <> pat."assignedPractitionerId"
ON CONFLICT ("patientId", "practitionerId") DO NOTHING;
