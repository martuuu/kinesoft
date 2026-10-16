-- M10 · perf_fk_indexes (PF-M, §20.9 del plan). Aditiva: solo CREATE INDEX IF NOT EXISTS.
--
-- Por qué: FKs de una columna que no son prefijo de ningún índice (catálogo local, 15-oct). Sin índice, cada lectura
-- por esa columna y cada ON DELETE del padre hace Seq Scan del hijo. Coverage.patientId es el confirmado por el
-- harness de A1 (Seq Scan de Coverage por turno en el «OS percibido»); Patient.userId lo usa el portal en todos los
-- consultorios (lib/portal-identity-internal.ts, findMany where userId); Service.tenantId lo lee cada carga de agenda
-- y configuración; Booking.serviceId lo cuenta el panel de Servicios («N turnos») y lo recorre el borrado de un
-- servicio; los tags y favoritos, los filtros de Biblioteca. Las FKs compuestas con tenantId (ClinicalNote,
-- SupportThread, SaasPayment…) NO van: las lecturas usan el índice con tenant adelante y el padre casi no se borra.
--
-- Sin CONCURRENTLY: Prisma corre cada migración dentro de una transacción y CREATE INDEX CONCURRENTLY no puede ir en
-- una. Las tablas de prod son chicas (datos demo); el SHARE lock dura milisegundos. lock_timeout corta si hay un
-- lock largo en vez de encolar escrituras detrás: si falla, se reintenta en un momento sin tráfico.
-- Ningún índice es parcial: todos están declarados en schema.prisma con @@index (mismo nombre), así que
-- `migrate diff` no ve drift.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "Coverage_patientId_idx" ON "Coverage"("patientId");
CREATE INDEX IF NOT EXISTS "EmergencyContact_patientId_idx" ON "EmergencyContact"("patientId");
CREATE INDEX IF NOT EXISTS "Patient_userId_idx" ON "Patient"("userId");
CREATE INDEX IF NOT EXISTS "PatientTenantLink_tenantId_idx" ON "PatientTenantLink"("tenantId");
CREATE INDEX IF NOT EXISTS "Service_tenantId_idx" ON "Service"("tenantId");
CREATE INDEX IF NOT EXISTS "Service_practitionerId_idx" ON "Service"("practitionerId");
CREATE INDEX IF NOT EXISTS "Session_practitionerId_idx" ON "Session"("practitionerId");
CREATE INDEX IF NOT EXISTS "SessionExercise_exerciseId_idx" ON "SessionExercise"("exerciseId");
CREATE INDEX IF NOT EXISTS "Booking_serviceId_idx" ON "Booking"("serviceId");
CREATE INDEX IF NOT EXISTS "Favorite_exerciseId_idx" ON "Favorite"("exerciseId");
CREATE INDEX IF NOT EXISTS "ExerciseTag_tagId_idx" ON "ExerciseTag"("tagId");
CREATE INDEX IF NOT EXISTS "ConditionTag_tagId_idx" ON "ConditionTag"("tagId");
CREATE INDEX IF NOT EXISTS "Condition_createdById_idx" ON "Condition"("createdById");
