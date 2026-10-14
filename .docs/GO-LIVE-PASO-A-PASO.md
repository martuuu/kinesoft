# Go-live a producción · paso a paso (para Martin)

> Escrito el 14-oct-2026, después de SV. Es la versión **con comandos y consolas** de la sección «Go-live con reset»
> del [MIGRACIONES-RUNBOOK.md](MIGRACIONES-RUNBOOK.md) (que queda como referencia técnica). Todo lo que dice «tuyo» lo
> hacés vos: el agente no toca prod. Marcá las casillas a medida que avanzás.
>
> **Decisiones de Martin del 14-oct (mandan sobre lo de abajo):**
> - **No hay staging:** no quedan proyectos gratis en Supabase. Todo se ejecuta sobre prod, con backup antes.
> - **No hay reset por ahora:** prod conserva sus datos y las migraciones pendientes se aplican sobre la base viva
>   (camino incremental del RUNBOOK §2.1-§2.4). La sección 6.2 queda en suspenso.
> - **El catálogo clínico de prod es todo demo** (la sección 1 no bloquea).
> - Variables de Vercel: las de prod se quedan como están (`REALTIME_DRIVER` sin setear = `off`).
> - Para la demo se crea **un consultorio nuevo** en prod.
>
> **Regla de oro (original):** todo se hace primero en **staging** (un proyecto de Supabase aparte) y recién después en prod. Los
> pasos son los mismos; solo cambia el archivo de entorno (`.env.staging.local` o `.env.prod.local`).

---

## 0. Tus tres dudas, respondidas

**¿Las migraciones se aplican solas?** Solo en un caso: cuando Vercel buildea la rama **`main`** (Production). El build
corre `prisma migrate deploy` antes de `next build` (`scripts/vercel-build.mjs`), usando `DIRECT_URL`. Los Preview
(cualquier otra rama) **nunca** migran. Si la migración falla, el build falla y Vercel no publica nada. Por eso
recomiendo que **la primera vez las apliques vos a mano** (paso 6.3): las ves correr, ves los errores, y cuando
mergees a `main` el build solo dice «No pending migrations».

**¿Qué es lo de realtime?** Es la Sala de Espera en vivo. Está apagada por defecto (`REALTIME_DRIVER=off`): la app
anda igual que antes y `/sala` se actualiza cada 60 s. Se prende **al final**, en un paso aparte (sección 7), cuando
el resto ya está andando. Necesita configurar tres cosas en Supabase (clave JWT, «Allow public access» apagado,
policy ya creada por la migración) y tres variables en Vercel.

**¿Dónde configuro lo que falta de Supabase?** Todo está en la tabla de la sección 3, con el menú exacto. Las
migraciones se encargan del schema; **no** configuran Auth, Storage ni Realtime: eso es consola.

---

## 1. ⚠️ Antes de nada: el reset borra la biblioteca global (bloqueante)

El reset (`DROP SCHEMA public`) borra **todo** lo que está en la base de prod, incluido lo que no es del cliente:
ejercicios globales, condiciones de Diagnóstico, tags, regiones anatómicas, media y artículos. **No existe una forma
versionada de recargarlos en prod:** salen de `prisma/seed.ts`, que es solo local y se niega a correr contra una base
remota. El catálogo de obras sociales y prácticas **sí** se recarga (`scripts/catalog-import.ts`); lo clínico no.

**Qué hacer, en este orden:**

1. Contá qué hay hoy en prod (solo lectura, SQL Editor de Supabase de prod):

   ```sql
   SELECT 'Exercise global' AS tabla, count(*) FROM "Exercise" WHERE "tenantId" IS NULL
   UNION ALL SELECT 'Condition global', count(*) FROM "Condition" WHERE "tenantId" IS NULL
   UNION ALL SELECT 'Tag', count(*) FROM "Tag"
   UNION ALL SELECT 'AnatomicalRegion', count(*) FROM "AnatomicalRegion"
   UNION ALL SELECT 'ExerciseMedia', count(*) FROM "ExerciseMedia"
   UNION ALL SELECT 'ExerciseArticle', count(*) FROM "ExerciseArticle";
   ```

2. Si da **cero o solo datos de demo**: el reset es seguro, seguí.
3. Si hay contenido real (lo cargaste vos desde Plataforma): **no resetees todavía**. Falta una tarea chica que
   exporte e importe esas tablas (un script `catalog-global export/restore`, con tests). Pedímela y la hacemos antes
   del reset. La alternativa es no resetear y aplicar las migraciones sobre la base actual (RUNBOOK §2.1-§2.4), que
   conserva todo pero trae los prechecks de datos que el reset te evitaba.

El backup (paso 6.1) cubre el desastre, pero **restaurar un dump a mano no es un plan**: resolvé esto primero.

---

## 2. Qué tenés que tener creado

- [ ] **Proyecto Supabase de prod** (el que ya usás) y **uno de staging** (plan gratis alcanza). Staging es obligatorio
      para probar realtime y la cadena de migraciones, que nunca corrió completa sobre Supabase.
- [ ] **Proyecto Vercel** conectado al repo, rama de producción = `main`.
- [ ] **Dominio** propio apuntando a Vercel (Settings → Domains). Anotá la URL final: es `NEXT_PUBLIC_APP_URL`.
- [ ] **SMTP propio** (Resend o Postmark) con el dominio verificado (SPF, DKIM, DMARC). Sin esto el login del cliente
      anda, pero **no llegan** mails de alta, invitación ni reseteo de contraseña.
- [ ] **Upstash Redis** (región sa-east-1), uno para prod y otro para staging. Sin esto el rate-limit es decorativo.
- [ ] **Mercado Pago**: credenciales de **producción** (Access Token, Public Key) y, para staging, las de **prueba**.
- [ ] *(Opcional)* **Sentry** (`SENTRY_DSN`).
- [ ] En tu compu: `psql` y `pg_dump` instalados, y Node del repo (`npm ci` hecho).

### Archivos de entorno locales (gitignored, los creás vos)

Uno por proyecto. Los valores salen de Supabase → **Connect** (cadenas de conexión) y Settings → **API**:

```bash
# .env.prod.local   (y .env.staging.local con los datos de staging)
DIRECT_URL="postgresql://postgres.<ref>:<PASSWORD_DB>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
DATABASE_URL="postgresql://postgres.<ref>:<PASSWORD_DB>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="…"
SUPABASE_SERVICE_ROLE_KEY="…"
```

`<ref>` es el *project ref* (lo que va antes de `.supabase.co`). Es el valor que los scripts piden como
`KINESOFT_CONFIRM_PROD=<ref>` para no equivocarte de proyecto. El host exacto (`aws-1-sa-east-1…`) copialo de la
consola: depende de la región de tu proyecto. Estas dos primeras líneas apuntan al **dueño** (`postgres`), por el
puerto 5432 (sesión): son solo para migrar y correr scripts, **no** son las de Vercel.

---

## 3. Consola de Supabase · lo que hay que configurar (por proyecto)

Las migraciones no hacen nada de esto. Hacelo en staging y en prod. Los nombres de menú pueden variar un poco entre
versiones de la consola.

| # | Qué | Dónde | Valor |
|---|---|---|---|
| 1 | Confirmar email | Authentication → Providers → Email | **Confirm email: ON**. **Secure password change: OFF** |
| 2 | URLs de redirección | Authentication → URL Configuration | **Site URL** = `https://tu-dominio`. **Redirect URLs**: `https://tu-dominio/auth/confirm**`, `/auth/callback`, `/invite/**`, `/onboarding`, `/reset`, `/portal/**` (cada una con el dominio delante) |
| 3 | SMTP propio | Authentication → SMTP Settings | Custom SMTP con las credenciales de Resend/Postmark |
| 4 | Plantillas de mail | Authentication → Email Templates | El link de **Confirm signup** y **Reset password** tiene que ir a `/auth/confirm` con `token_hash` (texto exacto en [EXTERNAL-CONFIG.md §0.1](EXTERNAL-CONFIG.md)). Sin esto el mail llega pero el link no funciona |
| 5 | Google (solo si lo usás) | Authentication → Providers → Google | Client ID y Secret de Google Cloud; en Google, la redirect URI `https://<ref>.supabase.co/auth/v1/callback` |
| 6 | Buckets privados | Storage | Existen `patient-files` y `exercise-media`, ambos **Public: OFF**. Ninguna policy de `storage.objects` para `anon` ni `authenticated` |
| 7 | Data API | Settings → API (Data API) | **Desactivada** (o `public` fuera de los schemas expuestos). La app nunca la usa |
| 8 | Clave JWT | Settings → JWT Keys | Ver paso 7 (realtime). Anotá si hay «Legacy JWT secret» activo |
| 9 | Realtime público | Settings → Realtime | **Allow public access: OFF** |
| 10 | Backups | Database → Backups | Anotá si hay backups diarios y PITR (en prod, idealmente PITR) |

Los puntos 1-4 los exige el código para que el alta y el reseteo funcionen; 6, 7 y 9 son seguridad (si queda el
Data API prendido, la clave pública podría leer o escribir tablas sin RLS). Los 8 y 9 se completan en la sección 7.

---

## 4. Vercel · variables de entorno

Settings → Environment Variables. Cada variable se carga en el **scope** correcto: **Production** con los datos de
prod, **Preview** con los de staging. Además: Settings → Environment Variables → **«Automatically expose System
Environment Variables» ON** (sin eso, Production se buildea como si no lo fuera).

| Variable | Production | Preview (staging) |
|---|---|---|
| `DIRECT_URL` | owner `postgres`, sesión 5432 (la misma de `.env.prod.local`) | ídem staging |
| `DATABASE_URL` | rol **`kinesoft_app`**, pooler de transacciones **6543** (paso 6.4) | ídem staging |
| `DATABASE_URL_SERVICE` | rol **`kinesoft_service`**, pooler 6543 (paso 6.4) | ídem staging |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Settings → API | de staging |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API | de staging |
| `NEXT_PUBLIC_APP_URL` | `https://tu-dominio` (no localhost: el build falla) | URL del preview o dominio de staging |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | credenciales de **producción** | credenciales de **prueba** |
| `MP_WEBHOOK_SECRET` | el «secret» del webhook de MP (paso 6.9) | el de la app de prueba |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash prod | Upstash staging |
| `SENTRY_DSN` | opcional | opcional |
| `REALTIME_DRIVER` | **`off`** (se cambia en la sección 7) | `off` hasta la sección 7 |

**Nunca** cargues `KINESOFT_ALLOW_DEMO_ACTOR` (es el bypass de login local).

Si falta una variable obligatoria, el **build de Production falla** a propósito, con el nombre de la que falta.

---

## 5. Ensayo en staging (hacelo completo antes de tocar prod)

Mismos pasos que prod (sección 6), con `.env.staging.local` y el proyecto de staging. Lo que cambia:

- Staging está vacío: **no hay reset**. Saltá 6.2.
- Corré igual 6.3 (migrar), 6.4 (roles), 6.5 (catálogo) y 6.6 (crear consultorio).
- En vez de mergear a `main`, **pusheá `develop`**: Vercel arma un Preview con las variables de staging. En el log
  tiene que decir `[vercel-build] skip migrate (VERCEL_ENV=preview)` (los Preview no migran; por eso migrás vos a
  mano) y la app tiene que conectar a staging.
- Probá login, crear un turno, `/sala`, el turnero público y un pago de prueba con MP en modo prueba.
- Al final, la sección 7 completa (V1-V7).

Si algo falla en staging, lo arreglamos acá; prod no se entera.

---

## 6. Producción · el día del deploy

Tomate una ventana tranquila (30-60 min) y avisale al cliente: entre el reset y el deploy la app vieja **no
funciona** contra la base nueva.

### 6.1 Backup (tuyo)
```bash
npm run db:prod:backup        # deja ~/kinesoft-backups/prod-<fecha>.dump
```
Verificá que el archivo existe y pesa algo razonable. Además: Supabase → Database → Backups.

### 6.2 Reset de prod (tuyo, destructivo) — solo si resolviste la sección 1
En el **SQL Editor de prod**, confirmando arriba a la izquierda que estás en el proyecto de producción:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres;
```
El último `GRANT USAGE` importa: la policy de realtime corre como `authenticated` y llama a una función de `public`;
sin `USAGE` no puede. Si el `DROP` tira un error de dependencias, **frená** y no sigas.

Esto **no** borra: los usuarios de Supabase Auth (el cliente conserva su login; `create-tenant` los reutiliza) ni los
archivos de Storage (quedan huérfanos con datos de pacientes: vaciá los buckets `patient-files` desde Storage).

Chequeo: la base está vacía.
```sql
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';   -- 0
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';   -- rolbypassrls = t
```

### 6.3 Migrar desde vacío (tuyo)
```bash
npm run db:prod:deploy        # aplica las 32 migraciones en orden, hasta M5
npm run db:prod:status        # → "Database schema is up to date!"
```
Mirá el log: **no** tiene que aparecer `NOTICE: reception_call_realtime: no existe realtime.messages` (si aparece, la
policy del canal no se creó) ni `WARNING tenant_verticals: … siguen accesibles`. Si una migración falla, con la base
vacía no se pierde nada: corregimos la causa, repetís el reset (6.2) y migrás de nuevo.

### 6.4 Roles de la app (tuyo)
La app no debe conectarse como `postgres` (ese rol se salta la seguridad por consultorio). Se crean dos roles y se
generan sus contraseñas **ahora**, antes de seguir. Usamos `-hex` y no base64 porque `/`, `+` y `=` rompen las URLs:

```bash
set -a; . ./.env.prod.local; set +a
APP_PW="$(openssl rand -hex 24)"; SVC_PW="$(openssl rand -hex 24)"
psql "$DIRECT_URL" -v app_password="$APP_PW" -v service_password="$SVC_PW" -f prisma/roles.supabase.sql
echo "kinesoft_app:     $APP_PW"
echo "kinesoft_service: $SVC_PW"       # copiá las dos a tu gestor de contraseñas AHORA
```

Con eso armás las dos URLs de Vercel (Connect → *Transaction pooler*, puerto **6543**). El usuario lleva el sufijo
`.<ref>`; copiá el host de la consola:

```
DATABASE_URL         = postgresql://kinesoft_app.<ref>:<APP_PW>@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
DATABASE_URL_SERVICE = postgresql://kinesoft_service.<ref>:<SVC_PW>@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```
Cargalas en Vercel (scope Production) **antes** del deploy.

### 6.5 Catálogo de obras sociales y prácticas (tuyo)
```bash
export KINESOFT_CONFIRM_PROD=<ref>
npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts            # dry-run: revisá el diff
npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts --apply
npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts            # de nuevo: tiene que dar 0 cambios
```

### 6.6 Crear los consultorios y tu cuenta de plataforma (tuyo)
Un consultorio para vos (la «casa de la plataforma») y uno para el cliente. Si el email ya existe en Supabase Auth
(el del cliente), se **reutiliza** su usuario y su contraseña no cambia.

```bash
export KINESOFT_CONFIRM_PROD=<ref>
npx dotenv -e .env.prod.local -- npx tsx scripts/create-tenant.ts \
  --email tu-email@dominio.com --password "mínimo 8 caracteres" \
  --clinic "KineSoft" --slug kinesoft --owner-name "Martin Navarro" --vertical kinesiologia

npx dotenv -e .env.prod.local -- npx tsx scripts/create-tenant.ts \
  --email email-del-cliente@… --password "mínimo 8 caracteres (se ignora si ya tiene cuenta)" \
  --clinic "Nombre del consultorio" --slug <slug-del-cliente> --owner-name "Nombre Apellido" --vertical kinesiologia

npx dotenv -e .env.prod.local -- npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
npx dotenv -e .env.prod.local -- npx tsx scripts/set-platform-admin.ts --list
```
Para un cardiólogo u otra especialidad sin módulos de kinesiología: `--vertical general`.

### 6.7 Revisión antes de publicar (tuyo)
- [ ] Vercel → Production tiene **todas** las variables de la sección 4 y `REALTIME_DRIVER=off`.
- [ ] Data API desactivada y buckets privados (sección 3, puntos 6 y 7).
- [ ] CI de GitHub en verde sobre `develop`.
- [ ] `git status` limpio y el commit de SV hecho.

### 6.8 Publicar (tuyo)
```bash
git checkout main && git pull
git merge develop
git push origin main          # Vercel buildea Production
```
En Vercel → Deployments → el build nuevo → Logs. Tiene que aparecer:
`[vercel-build] $ npx prisma migrate deploy` → **«No pending migrations to apply»** → `prisma generate` → `next build`.
Si falla por una variable faltante, el mensaje dice cuál: la cargás y hacés *Redeploy*.

### 6.9 Mercado Pago (tuyo)
En el panel de desarrolladores de MP → tu aplicación → Webhooks (modo producción): URL
`https://tu-dominio/api/webhooks/mercadopago`, evento de pagos. Copiá el **secret** que te da a `MP_WEBHOOK_SECRET` en
Vercel y hacé *Redeploy*. Sin ese secret, el webhook devuelve 503 a propósito.

### 6.10 Desde la app (tuyo)
1. Entrá con tu cuenta → **/plataforma → Consultorios** → el del cliente: plan (PRO u otro) y **prender los turnos
   online** (nacen apagados).
2. **/plataforma → Catálogo → Importaciones → «Refrescar catálogo»**. Sin esto los consultorios ven el catálogo viejo
   hasta una hora.
3. Entrá como el cliente (o pedile que entre) y creá un turno de prueba.

### 6.11 Verificación final
```sql
-- Supabase SQL Editor de prod
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%';   -- app: f · service: t
SELECT vertical, "publicBookingEnabled" FROM "Tenant";
-- tiene que dar 0 filas (nada accesible para anon/authenticated):
SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
  AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
```
Y desde el navegador: login, `/dashboard`, `/agenda`, un turno nuevo, `/sala`, el turnero `/c/<slug>/booking` y, si MP
está en producción, un pago real chico.

---

## 7. Realtime (Sala de Espera en vivo) · se prende al final

Hasta acá todo corre con `REALTIME_DRIVER=off`. **Primero en staging, después en prod.**

1. **Chequeos en el SQL Editor** (solo lectura). Después de migrar tienen que dar:
   ```sql
   select to_regclass('realtime.messages') is not null;     -- true
   select policyname, cmd, roles from pg_policies where schemaname = 'realtime';
   --  → UNA fila: kinesoft_agenda_read | SELECT | {authenticated}. Cualquier otra fila (INSERT o ALL) se borra antes de seguir.
   ```
   Si la primera da `false`, frená: tu proyecto no tiene la tabla de Realtime y hay que resolverlo antes.
2. **Settings → Realtime → Allow public access: OFF.**
3. **Settings → JWT Keys** (lo que antes llamábamos R4). Supabase firma los tokens de sesión con una clave del
   proyecto; nuestro servidor necesita **el secreto** para firmar el token corto del canal.
   - Si figura el **«Legacy JWT secret» activo**: ese es tu `SUPABASE_JWT_SECRET`; `SUPABASE_JWT_KID` queda **vacío**.
   - Si **solo hay claves asimétricas**: creá una clave nueva tipo **Shared secret (HS256)** en *standby*. Si la
     consola te deja elegir el secreto, generalo con `openssl rand -base64 48`. Ese secreto es `SUPABASE_JWT_SECRET` y
     el **Key ID** que muestra la lista es `SUPABASE_JWT_KID`.
4. **Staging:** en Vercel (scope Preview) cargá `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_KID` (si corresponde) y poné
   `REALTIME_DRIVER=supabase`. Pusheá `develop` (o *Redeploy*: la variable se lee al arrancar).
5. **Verificación V1-V7.** Sumá a `.env.staging.local` estas tres líneas (`SUPABASE_JWT_SECRET`, `SUPABASE_JWT_KID`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` si no estaba) y corré:
   ```bash
   npx dotenv -e .env.staging.local -- npx tsx --conditions=react-server scripts/realtime-verify.ts \
     --tenant <id-del-tenant-de-staging> --confirm=<ref-de-staging>
   ```
   (`SELECT id FROM "Tenant";` te da el id.) Tiene que mostrar **PASS** en las 7 filas. Si V1 da `CHANNEL_ERROR` con
   una clave en *standby*, promovela a *current* («Rotate keys») y repetí: Supabase pasa a firmar con HS256 y el
   login no cambia.
6. **A mano:** abrí `/sala` en dos navegadores de staging con usuarios distintos y marcá «Llegó» en uno: tiene que
   aparecer en el otro en un par de segundos.
7. **Prod:** repetí 1-3 en el proyecto de prod; en Vercel (Production) cargá las variables y poné
   `REALTIME_DRIVER=supabase`; **Deployments → ⋯ → Redeploy**. Probá lo mismo con dos navegadores.

**Volver atrás** es solo `REALTIME_DRIVER=off` + Redeploy. No hace falta tocar código ni la base.

Los avisos con sonido (llegada y llamado) los configura cada usuario en Configuración → General; arrancan en «Visual».

---

## 8. Si algo sale mal

| Síntoma | Qué hacer |
|---|---|
| El build de Production falla por variable | Mirá el log: dice cuál. Cargala y *Redeploy* |
| `migrate deploy` falla (P3009) | Con base vacía: corregí la causa, repetí 6.2 y 6.3 |
| La app anda pero un usuario ve datos de otro consultorio | Parar y avisarme: casi seguro `DATABASE_URL` quedó apuntando a `postgres` en vez de `kinesoft_app` |
| `/plataforma` no guarda | Falta `DATABASE_URL_SERVICE` (o la contraseña está mal) |
| No llegan mails de alta o reseteo | SMTP o plantillas (sección 3, puntos 3 y 4) |
| El webhook de MP devuelve 503 | Falta `MP_WEBHOOK_SECRET` |
| Realtime raro | `REALTIME_DRIVER=off` + Redeploy y seguimos mirando |
| Desastre de datos | Restaurar el dump del paso 6.1 (consultame antes: no lo hagas a ciegas) |
