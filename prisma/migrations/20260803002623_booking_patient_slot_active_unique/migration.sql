-- Race-free backstop for the patient-day guard (TOCTOU): a patient can't have
-- two ACTIVE turnos at the exact same instant, even under genuinely-concurrent
-- creates from different sessions (two tabs / two front-desk users) that both
-- pass the app-level guard. Partial + patientId-scoped so guests (patientId
-- NULL) never collide and a CANCELLED turno frees its slot for a re-book.
--
-- NOTE: partial indexes are not expressible in the Prisma schema (5.22), so this
-- index is managed by this migration only. If a future `prisma migrate dev`
-- proposes to DROP it, keep it — see .docs/AUDIT.md (Ronda 6, booking-same-patient-slot-toctou).
CREATE UNIQUE INDEX "Booking_tenant_patient_slot_active_key"
  ON "Booking" ("tenantId", "patientId", "scheduledFor")
  WHERE "patientId" IS NOT NULL AND status <> 'CANCELLED';
