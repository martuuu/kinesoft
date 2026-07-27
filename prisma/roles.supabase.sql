-- KineSoft — Ola B2b · Roles de aplicación para Supabase (PRODUCCIÓN)
-- ---------------------------------------------------------------------------
-- Por qué: hoy la app conecta como `postgres`. OJO: en Supabase `postgres` NO
-- es un superuser real, pero SÍ tiene el atributo BYPASSRLS → ignora RLS igual.
-- (El superuser real es `supabase_admin`, interno e inaccesible.) Por eso las
-- policies no aíslan nada aunque estén con FORCE. Estos roles NO tienen
-- SUPERUSER ni BYPASSRLS (el `_app`), así que la RLS se aplica de verdad.
--
-- Cómo aplicarlo: pegar en el SQL Editor de Supabase (corre como `postgres`,
-- que tiene CREATEROLE), DESPUÉS de `prisma migrate deploy` y de aplicar
-- policies.sql. Reemplazá los passwords por secretos largos y guardalos en el
-- secret manager / env de Vercel. NO commitees los passwords reales.
-- Idempotente.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) ROL DE APP — RLS FORZADA. Va en DATABASE_URL (runtime, requests con Actor).
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinesoft_app') THEN
    CREATE ROLE kinesoft_app LOGIN PASSWORD 'REEMPLAZAR_SECRETO_APP'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO kinesoft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO kinesoft_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO kinesoft_app;
-- En Supabase las tablas las crea `postgres` (SQL editor + prisma migrate).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kinesoft_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kinesoft_app;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) ROL SERVICE — BYPASSRLS. Va en un SEGUNDO connection string
--    (DATABASE_URL_SERVICE) para las superficies SIN Actor: webhook MP,
--    booking público, auditoría desde jobs. Preferible a reutilizar el
--    `service_role` de Supabase (que es NOLOGIN y hay que despertarlo).
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinesoft_service') THEN
    CREATE ROLE kinesoft_service LOGIN PASSWORD 'REEMPLAZAR_SECRETO_SERVICE'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO kinesoft_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO kinesoft_service;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO kinesoft_service;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kinesoft_service;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kinesoft_service;

COMMIT;

-- ── Recordatorio ───────────────────────────────────────────────────────────
-- GRANT ... ON ALL TABLES es una foto puntual: NO cubre tablas creadas por
-- migraciones futuras. El ALTER DEFAULT PRIVILEGES de arriba las cubre SOLO si
-- las crea `postgres`. Si dudás, reejecutá los dos bloques GRANT tras cada
-- deploy de migraciones que agregue tablas.
