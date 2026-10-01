-- B-pre B1.0 · catalog_global (30-sep-2026) — migración 1 de 2 de B-pre
-- (la 2 es `agenda_foundations`, M-agenda, en la ola B2.0).
--
-- Por qué: hoy cada consultorio tipea a mano sus obras sociales (Insurer.name),
-- sus planes (Coverage.planName) y sus servicios (Service.name): no hay forma de
-- saber que "OSDE", "O.S.D.E." y "Osde 210" son la misma prestadora, ni de
-- ofrecer un catálogo para el alta, el turnero y (bloque D) el marketplace. Esta
-- migración crea el CATÁLOGO GLOBAL de referencia (especialidades, prácticas,
-- prestadoras y planes) y los punteros opcionales desde las tablas del tenant.
--
-- Aditiva (expand/contract), segura con la app vieja corriendo:
--   • 6 tablas nuevas + 2 enums; ningún DROP, ningún SET NOT NULL.
--   • 3 columnas NULLABLE nuevas en tablas vivas (Insurer.payerId,
--     Coverage.payerPlanId, Service.practiceId) con FK ON DELETE SET NULL. Sin
--     DEFAULT → ADD COLUMN no reescribe la tabla. Sin backfill ni auto-link:
--     el vínculo lo hace el usuario desde la UI (sugerencia por matchKey).
--   • `Coverage.planName` queda como cache de display (no se toca).
--
-- RLS (en la MISMA migración, regla del repo):
--   • GLOBAL READ-ONLY — Specialty, Practice, PracticeSpecialty, Payer,
--     CatalogImportRun: ENABLE + FORCE + una sola policy `FOR SELECT USING (true)`
--     y NINGUNA policy de escritura. Mismo patrón que ExerciseMedia/Article
--     (20260803022653). Con RLS activo, la ausencia de policy para un comando es
--     default-deny: el rol `kinesoft_app` (sin BYPASSRLS) recibe "new row
--     violates row-level security policy" en INSERT, y UPDATE/DELETE no ven
--     ninguna fila (0 filas afectadas; Prisma `update` tira P2025). Esto vale
--     aunque `kinesoft_app` tenga GRANT INSERT/UPDATE/DELETE por los DEFAULT
--     PRIVILEGES de prisma/roles.*.sql: el GRANT habilita el comando, RLS
--     filtra las filas. Lo escriben solo el import (scripts/catalog-import.ts)
--     y Plataforma, por el canal `prismaService` (BYPASSRLS).
--   • PayerPlan: split como Exercise/Condition — lectura = globales
--     (tenantId NULL) + propios; escritura = solo propios (un consultorio puede
--     proponer un plan, nunca tocar un global ni uno de otro tenant).
--   • Verificado por scripts/guard-tenant-isolation.mjs (set GLOBAL_READONLY) y
--     tests/integration/rls-isolation.test.ts.
--
-- Mientras prod conecte con un rol BYPASSRLS, las policies son inertes ahí
-- (igual que el resto de B2); la barrera en prod sigue siendo `where tenantId`.

BEGIN;

-- CreateEnum
CREATE TYPE "CatalogSource" AS ENUM ('REFEPS', 'NOMENCLADOR_NACIONAL', 'PMO', 'RNOS', 'RNEMP', 'PROVINCIAL', 'CURATED', 'TENANT');

-- CreateEnum
CREATE TYPE "PayerKind" AS ENUM ('OBRA_SOCIAL', 'PREPAGA', 'MUTUAL', 'OTRA');

-- AlterTable
ALTER TABLE "Coverage" ADD COLUMN     "payerPlanId" TEXT;

-- AlterTable
ALTER TABLE "Insurer" ADD COLUMN     "payerId" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "practiceId" TEXT;

-- CreateTable
CREATE TABLE "Specialty" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "aliases" TEXT[],
    "source" "CatalogSource" NOT NULL,
    "sourceRef" TEXT,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "curatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Practice" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "aliases" TEXT[],
    "code" TEXT,
    "nomenclador" TEXT,
    "defaultDurationMin" INTEGER,
    "source" "CatalogSource" NOT NULL,
    "sourceRef" TEXT,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "curatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Practice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSpecialty" (
    "practiceId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,

    CONSTRAINT "PracticeSpecialty_pkey" PRIMARY KEY ("practiceId","specialtyId")
);

-- CreateTable
CREATE TABLE "Payer" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "kind" "PayerKind" NOT NULL,
    "registryCode" TEXT,
    "cuit" TEXT,
    "province" TEXT,
    "matchKey" TEXT NOT NULL,
    "aliases" TEXT[],
    "source" "CatalogSource" NOT NULL,
    "sourceRef" TEXT,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "curatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayerPlan" (
    "id" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "source" "CatalogSource" NOT NULL,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "promotedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogImportRun" (
    "id" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "conflicts" JSONB NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ranBy" TEXT,

    CONSTRAINT "CatalogImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Specialty_slug_key" ON "Specialty"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Specialty_matchKey_key" ON "Specialty"("matchKey");

-- CreateIndex
CREATE UNIQUE INDEX "Practice_slug_key" ON "Practice"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Practice_matchKey_key" ON "Practice"("matchKey");

-- CreateIndex
CREATE INDEX "PracticeSpecialty_specialtyId_idx" ON "PracticeSpecialty"("specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "Payer_slug_key" ON "Payer"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Payer_matchKey_key" ON "Payer"("matchKey");

-- CreateIndex
CREATE INDEX "PayerPlan_payerId_idx" ON "PayerPlan"("payerId");

-- CreateIndex
CREATE INDEX "PayerPlan_tenantId_idx" ON "PayerPlan"("tenantId");

-- CreateIndex
CREATE INDEX "Coverage_payerPlanId_idx" ON "Coverage"("payerPlanId");

-- CreateIndex
CREATE INDEX "Insurer_tenantId_payerId_idx" ON "Insurer"("tenantId", "payerId");

-- CreateIndex
CREATE INDEX "Service_practiceId_idx" ON "Service"("practiceId");

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_payerPlanId_fkey" FOREIGN KEY ("payerPlanId") REFERENCES "PayerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insurer" ADD CONSTRAINT "Insurer_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSpecialty" ADD CONSTRAINT "PracticeSpecialty_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSpecialty" ADD CONSTRAINT "PracticeSpecialty_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerPlan" ADD CONSTRAINT "PayerPlan_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerPlan" ADD CONSTRAINT "PayerPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Unicidad de PayerPlan (índices PARCIALES, a mano) ────────────────
-- NO BORRAR si `prisma migrate dev` propone dropearlos: Prisma no sabe
-- expresar índices parciales y los ve como drift. (Igual que el índice único
-- parcial de Booking.) Con NULLs distintos en Postgres, un UNIQUE común sobre
-- (payerId, tenantId, slug) NO evitaría dos globales con el mismo slug; por eso
-- los globales tienen su propio índice.
--   • globales: un slug por prestadora entre las filas tenantId NULL;
--   • de tenant: un slug por prestadora y por consultorio (dos consultorios
--     pueden proponer el mismo plan hasta que Plataforma lo promueva).
CREATE UNIQUE INDEX "PayerPlan_payerId_slug_global_key"
  ON "PayerPlan"("payerId", "slug") WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX "PayerPlan_payerId_tenantId_slug_key"
  ON "PayerPlan"("payerId", "tenantId", "slug") WHERE "tenantId" IS NOT NULL;

-- ── RLS: catálogo global de solo lectura ────────────────────────────
-- FORCE para que también el owner de la tabla obedezca (superuser/BYPASSRLS
-- igual hace bypass: ese es el canal de escritura del import y Plataforma).
ALTER TABLE "Specialty" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Specialty" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS specialty_read ON "Specialty";
CREATE POLICY specialty_read ON "Specialty" FOR SELECT USING (true);

ALTER TABLE "Practice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Practice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS practice_read ON "Practice";
CREATE POLICY practice_read ON "Practice" FOR SELECT USING (true);

ALTER TABLE "PracticeSpecialty" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PracticeSpecialty" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS practice_specialty_read ON "PracticeSpecialty";
CREATE POLICY practice_specialty_read ON "PracticeSpecialty" FOR SELECT USING (true);

ALTER TABLE "Payer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payer_read ON "Payer";
CREATE POLICY payer_read ON "Payer" FOR SELECT USING (true);

ALTER TABLE "CatalogImportRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogImportRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_import_run_read ON "CatalogImportRun";
CREATE POLICY catalog_import_run_read ON "CatalogImportRun" FOR SELECT USING (true);

-- ── RLS: PayerPlan, split como Exercise (20260725120000_rls_policies) ──
-- `tenantId IS NULL` = plan global del catálogo (visible para todos);
-- `tenantId = <id>` = plan propuesto por ese consultorio. Read = global OR own;
-- write = own only. app_current_tenant_id() devuelve NULL sin GUC → la
-- escritura con tenantId NULL nunca pasa el WITH CHECK (NULL = x es NULL).
ALTER TABLE "PayerPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayerPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payer_plan_read ON "PayerPlan";
CREATE POLICY payer_plan_read ON "PayerPlan"
  FOR SELECT USING ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id());
DROP POLICY IF EXISTS payer_plan_write ON "PayerPlan";
CREATE POLICY payer_plan_write ON "PayerPlan"
  FOR ALL USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

COMMIT;
