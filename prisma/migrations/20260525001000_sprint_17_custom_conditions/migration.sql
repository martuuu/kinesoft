-- Sprint 17 — practitioner-authored custom conditions.
--
-- Extends the existing `Condition` table with a tenantId + createdById
-- pair. tenantId = null preserves the global catalog rows. Custom rows
-- (tenantId != null) are surfaced in the diagnostico AssignPlanModal
-- as a manual override; they don't link into the anatomy / tag /
-- exercise matching engine.

ALTER TABLE "Condition" ADD COLUMN "tenantId"    TEXT;
ALTER TABLE "Condition" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Condition" ADD COLUMN "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- FKs
ALTER TABLE "Condition"
  ADD CONSTRAINT "Condition_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Condition"
  ADD CONSTRAINT "Condition_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Condition_tenantId_idx" ON "Condition"("tenantId");
