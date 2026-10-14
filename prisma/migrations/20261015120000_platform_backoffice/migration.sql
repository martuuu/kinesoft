-- M7 · platform_backoffice (bloque BO, ola BO0, va SOLA; 14-oct-2026). Plan §19.5 (tabla BO0), §19.2 decisión 3,
--   §19.10 BO-D1..D9; contratos C-BO1, C-BO5, C-BO7, C-BO9 (bo-contracts).
-- Por qué:
--   • Tenant.status (ACTIVE | SUSPENDED | CLOSED) + statusChangedAt/statusReason: el ACCESO del consultorio pasa a ser
--     CALCULADO (`tenantAccessFor`, C-BO1) a partir del estado administrativo + la suscripción + el trial. Hoy no hay
--     forma de suspender ni dar de baja un consultorio sin borrarlo (BO2-D: suspender/reactivar/baja «sin borrar»).
--   • Tenant.subscriptionStatusChangedAt: la gracia de PAST_DUE (10 días, BO-D2) se cuenta desde que cambió la
--     suscripción; sin la fecha no hay cómo calcularla. La escribe solo el escritor único de entitlements (C-BO6).
--   • Tenant.seatLimitOverride: cupos por plan (BO-D7: Free 1 · Base 3 · PRO 10 · Enterprise a medida); el override
--     es el «a medida». NULL = el del plan (`seatLimitFor`, C-BO7). CHECK ≥ 1: un consultorio sin lugar para su
--     titular no tiene sentido.
--   • UserProfile.disabledAt/disabledReason: usuario deshabilitado a nivel PLATAFORMA (todas sus membresías y el
--     portal), distinto de Membership.disabledAt (M6, suspensión dentro de un consultorio). Lo lee `getSessionBlock`
--     (C-BO2) y lo escribe BO2-C.
--   • Tabla PlatformAuditEvent: registro GLOBAL de las acciones del superadmin. No alcanza con AuditEvent porque
--     `AuditEvent.tenantId` es NOT NULL y el superadmin deja de necesitar un consultorio «casa» (PlatformActor con
--     homeTenantId null, C-BO2): dar/quitar superadmin, deshabilitar un usuario o reparar un huérfano de Auth no
--     tienen consultorio. Cada acción sobre un consultorio escribe las DOS filas (C-BO5). Solo inserción: un trigger
--     rechaza UPDATE, DELETE y TRUNCATE incluso para el owner (es la prueba de lo que hizo la plataforma);
--     `idempotencyKey` único para que un doble submit no duplique. tenantId nullable con FK RESTRICT: un
--     consultorio con historial de plataforma no se borra (la baja es lógica, status = CLOSED).
--   • Tabla SupportSession: «Entrar como soporte» (decisión 3 de Martin). SIN VENCIMIENTO — decisión de Martin:
--     termina con «Salir de soporte» o al cerrar sesión (endedAt/endedReason); por eso NO hay CHECK de duración
--     ni columna expiresAt. `reason` obligatorio de 10 a 500 caracteres (se le manda al OWNER por mail y queda en
--     la lista «Accesos de soporte» de Configuración). Índice PARCIAL único: un superadmin tiene a lo sumo UNA
--     sesión abierta (en cualquier consultorio); cerradas, todas las que quiera. scope ADMIN_CONFIG = lectura de
--     todo menos lo clínico + escritura de Configuración (C-BO4); el enum deja lugar para otros alcances.
--   • Tabla TenantSlugAlias: cambio de slug con alias 301 permanente (BO-D9). El slug viejo apunta al consultorio y
--     el turnero (canal service) redirige.
--
-- ADITIVA. Sin DROP, sin SET NOT NULL sobre columnas existentes, sin UPDATE de filas. Las columnas nuevas son
--   nullables sin default o NOT NULL con default constante (Postgres 11+: solo catálogo, sin rewrite de Tenant).
--   Compatible hacia atrás: el código viejo no lee ninguna columna ni tabla nueva (Prisma solo selecciona lo que
--   conoce), así que puede aplicarse ANTES del deploy del bloque BO.
--
-- RLS de las tablas nuevas (las tres tienen tenantId; `npm run guard:isolation` las clasifica):
--   • PlatformAuditEvent y TenantSlugAlias → SERVICE_ONLY: ENABLE + FORCE y CERO policies. kinesoft_app tiene el
--     grant por DEFAULT PRIVILEGES, pero RLS sin policy es default-deny: no ve ni escribe nada con ningún GUC. Solo
--     el canal service (BYPASSRLS: Plataforma, turnero) las usa.
--   • SupportSession → TENANT_READONLY: ENABLE + FORCE y UNA policy FOR SELECT ("tenantId" = app_current_tenant_id()):
--     el OWNER ve en Configuración quién entró a su consultorio. Sin policy de escritura: la abre y la cierra solo
--     la plataforma por el canal service.
--   Sin privilegios explícitos: kinesoft_app y kinesoft_service los reciben por DEFAULT PRIVILEGES
--   (prisma/roles.*.sql); los roles de la Data API siguen sin nada desde M2 (guard 3c).
--
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` / `migrate diff` los propone;
--   migrate dev está prohibido en este repo):
--   • CHECK "Tenant_seatLimitOverride_check" y CHECK "SupportSession_reason_check";
--   • el índice PARCIAL único "SupportSession_one_open_per_superadmin" (WHERE "endedAt" IS NULL);
--   • la función platform_audit_event_append_only() y los triggers "PlatformAuditEvent_append_only" /
--     "PlatformAuditEvent_no_truncate";
--   • ENABLE/FORCE de las tres tablas y la policy "SupportSession_tenant_read".
--
-- Locks: ADD COLUMN toma ACCESS EXCLUSIVE sobre Tenant y UserProfile hasta el COMMIT (los lee cada request: la
--   ventana es de milisegundos porque no hay rewrite; ADD CONSTRAINT CHECK valida las filas, todas NULL). Las FKs
--   nuevas toman SHARE ROW EXCLUSIVE sobre Tenant/UserProfile. lock_timeout: si alguna está tomada, falla rápido en
--   vez de colgar el login (RUNBOOK P3009).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── Enums ────────────────────────────────────────────────────────────
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
-- Soporte: lectura de todo menos lo clínico + escritura de Configuración (decisión 3, C-BO4).
CREATE TYPE "SupportScope" AS ENUM ('ADMIN_CONFIG');

-- ── Tenant: estado administrativo, fecha de cambio de suscripción, cupos ──
ALTER TABLE "Tenant"
  ADD COLUMN "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "statusChangedAt" TIMESTAMP(3),
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "subscriptionStatusChangedAt" TIMESTAMP(3),
  ADD COLUMN "seatLimitOverride" INTEGER,
  -- Drift aceptado. NULL = el cupo del plan.
  ADD CONSTRAINT "Tenant_seatLimitOverride_check" CHECK ("seatLimitOverride" IS NULL OR "seatLimitOverride" >= 1);

-- ── UserProfile: deshabilitado a nivel plataforma ────────────────────
ALTER TABLE "UserProfile"
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "disabledReason" TEXT;

-- ── PlatformAuditEvent ───────────────────────────────────────────────
-- `id` sin default en SQL: lo genera Prisma (@default(cuid())), como el resto de las tablas. actorId/targetUserId
-- sin FK a propósito: el registro sobrevive a que se borre el usuario (actorEmail queda como foto).
CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "tenantId" TEXT,
    "targetUserId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAuditEvent_idempotencyKey_key" ON "PlatformAuditEvent"("idempotencyKey");
-- Visor de Auditoría (BO3-E): orden global con cursor (createdAt DESC, id).
CREATE INDEX "PlatformAuditEvent_createdAt_id_idx" ON "PlatformAuditEvent"("createdAt" DESC, "id");
CREATE INDEX "PlatformAuditEvent_tenantId_createdAt_idx" ON "PlatformAuditEvent"("tenantId", "createdAt");
CREATE INDEX "PlatformAuditEvent_actorId_createdAt_idx" ON "PlatformAuditEvent"("actorId", "createdAt");
CREATE INDEX "PlatformAuditEvent_targetUserId_createdAt_idx" ON "PlatformAuditEvent"("targetUserId", "createdAt");

ALTER TABLE "PlatformAuditEvent" ADD CONSTRAINT "PlatformAuditEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Solo inserción, también para el owner (BYPASSRLS no saltea triggers). Drift aceptado. Limpiar filas de TEST
-- requiere `SET LOCAL session_replication_role = replica` (superusuario: solo el Docker local; ver
-- tests/helpers/tenant-factory.ts `deleteTenantDeep`). En prod el owner de Supabase no es superusuario.
CREATE FUNCTION platform_audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- SQLSTATE P0001 (raise_exception) a propósito: distinto del 42501 de RLS, para no confundirlos al traducirlo.
  RAISE EXCEPTION 'PlatformAuditEvent es solo inserción: % rechazado', TG_OP;
END;
$$;

CREATE TRIGGER "PlatformAuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_event_append_only();

CREATE TRIGGER "PlatformAuditEvent_no_truncate"
  BEFORE TRUNCATE ON "PlatformAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_event_append_only();

-- ── SupportSession ───────────────────────────────────────────────────
-- SIN vencimiento (decisión de Martin): ni expiresAt ni CHECK de duración. Ver cabecera.
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "superadminId" TEXT NOT NULL,
    "scope" "SupportScope" NOT NULL DEFAULT 'ADMIN_CONFIG',
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id"),
    -- Drift aceptado. btrim: un motivo de puros espacios no cuenta.
    CONSTRAINT "SupportSession_reason_check" CHECK (length(btrim("reason")) BETWEEN 10 AND 500)
);

-- Lista «Accesos de soporte» de Configuración (por consultorio) y la del superadmin.
CREATE INDEX "SupportSession_tenantId_startedAt_idx" ON "SupportSession"("tenantId", "startedAt");
CREATE INDEX "SupportSession_superadminId_startedAt_idx" ON "SupportSession"("superadminId", "startedAt");
-- PARCIAL: una sesión abierta por superadmin. Prisma no lo expresa: drift aceptado, NO borrar si `migrate dev`
-- lo propone.
CREATE UNIQUE INDEX "SupportSession_one_open_per_superadmin" ON "SupportSession"("superadminId") WHERE "endedAt" IS NULL;

ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_superadminId_fkey"
  FOREIGN KEY ("superadminId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── TenantSlugAlias ──────────────────────────────────────────────────
CREATE TABLE "TenantSlugAlias" (
    "slug" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSlugAlias_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX "TenantSlugAlias_tenantId_idx" ON "TenantSlugAlias"("tenantId");

ALTER TABLE "TenantSlugAlias" ADD CONSTRAINT "TenantSlugAlias_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────
-- SERVICE_ONLY: ENABLE + FORCE sin policies (default-deny para kinesoft_app con cualquier GUC).
ALTER TABLE "PlatformAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAuditEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TenantSlugAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSlugAlias" FORCE ROW LEVEL SECURITY;

-- TENANT_READONLY: el consultorio LEE sus sesiones de soporte; nadie escribe por la app.
ALTER TABLE "SupportSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupportSession_tenant_read" ON "SupportSession"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());

COMMIT;
