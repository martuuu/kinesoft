-- Multi-turno batch grouping. Every turno created in one "Repetir / Múltiples
-- turnos" batch shares a seriesId; single bookings stay NULL. Enables a future
-- "plan" entity to regroup a batch indirectly without a destructive migration.
ALTER TABLE "Booking" ADD COLUMN "seriesId" TEXT;
CREATE INDEX "Booking_tenantId_seriesId_idx" ON "Booking" ("tenantId", "seriesId");
