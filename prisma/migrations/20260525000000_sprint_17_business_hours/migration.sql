-- Sprint 17 — configurable business hours.
-- Defaults match the pre-Sprint 17 hardcoded constants (8..19) so
-- existing tenants don't see their agenda timeline change.
ALTER TABLE "Tenant" ADD COLUMN "businessHoursStart" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "Tenant" ADD COLUMN "businessHoursEnd"   INTEGER NOT NULL DEFAULT 19;
