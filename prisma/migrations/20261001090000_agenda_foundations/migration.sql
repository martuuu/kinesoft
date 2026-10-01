-- B-pre B2.0 · agenda_foundations (01-oct-2026) — migración 2 de 2 de B-pre
-- (la 1 es `20260930200000_catalog_global`, M-cat, ola B1.0). Diseño:
-- bpre-design §B; decisiones 1-14 del plan.
--
-- Por qué: hoy la agenda no sabe DÓNDE ni CUÁNDO atiende cada profesional.
-- Hay un único horario por consultorio (Tenant.businessHoursStart/End, lun-sáb,
-- domingo cerrado: regla repetida en suggestNextFreeSlot y buildPublicSlots),
-- el sobreturno es el prefijo "[SOBRETURNO]" en `notes` y "qué servicio da
-- cada profesional" es `Service.practitionerId` (uno o todos). Esta migración
-- crea las bases de la agenda multi-profesional: sedes (Location), franjas
-- semanales por profesional y sede (PractitionerSchedule), excepciones por día
-- (ScheduleException), bloqueos (TimeBlock), qué servicios atiende y qué
-- coberturas acepta cada profesional (PractitionerService / PractitionerPayer),
-- sus especialidades del catálogo (PractitionerSpecialty) y columnas nuevas de
-- Booking (sede, sobreturno, recepción, telemedicina) + UserPreferences.agendaPrefs.
--
-- Aditiva (expand/contract), segura con la app vieja corriendo:
--   • 7 tablas nuevas + 2 enums; ningún DROP, ningún SET NOT NULL.
--   • Booking: 6 columnas nuevas. Las Boolean con DEFAULT constante
--     (isOverbooked, isTelemedicine) no reescriben la tabla en PG >= 11; el
--     resto son NULLABLE sin default. `locationId` null = sede principal (el
--     loader lo trata así para siempre, aunque el backfill las complete).
--   • UserPreferences.agendaPrefs JSONB nullable.
--   • Contract (DESPUÉS de B-pre, no ahora): `Service.practitionerId`, el
--     prefijo "[SOBRETURNO]" (se sigue escribiendo) y `Tenant.businessHours*`.
--
-- FKs: CASCADE desde Tenant en todas. Desde Practitioner, CASCADE en todas
-- (config sin dueño no significa nada). En ScheduleException y TimeBlock
-- `practitionerId` NULL significa "todo el consultorio": un SET NULL
-- convertiría la excepción/bloqueo de un profesional borrado en uno de TODOS,
-- por eso CASCADE. Mismo razonamiento para TimeBlock.locationId (null = todas
-- las sedes). PractitionerSchedule.locationId CASCADE (la franja no existe sin
-- sede; las sedes se desactivan con `active`). Booking.locationId RESTRICT:
-- una sede con turnos no se puede borrar. PractitionerSpecialty.specialtyId
-- RESTRICT: el catálogo global se archiva, no se borra; un borrado real tiene
-- que repuntar antes y no perder datos de un tenant en silencio.
-- `createdById` (UserProfile.id) sin FK a propósito: autoría, no pertenencia.
--
-- RLS (en la MISMA migración, regla del repo): las 7 tablas tienen tenantId →
-- ENABLE + FORCE + policy `<Tabla>_tenant_isolation` FOR ALL con
-- `"tenantId" = app_current_tenant_id()` en USING y WITH CHECK, mismo loop que
-- 20260725120000_rls_policies. Verificado por scripts/guard-tenant-isolation.mjs
-- y tests/integration/rls-isolation.test.ts. Mientras prod conecte con un rol
-- BYPASSRLS las policies son inertes ahí: la barrera sigue siendo `where tenantId`.
--
-- Backfill (bloque marcado más abajo; idempotente; ids determinísticos md5):
--   ver el detalle en el bloque. Resultado con los datos de hoy: la agenda
--   calcula EXACTAMENTE lo mismo que antes (franjas = businessHours lun-sáb en la
--   sede principal; todo profesional atiende lo que atendía y acepta todas las
--   coberturas activas).
--   ⚠ El UPDATE de Booking NO toca `updatedAt`: no hay trigger en Booking
--   (verificado en pg_trigger: 0 triggers de usuario) y `@updatedAt` de Prisma
--   lo pone el CLIENTE, no la base. Importa: `updatedAt` es el optimistic lock
--   (`expectedUpdatedAt`) de las mutaciones de turnos; si el backfill lo
--   moviera, cada modal abierto durante el deploy daría "el turno cambió".
--
-- Locks: ADD COLUMN/ADD CONSTRAINT/CREATE INDEX sobre Booking toman lock
-- exclusivo hasta el COMMIT (la tabla es chica: < 1 s). Sin CONCURRENTLY
-- porque va dentro de la transacción de la migración.

BEGIN;

-- CreateEnum
CREATE TYPE "ScheduleExceptionKind" AS ENUM ('CLOSED', 'CUSTOM_HOURS');

-- CreateEnum
CREATE TYPE "PracticeVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "attendingAt" TIMESTAMP(3),
ADD COLUMN     "isOverbooked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isTelemedicine" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "telemedicineUrl" TEXT;

-- AlterTable
ALTER TABLE "UserPreferences" ADD COLUMN     "agendaPrefs" JSONB;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "dow" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "validFrom" DATE,
    "validUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PractitionerSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT,
    "date" DATE NOT NULL,
    "kind" "ScheduleExceptionKind" NOT NULL,
    "ranges" JSONB,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT,
    "locationId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "groupId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TimeBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerService" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "durationMin" INTEGER,
    "visibility" "PracticeVisibility" NOT NULL DEFAULT 'PUBLIC',
    "minLeadMinutes" INTEGER,
    "maxLeadDays" INTEGER,
    "concurrencyOverride" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrent" INTEGER,
    "notifyOnBooking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PractitionerService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerPayer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "insurerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PractitionerPayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerSpecialty" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,

    CONSTRAINT "PractitionerSpecialty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");

-- CreateIndex
CREATE INDEX "PractitionerSchedule_tenantId_practitionerId_dow_idx" ON "PractitionerSchedule"("tenantId", "practitionerId", "dow");

-- CreateIndex
CREATE INDEX "ScheduleException_tenantId_date_idx" ON "ScheduleException"("tenantId", "date");

-- CreateIndex
CREATE INDEX "TimeBlock_tenantId_startsAt_idx" ON "TimeBlock"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "TimeBlock_practitionerId_startsAt_idx" ON "TimeBlock"("practitionerId", "startsAt");

-- CreateIndex
CREATE INDEX "PractitionerService_tenantId_serviceId_idx" ON "PractitionerService"("tenantId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerService_practitionerId_serviceId_key" ON "PractitionerService"("practitionerId", "serviceId");

-- CreateIndex
CREATE INDEX "PractitionerPayer_tenantId_insurerId_idx" ON "PractitionerPayer"("tenantId", "insurerId");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerPayer_practitionerId_insurerId_key" ON "PractitionerPayer"("practitionerId", "insurerId");

-- CreateIndex
CREATE INDEX "PractitionerSpecialty_tenantId_idx" ON "PractitionerSpecialty"("tenantId");

-- CreateIndex
CREATE INDEX "PractitionerSpecialty_specialtyId_idx" ON "PractitionerSpecialty"("specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerSpecialty_practitionerId_specialtyId_key" ON "PractitionerSpecialty"("practitionerId", "specialtyId");

-- CreateIndex
CREATE INDEX "Booking_tenantId_locationId_scheduledFor_idx" ON "Booking"("tenantId", "locationId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerService" ADD CONSTRAINT "PractitionerService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerService" ADD CONSTRAINT "PractitionerService_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerService" ADD CONSTRAINT "PractitionerService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerPayer" ADD CONSTRAINT "PractitionerPayer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerPayer" ADD CONSTRAINT "PractitionerPayer_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerPayer" ADD CONSTRAINT "PractitionerPayer_insurerId_fkey" FOREIGN KEY ("insurerId") REFERENCES "Insurer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSpecialty" ADD CONSTRAINT "PractitionerSpecialty_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSpecialty" ADD CONSTRAINT "PractitionerSpecialty_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSpecialty" ADD CONSTRAINT "PractitionerSpecialty_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECKs (Prisma no los expresa; NO BORRAR si `migrate dev` los propone) ──
-- dow con la convención de toARDow (lib/datetime-ar.ts): 0=Dom … 6=Sáb.
-- Minutos AR desde 00:00, rango semiabierto [startMin, endMin); 1440 = 24:00.
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_dow_check"
  CHECK ("dow" BETWEEN 0 AND 6);
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_range_check"
  CHECK ("startMin" >= 0 AND "startMin" < "endMin" AND "endMin" <= 1440);
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_validity_check"
  CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil");
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_range_check"
  CHECK ("startsAt" < "endsAt");
-- CUSTOM_HOURS sin franjas no tiene significado (para "no se atiende" está CLOSED).
-- El contenido de cada franja lo valida zod al escribir.
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_ranges_check"
  CHECK ("kind" <> 'CUSTOM_HOURS' OR ("ranges" IS NOT NULL AND jsonb_typeof("ranges") = 'array'));
-- null = hereda (de Service o del tenant); si viene, tiene que ser usable.
ALTER TABLE "PractitionerService" ADD CONSTRAINT "PractitionerService_values_check"
  CHECK (("durationMin" IS NULL OR "durationMin" > 0)
     AND ("maxConcurrent" IS NULL OR "maxConcurrent" >= 1)
     AND ("minLeadMinutes" IS NULL OR "minLeadMinutes" >= 0)
     AND ("maxLeadDays" IS NULL OR "maxLeadDays" >= 0));

-- ── Índices únicos PARCIALES (a mano) ───────────────────────────────
-- NO BORRAR si `prisma migrate dev` propone dropearlos: Prisma no sabe
-- expresar índices parciales y los ve como drift (igual que el único parcial
-- de Booking y los de PayerPlan).
--   • una sola sede principal por tenant;
--   • una excepción por (profesional, día) y una "de consultorio"
--     (practitionerId NULL) por (tenant, día). Con NULLs distintos un UNIQUE
--     común sobre (tenantId, practitionerId, date) no frenaría dos de consultorio.
CREATE UNIQUE INDEX "Location_tenantId_primary_key"
  ON "Location"("tenantId") WHERE "isPrimary";
CREATE UNIQUE INDEX "ScheduleException_practitionerId_date_key"
  ON "ScheduleException"("practitionerId", "date") WHERE "practitionerId" IS NOT NULL;
CREATE UNIQUE INDEX "ScheduleException_tenantId_date_tenantwide_key"
  ON "ScheduleException"("tenantId", "date") WHERE "practitionerId" IS NULL;

-- ── RLS: las 7 tablas nuevas con tenantId ───────────────────────────
-- Mismo loop y mismo nombre de policy que 20260725120000_rls_policies.
-- app_current_tenant_id() devuelve NULL sin GUC → ninguna fila visible y
-- ningún INSERT pasa el WITH CHECK fuera de runWithRls.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Location', 'PractitionerSchedule', 'ScheduleException', 'TimeBlock',
    'PractitionerService', 'PractitionerPayer', 'PractitionerSpecialty'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- >>> BACKFILL agenda_foundations BEGIN
-- Idempotente: re-correr este bloque (psql, dentro de BEGIN … COMMIT) no
-- cambia nada — cada INSERT tiene `WHERE NOT EXISTS` + ids determinísticos
-- (md5) con ON CONFLICT DO NOTHING, y cada UPDATE filtra las filas ya hechas.
-- tests/integration/agenda-backfill.test.ts lee ESTE bloque del archivo y lo
-- ejecuta (testea el SQL literal que corre en prod), acotado a sus tenants con
-- el GUC opcional `kinesoft.backfill_tenants` (lista de ids separada por comas;
-- sin setear = TODOS los tenants, que es lo que pasa en la migración).
-- Reglas del bloque: sin ';' dentro de una sentencia (el test parte por ';').
--
-- Guarda: con row_security = off, si el rol que migra NO tiene BYPASSRLS
-- (FORCE RLS aplica también al dueño de la tabla), cada sentencia FALLA con
-- "query would be affected by row-level security policy" en vez de backfillear
-- 0 filas en silencio. Con superuser/BYPASSRLS (Docker, owner de Supabase) es
-- un no-op. SET LOCAL: vale hasta el COMMIT de esta migración.
SET LOCAL row_security = off;

-- (1) Sede "Principal" por tenant (si todavía no tiene una principal).
INSERT INTO "Location" ("id", "tenantId", "name", "isPrimary", "active", "sortOrder", "createdAt", "updatedAt")
SELECT 'loc_' || md5('agenda_foundations:location:' || t."id"),
       t."id", 'Principal', true, true, 0,
       now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Tenant" t
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR t."id" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND NOT EXISTS (SELECT 1 FROM "Location" l WHERE l."tenantId" = t."id" AND l."isPrimary")
ON CONFLICT ("id") DO NOTHING;

-- (2) Franjas lun-sáb (dow 1..6, convención toARDow 0=Dom) por profesional con
-- membresía aceptada, con el horario del tenant, en la sede principal. Es la
-- regla que hoy aplican suggestNextFreeSlot y buildPublicSlots (domingo
-- cerrado, businessHoursStart..End). Solo profesionales SIN ninguna franja
-- (no pisa una configuración ya cargada). Un tenant con horario inválido
-- (start >= end, fuera de 0..24) se saltea: el loader cae al horario del tenant.
INSERT INTO "PractitionerSchedule" ("id", "tenantId", "practitionerId", "locationId", "dow", "startMin", "endMin", "createdAt", "updatedAt")
SELECT 'psch_' || md5('agenda_foundations:schedule:' || p."id" || ':' || d.dow::text),
       p."tenantId", p."id", l."id", d.dow,
       t."businessHoursStart" * 60, t."businessHoursEnd" * 60,
       now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Practitioner" p
JOIN "Tenant" t ON t."id" = p."tenantId"
JOIN "Membership" m ON m."userId" = p."userId" AND m."tenantId" = p."tenantId" AND m."acceptedAt" IS NOT NULL
JOIN "Location" l ON l."tenantId" = p."tenantId" AND l."isPrimary"
CROSS JOIN generate_series(1, 6) AS d(dow)
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR p."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND t."businessHoursStart" >= 0
  AND t."businessHoursStart" < t."businessHoursEnd"
  AND t."businessHoursEnd" <= 24
  AND NOT EXISTS (SELECT 1 FROM "PractitionerSchedule" s WHERE s."practitionerId" = p."id")
ON CONFLICT ("id") DO NOTHING;

-- (3) Qué servicios atiende cada profesional, igual que hoy:
--     Service con practitionerId = P → solo (P, S);
--     Service sin practitionerId (compartido) → todos los profesionales del
--     tenant con membresía aceptada. PUBLIC + enabled (hoy el turnero ofrece
--     todos los servicios); el resto de las columnas en null = hereda de Service.
INSERT INTO "PractitionerService" ("id", "tenantId", "practitionerId", "serviceId", "createdAt", "updatedAt")
SELECT 'psvc_' || md5('agenda_foundations:service:' || p."id" || ':' || s."id"),
       s."tenantId", p."id", s."id",
       now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Service" s
JOIN "Practitioner" p ON p."tenantId" = s."tenantId"
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR s."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND (
    s."practitionerId" = p."id"
    OR (s."practitionerId" IS NULL AND EXISTS (
      SELECT 1 FROM "Membership" m
      WHERE m."userId" = p."userId" AND m."tenantId" = p."tenantId" AND m."acceptedAt" IS NOT NULL))
  )
  AND NOT EXISTS (SELECT 1 FROM "PractitionerService" x WHERE x."practitionerId" = p."id" AND x."serviceId" = s."id")
ON CONFLICT DO NOTHING;

-- (3b) Lo que el profesional YA venía atendiendo: hoy createBooking/batch no
--     miran Service.practitionerId, así que en un consultorio con 2+
--     profesionales P2 pudo dar turnos de un servicio "propio" de P1. Con (3)
--     solo, el rechazo nuevo "servicio no habilitado" (B3.1) le cortaría a P2
--     algo que hacía ayer (hallazgo de la revisión de B-pre). Todo par
--     (profesional, servicio) con algún turno NO cancelado (pasado o futuro)
--     queda habilitado, pero PRIVATE: la agenda sigue igual y el turnero no
--     empieza a ofrecer a P2 lo que antes solo ofrecía con P1. Mismo id md5
--     que (3) para el par → si (3) ya lo creó, ON CONFLICT lo saltea. Corre
--     DESPUÉS de (3) para no pisar el PUBLIC de los pares que (3) cubre.
--     Los JOIN por tenant son defensivos (Booking ya garantiza el par).
INSERT INTO "PractitionerService" ("id", "tenantId", "practitionerId", "serviceId", "enabled", "visibility", "createdAt", "updatedAt")
SELECT DISTINCT 'psvc_' || md5('agenda_foundations:service:' || b."practitionerId" || ':' || b."serviceId"),
       b."tenantId", b."practitionerId", b."serviceId", true, 'PRIVATE'::"PracticeVisibility",
       now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Booking" b
JOIN "Practitioner" p ON p."id" = b."practitionerId" AND p."tenantId" = b."tenantId"
JOIN "Service" s ON s."id" = b."serviceId" AND s."tenantId" = b."tenantId"
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR b."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND b."status" <> 'CANCELLED'
  AND NOT EXISTS (SELECT 1 FROM "PractitionerService" x WHERE x."practitionerId" = b."practitionerId" AND x."serviceId" = b."serviceId")
ON CONFLICT DO NOTHING;

-- (4) Coberturas: cada profesional con membresía aceptada acepta todos los
--     Insurer ACTIVOS del tenant (incluido Particular), como hoy.
INSERT INTO "PractitionerPayer" ("id", "tenantId", "practitionerId", "insurerId", "createdAt")
SELECT 'ppay_' || md5('agenda_foundations:payer:' || p."id" || ':' || i."id"),
       i."tenantId", p."id", i."id",
       now() AT TIME ZONE 'UTC'
FROM "Insurer" i
JOIN "Practitioner" p ON p."tenantId" = i."tenantId"
JOIN "Membership" m ON m."userId" = p."userId" AND m."tenantId" = p."tenantId" AND m."acceptedAt" IS NOT NULL
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR i."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND i."active"
  AND NOT EXISTS (SELECT 1 FROM "PractitionerPayer" x WHERE x."practitionerId" = p."id" AND x."insurerId" = i."id")
ON CONFLICT DO NOTHING;

-- (5) Sobreturno: la marca vieja es el prefijo "[SOBRETURNO]" en notes
--     (lib/bookings.ts). En LIKE de Postgres '[' es literal (solo % y _ son
--     comodines). El prefijo NO se borra: se sigue escribiendo hasta el contract.
--     No toca updatedAt (ver cabecera).
UPDATE "Booking" b
SET "isOverbooked" = true
WHERE (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR b."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')))
  AND b."notes" LIKE '[SOBRETURNO]%'
  AND NOT b."isOverbooked";

-- (6) Todo turno sin sede → la principal de su tenant. No toca updatedAt
--     (optimistic lock: ver cabecera).
UPDATE "Booking" b
SET "locationId" = l."id"
FROM "Location" l
WHERE l."tenantId" = b."tenantId"
  AND l."isPrimary"
  AND b."locationId" IS NULL
  AND (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR b."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')));
-- <<< BACKFILL agenda_foundations END

COMMIT;
