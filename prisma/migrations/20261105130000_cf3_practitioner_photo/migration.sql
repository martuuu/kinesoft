-- M24 · cf3_practitioner_photo (CF3b, 05-nov-2026; SOLA). Va con M22 y M23 en el MISMO `db:prod:deploy`. Pedido de
-- Martin del 05-nov: cada usuario (sobre todo los profesionales) sube SU foto, que es su avatar en la app y puede salir
-- en la selección de profesional del turnero y en las tarjetas de la sede digital.
-- Por qué:
--   (A) Foto de la PERSONA en UserProfile: `photoStorageKey` + `photoUpdatedAt`. Hoy solo existe UserProfile.avatarUrl,
--       que escribe el login con Google/Facebook (lib/identity/oauth-profile.ts): es una URL de terceros que cambia o
--       caduca con cada login, no se puede subir y servirla en una página pública dependería de esa URL. No se reusa:
--       el login la pisa. Va en UserProfile (una por persona, la misma en todos sus consultorios, como la matrícula de
--       M23) y NO en Practitioner (por consultorio: la persona la subiría N veces y cada consultorio tendría otra).
--       Molde de Practitioner.signatureStorageKey / Tenant.logoStorageKey (M14): clave del objeto en el bucket PRIVADO
--       `practice-assets` (sin policies de storage; lo lee y escribe el canal service) + fecha de la subida (el `?v=`
--       de una respuesta `immutable`). UserProfile_photo_check: las dos o ninguna (IS NULL nunca da NULL, sin COALESCE).
--       UserProfile_photoStorageKey_check (forma): la clave empieza con `users/<id de ESA fila>/`, mide ≤ 200 y sus
--       segmentos son [A-Za-z0-9._-] sin empezar con «.» (ni vacíos, ni «.», ni «..», ni barra final). Por qué en la
--       base y no solo en la app: UserProfile no tiene RLS (no tiene tenantId) y la foto se va a servir en superficies
--       PÚBLICAS (turnero, sede) por el canal service, que lee la clave de la fila y baja el objeto con service-role.
--       Si una fila pudiera apuntar a cualquier objeto del bucket (`<tenantId>/signature/…`, la firma escaneada de un
--       profesional; el logo de otro consultorio; la carpeta de otro usuario), un escritor con un bug publicaría la
--       FIRMA de alguien como foto. Con el prefijo atado al id, lo peor que puede pasar es una foto vieja de la misma
--       persona. `starts_with` y no LIKE: un `_` del id sería comodín. El prefijo `users/` no choca con las claves de hoy
--       (`<tenantId>/…`, `pending/…`).
--   (B) Practitioner.showPhotoPublic BOOLEAN NOT NULL DEFAULT false: POR CONSULTORIO, si su foto sale en el turnero y la
--       sede de ESE consultorio. Opt-in sin backfill: es la imagen de una persona en una página pública (dato personal,
--       Ley 25.326; molde de showContactInLeadWindow de M21). En la app (avatar) la foto sale sin flag: ahí la ve solo
--       el equipo. Sin CHECK contra la foto: vive en otra tabla; la app publica solo con flag Y foto.
-- ADITIVA: ADD COLUMN NULL o NOT NULL con DEFAULT constante (solo catálogo, sin reescritura) y CHECKs que pasan sobre las
-- filas existentes (todas NULL / false). Sin backfill, sin trigger, no toca Booking. Compatible con el código de prod:
-- nadie lee ni escribe las columnas nuevas, sus INSERT toman los defaults y sus UPDATE (login, nombre, 2FA, Configuración)
-- no las nombran. Va ANTES del deploy.
-- Sin tabla nueva → guard:isolation no cambia (Practitioner ya tiene su policy de tenant; UserProfile no tiene tenantId).
-- lock_timeout 5 s: UserProfile (la foto de acceso de CADA request) y Practitioner (agenda y turnero) se leen siempre;
-- ACCESS EXCLUSIVE breve.
-- DRIFT ACEPTADO (NO borrar si `migrate dev` lo propone): UserProfile_photoStorageKey_check, UserProfile_photo_check.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- (A) Foto de la persona.
ALTER TABLE "UserProfile"
  ADD COLUMN "photoStorageKey" TEXT,
  ADD COLUMN "photoUpdatedAt" TIMESTAMP(3);
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_photoStorageKey_check"
  CHECK ("photoStorageKey" IS NULL OR (
        char_length("photoStorageKey") <= 200
    AND starts_with("photoStorageKey", 'users/' || "id" || '/')
    AND "photoStorageKey" ~ '^users(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$'));
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_photo_check"
  CHECK (("photoStorageKey" IS NULL) = ("photoUpdatedAt" IS NULL));

-- (B) Publicarla en el turnero y la sede de ESTE consultorio.
ALTER TABLE "Practitioner" ADD COLUMN "showPhotoPublic" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
