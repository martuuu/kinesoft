-- Sprint 18 — per-turno + per-patient copago overrides.
--
-- Copago resolution precedence (highest first):
--   Booking.copagoCents      → this turno only
--   Coverage.copagoCents     → this patient's default (overrides their OS)
--   Insurer.copagoCents      → the obra social's configured copago
--   Particular insurer copago→ uninsured patients
--   Service.priceCents       → last-resort fallback
ALTER TABLE "Booking"  ADD COLUMN "copagoCents" INTEGER;
ALTER TABLE "Coverage" ADD COLUMN "copagoCents" INTEGER;
