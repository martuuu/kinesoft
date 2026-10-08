-- rooms · M4, corrida SR, ola SR0 (va sola). Plan §16.3 / §17.1 / §17.5 (decisiones de Martin del 08-oct).
-- Por qué: hoy solo existen sedes (Location). El turno toma la sede de la franja (defaultLocationFor) y nada
--   impide que dos profesionales usen el mismo consultorio a la misma hora. M4 crea:
--   • las salas de cada sede: Room (CONSULTORIO | BOX | GIMNASIO | SALA). `capacity` = cuántos PROFESIONALES a la
--     vez (SR-D1, §17.5); el cupo de pacientes sigue en Service.maxConcurrent;
--   • la sala en la franja (PractitionerSchedule.roomId: "atiende en el Consultorio 2 los lunes de 9 a 13");
--   • la sala en el turno (Booking.roomId);
--   • el bloqueo de una sala (TimeBlock.roomId, enmienda "Bloquear sala" de §17.5): bloquea SOLO la sala, nunca a
--     los profesionales. Por eso el CHECK exige sede explícita y practitionerId NULL (hoy practitionerId NULL en
--     TimeBlock = "todos los profesionales"; el motor, SR1a, excluye los bloqueos con sala de ese significado).
--   ScheduleException.ranges[].roomId es JSON: sin DDL (lo valida zod al escribir y el loader no confía).
-- TABLA NUEVA "Room" con RLS ENABLE + FORCE + "Room_tenant_isolation" (mismo DO-block que agenda_foundations y M1;
--   la verifica `npm run guard:isolation`). Sin GRANT: los privilegios de kinesoft_app / kinesoft_service llegan
--   por DEFAULT PRIVILEGES (prisma/roles.*.sql); anon/authenticated siguen sin nada desde M2.
--
-- FKs (las FK saltean RLS y prod es BYPASSRLS: las COMPUESTAS son la red de "misma empresa" y "misma sede"):
--   • Room → Tenant CASCADE y Room → Location (locationId, tenantId) CASCADE: la sala no existe sin su sede. Las
--     sedes y las salas se archivan con `active`; un borrado real de sede ya lo frena el RESTRICT de
--     Booking.locationId si tiene turnos.
--   • Booking → Room RESTRICT (simple + (roomId, tenantId) + (roomId, locationId)): una sala con turnos no se
--     borra, se archiva. Booking no cascadea desde Tenant (deleteTenantDeep borra los turnos antes).
--     OJO write-paths (SR2a): cambiar Booking.locationId dejando un roomId de la sede vieja viola la compuesta
--     (23503); quien cambia la sede recalcula o limpia la sala en el MISMO UPDATE.
--   • PractitionerSchedule → Room NO ACTION (las 3). Una franja no se borra en silencio porque se borró su sala.
--     Revisión SR-M sobre el relevamiento: en Postgres RESTRICT y NO ACTION se chequean IGUAL, en la cola de
--     triggers AFTER al final de la sentencia (la única diferencia es que NO ACTION se puede diferir); no es cierto
--     que RESTRICT "chequee antes". El borrado del tenant (o de una sede) no falla con ninguna de las dos porque
--     la cascada DIRECTA Tenant→PractitionerSchedule (y Location→PractitionerSchedule) queda encolada ANTES que el
--     chequeo que genera el borrado en cascada de la sala. Se deja NO ACTION (el default SQL, diferible) y el
--     multi-camino lo prueba tests/integration/rooms-m4.test.ts (borrado del tenant y de una sede con salas,
--     franjas, bloqueos y turnos con sala).
--   • TimeBlock → Room CASCADE (las 3, §17.5): un bloqueo de una sala que se borra no tiene sentido.
--   • Booking.locationId NULL = sede principal: con MATCH SIMPLE una FK con un NULL no se chequea, así que
--     Booking_room_location_check exige sede explícita si hay sala (SR-D6: quien estampa sala estampa la sede de
--     la sala). TimeBlock.locationId NULL = "todas las sedes": TimeBlock_room_scope_check la exige con sala.
--     PractitionerSchedule.locationId ya es NOT NULL.
--
-- Aditiva: un CREATE TYPE, una tabla, tres ADD COLUMN nullable sin default (solo catálogo: sin rewrite y sin
--   UPDATE; Booking.updatedAt = optimistic lock no se mueve, AUDIT §5.30), FKs y CHECKs sobre columnas recién
--   creadas (todas NULL: la validación es un scan trivial). Sin backfill: prod se resetea (§16.4) y roomId NULL =
--   "sin sala" para siempre.
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` / `migrate diff` los propone;
--   migrate dev está prohibido en este repo):
--   • único PARCIAL + expresión Room_locationId_name_active_key (SR-D9: nombre único por sede entre activas);
--   • FKs compuestas Booking_room_tenant_fkey, Booking_room_location_fkey, PractitionerSchedule_room_tenant_fkey,
--     PractitionerSchedule_room_location_fkey, TimeBlock_room_tenant_fkey, TimeBlock_room_location_fkey;
--   • CHECKs Room_name_check, Room_capacity_check, Room_sortOrder_check, Booking_room_location_check,
--     TimeBlock_room_scope_check;
--   • la policy Room_tenant_isolation.
-- Locks: el CREATE UNIQUE INDEX sobre Location toma SHARE (frena escrituras de sedes < 1 s); ALTER / ADD
--   CONSTRAINT sobre Booking, PractitionerSchedule y TimeBlock toman lock exclusivo hasta el COMMIT.
--   lock_timeout: si la agenda tiene tomada "Booking", falla rápido en vez de colgarla (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "RoomKind" AS ENUM ('CONSULTORIO', 'BOX', 'GIMNASIO', 'SALA');

CREATE UNIQUE INDEX "Location_id_tenantId_key" ON "Location"("id", "tenantId");   -- destino de FK compuesta

CREATE TABLE "Room" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "kind"       "RoomKind" NOT NULL DEFAULT 'CONSULTORIO',
  "capacity"   INTEGER NOT NULL DEFAULT 1,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Room_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  CONSTRAINT "Room_capacity_check" CHECK ("capacity" BETWEEN 1 AND 50),   -- = profesionales a la vez (SR-D1)
  CONSTRAINT "Room_sortOrder_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "Room_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Room_location_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Room_id_tenantId_key"   ON "Room"("id", "tenantId");     -- destino FK compuesta (misma empresa)
CREATE UNIQUE INDEX "Room_id_locationId_key" ON "Room"("id", "locationId");   -- destino FK compuesta (misma sede)
CREATE INDEX "Room_tenantId_locationId_idx"  ON "Room"("tenantId", "locationId");
-- PARCIAL + expresión (no lo expresa Prisma; NO borrar): nombre único por sede entre las activas, sin distinguir
-- mayúsculas ni espacios de los bordes (SR-D9). Una sala archivada libera el nombre.
CREATE UNIQUE INDEX "Room_locationId_name_active_key" ON "Room"("locationId", lower(btrim("name"))) WHERE "active";

-- Franja con sala.
ALTER TABLE "PractitionerSchedule" ADD COLUMN "roomId" TEXT;
ALTER TABLE "PractitionerSchedule"
  ADD CONSTRAINT "PractitionerSchedule_roomId_fkey"        FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PractitionerSchedule_room_tenant_fkey"   FOREIGN KEY ("roomId", "tenantId")   REFERENCES "Room"("id", "tenantId")   ON DELETE NO ACTION,
  ADD CONSTRAINT "PractitionerSchedule_room_location_fkey" FOREIGN KEY ("roomId", "locationId") REFERENCES "Room"("id", "locationId") ON DELETE NO ACTION;
CREATE INDEX "PractitionerSchedule_tenantId_roomId_idx" ON "PractitionerSchedule"("tenantId", "roomId");   -- validación entre profesionales (SR1c) + chequeo de FK

-- Sala del turno.
ALTER TABLE "Booking" ADD COLUMN "roomId" TEXT;
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_roomId_fkey"         FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_room_tenant_fkey"    FOREIGN KEY ("roomId", "tenantId")   REFERENCES "Room"("id", "tenantId")   ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_room_location_fkey"  FOREIGN KEY ("roomId", "locationId") REFERENCES "Room"("id", "locationId") ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_room_location_check" CHECK ("roomId" IS NULL OR "locationId" IS NOT NULL);   -- SR-D6
CREATE INDEX "Booking_tenantId_roomId_scheduledFor_idx" ON "Booking"("tenantId", "roomId", "scheduledFor");   -- ocupación de sala, vista "Por sala", RESTRICT

-- Bloqueo de sala (§17.5). Bloquea SOLO la sala: sede explícita y sin profesional.
ALTER TABLE "TimeBlock" ADD COLUMN "roomId" TEXT;
ALTER TABLE "TimeBlock"
  ADD CONSTRAINT "TimeBlock_roomId_fkey"         FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeBlock_room_tenant_fkey"    FOREIGN KEY ("roomId", "tenantId")   REFERENCES "Room"("id", "tenantId")   ON DELETE CASCADE,
  ADD CONSTRAINT "TimeBlock_room_location_fkey"  FOREIGN KEY ("roomId", "locationId") REFERENCES "Room"("id", "locationId") ON DELETE CASCADE,
  ADD CONSTRAINT "TimeBlock_room_scope_check"    CHECK ("roomId" IS NULL OR ("locationId" IS NOT NULL AND "practitionerId" IS NULL));
CREATE INDEX "TimeBlock_tenantId_roomId_startsAt_idx" ON "TimeBlock"("tenantId", "roomId", "startsAt");   -- bloqueos de la sala por ventana

-- ── RLS: la tabla nueva con tenantId ─────────────────────────────────
-- Mismo loop y mismo nombre de policy que 20260725120000_rls_policies, agenda_foundations y M1.
-- app_current_tenant_id() devuelve NULL sin GUC → ninguna fila visible y ningún INSERT pasa el WITH CHECK fuera
-- de runWithRls.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Room']
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

COMMIT;
