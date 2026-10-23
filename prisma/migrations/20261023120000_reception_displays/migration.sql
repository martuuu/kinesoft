-- M17 · reception_displays (TV, T7; SOLA). Plan §21.8, §22.7, §26.4; ADR-028.
-- Staff escribe por runWithRls (policy por tenant); el dispositivo (vincular, lastSeenAt) por prismaService con
--   id + tenantId a mano (SECURITY). Categoría por defecto: la escritura del staff conserva RLS como 2ª barrera.
-- Secretos nunca en claro: pairingCodeHash = HMAC-SHA256 con clave derivada del server (8 chars Crockford = 40 bits:
--   un sha256 pelado se revierte offline); deviceSecretHash = sha256 de 256 bits aleatorios.
-- mediaRef = id canónico (nunca la URL cruda: el iframe lo arma lib/youtube.ts). Regex = las de lib/youtube.ts (test).
-- ADITIVA: 5 enums + 1 tabla. No toca tablas existentes → antes del deploy.
-- DRIFT ACEPTADO (NO borrar si migrate diff lo propone): ReceptionDisplay_pairingCodeHash_key,
--   ReceptionDisplay_tenant_name_live_key (parciales, expresión), ReceptionDisplay_location_tenant_fkey, CHECKs, policy.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TYPE "DisplayNameMode"        AS ENUM ('SHORT_NAME', 'TURN_TIME');
CREATE TYPE "DisplayTheme"           AS ENUM ('DARK', 'LIGHT');
CREATE TYPE "DisplayMediaKind"       AS ENUM ('NONE', 'VIDEO', 'LIVE', 'PLAYLIST', 'CHANNEL_LIVE');
CREATE TYPE "DisplayMediaLayout"     AS ENUM ('SIDE', 'HERO_IDLE');
CREATE TYPE "DisplayMediaDuringCall" AS ENUM ('DUCK', 'HIDE', 'KEEP');
CREATE TABLE "ReceptionDisplay" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "locationId" TEXT, "name" TEXT NOT NULL,
  "nameMode" "DisplayNameMode" NOT NULL DEFAULT 'SHORT_NAME', "theme" "DisplayTheme" NOT NULL DEFAULT 'DARK',
  "mediaKind" "DisplayMediaKind" NOT NULL DEFAULT 'NONE', "mediaRef" TEXT,
  "mediaLayout" "DisplayMediaLayout" NOT NULL DEFAULT 'SIDE', "mediaMuted" BOOLEAN NOT NULL DEFAULT true,
  "mediaDuringCall" "DisplayMediaDuringCall" NOT NULL DEFAULT 'DUCK',
  "pairingCodeHash" TEXT, "pairingExpiresAt" TIMESTAMP(3), "deviceSecretHash" TEXT, "pairedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "createdByUserId" TEXT NOT NULL, "revokedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceptionDisplay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceptionDisplay_name_check" CHECK (char_length("name") BETWEEN 1 AND 60 AND "name" = btrim("name")),
  CONSTRAINT "ReceptionDisplay_media_check" CHECK (COALESCE(
       ("mediaKind" = 'NONE' AND "mediaRef" IS NULL)
    OR ("mediaKind" IN ('VIDEO', 'LIVE') AND "mediaRef" ~ '^[A-Za-z0-9_-]{11}$')
    OR ("mediaKind" = 'PLAYLIST'     AND "mediaRef" ~ '^(PL|UU|OL|FL)[A-Za-z0-9_-]{10,62}$')
    OR ("mediaKind" = 'CHANNEL_LIVE' AND "mediaRef" ~ '^UC[A-Za-z0-9_-]{22}$'), false)),
  CONSTRAINT "ReceptionDisplay_pairing_check" CHECK (("pairingCodeHash" IS NULL) = ("pairingExpiresAt" IS NULL)
    AND ("pairingCodeHash" IS NULL OR "pairingCodeHash" ~ '^[A-Za-z0-9_-]{43}$')),
  CONSTRAINT "ReceptionDisplay_device_check" CHECK ("deviceSecretHash" IS NULL
    OR ("deviceSecretHash" ~ '^[A-Za-z0-9_-]{43}$' AND "pairedAt" IS NOT NULL)),
  CONSTRAINT "ReceptionDisplay_revoked_check" CHECK ("revokedAt" IS NULL
    OR ("deviceSecretHash" IS NULL AND "pairingCodeHash" IS NULL AND "revokedByUserId" IS NOT NULL)),
  CONSTRAINT "ReceptionDisplay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReceptionDisplay_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- FK salta RLS y prod es BYPASSRLS: la sede es de ESTE tenant.
  CONSTRAINT "ReceptionDisplay_location_tenant_fkey" FOREIGN KEY ("locationId", "tenantId")
    REFERENCES "Location"("id", "tenantId") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ReceptionDisplay_tenantId_idx"   ON "ReceptionDisplay"("tenantId");
CREATE INDEX "ReceptionDisplay_locationId_idx" ON "ReceptionDisplay"("locationId");
-- PARCIAL: la TV busca el código SIN tenant → único global mientras está vivo.
CREATE UNIQUE INDEX "ReceptionDisplay_pairingCodeHash_key" ON "ReceptionDisplay"("pairingCodeHash") WHERE "pairingCodeHash" IS NOT NULL;
-- PARCIAL: dos «Recepción PB» vivas confunden y frena el doble submit del alta.
CREATE UNIQUE INDEX "ReceptionDisplay_tenant_name_live_key" ON "ReceptionDisplay"("tenantId", lower("name")) WHERE "revokedAt" IS NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ReceptionDisplay'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())', t || '_tenant_isolation', t);
  END LOOP; END $$;
COMMIT;
