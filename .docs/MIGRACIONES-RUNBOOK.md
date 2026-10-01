# Runbook de migraciones — dev (local Docker) y prod (Supabase)

> Guía operativa para el dueño. Los comandos están listos para copiar/pegar.
> El agente **solo** aplica migraciones en LOCAL; producción la ejecuta el dueño,
> en el orden que el agente deja escrito al cerrar cada bloque.
> Reescrito en A0b/A0c (2026-09-29): **ya no se comenta/descomenta el `.env`**.

---

## 0. Cómo está armado (leer una vez)

| Archivo | Apunta a | Lo usan |
|---|---|---|
| `.env` | **Solo DEV** (Docker :5433). Borrá el bloque PROD comentado si todavía lo tenés | Prisma CLI y `@prisma/client` (lo cargan solos) |
| `.env.local` | Docker :5433, rol app `kinesoft_app` (RLS activa) | `npm run dev`, scripts `prisma:*`, tests |
| `.env.prod.local` | **Supabase PROD** (owner): `DIRECT_URL` + `DATABASE_URL` | **solo** los scripts `db:prod:*` |

`.env.prod.local` lo creás vos (está en `.gitignore` por `.env*.local`) con dos líneas:

```
DIRECT_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
DATABASE_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
```

> ⚠️ Por qué cambió: con el switch manual, olvidarse de volver el `.env` a DEV
> hacía que el próximo `migrate reset` o seed del §1 pegara en producción.
> Además todos los seeds/scripts ahora imprimen su destino y se niegan a ir a
> una base remota sin confirmación (`assertSafeTarget`).

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Runtime de la app (rol **sin** BYPASSRLS). En el CLI: la base a migrar. |
| `DIRECT_URL` | Conexión **directa** (5432, sin pooler) — la que usa `prisma migrate`. |
| `DATABASE_URL_SERVICE` | `kinesoft_service` (BYPASSRLS) en prod. Sin esto el panel Plataforma no escribe. |

---

## 1. Local (Docker) — desarrollo

```bash
cd ~/Documents/kinesoft

# 0) La DB tiene que estar arriba (solo el servicio db: adminer usa el 8080 y suele chocar)
docker compose up -d db
docker compose ps                 # kinesoft-db … Up (healthy)

# 1) Aplicar migraciones pendientes (NO usa migrate dev: detecta drift y propone
#    resetear, y puede proponer borrar los índices parciales hechos a mano)
npx dotenv -e .env.local -- npx prisma migrate deploy
npx prisma generate

# 2) Verificar
npx dotenv -e .env.local -- npx prisma migrate status   # → "Database schema is up to date!"
```

**Crear una migración nueva:** a mano, en `prisma/migrations/<YYYYMMDDHHMMSS>_<nombre>/migration.sql`
(aditiva, con el porqué en la cabecera), editar `schema.prisma` en paralelo, y aplicarla con el paso 1.
Verificar objeto por objeto (columnas, índices, policies) y correr `npm run guard:isolation`.

**Resetear la base local** (destructivo, solo el dueño; el agente no lo corre):

```bash
npm run prisma:reset     # re-migra y re-siembra el Docker (el seed se niega a ir a una base remota)
# Después del reset: re-crear el rol de app y re-marcar el superadmin
psql "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" -f prisma/roles.local.sql
DATABASE_URL="postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" \
  npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
```

---

## 2. Producción (Supabase + Vercel)

> Desde A0b **solo el deploy de Production migra** (`scripts/vercel-build.mjs`); los Preview no.
> Las migraciones son aditivas, así que el código viejo sigue andando si se aplican antes del deploy.

### Paso a paso (para cada bloque con migraciones)

**1) Estado** (lee, no escribe; tiene que decir `…supabase.com`):

```bash
npm run db:prod:status
```

**2) Prechecks de solo lectura** que deja el agente para ese bloque (en el SQL Editor o con psql).
Los fijos, antes de cualquier migración:

```sql
-- Migraciones registradas, fallidas o de ramas descartadas
SELECT migration_name, finished_at, rolled_back_at, logs IS NOT NULL AS con_error
FROM _prisma_migrations ORDER BY started_at;
-- Roles (si existen y se crearon con el placeholder viejo, rotalos con roles.supabase.sql)
SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'kinesoft%';
```

**3) Backup:**

```bash
npm run db:prod:backup      # pg_dump -Fc → ~/kinesoft-backups/prod-<fecha>.dump
```

**4) Staging primero:** con el Preview apuntado a staging, aplicar ahí y hacer el QA del bloque.

**5) Aplicar en prod:** o mergeás a `main` y el build de Production las aplica, o las aplicás antes:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

### Migraciones pendientes en prod (bloque reciente)

> ⚠️ **Estado real sin verificar (auditoría 2026-09-23):** hasta A0b, `vercel.json` corría `migrate deploy` en
> cada build y `main` ya contiene estas migraciones, así que **puede que ya estén aplicadas** — o que un
> deploy haya fallado (por ejemplo la #3, si había duplicados). Antes de nada: `npm run db:prod:status` y la
> query de `_prisma_migrations` del paso 2.

En orden. Todas aplicadas y verificadas en local:

| # | Migración | Qué hace | Ronda |
|---|---|---|---|
| 1 | `20260802220514_wave_service_color_booking_title_patient_diagnosis` | `Service.color`, `Booking.title/description`, diagnóstico del paciente | 4 |
| 2 | `20260802232454_notification_kind_patient_shared` | enum `NotificationKind += PATIENT_SHARED` | 5 |
| 3 | `20260803002623_booking_patient_slot_active_unique` | **Índice único parcial** (paciente+instante, no cancelados) | 6 |
| 4 | `20260803022526_platform_admin_flag` | `UserProfile.isPlatformAdmin` | 7 |
| 5 | `20260803022544_tagkind_add_muscle_discipline` | enum `TagKind += MUSCLE_GROUP, DISCIPLINE` | 7 |
| 6 | `20260803022626_exercise_optional_reps_and_archive` | reps/series opcionales, `durationSeconds`, `archivedAt` | 7 |
| 7 | `20260803022653_exercise_media_and_article` | tablas `ExerciseMedia`/`ExerciseArticle` **+ políticas RLS** | 7 |
| 8 | `20260803183019_user_prefs_catalog` | `UserPreferences.catalogPrefs` (JSON) | 8 |
| 9 | `20260816014954_tenant_agenda_slot_minutes` | `Tenant.agendaSlotMinutes` (vista 30/60 min) | 10 |
| 10 | `20260930120000_tenant_onboarding` | `Tenant.onboardingCompletedAt/phone/whatsapp/publicEmail` + backfill | A3c — **ver §2.1** |
| 11 | `20260930200000_catalog_global` | catálogo global + punteros nullable + RLS de solo lectura | B-pre — **ver §2.2** |
| 12 | `20261001090000_agenda_foundations` | sedes, franjas, excepciones, bloqueos, PS/PP, Booking expand + **backfill** | B-pre — **ver §2.2** |

⚠️ La #7 además crea políticas RLS (`ENABLE`/`FORCE` + `SELECT` en las dos tablas nuevas).
⚠️ La #3 falla si ya existieran dos turnos activos del **mismo paciente en el mismo instante**
exacto. En local verifiqué 0 casos; si prod tuviera alguno, `migrate deploy` aborta sin
dejar la base a medias y hay que limpiar esos duplicados primero:

```sql
-- Diagnóstico previo (solo lectura) — debería devolver 0 filas:
SELECT "tenantId", "patientId", "scheduledFor", count(*)
FROM "Booking"
WHERE "patientId" IS NOT NULL AND status <> 'CANCELLED'
GROUP BY 1,2,3 HAVING count(*) > 1;
```

### Tareas de prod que van una sola vez (además de migrar)

```bash
# a) Roles: app sin BYPASSRLS + service con BYPASSRLS. Passwords por variable
#    (nunca en el archivo); re-correrlo ROTA los passwords.
set -a; . ./.env.prod.local; set +a
psql "$DIRECT_URL" -v app_password="$(openssl rand -base64 32)" \
  -v service_password="$(openssl rand -base64 32)" -f prisma/roles.supabase.sql
#    → después, en Vercel: DATABASE_URL apunta al rol app (pooler 6543)
#      y DATABASE_URL_SERVICE al rol kinesoft_service (cargala ANTES del flip).

# b) Superadmin de plataforma (vos + tu cliente). Pide confirmar el project ref.
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/set-platform-admin.ts --list

# c) Backfill de tags estructurados (Ronda 7; sin esto los filtros de
#    músculo/equipamiento de /biblioteca quedan vacíos en prod). Idempotente.
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx prisma/backfill-exercise-tags.ts

# d) Bucket de Supabase Storage para la media de ejercicios
#    Crear "exercise-media" PRIVADO en el proyecto de prod (la app usa signed URLs).
```

> Nunca corras `prisma/seed.ts` contra prod: es demo (borra los turnos del tenant `movare`) y
> se niega a ejecutarse contra una base remota.

### Variables de entorno en Vercel (chequeo)

- `DATABASE_URL` → rol de app (**sin** BYPASSRLS)
- `DIRECT_URL` → owner (migraciones)
- `DATABASE_URL_SERVICE` → `kinesoft_service` (BYPASSRLS) — **sin esto el panel Plataforma no escribe**
- `KINESOFT_ALLOW_DEMO_ACTOR` → **NO debe existir en prod** (es el bypass de login local)

---

## 2.1 Deploy del Bloque A (A2 + A3) — orden exacto (30-sep-2026)

> ⚠️ **Hay UNA migración nueva en este bloque: `20260930120000_tenant_onboarding`** (A3c). A2, A3a y A3b no
> tienen migraciones. Reglas de corte:
> - **A3 no se despliega sin el SMTP propio configurado** (EXTERNAL-CONFIG §0.1): sin él, los mails de
>   verificación del signup no llegan y nadie puede darse de alta.
> - **A3b no se despliega sin A3c**: la página de invitación de A3b ofrece "Crear mi cuenta para unirme", que
>   con el signup viejo crearía un consultorio nuevo en vez de sumarse al equipo.
> - **El QA del signup (QA.md §A3c) se corre en staging con un email real ANTES del merge a `main`.** Si falla,
>   no se mergea.
> - El bug `signup-confirm-doble-salto` (hallado al cerrar A3c) **ya está corregido en código** (30-sep): el
>   `emailRedirectTo` es el destino final y `/auth/confirm` desenvuelve un `next` que apunta a sí mismo. Igual
>   se verifica con el QA de email real.
> - A2 (+ A3a) sí puede ir solo, antes, si conviene separar.

**1) Prechecks de solo lectura** (SQL Editor de prod, o `psql "$DIRECT_URL"` con `.env.prod.local`). Anotá los
tres resultados antes de seguir:

```sql
-- (a) Reservas públicas pre-A2 que el discriminante nuevo reconoce (por la key
--     vieja `<tenant>:<prof>:<ISO>:<patientId>`). Informativo.
SELECT status, "paymentStatus", count(*) FROM "Booking"
WHERE "patientId" IS NOT NULL
  AND "idempotencyKey" ~ '^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[^:]+$'
  AND "idempotencyKey" LIKE '%:' || "patientId"
GROUP BY 1,2;

-- (b) Reservas públicas impagas FUTURAS de más de 30 min: al deployar pasan a
--     "vencidas" y liberan el cupo (otro paciente puede tomar ese horario).
SELECT count(*) FROM "Booking"
WHERE status='PENDING' AND "paymentStatus" IN ('UNPAID','FAILED') AND "patientId" IS NOT NULL
  AND "scheduledFor" > now() AND "createdAt" < now() - interval '30 min';

-- (c) Turnos de AGENDA (no públicos) en PENDING con paciente.
SELECT count(*) FROM "Booking"
WHERE status='PENDING' AND "patientId" IS NOT NULL
  AND "idempotencyKey" NOT LIKE 'pub:%'
  AND "idempotencyKey" !~ '^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[^:]+$';

-- (d) Precheck de la migración: el Tenant todavía no tiene las columnas nuevas
--     (si ya existen, la migración falla: revisá _prisma_migrations primero).
SELECT column_name FROM information_schema.columns
WHERE table_name = 'Tenant'
  AND column_name IN ('onboardingCompletedAt','phone','whatsapp','publicEmail');   -- esperado: 0 filas
```

Qué hacer si dan > 0:
- **(a) > 0:** nada; es para saber cuántas reservas viejas entran en la regla de los 30 min.
- **(b) > 0:** **antes del deploy**, confirmar esas reservas a mano (o cobrarlas) desde la agenda. Si no, al
  deployar dejan de retener el cupo y se ven "Pendiente de pago · vencida".
- **(c) > 0:** recomendable pasarlos a CONFIRMED a mano desde la agenda. Desde A2 la agenda ya no deja un turno
  con paciente en PENDING, así que esos quedan en un estado que la app no produce más.
- **(d) > 0:** frenar; la migración ya corrió (o a medias). Revisar `_prisma_migrations` (§2 paso 2).

**2) Backup:** `npm run db:prod:backup`.

**3) Staging primero (antes del merge a `main`):** con los prerrequisitos de EXTERNAL-CONFIG §0.1 cargados en
staging (SMTP propio, plantillas con `type=email` / `type=recovery`, Redirect URLs, "Confirm email" ON, "Secure
password change" OFF, Upstash, DSN), deployar el bloque al Preview de staging. La migración se aplica en staging
con `migrate deploy` contra la DB de staging (el Preview no migra solo). Correr el QA de
[QA.md §Bloque A — A2/A3](QA.md) **incluida la subsección A3c con un email real** (mail abierto en otro
dispositivo, invitación, forgot → reset). Recién con eso verde se mergea.

**4) Migración `20260930120000_tenant_onboarding`** — aditiva: 4 columnas nullable en `Tenant`
(`onboardingCompletedAt`, `phone`, `whatsapp`, `publicEmail`), sin DROP ni NOT NULL, y backfill
`onboardingCompletedAt = createdAt` para los tenants existentes (idempotente). `Tenant` no lleva policy nueva.
La aplica el build de Production al mergear a `main`, o antes, a mano:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

Verificar **inmediatamente después** (el cliente vivo no debe ver el stepper de alta):

```sql
SELECT count(*) FROM "Tenant" WHERE "onboardingCompletedAt" IS NULL;   -- tiene que dar 0
```

Si da > 0 (un tenant creado entre la migración y el deploy): `UPDATE "Tenant" SET "onboardingCompletedAt" =
"createdAt" WHERE "onboardingCompletedAt" IS NULL AND "createdAt" < '<momento del deploy>';` solo para tenants
que ya operaban, no para altas nuevas del signup.

**5) Después del deploy — normalizar emails de pacientes** (no es migración; el código nuevo ya guarda los
emails normalizados):

```bash
set -a; . ./.env.prod.local; set +a
# dry-run (default): lista qué cambiaría y las COLISIONES (ids, no emails)
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/normalize-patient-emails.ts
# revisar colisiones: dos fichas del mismo consultorio con el "mismo" email.
# Esas NO se tocan; el consultorio decide cuál es la buena (archivar la otra o corregir el email).
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/normalize-patient-emails.ts --apply
```

La URL tiene que ser la **owner** (BYPASSRLS): con el rol de la app RLS devuelve 0 fichas y el script aborta.

**6) Verificación final en prod:** login del cliente vivo sin stepper; `curl -I` con HSTS; en Sentry (si hay
DSN) llega un evento de prueba; en Upstash aparecen claves `rl:production:`.

## 2.2 Deploy de B-pre (agenda y catálogo) — orden exacto (01-oct-2026)

> ⚠️ **Hay DOS migraciones nuevas en esta tanda**, en este orden:
> 1. `20260930200000_catalog_global` — catálogo global (Specialty, Practice, PracticeSpecialty, Payer, PayerPlan,
>    CatalogImportRun + enums `CatalogSource`/`PayerKind`), punteros nullable `Insurer.payerId`,
>    `Coverage.payerPlanId`, `Service.practiceId` (FK SET NULL), RLS global de solo lectura y PayerPlan split,
>    índices parciales de PayerPlan. Sin backfill.
> 2. `20261001090000_agenda_foundations` — Location, PractitionerSchedule, ScheduleException, TimeBlock,
>    PractitionerService, PractitionerPayer, PractitionerSpecialty; Booking + `locationId` (RESTRICT),
>    `isOverbooked`, `arrivedAt`, `attendingAt`, `isTelemedicine`, `telemedicineUrl`; `UserPreferences.agendaPrefs`;
>    RLS + CHECKs + índices parciales; **backfill idempotente** con `SET LOCAL row_security = off`.
>
> Las dos son aditivas (expand): ningún DROP ni SET NOT NULL; el código viejo convive con el schema nuevo. Por eso
> van **antes o junto con** el código, nunca después. Lo normal es que las aplique el build de Production al
> mergear a `main`.
>
> **Relación con el Bloque A:** el Bloque A ya está commiteado (`ef3281f`). B-pre puede desplegarse **solo** (si A
> ya está en prod) o **en el mismo deploy** que A. Las reglas de A no cambian: **A3 sigue requiriendo el SMTP
> propio** (EXTERNAL-CONFIG §0.1) y A3b no va sin A3c. Si A no está en prod, este deploy lleva también
> `20260930120000_tenant_onboarding` (§2.1): aplicar los prechecks de las dos secciones y el orden de migraciones
> es por timestamp (onboarding → catalog_global → agenda_foundations), que es lo que hace `migrate deploy`.

**1) Prechecks de solo lectura** (SQL Editor de prod o `psql "$DIRECT_URL"` con `.env.prod.local`). Además de los
fijos de §2 paso 2. Anotá cada resultado: los conteos esperados del paso 5 salen de acá.

```sql
-- (a) Rol con el que migra el build (DIRECT_URL). TIENE que ser rolsuper o rolbypassrls:
--     el backfill corre con row_security = off y, sin BYPASSRLS, la migración FALLA a propósito.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

-- (b) Las tablas nuevas no existen todavía (todas null). Si alguna existe, frenar y revisar _prisma_migrations.
SELECT to_regclass('"Specialty"'), to_regclass('"Practice"'), to_regclass('"Payer"'), to_regclass('"PayerPlan"'),
       to_regclass('"CatalogImportRun"'), to_regclass('"Location"'), to_regclass('"PractitionerSchedule"'),
       to_regclass('"PractitionerService"'), to_regclass('"TimeBlock"');

-- (c) catalog_global: lo que hoy se tipea a mano (informativo; la migración no lo toca).
SELECT COUNT(*) FROM "Insurer";
SELECT "tenantId", COUNT(*) FROM "Insurer" GROUP BY 1;
SELECT COUNT(*) FILTER (WHERE "planName" IS NOT NULL) FROM "Coverage";
SELECT COUNT(*) FROM "Service";

-- (d) agenda_foundations: base de los conteos esperados.
SELECT COUNT(*) AS tenants FROM "Tenant";
SELECT id, "businessHoursStart", "businessHoursEnd" FROM "Tenant";
--     tenants con horario inválido: quedan SIN franjas (el motor usa el horario del tenant como fallback)
SELECT id FROM "Tenant"
WHERE NOT ("businessHoursStart" >= 0 AND "businessHoursStart" < "businessHoursEnd" AND "businessHoursEnd" <= 24);
--     profesionales con membresía aceptada, por tenant
SELECT p."tenantId", COUNT(*) FROM "Practitioner" p
JOIN "Membership" m ON m."userId"=p."userId" AND m."tenantId"=p."tenantId" AND m."acceptedAt" IS NOT NULL
GROUP BY 1;
--     turnos futuros de profesionales SIN membresía aceptada (no reciben franjas: revisar a mano)
SELECT b."practitionerId", COUNT(*) FROM "Booking" b
WHERE b."scheduledFor" > now() AND b.status <> 'CANCELLED' AND NOT EXISTS (
  SELECT 1 FROM "Practitioner" p
  JOIN "Membership" m ON m."userId"=p."userId" AND m."tenantId"=p."tenantId" AND m."acceptedAt" IS NOT NULL
  WHERE p.id=b."practitionerId")
GROUP BY 1;
SELECT "practitionerId" IS NULL AS compartido, COUNT(*) FROM "Service" GROUP BY 1;
SELECT COUNT(*) FROM "Insurer" WHERE active;
--     turnos de un servicio "propio" de OTRO profesional: el paso 3b del backfill los habilita como PRIVATE
SELECT COUNT(*) FROM "Booking" b JOIN "Service" s ON s.id=b."serviceId"
WHERE s."practitionerId" IS NOT NULL AND s."practitionerId"<>b."practitionerId" AND b.status<>'CANCELLED';
--     sobreturnos marcados por prefijo (= isOverbooked esperado)
SELECT COUNT(*) FROM "Booking" WHERE notes LIKE '[SOBRETURNO]%';
--     turnos futuros fuera del horario del tenant o en domingo: siguen en la agenda; desde B-pre reprogramarlos
--     o reactivarlos da el aviso blando "fuera de horario" (se fuerza, no se rechaza). Informativo.
SELECT COUNT(*) FROM "Booking" b JOIN "Tenant" t ON t.id=b."tenantId"
WHERE b."scheduledFor" > now() AND b.status <> 'CANCELLED' AND (
  EXTRACT(DOW FROM b."scheduledFor" AT TIME ZONE 'America/Argentina/Buenos_Aires')=0
  OR EXTRACT(HOUR FROM b."scheduledFor" AT TIME ZONE 'America/Argentina/Buenos_Aires') < t."businessHoursStart"
  OR EXTRACT(HOUR FROM b."scheduledFor" AT TIME ZONE 'America/Argentina/Buenos_Aires') >= t."businessHoursEnd");
SELECT COUNT(*) FROM "Booking";
```

Qué hacer si:
- **(a)** no tiene `rolsuper` ni `rolbypassrls` → **frenar**: corregir `DIRECT_URL` en Vercel al owner antes del
  merge (si no, el deploy falla en la migración 2 y no queda nada a medias, pero no sale).
- **(b)** alguna no es null → frenar, revisar `_prisma_migrations` (§2 paso 2).
- **turnos de profesionales sin membresía aceptada > 0** → no rompen nada (el motor les aplica el horario del
  tenant), pero conviene reasignarlos o re-aceptar la membresía.

**2) Backup:** `npm run db:prod:backup`.

**3) Staging primero (antes del merge a `main`):** `migrate deploy` contra la DB de staging (el Preview no migra
solo) → correr los mismos prechecks y los conteos del paso 5 → QA de [QA.md §B-pre](QA.md) con `TZ=UTC` → import
del catálogo en staging (paso 6). Recién con eso verde se mergea.

**4) Aplicar en prod:** merge a `main` (el build de Production aplica las dos), o antes a mano:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

Si se aplican a mano **antes** del deploy del código, en el hueco el código viejo sigue andando (todo es nullable
o con default). Lo único que queda desfasado se corrige en el paso 5.

**5) Post-deploy (inmediatamente después de que el código nuevo esté vivo):**

```sql
-- (a) Sobreturnos que el código VIEJO cargó entre la migración y el deploy (solo escribía el prefijo):
UPDATE "Booking" SET "isOverbooked" = true WHERE notes LIKE '[SOBRETURNO]%' AND NOT "isOverbooked";

-- (b) Conteos esperados
SELECT COUNT(*) FROM "Location";                       -- = #tenants (una "Principal" por tenant)
SELECT COUNT(*) FROM "Location" WHERE "isPrimary";     -- = #tenants
SELECT COUNT(*) FROM "PractitionerSchedule";           -- = 6 × profesionales aceptados (de tenants con horario válido)
SELECT COUNT(*) FROM "Booking" WHERE "locationId" IS NULL;                  -- = 0
SELECT COUNT(*) FROM "Booking" WHERE "isOverbooked";   -- = conteo de '[SOBRETURNO]%' del precheck (+ los nuevos)
SELECT visibility, COUNT(*) FROM "PractitionerService" GROUP BY 1;          -- PRIVATE = pares del paso 3b
SELECT COUNT(*) FROM "PractitionerPayer";              -- = aceptados × insurers activos, por tenant
-- (c) RLS del catálogo: solo SELECT
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('Specialty','Practice','PracticeSpecialty','Payer','CatalogImportRun','PayerPlan')
ORDER BY 1, 2;
```

- **(d) Re-correr el backfill** si entre la migración y el deploy del código se creó un tenant, se aceptó una
  invitación o se cargó un servicio/obra social (esas altas nacen sin sede/franjas/PS/PP con el código viejo; el
  código nuevo ya las crea con `lib/agenda-defaults.ts`). Es idempotente: re-correrlo no cambia lo ya hecho.
  Owner connection:

  ```bash
  set -a; . ./.env.prod.local; set +a
  M=prisma/migrations/20261001090000_agenda_foundations/migration.sql
  { echo 'BEGIN;'
    sed -n '/>>> BACKFILL agenda_foundations BEGIN/,/<<< BACKFILL agenda_foundations END/p' "$M"
    echo 'COMMIT;'; } | psql "$DIRECT_URL" -v ON_ERROR_STOP=1
  # Para acotarlo a ciertos tenants: agregar, después de BEGIN,
  #   SET LOCAL kinesoft.backfill_tenants = '<id1>,<id2>';
  ```

  Después, repetir los conteos de (b). Con el deploy por merge (migración y código juntos) el hueco es de
  segundos y normalmente no hace falta.

**6) Import del catálogo** (lo corre Martin; no es migración; **staging primero**, después prod):

```bash
npm run db:prod:backup                     # backup antes (en staging, el suyo)
# dry-run (default): imprime el diff y los conflictos, no escribe. Lee prod → pide el project ref.
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts
# revisar conflictos (siglas ambiguas, referencias desconocidas): esas filas no se escriben, el resto sí
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts --apply
# verificación: otro dry-run tiene que dar 0 cambios
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts
```

- Usa `DIRECT_URL` (owner) y aborta si la conexión no tiene BYPASSRLS: el catálogo es de solo lectura para el rol
  de la app. Escribe todo en **una** tx (o entra completo o nada) y deja un `CatalogImportRun` por archivo.
- Nunca pisa una fila curada en Plataforma (`curatedAt`), no desarchiva y los `*.seed-*.csv` solo crean.
- El script corre fuera de Next y no puede invalidar el cache: **Plataforma → Catálogo → Importaciones →
  "Refrescar catálogo"**. Sin eso, los consultorios ven el catálogo viejo hasta que expire el cache (1 h).
- Después de un import grande, `ANALYZE` (lección de PERF.md: sin estadísticas el planner elige mal).
- Local: `npm run catalog:import` (dry-run) y `npm run catalog:import -- --apply`.

**7) Verificación final en prod:** el cliente vivo entra a `/agenda` y ve lo mismo que antes (sus turnos, su
horario); en Configuración → Profesionales tiene franjas lun-sáb con el horario del consultorio; el turnero
público ofrece los mismos horarios que antes; un sobreturno viejo muestra el badge.

**Rollback:** volver el deploy de Vercel al commit anterior. El schema nuevo es compatible con el código viejo
(columnas nullable o con default, tablas nuevas sin uso). Las filas que cargue el código nuevo (sedes, franjas,
bloqueos) quedan y se reusan al volver a desplegar.

## 3. Rollback

Prisma no revierte automáticamente. Como todas las migraciones de esta tanda son
aditivas, el rollback real es **volver el deploy de Vercel** al commit anterior: el
schema nuevo es compatible con el código viejo (columnas nuevas con default, tablas
nuevas sin uso). Solo si hiciera falta revertir el DDL, se escribe una migración
inversa nueva — nunca se edita una ya aplicada.
