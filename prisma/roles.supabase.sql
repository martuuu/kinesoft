-- KineSoft — Ola B2b · Roles de aplicación para Supabase (PRODUCCIÓN)
-- ---------------------------------------------------------------------------
-- Por qué: hoy la app conecta como `postgres`. OJO: en Supabase `postgres` NO
-- es un superuser real, pero SÍ tiene el atributo BYPASSRLS → ignora RLS igual.
-- (El superuser real es `supabase_admin`, interno e inaccesible.) Por eso las
-- policies no aíslan nada aunque estén con FORCE. Estos roles NO tienen
-- SUPERUSER ni BYPASSRLS (el `_app`), así que la RLS se aplica de verdad.
--
-- Cómo aplicarlo (A0b, 2026-09-29): con psql y la conexión owner (`postgres`,
-- que tiene CREATEROLE), DESPUÉS de `prisma migrate deploy`. Los passwords se
-- pasan como variables de psql — NUNCA van escritos en este archivo:
--
--   APP_PW="$(openssl rand -hex 24)"; SVC_PW="$(openssl rand -hex 24)"   # hex: base64 rompe las URLs
--   psql "$OWNER_URL" -v app_password="$APP_PW" -v service_password="$SVC_PW" \
--     -f prisma/roles.supabase.sql
--
-- (guardá los dos secretos generados en el secret manager / env de Vercel).
--
-- Por qué cambió: antes el archivo creaba los roles con passwords placeholder
-- literales y el `IF NOT EXISTS` impedía rotarlos al re-correr: seguir el
-- RUNBOOK al pie de la letra dejaba `kinesoft_service` (BYPASSRLS) con un
-- password público del repo. Ahora el DO crea el rol SIN password y el
-- ALTER ROLE de abajo lo setea SIEMPRE → re-correr el archivo = rotar.
-- No se puede pegar en el SQL Editor (usa variables de psql). Idempotente.

\set ON_ERROR_STOP on
\if :{?app_password}
\else
  \echo 'Falta -v app_password=... (ver cabecera). Abortado sin cambios.'
  \quit
\endif
\if :{?service_password}
\else
  \echo 'Falta -v service_password=... (ver cabecera). Abortado sin cambios.'
  \quit
\endif

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) ROL DE APP — RLS FORZADA. Va en DATABASE_URL (runtime, requests con Actor).
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinesoft_app') THEN
    CREATE ROLE kinesoft_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
-- Password siempre desde la variable de psql (crear o rotar).
SELECT format('ALTER ROLE kinesoft_app WITH PASSWORD %L', :'app_password') \gexec

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
    CREATE ROLE kinesoft_service LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
SELECT format('ALTER ROLE kinesoft_service WITH PASSWORD %L', :'service_password') \gexec

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
