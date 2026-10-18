-- M12 · agenda_secretaria_config (T3, 19-oct-2026; plan §23.10, brief T3 «M12»). Aditiva. Sin tablas nuevas
-- (guard:isolation sin cambios). Va SOLA, encabeza T3b (sesión T3b-1m).
--
-- Por qué:
--   * Tenant.moduleGrants / moduleRevokes: módulos y precio por consultorio (§23.6, solo /plataforma). `modulesFor` =
--     base del plan + grants − revokes; los escribe solo el escritor único de entitlements (source "platform"). TEXT[]
--     y no una tabla: son ≤ 32 claves por consultorio que se leen en CADA request junto con el Tenant (memo de
--     sesión), sin join. CHECK: un módulo no está dado y sacado a la vez, y el tamaño acotado (nadie mete basura).
--   * Tenant.bookingCap* / Practitioner.bookingCap*: tope de turnos por intervalo (C-AS3, decisión 6 del 19-oct).
--     El consultorio fija un default (los dos o ninguno: un tope sin intervalo no significa nada) y cada profesional
--     lo hereda (INHERIT), no tiene (NONE) o tiene el suyo (CUSTOM ⇔ los dos presentes). 1..60 e intervalo 15/30/60:
--     los buckets se alinean a la hora AR (`arIntervalKeyOf`), así que solo divisores de 60 que la grilla muestra.
--   * Booking.copagoPaymentMethod / copagoCollectedById: la Secretaría cobra el copago con medio y queda quién cobró
--     (C-AS2). Por qué `IN ('PAID','REFUNDED')` y no `⇒ PAID`: un reembolso de MP (T5) deja REFUNDED en un turno que
--     ya tenía medio; con `⇒ PAID` el webhook fallaría. `copagoCollectedById` sin FK, sin índice y sin back-relation:
--     Booking es la tabla caliente de la agenda (cada FK suma un chequeo por escritura y un RESTRICT al borrar el
--     UserProfile) y el dato es de lectura de auditoría/facturación, no de navegación. Enum propio y no
--     `SaasPaymentMethod` (M8c) aunque los valores coincidan: el de la suscripción y el del turno evolucionan por
--     separado (T5 agrega cobros online al turno); la paridad la fija un test en lib/payment-method.ts (1k1).
--   * Datos (precedente M8b): el Admin trae «Planes y pagos» por defecto (decisión 2 de Martin, 19-oct), salvo a quien
--     el Titular se lo SACÓ. Verificado en T3b-1m contra el código real antes de escribir el UPDATE:
--       - lib/team-internal.ts `setMemberGrantsInTx` es el ÚNICO escritor de `grantBilling` después del alta
--         (invitar/activar lo deja en false: lib/invite-activation-internal.ts) y audita, en la misma tx,
--         action `membership.grants.change`, entity `Membership`, entityId = Membership.id, payload
--         `{ userId, from: { grantSettings, grantBilling }, to: { grantSettings, grantBilling } }` (booleanos JSON).
--       - Desde Plataforma (lib/platform-team.ts → `teamAuditInTx` vía platform → lib/audit.ts `auditPlatformInTx`) la
--         fila del consultorio en "AuditEvent" lleva action `platform.membership.grants.change`, el MISMO payload más
--         `platform: {...}`, mismo tenantId/entityId. Por eso las dos acciones.
--       - Ajuste al SQL del brief: además de `to.grantBilling = false` se exige `from.grantBilling = true`. Con solo
--         `to = false`, un ADMIN al que el Titular le tocó SOLO «Configuración» (payload con billing false → false,
--         nunca tuvo «Planes y pagos») quedaba excluido sin que nadie se lo sacara. Un «sacado → devuelto → sacado»
--         sigue excluido (hay un evento true → false y hoy está en false); un «sacado → devuelto» ya está en true y el
--         UPDATE no lo mira.
--       - Membership no tiene `updatedAt`; el UPDATE no toca ninguna otra columna. Idempotente.
--     ASSISTANT/BILLING no se tocan: desde 1k1 no pueden tener «Planes y pagos» (C-AS1); el código nuevo lo rechaza.
--
-- lock_timeout 5 s: Tenant y Booking son calientes; si hay una tx larga, la migración falla rápido (P3009) en vez de
-- encolar la agenda detrás de un ACCESS EXCLUSIVE. Los CHECK validan al instante (columnas nuevas, todas NULL o en su
-- default): ningún turno existente tiene medio de pago.
--
-- COALESCE((…), false) en los dos CHECK de tope (desvío del SQL del brief, precedente M11): un CHECK ACEPTA cuando la
-- expresión da NULL, y `NULL IN (15,30,60)` / `NULL BETWEEN 1 AND 60` dan NULL. Sin el COALESCE entraban un tope sin
-- intervalo (count 2, intervalo NULL) y un CUSTOM sin valores; lo detectó tests/integration/as-m12.test.ts. Los de
-- Booking no lo necesitan: `paymentStatus` es NOT NULL y las ramas con NULL usan IS [NOT] NULL.
--
-- DRIFT ACEPTADO: los CHECK no se expresan en Prisma; si `migrate dev` propone borrarlos, NO se aceptan.
-- Compatible con el código anterior: nadie lee las columnas nuevas y nacen vacías/NULL/INHERIT → va ANTES del deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Tenant"
  ADD COLUMN "moduleGrants"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "moduleRevokes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bookingCapCount" INTEGER,
  ADD COLUMN "bookingCapIntervalMin" INTEGER;
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_moduleOverrides_check" CHECK (NOT ("moduleGrants" && "moduleRevokes")
      AND cardinality("moduleGrants") <= 32 AND cardinality("moduleRevokes") <= 32),
  ADD CONSTRAINT "Tenant_bookingCap_check" CHECK (COALESCE(
      ("bookingCapCount" IS NULL AND "bookingCapIntervalMin" IS NULL)
   OR ("bookingCapCount" BETWEEN 1 AND 60 AND "bookingCapIntervalMin" IN (15,30,60)), false));
CREATE TYPE "BookingCapMode" AS ENUM ('INHERIT','NONE','CUSTOM');
ALTER TABLE "Practitioner"
  ADD COLUMN "bookingCapMode" "BookingCapMode" NOT NULL DEFAULT 'INHERIT',
  ADD COLUMN "bookingCapCount" INTEGER,
  ADD COLUMN "bookingCapIntervalMin" INTEGER;
ALTER TABLE "Practitioner"
  ADD CONSTRAINT "Practitioner_bookingCap_check" CHECK (COALESCE(
      ("bookingCapMode" = 'CUSTOM' AND "bookingCapCount" BETWEEN 1 AND 60 AND "bookingCapIntervalMin" IN (15,30,60))
   OR ("bookingCapMode" <> 'CUSTOM' AND "bookingCapCount" IS NULL AND "bookingCapIntervalMin" IS NULL), false));
CREATE TYPE "BookingPaymentMethod" AS ENUM ('CASH','TRANSFER','CARD','WALLET','MERCADO_PAGO','OTHER');
ALTER TABLE "Booking"
  ADD COLUMN "copagoPaymentMethod" "BookingPaymentMethod",
  ADD COLUMN "copagoCollectedById" TEXT;  -- sin FK: tabla caliente, sin índice ni back-relation
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_copago_method_check" CHECK ("copagoPaymentMethod" IS NULL OR "paymentStatus" IN ('PAID','REFUNDED')),
  ADD CONSTRAINT "Booking_copago_collector_check" CHECK ("copagoCollectedById" IS NULL
      OR ("copagoPaymentMethod" IS NOT NULL AND "paymentStatus" IN ('PAID','REFUNDED')));
-- Datos (precedente M8b): el Admin trae «Planes y pagos» (decisión 2, 19-oct), salvo a quien el Titular se lo sacó
-- (evento de delegación true → false, desde el consultorio o desde Plataforma; ver cabecera).
UPDATE "Membership" m SET "grantBilling" = true
 WHERE m."role" = 'ADMIN' AND m."grantBilling" = false
   AND NOT EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a."tenantId" = m."tenantId" AND a."entityId" = m."id"
     AND a."entity" = 'Membership'
     AND a."action" IN ('membership.grants.change','platform.membership.grants.change')
     AND a."payload"->'from'->>'grantBilling' = 'true'
     AND a."payload"->'to'->>'grantBilling' = 'false');
COMMIT;
