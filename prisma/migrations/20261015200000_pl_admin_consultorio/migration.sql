-- M8b · pl_admin_consultorio (bloque PL del §20, inicio de PL-2, va SOLA; 15-oct-2026). Plan §20.17 (decisiones de
--   Martin del 15-oct, noche). Solo DATOS: no cambia el schema (ni Prisma ni objetos de la base).
-- Por qué:
--   • «Consultorio = 5 usuarios de cualquier tipo» (Martin, literal). M8 sembró la fila CONSULTORIO de
--     `SaasPlanConfig` con 4 profesionales + 1 no clínico, y la fila MANDA sobre `PLAN_DEFAULTS`
--     (lib/saas-plans-logic.ts), así que el código de PL-1 seguía frenando al 5.º profesional. Los límites por tipo
--     pasan a NULL (sin tope) y queda solo el total (`maxUsers` = 5, que no se toca). Los cupos a medida por
--     consultorio (`Tenant.max*Override`, PL-D3) siguen mandando sobre esta fila: no se tocan.
--   • «El Administrador/a NUNCA atiende» (Martin, literal; solo el Titular elige). M8 backfilleó `clinical = true` para
--     todos los ADMIN (el default de la columna), y lib/roles.ts `isClinicalMember` los sigue leyendo como clínicos
--     SOLO para no quitarles la agenda antes de esta migración. Normalización:
--       1. ADMIN con agenda EN USO en ese consultorio → PRACTITIONER + `grantSettings = true` (conserva agenda, turnos,
--          pacientes, planes y «Configuración»). «En uso» replica en SQL los bloqueos de pasar a un rol no clínico de
--          lib/team-internal.ts (`countPractitionerLoad` + `countActivePlansAsResponsible`): su `Practitioner` de ESE
--          consultorio tiene ≥ 1 turno futuro PENDING/CONFIRMED, o ≥ 1 paciente asignado sin archivar, o es
--          responsable de ≥ 1 plan ACTIVE sin archivar. Así nadie pierde una agenda que se está usando ni queda un
--          turno/paciente/plan colgado de alguien que ya no atiende. Default del orquestador (§20.17), anotado para
--          el resumen.
--          Solo los ADMIN con `clinical = true`: un ADMIN que ya está como «no atiende» (escrito por el código de
--          PL-1) no se asciende a un rol con historia clínica por una fila vieja; si tuviera carga, queda como está
--          (el mismo estado que dejaba PL-1).
--          Las membresías suspendidas (`disabledAt`) entran igual: es una normalización de datos; suspendida sigue
--          suspendida y no ocupa ni cambia de lugar hasta que la reactiven.
--       2. El resto de los ADMIN → `clinical = false` (dejan de leer HC y de ser reservables). `grantSettings` NO se
--          toca (M8 ya los dejó en true). Su `Practitioner` NO se borra (turnos pasados, sesiones e historia lo
--          referencian): queda como historia, igual que al quitar a alguien del equipo.
--     Cupo: el convertido sigue en un lugar clínico (ADMIN clínico ya contaba como profesional); el que pasa a no
--     clínico cambia de tipo de lugar. Con Consultorio/Clínica sin tope por tipo no cambia nada; solo un
--     `maxStaffOverride` a medida podría quedar excedido (no se deshabilita a nadie acá: el precheck del RUNBOOK lo
--     muestra y Plataforma lo ajusta).
--
-- ADITIVA: solo UPDATE de filas existentes, idempotente (re-correrla no cambia nada: la 1.ª sentencia es fija y las
--   de Membership filtran `role = 'ADMIN' AND clinical = true`). Sin DDL. NO toca `updatedAt` de nada: Membership no
--   tiene la columna, SaasPlanConfig la tiene con `@updatedAt` de Prisma (lo pone el cliente; no hay trigger) y este
--   SQL no la nombra; Tenant no se toca.
--   Compatible hacia atrás: el código viejo (pre-PL-1) no lee `clinical` ni `SaasPlanConfig`, y un ADMIN que pasa a
--   PRACTITIONER sigue teniendo agenda y HC con cualquier versión. Por eso puede ir antes del deploy de PL-1/PL-2.
--   «Ahora» = `now() AT TIME ZONE 'UTC'`: `Booking.scheduledFor` es `timestamp` sin zona guardado en UTC (Prisma);
--   así no depende del TimeZone de la sesión.
--
-- Locks: ROW EXCLUSIVE sobre Membership y SaasPlanConfig y locks de fila solo en las filas que cambian (decenas,
--   milisegundos). Las subconsultas leen Booking/Patient/TreatmentProgram sin lockear. lock_timeout: si alguna fila
--   está tomada, falla rápido en vez de colgar el login (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Consultorio: 5 usuarios de cualquier tipo (sin tope por tipo).
UPDATE "SaasPlanConfig" SET "maxProfessionals" = NULL, "maxStaff" = NULL WHERE "plan" = 'CONSULTORIO';

-- 2a. ADMIN con agenda en uso → PRACTITIONER + «Configuración».
UPDATE "Membership" m SET "role" = 'PRACTITIONER', "clinical" = true, "grantSettings" = true
WHERE m."role" = 'ADMIN' AND m."clinical" = true AND EXISTS (
  SELECT 1 FROM "Practitioner" p
  WHERE p."tenantId" = m."tenantId" AND p."userId" = m."userId" AND (
    EXISTS (SELECT 1 FROM "Booking" b
            WHERE b."tenantId" = p."tenantId" AND b."practitionerId" = p."id"
              AND b."scheduledFor" >= (now() AT TIME ZONE 'UTC') AND b."status" IN ('PENDING', 'CONFIRMED'))
    OR EXISTS (SELECT 1 FROM "Patient" pa
               WHERE pa."tenantId" = p."tenantId" AND pa."assignedPractitionerId" = p."id" AND pa."archivedAt" IS NULL)
    OR EXISTS (SELECT 1 FROM "TreatmentProgram" tp
               WHERE tp."tenantId" = p."tenantId" AND tp."practitionerId" = p."id"
                 AND tp."status" = 'ACTIVE' AND tp."archivedAt" IS NULL)
  )
);

-- 2b. El resto de los ADMIN: no atienden.
UPDATE "Membership" SET "clinical" = false WHERE "role" = 'ADMIN' AND "clinical" = true;

COMMIT;
