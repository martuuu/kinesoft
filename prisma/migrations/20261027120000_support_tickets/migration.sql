-- M19 · support_tickets (PV, Q0; SOLA). Decisión de Martin (literal): «que todos los contactos de formularios y
--   consultas a soporte vayan a la parte de /plataforma de Superadmin, y se abran como "tickets" para resolver desde
--   ahi. Yo me comunico luego con cada cliente».
-- ADITIVA: 1 enum, 3 columnas NULL en SupportThread (sin DEFAULT: solo catálogo), 1 tabla, backfill de `source` sobre
--   una tabla chica (no toca "updatedAt": no hay trigger). El código viejo no lee nada nuevo → ANTES del deploy.
-- Sin ALTER TYPE a propósito: «En curso» NO es un valor de "SupportThreadStatus" (el consultorio lo ve como
--   Abierta/Cerrada y Prisma revienta al leer un valor de enum desconocido si se vuelve atrás el código). Es
--   status = OPEN + "platformTakenAt" NOT NULL. Así tampoco hace falta la tx partida de M15.
-- RLS: SupportThread sigue con M8. SupportTicketNote = SERVICE_ONLY (ENABLE + FORCE, CERO policies): notas internas
--   que el consultorio no ve con ningún GUC (por eso no son columnas de SupportThread, cuyo SELECT es del tenant).
-- DRIFT ACEPTADO (no borrar si migrate diff lo propone): CHECKs, ENABLE/FORCE.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "SupportTicketSource" AS ENUM ('LANDING','PRICING','PLAN_LIBRE','SIGNUP_ASSISTED','ONBOARDING',
  'TENANT_SUPPORT','PLAN_CHANGE','TENANT_SUSPENDED','ACCOUNT_DISABLED','PRIVACY');

ALTER TABLE "SupportThread"
  ADD COLUMN "source" "SupportTicketSource",
  ADD COLUMN "platformTakenAt" TIMESTAMP(3),
  ADD COLUMN "platformTakenById" TEXT; -- superadmin; sin FK (historia)

UPDATE "SupportThread" SET "source" = CASE WHEN "kind" = 'TENANT' THEN 'TENANT_SUPPORT'::"SupportTicketSource"
                                           ELSE 'LANDING'::"SupportTicketSource" END
 WHERE "source" IS NULL;

-- NULL tolerado: un INSERT del código viejo entre M19 y el deploy no lo manda.
ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_source_check" CHECK (
  "source" IS NULL
  OR ("kind" = 'TENANT' AND "source" IN ('TENANT_SUPPORT','PLAN_CHANGE','TENANT_SUSPENDED','PRIVACY'))
  OR ("kind" = 'LEAD'   AND "source" IN ('LANDING','PRICING','PLAN_LIBRE','SIGNUP_ASSISTED','ONBOARDING','ACCOUNT_DISABLED','PRIVACY')));
ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_taken_check" CHECK (
  ("platformTakenAt" IS NULL) = ("platformTakenById" IS NULL));

CREATE TABLE "SupportTicketNote" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL, -- superadmin; sin FK (historia, como SupportMessage.authorUserId)
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicketNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicketNote_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 2000),
  CONSTRAINT "SupportTicketNote_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportThread"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE INDEX "SupportTicketNote_threadId_createdAt_idx" ON "SupportTicketNote"("threadId","createdAt");
ALTER TABLE "SupportTicketNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportTicketNote" FORCE ROW LEVEL SECURITY;
COMMIT;
