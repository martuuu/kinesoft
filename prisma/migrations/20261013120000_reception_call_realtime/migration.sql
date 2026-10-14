-- M5 · reception_call_realtime (SV0, 13-oct-2026). Aditiva. Prod se resetea: va en la cadena única
-- M1 → … → M3a → M4 → M5 del `migrate deploy` desde vacío (VERTICALES §9).
-- Qué agrega: Booking.calledAt (estado «Llamado» de la Sala de Espera), la función pura que decide quién puede
-- leer el canal Broadcast privado `tenant:<id>:agenda`, y la policy sobre realtime.messages (solo en Supabase).
-- DRIFT ACEPTADO: el CHECK, la función y la policy no se expresan en Prisma; si `migrate dev` propone borrarlos,
-- NO se aceptan.
-- Guard 3c: ningún trozo entre `;` le otorga privilegios a los roles de la Data API (tampoco en comentarios).
BEGIN;
SET LOCAL lock_timeout = '5s';   -- si "Booking" está tomada, falla rápido. Ver RUNBOOK P3009.

ALTER TABLE "Booking" ADD COLUMN "calledAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_called_requires_arrived_check"
  CHECK ("calledAt" IS NULL OR "arrivedAt" IS NOT NULL);

-- Predicado puro: ¿estos claims pueden leer este topic? Vive en public para testearlo en el Docker local (que no
-- tiene schema realtime). IMMUTABLE + STRICT: con NULL devuelve NULL, que en USING vale false.
CREATE OR REPLACE FUNCTION public.kinesoft_realtime_can_read(topic text, claims jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT (claims->>'purpose') = 'kinesoft-realtime'
     AND (claims->>'role') = 'authenticated'
     AND (claims->>'tenant_id') ~ '^[A-Za-z0-9]{16,40}$'
     AND topic = 'tenant:' || (claims->>'tenant_id') || ':agenda'
$$;
-- EXECUTE para todos los roles: la policy corre como el rol del token. Se nombra PUBLIC a propósito.
GRANT EXECUTE ON FUNCTION public.kinesoft_realtime_can_read(text, jsonb) TO PUBLIC;

-- El test de integración extrae y ejecuta el SQL entre estos marcadores: no los muevas ni los renombres.
-- >>> REALTIME_POLICY BEGIN
DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE NOTICE 'reception_call_realtime: no existe realtime.messages (Postgres sin Supabase Realtime); la policy del canal no se crea';
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS kinesoft_agenda_read ON realtime.messages';
  EXECUTE $p$
    CREATE POLICY kinesoft_agenda_read ON realtime.messages
      FOR SELECT TO authenticated
      USING (
        realtime.messages.extension = 'broadcast'
        AND public.kinesoft_realtime_can_read(realtime.topic(), (SELECT auth.jwt()))
      )
  $p$;
END $$;
-- <<< REALTIME_POLICY END

COMMIT;
