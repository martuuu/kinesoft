-- tenant_verticals · M2, corrida EV0 ola V.0 (sola). Plan §15.1 + §15.3, decisiones de Martin del 07-oct.
-- Por qué:
--   (1) Verticales del SaaS: "Consultorio General" (sin módulos clínicos de kine) y "Consultorio Kinesiología"
--       (lo actual). `Tenant.vertical` + `Tenant.plan` (enum existente) alimentan la matriz de módulos pura
--       (`modulesFor`, C-EV1). Default KINESIOLOGY: es lo que son todos los consultorios de hoy.
--   (2) Turnero público con switch por consultorio: `publicBookingEnabled` default false = OPT-IN (EV-D2); se
--       prende desde Configuración o /plataforma. Prod se resetea antes del go-live: no hay backfill.
--   (3) HALLAZGO CRÍTICO §15.1: 9 tablas de `public` no tienen RLS (UserProfile —con isPlatformAdmin—,
--       UserPreferences, Favorite, Tag, ExerciseTag, ConditionTag, ConditionExerciseLink, AnatomicalRegion,
--       ConditionAnatomy) y las policies no son `TO <rol>`. Si la Data API (PostgREST) de Supabase expone
--       `public` con los grants por defecto, la anon key (pública) podría leer emails y escribir
--       `UserProfile.isPlatformAdmin`. La app NUNCA usa PostgREST (todo va por Prisma con kinesoft_app /
--       kinesoft_service / owner), así que a `anon` y `authenticated` se les saca TODO en `public`:
--       tablas, secuencias, rutinas y los DEFAULT PRIVILEGES (para que las tablas de migraciones futuras
--       tampoco nazcan expuestas). Defensa en profundidad: Martin igual desactiva la Data API en la consola.
-- Alcance del REVOKE (verificado en tests/integration/tenant-verticals-m2.test.ts con roles temporales):
--   · Solo `IN SCHEMA public` y solo los roles `anon`/`authenticated`. NO toca a `kinesoft_app`,
--     `kinesoft_service` ni al owner (`postgres` en Supabase, `kinesoft` en local): sus GRANTs son propios
--     (prisma/roles.*.sql), no heredados de anon/authenticated. No toca Storage/Auth/Realtime: viven en sus
--     schemas (`storage`, `auth`, `realtime`) y ninguna policy ni trigger nuestro llama a `public` desde ahí.
--   · NO se revoca EXECUTE de PUBLIC sobre `app_current_tenant_id()`: las policies RLS la ejecutan como el rol
--     que consulta (kinesoft_app). Para anon es inocua (lee un GUC) y sin SELECT en las tablas no sirve de nada.
--   · DEFAULT PRIVILEGES: se revocan para el rol que corre la migración (current_user) y, si no es `postgres`
--     pero es miembro, también `FOR ROLE postgres` (en Supabase los defaults que dan ALL a anon/authenticated
--     están definidos FOR ROLE postgres y FOR ROLE supabase_admin; migrate corre como `postgres`, así que
--     current_user ya los cubre). Los de `supabase_admin` no se pueden tocar (no somos miembros) y solo
--     afectan objetos que cree ese rol interno: ninguno de nuestras migraciones. El autochequeo del final
--     avisa (WARNING) si quedara algún objeto de `public` con privilegios para estos roles.
--   · Sin los roles (Docker local, CI) el bloque es NOTICE + no-op.
-- Guard estático: `npm run guard:isolation` falla si alguna migración (o prisma/roles.*.sql) hace GRANT a
-- anon/authenticated, o si este bloque desaparece.
-- Aditiva: un CREATE TYPE y dos ADD COLUMN con default constante (sin rewrite de la tabla en PG ≥ 11).
-- Sin tabla nueva → `guard:isolation` de RLS no cambia.
BEGIN;
SET LOCAL lock_timeout = '5s';   -- si "Tenant" está tomada, falla rápido (no cuelga el login). Ver RUNBOOK P3009.

CREATE TYPE "TenantVertical" AS ENUM ('GENERAL', 'KINESIOLOGY');

ALTER TABLE "Tenant" ADD COLUMN "vertical" "TenantVertical" NOT NULL DEFAULT 'KINESIOLOGY';
ALTER TABLE "Tenant" ADD COLUMN "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false;   -- opt-in (EV-D2)

-- El test de integración extrae y ejecuta el SQL entre estos marcadores: no los muevas ni los renombres.
-- >>> REVOKE_DATA_API BEGIN
DO $$
DECLARE
  r        text;
  creator  text;
  creators text[];
  kind     text;
  leftover int;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE NOTICE 'tenant_verticals: no existe el rol %, no hay grants de la Data API que revocar', r;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM %I', r);   -- funciones + procedimientos

    creators := ARRAY[current_user::text];
    IF current_user::text <> 'postgres'
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
       AND pg_has_role(current_user, 'postgres', 'MEMBER') THEN
      creators := creators || 'postgres'::text;
    END IF;
    FOREACH creator IN ARRAY creators LOOP
      FOREACH kind IN ARRAY ARRAY['TABLES', 'SEQUENCES', 'FUNCTIONS'] LOOP
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON %s FROM %I',
                       creator, kind, r);
      END LOOP;
    END LOOP;

    -- Autochequeo: ningún objeto de `public` debería quedar accesible. WARNING (no EXCEPTION) para no dejar
    -- un P3009 en el deploy por un objeto ajeno; el precheck de consola de §15.1 lo ve igual.
    SELECT count(*) INTO leftover
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
    IF leftover > 0 THEN
      RAISE WARNING 'tenant_verticals: % tabla(s) de public siguen accesibles para % después del REVOKE', leftover, r;
    END IF;
  END LOOP;
END $$;
-- <<< REVOKE_DATA_API END

COMMIT;
