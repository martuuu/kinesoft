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

## 3. Rollback

Prisma no revierte automáticamente. Como todas las migraciones de esta tanda son
aditivas, el rollback real es **volver el deploy de Vercel** al commit anterior: el
schema nuevo es compatible con el código viejo (columnas nuevas con default, tablas
nuevas sin uso). Solo si hiciera falta revertir el DDL, se escribe una migración
inversa nueva — nunca se edita una ya aplicada.
