# Runbook de migraciones — dev (local Docker) y prod (Supabase)

> Guía operativa para el dueño. Los comandos están listos para copiar/pegar.
> El agente **solo** aplica migraciones en LOCAL; producción la ejecuta el dueño.

---

## 0. Cómo está armado (leer una vez)

**Ya no hace falta pegar ninguna URL a mano.** El archivo `.env` tiene dos bloques
y se cambia de entorno **comentando / descomentando**:

```
# ─── DEV · Docker local ───   ✅ ACTIVO
DATABASE_URL="postgresql://kinesoft:…@localhost:5433/kinesoft?schema=public"
DIRECT_URL="postgresql://kinesoft:…@localhost:5433/kinesoft?schema=public"

# ─── PROD · Supabase ───   🔒 COMENTADO
# DATABASE_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
# DIRECT_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
```

Quién lee qué — **esto es lo importante**:

| | Lee | Rol | Efecto |
|---|---|---|---|
| **App corriendo** (`npm run dev`) | `.env.local` (gana sobre `.env`) | `kinesoft_app` | RLS **activa**. No la afecta el switch. |
| **CLI de Prisma** (`migrate`, `studio`, `seed`) | **`.env`** (NO lee `.env.local`) | owner | Necesita DDL. **Este es el switch.** |

> ⚠️ Antes el `.env` apuntaba **siempre a producción**, así que cualquier
> `npx prisma migrate` sin variables inline pegaba en prod. Por eso ahora arranca
> en DEV y prod está comentado.

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Runtime de la app (rol **sin** BYPASSRLS). En el CLI: la base a migrar. |
| `DIRECT_URL` | Conexión **directa** (5432, sin pooler) — la que usa `prisma migrate`. |
| `DATABASE_URL_SERVICE` | `kinesoft_service` (BYPASSRLS) en prod. Sin esto el panel Plataforma no escribe. |

---

## 1. Local (Docker) — desarrollo

Con el bloque **DEV activo** (que es como quedó), los comandos son directos:

```bash
cd ~/Documents/kinesoft

# 0) La DB tiene que estar arriba (solo el servicio db: adminer usa el 8080 y suele chocar)
docker compose up -d db
docker compose ps                 # kinesoft-db … Up (healthy)

# 1) Aplicar migraciones pendientes + regenerar el client
npx prisma migrate dev

# 2) Verificar
npx prisma migrate status         # → "Database schema is up to date!"
```

**Crear una migración nueva** (cuando cambia `schema.prisma`):

```bash
npx prisma migrate dev --name descripcion_corta_en_snake_case
```

**Resetear la base local** (destructivo: borra datos locales y re-siembra):

```bash
npx prisma migrate reset
# Después del reset: re-crear el rol de app y re-marcar el superadmin
psql "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" -f prisma/roles.local.sql
npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
```

---

## 2. Producción (Supabase + Vercel)

> **Orden recomendado:** aplicar migraciones **primero**, esperar unos segundos,
> y recién ahí mergear a `main` para que Vercel buildee con el schema ya migrado.
> Las migraciones pendientes son **aditivas** (columnas/tablas nuevas con default),
> así que el código viejo sigue andando entre ambos pasos.

### Paso a paso

**1) Cambiar el `.env` a PROD** — comentá las 2 líneas del bloque DEV y descomentá
las 2 del bloque PROD. Debe quedar así:

```
# DATABASE_URL="postgresql://kinesoft:…@localhost:5433/…"   ← comentada
# DIRECT_URL="postgresql://kinesoft:…@localhost:5433/…"     ← comentada
DATABASE_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
```

**2) Confirmar a dónde apunta** (no escribe nada — el output dice el host):

```bash
npx prisma migrate status
```

Tiene que decir `…supabase.com` y listar las migraciones pendientes.
Si dice `localhost:5433`, el switch quedó mal hecho: revisá el paso 1.

**3) Aplicar** (`deploy` solo aplica las pendientes; nunca genera ni resetea):

```bash
npx prisma migrate deploy
```

**4) Confirmar** que quedó en sync:

```bash
npx prisma migrate status         # → "Database schema is up to date!"
```

**5) VOLVER EL `.env` A DEV** (descomentá DEV, comentá PROD). Si te olvidás,
el próximo `prisma migrate dev` local te pega en producción.

> 💡 Verificación rápida de en qué modo estás:
> ```bash
> npx prisma migrate status 2>&1 | grep Datasource
> ```
> `localhost:5433` = DEV · `supabase.com` = PROD.

### Migraciones pendientes en prod (bloque reciente)

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

Estas se corren **con el bloque PROD descomentado** (mismo switch del `.env`), así
los scripts toman la conexión de producción sin pegar nada a mano:

```bash
# a) Rol de app sin BYPASSRLS + rol de servicio con BYPASSRLS.
#    psql necesita la URL explícita: copiala del bloque PROD del .env.
psql "$(grep -m1 '^DIRECT_URL=' .env | cut -d= -f2- | tr -d '"')" -f prisma/roles.supabase.sql
#    → después, en Vercel: DATABASE_URL apunta al rol app (pooler 6543)
#      y DATABASE_URL_SERVICE al rol kinesoft_service.

# b) Marcar a los superadmin de plataforma (vos + tu cliente).
#    El script usa DATABASE_URL del .env → con PROD descomentado, va a prod.
npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
npx tsx scripts/set-platform-admin.ts email-del-cliente@dominio.com
npx tsx scripts/set-platform-admin.ts --list          # verificar

# c) Bucket de Supabase Storage para la media de ejercicios
#    Crear "exercise-media" PRIVADO en el proyecto de prod (la app usa signed URLs).
```

> Al terminar, **volvé el `.env` a DEV** (paso 5 de arriba).

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
