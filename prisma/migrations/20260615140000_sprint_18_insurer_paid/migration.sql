-- Sprint 18 — obra-social payment confirmation per turno.
-- The Facturación tab shows OS + copago separately; this column records
-- when the OS reimbursement was confirmed received. Copago stays on
-- Booking.paymentStatus.
ALTER TABLE "Booking" ADD COLUMN "insurerPaidAt" TIMESTAMP(3);
