-- A3c · tenant_onboarding (30-sep-2026)
--
-- Por qué: el signup pasa a ser self-service con email verificado + stepper de
-- alta del consultorio (decisión del dueño, 30-sep). El layout de la app manda a
-- `/onboarding` a quien tenga tenant sin `onboardingCompletedAt`, y el stepper
-- guarda los datos de contacto públicos del consultorio.
--
-- Aditiva (expand): 4 columnas nullable, sin DROP ni NOT NULL. La dirección NO
-- va acá: la trae `Location` en B-pre (sedes), para no rehacerla.
--
-- Backfill: todo tenant existente se marca como onboarding completo con su
-- `createdAt`, así el cliente vivo nunca ve el stepper. Idempotente (solo
-- toca filas en NULL). Tenant no tiene policy RLS por tenantId (es la raíz),
-- así que no hay policies nuevas.

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "phone" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "whatsapp" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "publicEmail" TEXT;

-- Backfill
UPDATE "Tenant" SET "onboardingCompletedAt" = "createdAt" WHERE "onboardingCompletedAt" IS NULL;
