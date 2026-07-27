-- KineSoft — Ola B2b · Rol de aplicación para el Postgres LOCAL (Docker)
-- ---------------------------------------------------------------------------
-- Por qué: hoy la app conecta como `kinesoft`, que es el POSTGRES_USER del
-- contenedor = SUPERUSER. Un superuser SIEMPRE hace bypass de RLS (incluso con
-- FORCE ROW LEVEL SECURITY), así que policies.sql es inerte. Este rol no tiene
-- SUPERUSER ni BYPASSRLS → las policies se aplican de verdad contra él.
--
-- Cómo aplicarlo (como owner `kinesoft`, DESPUÉS de migrate + seed):
--   docker compose exec -T db psql -U kinesoft -d kinesoft < prisma/roles.local.sql
--
-- Reejecutar tras cada `docker compose down -v` (el volumen se borra y el rol
-- desaparece). Es idempotente.

BEGIN;

-- 1) Rol de la app: LOGIN, sin SUPERUSER ni BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinesoft_app') THEN
    CREATE ROLE kinesoft_app LOGIN PASSWORD 'kinesoft_app'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- 2) Acceso al esquema + objetos EXISTENTES.
GRANT USAGE ON SCHEMA public TO kinesoft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO kinesoft_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO kinesoft_app;

-- 3) Objetos FUTUROS (las próximas migraciones corren como owner `kinesoft`).
--    Sin esto, cada tabla nueva quedaría sin permisos para la app.
ALTER DEFAULT PRIVILEGES FOR ROLE kinesoft IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kinesoft_app;
ALTER DEFAULT PRIVILEGES FOR ROLE kinesoft IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kinesoft_app;

COMMIT;

-- Canal service-role LOCAL: no hace falta un rol aparte. El propio owner
-- `kinesoft` es superuser → ya hace bypass de RLS, sirve como canal sin-Actor
-- (webhook MP, booking público, auditoría de jobs). En prod sí se crea uno
-- dedicado (ver roles.supabase.sql).
