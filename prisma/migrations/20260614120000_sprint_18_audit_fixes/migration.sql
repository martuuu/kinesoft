-- Sprint 18 — audit fixes (uniqueness · Particular insurer · agenda prefs)
--
-- 1) Patient uniqueness within a tenant. On PostgreSQL a composite UNIQUE
--    treats NULLs as distinct, so these forbid duplicate non-null values
--    while still allowing many patients with no email/phone.
--    NOTE: if existing data already has duplicate (tenantId, email) or
--    (tenantId, phone) pairs, these CREATE INDEX statements will fail —
--    de-duplicate first, then re-run.
CREATE UNIQUE INDEX "Patient_tenantId_email_key" ON "Patient"("tenantId", "email");
CREATE UNIQUE INDEX "Patient_tenantId_phone_key" ON "Patient"("tenantId", "phone");

-- 2) "Particular" as a real per-tenant Insurer.
--    Add the flag, mark any pre-existing "Particular" rows, and guarantee
--    every tenant has exactly one isParticular row (out-of-pocket pricing).
ALTER TABLE "Insurer" ADD COLUMN "isParticular" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Insurer" SET "isParticular" = true WHERE lower("name") = 'particular';

INSERT INTO "Insurer" ("id", "tenantId", "name", "copagoCents", "fixedFeeCents", "isParticular", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'Particular', 0, 0, true, true, NOW(), NOW()
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "Insurer" i WHERE i."tenantId" = t."id" AND i."isParticular" = true
);

-- 3) Per-user agenda personalisation. Defaults preserve the current
--    behaviour (header shown, all 7 days visible).
ALTER TABLE "UserPreferences" ADD COLUMN "agendaShowWeekHeader" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserPreferences" ADD COLUMN "agendaShowSaturday"   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserPreferences" ADD COLUMN "agendaShowSunday"     BOOLEAN NOT NULL DEFAULT true;
