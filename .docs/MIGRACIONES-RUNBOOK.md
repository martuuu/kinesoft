# Runbook de migraciones — dev (local Docker) y prod (Supabase)

> Guía operativa para el dueño. Los comandos están listos para copiar/pegar.
> El agente **solo** aplica migraciones en LOCAL; producción la ejecuta el dueño,
> en el orden que el agente deja escrito al cerrar cada bloque.
> Reescrito en A0b/A0c (2026-09-29): **ya no se comenta/descomenta el `.env`**.

---

## Go-live con reset (07-oct-2026) — **manda sobre §2.1-§2.4 donde choquen**

> **Decisión de Martin del 07-oct:** prod se **resetea** antes del go-live (reset total; el cliente vuelve a cargar).
> No hay datos de prod que preservar: el deploy de todo el bloque B (A + B-pre + Planes + verticales + Sala de Espera)
> es **una sola vez**, con la cadena completa de migraciones aplicada **desde vacío**. Contexto y contratos:
> [VERTICALES.md](VERTICALES.md); prechecks marcados en [PLANES.md §16](PLANES.md).
>
> **Obsoleto por el reset** (queda escrito abajo como historia, con nota en cada sección; se borra cuando el go-live
> quede hecho): el deploy incremental de §2.1-§2.4, los prechecks de datos, el dedupe de `(programId, index)`, el ensayo
> de datos en staging, el backfill de `agenda_foundations`, `normalize-patient-emails`, la ventana sin uso y el
> down-script de M1. Siguen valiendo: el precheck (0) (rol con BYPASSRLS), (17) Storage privado y el P3009 liviano.

**⚠️ Ya, independiente del reset (bloque A, AUDIT `data-api-anon-sin-rls`):** en la consola de prod, Settings → API →
Data API: si `public` está expuesto, **desactivarla** (o sacar `public` de los schemas expuestos). Precheck de solo
lectura:

```sql
SELECT relname, relrowsecurity, has_table_privilege('anon', oid, 'UPDATE')
FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r';
```

**Cadena de migraciones del go-live** (todas se aplican desde vacío, en orden de timestamp, con `migrate deploy`):

| Migración | Corrida | Estado |
|---|---|---|
| … todas las anteriores (tabla de §2, #1-#12) | A, B-pre | commiteadas |
| `20261004120000_plans_booking_link` (M1) | ES2a | commiteada (`0edb0c8`); el SQL no se toca |
| `20261007120000_tenant_verticals` (**M2**) | EV0 (ola V.0, sola) | **escrita y aplicada solo en el Docker local (07-oct), pendiente commit**. sha256 de `migration.sql` = `29649aa7fb7f4c1bc25eea9e5591a630569b632295961c315c6206c653cc8bb3`. `Tenant.vertical` (enum `TenantVertical`, default `KINESIOLOGY`), `Tenant.publicBookingEnabled` (default `false`) + bloque **guardado** `REVOKE … FROM anon, authenticated` (tablas, secuencias, rutinas y default privileges; en local no hay esos roles → NOTICE + no-op). `lock_timeout` 5 s |
| `…_reception_call_realtime` (**M3**) | SV (ola SV0, sola) | **futura**: `Booking.calledAt` + función `kinesoft_realtime_can_read` + policy guardada sobre `realtime.messages` |

**Orden del go-live** (staging primero, desde vacío, con QA completo; después prod):

1. Gate final del bloque B en local (después de EV1), commit de Martin, `develop` listo para `main`.
2. **Backup** de prod (`npm run db:prod:backup`): aunque se descarte, es la única copia de lo que cargó el cliente.
3. **Reset** de prod (acción de Martin en la consola de Supabase). Precheck (1) → **base vacía**:
   `SELECT count(*) FROM pg_tables WHERE schemaname='public';` = 0. Precheck (0): el rol de `DIRECT_URL` tiene
   `rolbypassrls = t`.
4. `migrate deploy` desde vacío (cadena completa hasta M3): `npm run db:prod:deploy` y `npm run db:prod:status` →
   "Database schema is up to date!". O merge a `main` y el build de Production aplica la cadena antes de servir.
5. **Roles SQL** (`prisma/roles.supabase.sql`, ver §2 "Tareas de prod que van una sola vez", punto a) → en Vercel
   `DATABASE_URL` al rol app y `DATABASE_URL_SERVICE` a `kinesoft_service`.
6. **Import del catálogo global** (`scripts/catalog-import.ts`, dry-run → `--apply` → dry-run = 0; comandos en §2.2).
7. **`create-tenant --vertical kinesiologia`** (casa de la plataforma):
   `KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/create-tenant.ts --vertical kinesiologia …`
   (`--vertical general|kinesiologia`, default `kinesiologia`).
8. **`set-platform-admin`** (§2, punto b).
9. Desde **/plataforma** → Consultorios: vertical y plan del cliente kine (PRO u otro) y **prender los turnos online**
   por consultorio (nacen apagados, EV-D2; también los prende el Titular desde Configuración → General).
10. **Data API desactivada** (arriba) y **Storage privado** (precheck (17): buckets `public = false`, ninguna policy de
    `storage.objects` para `anon`/`authenticated`; `SUPABASE_SERVICE_ROLE_KEY` en Vercel).
11. **Post-checks:** los de M1 (§2.4 "Post-checks", objeto por objeto), (11) tags DISCIPLINE = 2 y (12) vertical/plan del
    tenant ([PLANES.md §16](PLANES.md)), RLS de las tablas nuevas y **grants de M2** (tiene que dar 0 filas):

    ```sql
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
           OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
    ```

    Y en el log del deploy, ningún `WARNING tenant_verticals: … siguen accesibles` (autochequeo de M2). Columnas:
    `SELECT vertical, "publicBookingEnabled" FROM "Tenant";` → el tenant casa con la vertical elegida.
12. Con SV: `REALTIME_DRIVER=off` en el deploy → prechecks R1-R4 y V1-V6 en staging ([VERTICALES.md §7](VERTICALES.md))
    → env → `supabase`.

**Si falla un `migrate deploy` (P3009):** con la base vacía no hay nada que salvar: corregir la causa, re-reset y
`migrate deploy` de nuevo (antes de abrir al cliente). Después de abrir, el rollback es revertir el deploy de Vercel.

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

**No correr `npx prisma format` en una sesión:** reformatea **todo** `schema.prisma` (alineación de columnas de
cada modelo) y el diff tapa el cambio real; se vio en ES2a. Se edita a mano solo el bloque que toca la sesión.

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
> Las migraciones son aditivas, así que el código viejo sigue andando si se aplican antes del deploy. Única
> excepción aprobada: M1 `plans_booking_link` dropea `Patient_userId_key` (relaja la unicidad, el código viejo lo
> tolera; §2.4).

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

> **Desde el reset del 07-oct:** esta tabla es la **cadena completa** que se aplica desde vacío en el go-live, no una
> lista de pendientes sobre datos vivos. Los avisos de abajo (#3 con duplicados, etc.) ya no aplican a prod.

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
| 13 | `20261004120000_plans_booking_link` | M1 de Planes: FK turno↔plan/sesión, 2 tablas con RLS, `Patient_userId_key` por consultorio + **backfill** | ES2a — **ver §2.3 y §2.4** |
| 14 | `20261007120000_tenant_verticals` | M2: `Tenant.vertical` + `Tenant.publicBookingEnabled` + REVOKE guardado de `anon`/`authenticated` | EV0 — **ver «Go-live con reset»** |
| 15 | `…_reception_call_realtime` (futura) | M3: `Booking.calledAt` + `kinesoft_realtime_can_read` + policy guardada de `realtime.messages` | SV — **ver «Go-live con reset»** |

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

> ⚠️ **Obsoleta por el reset de prod (07-oct):** el deploy incremental de A y `normalize-patient-emails` (no hay emails viejos que normalizar). `tenant_onboarding` se aplica desde vacío con la cadena; las tareas de consola de EXTERNAL-CONFIG §0.1 siguen valiendo. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

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

> ⚠️ **Obsoleta por el reset de prod (07-oct):** los prechecks de datos y el backfill de `agenda_foundations` (con base vacía no hace nada). El import del catálogo (abajo) **sigue** y es el paso 6 del go-live. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

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
WHERE b."scheduledFor" > (now() AT TIME ZONE 'UTC') AND b.status <> 'CANCELLED' AND NOT EXISTS (
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
--     OJO (corregido en el Paso 0 de Planes, 03-oct): las columnas son TIMESTAMP(3) SIN zona y guardan UTC.
--     `col AT TIME ZONE 'America/...'` sobre un timestamp sin zona lo interpreta COMO hora AR y devuelve UTC:
--     corría la hora 3 h al revés. La hora AR es ((col AT TIME ZONE 'UTC') AT TIME ZONE 'America/...'),
--     y "ahora" comparable es (now() AT TIME ZONE 'UTC').
WHERE b."scheduledFor" > (now() AT TIME ZONE 'UTC') AND b.status <> 'CANCELLED' AND (
  EXTRACT(DOW FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires'))=0
  OR EXTRACT(HOUR FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')) < t."businessHoursStart"
  OR EXTRACT(HOUR FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')) >= t."businessHoursEnd");
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

## 2.3 Planes: preparación del deploy de M1 (`plans_booking_link`) — desde ES1 (04-oct-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** el dedupe de `(programId, index)` y los prechecks (2) y (15). El (17) Storage privado **sigue** (paso 10 del go-live). El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> **ES1 (Planes P0) no tiene migraciones.** La única migración de Planes es M1 `plans_booking_link`, escrita y
> aplicada en local en ES2a (04-oct). Por la decisión del 04-oct va en **un solo deploy al cierre del bloque B**,
> después de `catalog_global` y `agenda_foundations`. Esta sección deja lo que ES1 preparó (el dedupe y dos prechecks
> que vencen antes del deploy); el deploy en sí está en **§2.4**.

**Prechecks de solo lectura** (los SQL completos están en PLANES.md §16; acá los que trajo ES1):

```sql
-- (2) BLOQUEANTE para M1: sesiones repetidas (programId, index). Si > 0 → dedupe (abajo).
SELECT count(*) FROM (SELECT "programId","index" FROM "Session" GROUP BY 1,2 HAVING count(*)>1) x;

-- (15) Pacientes asignados a ASSISTANT/BILLING (S07sp). Si > 0: REASIGNARLOS con "Asignar profesional"
--      (assignPatientToPractitioner) ANTES del deploy. Con el nivel `admin` esa Secretaria deja de tener full
--      sobre "sus" pacientes y el kine tiene que quedar a cargo.
SELECT count(*) FROM "Patient" p
JOIN "Practitioner" pr ON pr.id = p."assignedPractitionerId"
JOIN "Membership" m ON m."userId" = pr."userId" AND m."tenantId" = p."tenantId"
WHERE m.role IN ('ASSISTANT','BILLING');

-- (17) Storage (S02m): buckets privados y ninguna policy de storage.objects para anon/authenticated.
SELECT id, public FROM storage.buckets;
SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects';
```

- **(17):** desde ES1 la app usa Storage **solo con service role** (`lib/storage-internal.ts`), así que
  `SUPABASE_SERVICE_ROLE_KEY` **tiene que estar en Vercel** (Production y staging) antes del deploy; sin ella, subir,
  firmar y borrar archivos fallan cerrado. Si (17) muestra un bucket `public = true` o una policy para `anon` /
  `authenticated` sobre `patient-files` o `exercise-media`, es una **fuga de bloque A**: hacer privado el bucket y
  dropear esas policies **en el mismo deploy** en que el código pasa a service role (ni antes, porque el código viejo
  las usa, ni después, porque quedarían abiertas). En el SQL Editor: `DROP POLICY "<nombre>" ON storage.objects;`
  por cada una, con backup previo.

**Dedupe de `(programId, index)`** (S02x; lo corre Martin; no es migración). Es una herramienta **pre-M1**: M1 crea el
único parcial `Session_programId_index_live_key` y aborta si hay repetidos. El script renumera: en cada grupo conserva el
id menor y manda el resto, en id asc, a `max+1`, `+2`… del programa. No borra nada ni toca `SessionExercise`,
`EvaScore`, `totalSessions` ni `Booking`. Idempotente. Dry-run por defecto (tx READ ONLY); aborta sin BYPASSRLS (bajo
RLS vería 0 sesiones = falso verde). Imprime el mapeo viejo → nuevo con ids, sin PHI. Requiere
`--conditions=react-server` (importa un módulo `server-only`).

```bash
# Local (Docker :5433)
npm run plans:dedupe-session-index                 # dry-run (local, con M1 aplicada: 0 movimientos)
npm run plans:dedupe-session-index -- --apply

# Prod (y staging, con su .env): NUNCA el script npm (lee .env.local). Pide el project ref.
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx --conditions=react-server scripts/plans-dedupe-session-index.ts
# opcional: --tenant=<id>[,<id>…] limita el alcance
```

**Orden** (staging primero, después prod), **inmediatamente antes del deploy de M1 y en la misma ventana sin uso**
(entre el dedupe y M1 no puede entrar una sesión a medida nueva que vuelva a duplicar):
1. precheck (2);
2. backup (`npm run db:prod:backup`);
3. dry-run;
4. revisar el mapeo (qué sesiones cambian de número);
5. `--apply`;
6. dry-run otra vez → **tiene que dar 0**;
7. recién ahí, el deploy con M1 (§2.4).

Aviso al usuario: las sesiones movidas cambian su "Sesión n" (pasan al final del plan).

**Después de M1** el script sigue andando pero no tiene nada que hacer: si existe `Session.archivedAt`, agrupa solo las
sesiones **vivas** (`"archivedAt" IS NULL`, F2 de P1.Z), igual que el único parcial. Una archivada que repite el index de
una viva no es duplicado, y el dry-run da 0. `tests/integration/plans-dedupe.test.ts` lo prueba post-M1 (dry-run = 0,
archivada + viva = 0, se niega sin BYPASSRLS); el apply con duplicados quedó probado en ES1 y en el unit del
planificador.

## 2.4 Deploy de M1 (`plans_booking_link`) — escrita en ES2a (04-oct-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** los prechecks de datos, la ventana sin uso, el orden incremental y el down-script. **Siguen:** el precheck (0), el P3009 (liviano: re-reset) y los post-checks objeto por objeto. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> **Hay 1 migración nueva:** `20261004120000_plans_booking_link` (sha256 de `migration.sql` =
> `7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd`). Aplicada y verificada en el Docker local; en
> staging y prod **no**. Va en el deploy único del cierre de B. Qué crea: PLANES.md §3 (el bloque SQL es idéntico al
> archivo). Incluye la **única excepción** a "todo aditivo", aprobada por Martin el 03-oct: `DROP INDEX
> "Patient_userId_key"`, reemplazado por `Patient_tenantId_userId_key`.

### Prechecks (solo lectura; SQL completo en PLANES.md §16)

| # | Qué | Esperado | Si no |
|---|---|---|---|
| (0) | rol de `DIRECT_URL` y migraciones previas | `rolbypassrls = t`; B-pre aplicado, nada fallido | sin BYPASSRLS, el backfill **aborta** M1 (guarda a propósito): usar el owner |
| (1) | M1 no corrió | 0 columnas/tipos; `to_regclass` null en las 2 tablas y los 2 índices nuevos; `Patient_userId_key` presente | frenar |
| (2) | duplicados `(programId, index)` | 0 | dedupe (§2.3) en la misma ventana |
| (3) | integridad cross-tenant | 0 en las 4 | frenar |
| (4) | `idempotencyKey LIKE 'plan:%'` y `copagoCents < 0` | 0 | frenar |
| (5) | volumen (Booking, Session, Patient) | dimensiona el lock | — |
| (11) | slugs `kinesiologia` / `osteopatia` | libres o ya `kind = 'DISCIPLINE'` | renombrar el tag ajeno antes: el `ON CONFLICT` es por slug, pero un id `tag_discipline_*` usado con otro slug choca por PK |
| (15) / (17) | Secretaria asignada / Storage | §2.3 | §2.3 |

```sql
-- (2) y (11), los bloqueantes que más se mueven entre staging y prod
SELECT count(*) FROM (SELECT "programId","index" FROM "Session" GROUP BY 1,2 HAVING count(*)>1) x;   -- 0
SELECT id, slug, kind FROM "Tag" WHERE slug IN ('kinesiologia','osteopatia') OR id LIKE 'tag_discipline_%' OR kind='DISCIPLINE';
```

### Ventana sin uso (no solo por el dedupe)

M1 es **una** transacción. Cada `ALTER TABLE` toma ACCESS EXCLUSIVE y lo retiene hasta el `COMMIT`: sobre
`TreatmentProgram`, `Session`, `Booking`, `PlanTemplate`, `EvaScore` y `Service`, y el `DROP INDEX` toma ACCESS
EXCLUSIVE sobre `Patient` (bloquea **también lecturas**: la ficha y la agenda esperan). Como toma TreatmentProgram y
Session antes que Booking, un turno en vuelo que tenga Booking y vaya a leer el plan puede cruzarse en un deadlock; el
`lock_timeout = '5s'` hace que falle rápido en vez de colgar la agenda. Con el volumen actual son milisegundos, pero se
hace en horario sin uso (el mismo de §2.3) y con el cliente avisado.

### Orden en prod (deploy único al cierre de B)

1. Prechecks (0)-(4), (11), (13), (15) y (17), primero en staging y después en prod.
2. Si (2) > 0: dedupe según §2.3 (dry-run → revisar → `--apply` → dry-run = 0).
3. `npm run db:prod:backup` (en staging, el suyo).
4. **Staging:** `migrate deploy` de todas las pendientes **en orden**: `catalog_global` → `agenda_foundations` →
   `plans_booking_link`; post-checks de abajo; QA de B-pre y de Planes con `TZ=UTC`.
5. **Prod:** merge de develop a `main` en la ventana sin uso. El build de Production aplica las migraciones **antes**
   de servir el código nuevo (`scripts/vercel-build.mjs`); si M1 falla, el build falla y sigue sirviendo el deploy
   anterior.
6. Post-checks en prod. Después, los pasos post-deploy de PLANES.md §16 (paso 4).

**GUC del backfill:** `kinesoft.backfill_tenants` acota el backfill del responsable a ciertos tenants (lo usan los
tests). En prod **no se setea** (= todos). Si alguna vez se acota, va **sin espacios**: `'id1,id2'`
(`string_to_array` no recorta y `' id2'` no matchea nada, en silencio).

### Si falla: P3009

Cualquier error dentro de la tx (`lock_timeout`, duplicado `(programId, index)`, rol sin BYPASSRLS por la guarda del
backfill, un id `tag_discipline_*` ya usado con otro slug) hace **ROLLBACK completo**: la base queda como antes, pero
`_prisma_migrations` registra M1 como fallida y el próximo `migrate deploy` corta con **P3009**. Corregir la causa y:

```bash
npx dotenv -e .env.prod.local -- npx prisma migrate resolve --rolled-back 20261004120000_plans_booking_link
npm run db:prod:status        # M1 vuelve a figurar como pendiente
# reintentar: redeploy en Vercel (o npm run db:prod:deploy)
```

### Post-checks (objeto por objeto)

```sql
-- Registro: M1 aplicada una vez, sin error
SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name LIKE '%plans_booking_link';
-- checksum = 7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd

-- Tablas nuevas con RLS: t,t en las dos; una policy <tabla>_tenant_isolation por tabla; vacías
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('ProgramAuthorization','PatientChangeRequest');
SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('ProgramAuthorization','PatientChangeRequest');
SELECT (SELECT count(*) FROM "ProgramAuthorization") pa, (SELECT count(*) FROM "PatientChangeRequest") pcr;

-- Identidad del portal: el viejo no está, los 2 nuevos sí
SELECT to_regclass('"Patient_userId_key"') viejo, to_regclass('"Patient_tenantId_userId_key"') por_tenant,
       to_regclass('"Patient_id_tenantId_key"') destino_fk;

-- Los 4 únicos parciales, con su predicado
SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('Session_programId_index_live_key','Booking_session_active_key',
  'ProgramAuthorization_programId_current_key','PatientChangeRequest_patient_pending_key');

-- FKs compuestas y CHECKs (nombres de PLANES §3)
SELECT conrelid::regclass, conname, contype FROM pg_constraint
WHERE conname LIKE 'Booking_plan_%' OR conname LIKE 'Booking_session_%' OR conname LIKE 'Booking_priced_%'
   OR conname LIKE 'TreatmentProgram_%_check' OR conname LIKE 'PlanTemplate_%_check' OR conname LIKE 'Session_%_check'
   OR conname LIKE 'ProgramAuthorization_%' OR conname LIKE 'PatientChangeRequest_%' ORDER BY 1,2;

-- Pricing con IS NOT DISTINCT FROM (F1): Postgres lo guarda como NOT (… IS DISTINCT FROM …); ok = t en las 2
SELECT conname, pg_get_constraintdef(oid) LIKE '%NOT ("pricingMode" IS DISTINCT FROM%' ok FROM pg_constraint
WHERE conname IN ('TreatmentProgram_pricing_check','PlanTemplate_pricing_check');

-- Datos: M1 no vinculó turnos; tags DISCIPLINE = 2; backfill del responsable
SELECT count(*) FROM "Booking" WHERE "programId" IS NOT NULL OR "pricedByPlan";                -- 0
SELECT count(*) FROM "Tag" WHERE kind='DISCIPLINE' AND slug IN ('kinesiologia','osteopatia');  -- 2
SELECT count(*) FILTER (WHERE "practitionerId" IS NOT NULL) con_responsable,
       count(*) FILTER (WHERE "practitionerId" IS NULL AND EXISTS (SELECT 1 FROM "Session" s WHERE s."programId"=p.id)) sin_responsable_con_sesiones
FROM "TreatmentProgram" p;   -- sin_responsable_con_sesiones = 0, salvo profesionales de otro tenant (los descarta el EXISTS)
```

**Drift esperado.** `npx dotenv -e .env.prod.local -- npx prisma migrate diff --from-schema-datasource
prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (solo lee) tiene que mostrar **exactamente 3
líneas**: `DROP CONSTRAINT "Booking_plan_patient_fkey"`, `"Booking_plan_tenant_fkey"` y `"Booking_session_program_fkey"`
(las FKs compuestas de Booking que el schema no declara; drift aceptado). Prisma 5 no ve los CHECK, los predicados de los
únicos parciales ni las policies, así que no aparecen. Cualquier otra línea → frenar y avisar. **Nunca** se corre
`migrate dev` para "arreglarlo": borraría esos objetos.

### Rollback

1. **Lo normal:** volver el deploy de Vercel al commit anterior. El código viejo tolera M1 (columnas nuevas null o con
   default, tablas nuevas vacías, CHECKs que se cumplen sin vínculo, búsquedas por `Patient.userId` con `findFirst`).
   La migración **no** se baja.
2. **Down-script** (PLANES.md §3 «Rollback»): solo con backup previo y decisión de Martin. Una tx; si el chequeo del
   paso 3 encuentra un `userId` repetido, aborta todo (hay pacientes del portal vinculados en más de un consultorio:
   frenar y decidir antes).

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
-- 1. Tablas nuevas (arrastran sus policies, índices y FKs)
DROP TABLE "PatientChangeRequest";
DROP TABLE "ProgramAuthorization";
-- 2.
DROP TYPE "PatientChangeRequestStatus";
-- 3. Patient_userId_key vuelve SOLO si no hay userId repetidos
DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT "userId" FROM "Patient" WHERE "userId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) x) > 0 THEN
    RAISE EXCEPTION 'Patient.userId repetido en más de un consultorio: no se recrea Patient_userId_key. Frenar.';
  END IF;
END $$;
CREATE UNIQUE INDEX "Patient_userId_key" ON "Patient"("userId");
DROP INDEX "Patient_tenantId_userId_key";
DROP INDEX "Patient_id_tenantId_key";
-- 4. El resto, en orden inverso al SQL de M1
DROP INDEX "EvaScore_sessionId_idx";
ALTER TABLE "EvaScore" DROP CONSTRAINT "EvaScore_sessionId_fkey", DROP COLUMN "sessionId", DROP COLUMN "note";

DROP INDEX "PlanTemplate_tenantId_discipline_idx";
DROP INDEX "PlanTemplate_serviceId_idx";
ALTER TABLE "PlanTemplate"
  DROP CONSTRAINT "PlanTemplate_schedule_check", DROP CONSTRAINT "PlanTemplate_duration_check",
  DROP CONSTRAINT "PlanTemplate_price_nonneg_check", DROP CONSTRAINT "PlanTemplate_pricing_check",
  DROP CONSTRAINT "PlanTemplate_serviceId_fkey",
  DROP COLUMN "archivedAt", DROP COLUMN "notes", DROP COLUMN "totalPriceCents", DROP COLUMN "pricePerSessionCents",
  DROP COLUMN "pricingMode", DROP COLUMN "schedule", DROP COLUMN "durationMin", DROP COLUMN "serviceId", DROP COLUMN "discipline";

DROP INDEX "Booking_session_active_key";
DROP INDEX "Booking_sessionId_idx";
DROP INDEX "Booking_tenantId_programId_idx";
ALTER TABLE "Booking"
  DROP CONSTRAINT "Booking_priced_by_plan_check", DROP CONSTRAINT "Booking_plan_patient_check",
  DROP CONSTRAINT "Booking_plan_link_check", DROP CONSTRAINT "Booking_session_program_fkey",
  DROP CONSTRAINT "Booking_plan_patient_fkey", DROP CONSTRAINT "Booking_plan_tenant_fkey",
  DROP CONSTRAINT "Booking_sessionId_fkey", DROP CONSTRAINT "Booking_programId_fkey",
  DROP COLUMN "pricedByPlan", DROP COLUMN "sessionId", DROP COLUMN "programId";

DROP INDEX "Session_programId_index_live_key";
DROP INDEX "Session_id_programId_key";
ALTER TABLE "Session" DROP CONSTRAINT "Session_priceCents_check",
  DROP COLUMN "updatedAt", DROP COLUMN "archivedAt", DROP COLUMN "priceCents", DROP COLUMN "title";

DROP INDEX "TreatmentProgram_templateId_idx";
DROP INDEX "TreatmentProgram_locationId_idx";
DROP INDEX "TreatmentProgram_serviceId_idx";
DROP INDEX "TreatmentProgram_practitionerId_idx";
DROP INDEX "TreatmentProgram_tenantId_discipline_status_idx";
DROP INDEX "TreatmentProgram_id_patientId_key";
DROP INDEX "TreatmentProgram_id_tenantId_key";
DROP INDEX "TreatmentProgram_tenantId_idempotencyKey_key";
ALTER TABLE "TreatmentProgram"
  DROP CONSTRAINT "TreatmentProgram_schedule_check", DROP CONSTRAINT "TreatmentProgram_duration_check",
  DROP CONSTRAINT "TreatmentProgram_price_nonneg_check", DROP CONSTRAINT "TreatmentProgram_pricing_check",
  DROP CONSTRAINT "TreatmentProgram_templateId_fkey", DROP CONSTRAINT "TreatmentProgram_locationId_fkey",
  DROP CONSTRAINT "TreatmentProgram_serviceId_fkey", DROP CONSTRAINT "TreatmentProgram_practitionerId_fkey",
  DROP COLUMN "archivedAt", DROP COLUMN "updatedAt", DROP COLUMN "idempotencyKey", DROP COLUMN "notes",
  DROP COLUMN "totalPriceCents", DROP COLUMN "pricePerSessionCents", DROP COLUMN "pricingMode", DROP COLUMN "schedule",
  DROP COLUMN "durationMin", DROP COLUMN "templateId", DROP COLUMN "locationId", DROP COLUMN "serviceId",
  DROP COLUMN "practitionerId", DROP COLUMN "discipline";

ALTER TABLE "Service" DROP COLUMN "discipline";
DROP TYPE "ProgramPricingMode";
DROP TYPE "Discipline";
-- Los 2 tags DISCIPLINE se dejan (el enum TagKind ya tenía DISCIPLINE desde la Ronda 7).
COMMIT;
```

3. **Marcar M1 como revertida** en `_prisma_migrations`; sin esto Prisma la sigue dando por aplicada y nunca la
   re-aplica:

```bash
npx dotenv -e .env.prod.local -- npx prisma migrate resolve --rolled-back 20261004120000_plans_booking_link
```

   ⚠️ Prisma documenta `--rolled-back` para migraciones **fallidas**; sobre una que terminó bien puede negarse (P3012,
   "not in a failed state"). En ese caso, con el backup ya hecho y en el SQL Editor:
   `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20261004120000_plans_booking_link';`
   (Prisma ignora las filas con `rolled_back_at` y la vuelve a aplicar en el próximo deploy). Probarlo primero en
   staging.

### Nota: bases que aplicaron la versión vieja de M1 (antes de F1)

En P1.Z se enmendó C1 (F1): `TreatmentProgram_pricing_check` y `PlanTemplate_pricing_check` pasaron de `=` a `IS NOT
DISTINCT FROM`, porque con `pricingMode` NULL el `=` da NULL (lógica de 3 valores) y el CHECK dejaba pasar un precio sin
modo. Prod y staging nunca la aplicaron. Si alguna base (otro Docker, un staging de prueba) ya tiene la versión
vieja, `migrate deploy` corta por checksum distinto. Arreglo, con backup, sin re-correr M1:

```sql
BEGIN;
ALTER TABLE "TreatmentProgram" DROP CONSTRAINT "TreatmentProgram_pricing_check",
  ADD CONSTRAINT "TreatmentProgram_pricing_check" CHECK (
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL));
ALTER TABLE "PlanTemplate" DROP CONSTRAINT "PlanTemplate_pricing_check",
  ADD CONSTRAINT "PlanTemplate_pricing_check" CHECK (
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL));
UPDATE _prisma_migrations SET checksum = '7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd'
WHERE migration_name = '20261004120000_plans_booking_link';
COMMIT;
```

Si el `ADD CONSTRAINT` falla, hay filas con precio y sin modo: corregirlas antes (son justo las que el CHECK viejo dejaba
pasar).

## 3. Rollback

Prisma no revierte automáticamente. El rollback real es **volver el deploy de Vercel** al commit anterior: las
migraciones son aditivas y el código viejo sigue andando sobre el schema nuevo (columnas nuevas con default, tablas
nuevas sin uso). Si hiciera falta revertir el DDL, se escribe una migración inversa nueva; nunca se edita una ya
aplicada. Hasta el go-live con reset (07-oct), el rollback de un `migrate deploy` fallido es re-reset y volver a aplicar
(«Go-live con reset»); el down-script de M1 (§2.4) quedó sin uso.
