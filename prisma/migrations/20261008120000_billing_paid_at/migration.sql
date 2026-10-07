-- billing_paid_at · M3a, corrida ES3 ola P3.0.0 (sola). Plan §16.2, decisiones de Martin del 08-oct.
-- Por qué:
--   (1) `Booking.copagoPaidAt`: el widget de ingresos del dashboard (S14r) hoy solo suma los `Payment` de MP,
--       así que un copago cobrado a mano (efectivo/transferencia, `paymentStatus = PAID` desde Facturación o el
--       drawer) no aparece nunca en "Ingresos" (AUDIT P11). Para ubicarlo en la semana/mes AR hace falta la fecha
--       en que se marcó cobrado: `updatedAt` no sirve (lo mueve cualquier edición del turno y es el optimistic
--       lock) y `scheduledFor` es la fecha del turno, no la del cobro. La escribe y la limpia SOLO
--       `toggleBilling`/`setBookingCopagoPaid` (S14r): marcar → now(), desmarcar → NULL. La obra social ya tiene
--       su propia fecha (`insurerPaidAt`).
--   (2) `UserPreferences.dashboardPrefs`: preferencias del dashboard por usuario, por ahora
--       `{revenueRange: 'month'|'week'}`. Blob JSON validado al leer (mismo patrón que `catalogPrefs` y
--       `agendaPrefs`, lib/preferences.ts) para que sumar una preferencia no necesite migración. El CHECK solo
--       garantiza que, si hay algo, sea un objeto (no un array/escalar/`null` JSON): la forma fina la valida la
--       app. Para limpiarla desde Prisma se escribe `Prisma.DbNull` (NULL SQL); `Prisma.JsonNull` guardaría el
--       `null` JSON y el CHECK lo rechaza a propósito.
-- Sin backfill: prod se resetea antes del go-live (plan §16.4). Los copagos PAID previos quedan con
-- `copagoPaidAt` NULL y el widget no los cuenta (no hay fecha de cobro confiable que inventarles).
-- Aditiva: dos ADD COLUMN nullable sin default (solo catálogo, sin rewrite ni escritura de filas: `updatedAt`
-- de los turnos no se mueve) + un CHECK sobre una columna recién creada (toda NULL, la validación es trivial).
-- Sin tabla nueva → `guard:isolation` de RLS no cambia; sin GRANTs (las columnas heredan los privilegios de
-- tabla de kinesoft_app / kinesoft_service; anon/authenticated siguen sin nada desde M2).
BEGIN;
SET LOCAL lock_timeout = '5s';   -- si "Booking" está tomada (agenda en uso), falla rápido. Ver RUNBOOK P3009.

ALTER TABLE "Booking" ADD COLUMN "copagoPaidAt" TIMESTAMP(3);

ALTER TABLE "UserPreferences" ADD COLUMN "dashboardPrefs" JSONB;
ALTER TABLE "UserPreferences" ADD CONSTRAINT "UserPreferences_dashboardPrefs_object_check"
  CHECK ("dashboardPrefs" IS NULL OR jsonb_typeof("dashboardPrefs") = 'object');

COMMIT;
