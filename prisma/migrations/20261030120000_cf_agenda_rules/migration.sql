-- M20 · cf_agenda_rules (CF, ola CF-0; SOLA). Feedback del cliente, decisiones de Martin (30-oct):
--   A. «El profesional no puede estar en dos servicios distintos a la vez» (por profesional; default = NO puede).
--   B. Paso de la grilla configurable por consultorio y por profesional (selector del staff y turnero).
--   C. Anticipación mínima del turnero por consultorio (default de cada servicio del profesional).
-- ADITIVA: 6 columnas (1 NOT NULL con DEFAULT constante = solo catálogo en PG ≥ 11, sin reescritura; 5 NULL sin
--   DEFAULT) y 5 CHECK. Sin tablas (guard:isolation sin cambios), sin índices, sin tocar Booking.
-- Por qué:
--   * Practitioner.allowParallelServices: el cupo era SOLO profesional + servicio (un turno de Evaluación no frenaba
--     uno de Kinesiología del mismo profesional a la misma hora). false = regla nueva: un turno de OTRO servicio que se
--     pisa bloquea (staff: aviso forzable como sobreturno; turnero: no se ofrece). true = la regla de antes.
--   * SIN BACKFILL (decisión de Martin: el default es que no puede). Los existentes pasan a la regla nueva en el deploy;
--     los turnos ya cargados no se tocan. El precheck pre.M20.crossService lista quién tiene hoy servicios pisados.
--   * {Tenant,Practitioner}.agendaSlotStepMin: paso del SELECTOR de horarios del staff (15/30/45/60; NULL = hereda:
--     profesional → consultorio → 15). NO es "agendaSlotMinutes" (alto de fila de la grilla, solo visual).
--   * {Tenant,Practitioner}.publicSlotStepMin: paso del turnero (NULL = hereda → automático por duración, AS-D9).
--   * Tenant.publicMinLeadMinutes: anticipación mínima online en minutos (NULL = 60). Precedencia
--     PractitionerService.minLeadMinutes > esta > 60. Tope 8 semanas = 80 640 (el turnero llega a hoy + 90 días).
-- CHECK con `IS NULL OR …` explícito.
-- lock_timeout 5 s: Tenant/Practitioner se leen en cada request de agenda; una tx larga → P3009 rápido, no cola.
-- DRIFT ACEPTADO: los CHECK no se expresan en Prisma; si `migrate dev` propone borrarlos, NO se aceptan.
-- Compatible con el código anterior (nadie lee las columnas; el INSERT viejo toma el DEFAULT) → ANTES del deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Tenant"
  ADD COLUMN "agendaSlotStepMin"    INTEGER,
  ADD COLUMN "publicSlotStepMin"    INTEGER,
  ADD COLUMN "publicMinLeadMinutes" INTEGER;
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_agendaSlotStepMin_check"    CHECK ("agendaSlotStepMin" IS NULL OR "agendaSlotStepMin" IN (15,30,45,60)),
  ADD CONSTRAINT "Tenant_publicSlotStepMin_check"    CHECK ("publicSlotStepMin" IS NULL OR "publicSlotStepMin" IN (15,30,45,60)),
  ADD CONSTRAINT "Tenant_publicMinLeadMinutes_check" CHECK ("publicMinLeadMinutes" IS NULL OR "publicMinLeadMinutes" BETWEEN 0 AND 80640);
ALTER TABLE "Practitioner"
  ADD COLUMN "allowParallelServices" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "agendaSlotStepMin"     INTEGER,
  ADD COLUMN "publicSlotStepMin"     INTEGER;
ALTER TABLE "Practitioner"
  ADD CONSTRAINT "Practitioner_agendaSlotStepMin_check" CHECK ("agendaSlotStepMin" IS NULL OR "agendaSlotStepMin" IN (15,30,45,60)),
  ADD CONSTRAINT "Practitioner_publicSlotStepMin_check" CHECK ("publicSlotStepMin" IS NULL OR "publicSlotStepMin" IN (15,30,45,60));
COMMIT;
