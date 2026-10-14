-- M6 · identity_access (bloque IAM, ola IAM-1, va SOLA; 14-oct-2026). Plan §19.2 decisión 6, §19.4, §19.10 IAM-D2.
-- Por qué:
--   • Practitioner deja de ser único GLOBAL por usuario y pasa a único POR CONSULTORIO (tenantId, userId).
--     Decisión 6 de Martin (14-oct): una misma persona puede ser profesional en varios consultorios con el mismo
--     usuario. Con el único global, un kine de A que aceptaba una invitación de B quedaba con membresía en B pero
--     SIN Practitioner ahí (accept-action lo salteaba), y `buildActor` no lo dejaba entrar a B (bucle de
--     redirecciones, hallazgo [A] de §19.1); y un removido que quería crear su propio consultorio chocaba con
--     PractitionerElsewhereError («escribinos a soporte»).
--   • Membership.disabledAt/disabledById: suspender a un miembro sin borrarlo (IAM-4c). Nadie las escribe en esta
--     ola; `bookablePractitionerWhere({ includeDisabledFilter })` (IAM-0c) ya las lee.
--   • Invitation.revokedAt/revokedById/acceptedByUserId/lastSentAt/sendCount/priorTokens: anular, reenviar sin
--     invalidar el link anterior (priorTokens guarda los HASHES viejos, nunca el token crudo) y saber quién aceptó
--     (IAM-2a/2b). Solo acceptedByUserId se escribe en esta ola (accept-action).
--   • Tabla EmailLog: una fila por intento de mail (también cuando NO salió), escrita por el sink de `sendEmail`
--     (`lib/email/log.ts`) por el canal service. Guarda hash + máscara del destinatario y el HOST del link; nunca
--     el email completo ni el link (lleva el token). tenantId NULL = mail sin consultorio (signup, olvidé
--     contraseña): invisible para la app por la policy (NULL = x es NULL → falso).
--
-- EXCEPCIÓN a "todo aditivo", APROBADA POR MARTIN EL 14-OCT (IAM-D2; mismo caso que el DROP de
--   "Patient_userId_key" en M1 20261004120000_plans_booking_link, aprobado el 03-oct): DROP INDEX
--   "Practitioner_userId_key". Solo RELAJA la unicidad (de global a por consultorio): ninguna fila existente la
--   viola y el código viejo la tolera — busca el Practitioner del usuario con findUnique({ userId }) (=
--   `WHERE "userId" = $1 LIMIT 1`, sin depender del índice) y NUNCA crea un segundo Practitioner para el mismo
--   usuario (lo chequea antes), así que entre esta migración y el deploy del código nuevo no aparecen duplicados.
--   Lo único que se pierde en esa ventana: la red de la base contra dos altas simultáneas del paso 2 del
--   onboarding del MISMO usuario (el código nuevo la reemplaza con un advisory lock por usuario en
--   `bootstrapTenant`).
-- Fuera de eso: sin DROP, sin SET NOT NULL sobre columnas existentes, sin UPDATE de filas. Las columnas nuevas son
--   nullables sin default o NOT NULL con default constante (Postgres 11+: solo catálogo, sin rewrite).
--   Ni Membership ni Invitation tienen updatedAt (optimistic lock): no se mueve nada.
--
-- TABLA NUEVA "EmailLog" con RLS ENABLE + FORCE + "EmailLog_tenant_isolation" (mismo DO-block que
--   agenda_foundations, M1 y M4; la verifica `npm run guard:isolation`). Sin privilegios explícitos: kinesoft_app
--   y kinesoft_service los reciben por DEFAULT PRIVILEGES (prisma/roles.*.sql); los roles de la Data API siguen
--   sin nada desde M2 (guard 3c).
--
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` / `migrate diff` los propone;
--   migrate dev está prohibido en este repo):
--   • CHECK "EmailLog_status_check";
--   • la policy "EmailLog_tenant_isolation" (y ENABLE/FORCE).
--
-- Locks: el CREATE UNIQUE INDEX sobre Practitioner toma SHARE; el DROP INDEX toma ACCESS EXCLUSIVE sobre
--   Practitioner (frena también lecturas) hasta el COMMIT, igual que M1 con Patient. Practitioner tiene pocas
--   filas: la ventana es de milisegundos. Los ADD COLUMN toman ACCESS EXCLUSIVE sobre Membership e Invitation.
--   lock_timeout: si alguna está tomada, falla rápido en vez de colgar el login (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Prechequeo: el único nuevo fallaría igual con un duplicado, pero con un mensaje críptico. El test de
-- integración extrae y ejecuta el SQL entre estos marcadores: no los muevas ni los renombres.
-- >>> PRECHECK BEGIN
DO $$
DECLARE
  dups integer;
BEGIN
  SELECT count(*) INTO dups FROM (
    SELECT 1 FROM "Practitioner" GROUP BY "tenantId", "userId" HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN
    RAISE EXCEPTION 'identity_access: hay % par(es) (tenantId, userId) repetidos en "Practitioner"; resolvelos antes de migrar (RUNBOOK fila M6)', dups;
  END IF;
END $$;
-- <<< PRECHECK END

-- ── Practitioner: único por consultorio ──────────────────────────────
-- EXCEPCIÓN aprobada por Martin (14-oct, IAM-D2). Ver cabecera. El índice por userId reemplaza al único global
-- para las búsquedas "¿en qué consultorios es profesional este usuario?".
CREATE UNIQUE INDEX "Practitioner_tenantId_userId_key" ON "Practitioner"("tenantId", "userId");
DROP INDEX "Practitioner_userId_key";
CREATE INDEX "Practitioner_userId_idx" ON "Practitioner"("userId");

-- ── Membership: suspensión (IAM-4c) ──────────────────────────────────
ALTER TABLE "Membership"
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "disabledById" TEXT;

-- ── Invitation: anular, reenviar, quién aceptó (IAM-2) ───────────────
ALTER TABLE "Invitation"
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedById" TEXT,
  ADD COLUMN "acceptedByUserId" TEXT,
  ADD COLUMN "lastSentAt" TIMESTAMP(3),
  ADD COLUMN "sendCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "priorTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── EmailLog ─────────────────────────────────────────────────────────
-- `id` sin default en SQL: lo genera Prisma (@default(cuid())), como el resto de las tablas.
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" TEXT NOT NULL,
    "toHash" TEXT NOT NULL,
    "toMasked" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "transport" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "reason" TEXT,
    "linkHost" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id"),
    -- Los 4 valores de `emailLogStatus` (lib/email/log.ts). Drift aceptado.
    CONSTRAINT "EmailLog_status_check" CHECK ("status" IN ('sent', 'skipped', 'failed', 'blocked'))
);

CREATE INDEX "EmailLog_tenantId_createdAt_idx" ON "EmailLog"("tenantId", "createdAt");
CREATE INDEX "EmailLog_entity_entityId_createdAt_idx" ON "EmailLog"("entity", "entityId", "createdAt");

-- Borrar un consultorio borra su registro de mails (no es historia clínica ni contable).
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS: la tabla nueva con tenantId ─────────────────────────────────
-- Mismo loop y mismo nombre de policy que 20260725120000_rls_policies, agenda_foundations, M1 y M4.
-- app_current_tenant_id() devuelve NULL sin GUC → ninguna fila visible y ningún INSERT pasa el WITH CHECK fuera
-- de runWithRls. El sink escribe por el canal service (BYPASSRLS).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EmailLog']
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
