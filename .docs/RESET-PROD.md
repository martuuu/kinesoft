# Reset de producción + push de PV (29-oct-2026)

> ✅ **Ejecutado el 29/30-oct.** Desde ahí prod tiene **un cliente vivo**: esta guía **no se repite**. Las migraciones
> siguientes son incrementales con precheck → backup → deploy → postcheck → push; la primera es **M20** (tanda CF,
> [RUNBOOK «M20 en prod»](MIGRACIONES-RUNBOOK.md)).

**Manda sobre [PUSH-DIA.md](PUSH-DIA.md)** para esta salida: prod se resetea, así que no hay migraciones incrementales,
precheck `--pre` ni backup (decisión de Martin, 27/29-oct: «solo hay data demo»). Todo lo de esta guía lo corre Martin;
el agente no ejecuta nada contra prod.

Convenciones:
- `<ref>` = el project ref de Supabase de prod (el de `PROD_SUPABASE_REF`).
- `<dominio>` = `https://www.consultorio-online.com` (o el que uses como `NEXT_PUBLIC_APP_URL`).
- Los comandos de terminal van desde la raíz del repo, en `develop` y con el árbol limpio.
- `.env.prod.local` (gitignored, ya lo tenés de antes) con `DIRECT_URL` y `DATABASE_URL` de prod. `DIRECT_URL` tiene
  que ser el pooler de **sesión** (puerto 5432) con el usuario dueño (`postgres.<ref>`): `migrate deploy` lo necesita.
- 📋 = pegá la salida si algo no coincide con lo esperado.

---

## A · Antes de tocar nada (≈ 20 min, sin downtime)

### A0 · ¿Hay biblioteca global de ejercicios para conservar?
El reset borra **todo** `public`, incluida la biblioteca global (ejercicios, media, artículos, condiciones de
Diagnóstico, tags) que hayas cargado desde /plataforma. No hay carga versionada para reponerla. En el SQL Editor de prod:

```sql
SELECT (SELECT count(*) FROM "Exercise" WHERE "tenantId" IS NULL) AS ejercicios_globales,
       (SELECT count(*) FROM "Condition" WHERE "tenantId" IS NULL) AS condiciones_globales;
```

- Si da ~0, o no te importa volver a cargarlos → seguí.
- Si querés conservarlos → **frená acá** y pedile al agente un script de export/import de la biblioteca global (no
  lo improvises con `pg_dump`: las filas privadas de consultorios tienen FKs a tenants que van a dejar de existir).

### A1 · Resend con el dominio verificado
Sin esto el cliente no recibe el mail de activación (igual vas a tener el link para copiar, ver F3).
- Resend → Domains → `mail.consultorio-online.com` (o el que uses) en **Verified** (DKIM, SPF y DMARC `p=none`).
- API key con permiso de envío para ese dominio.

### A2 · Supabase → Authentication → URL Configuration (prod)
- **Site URL** = `<dominio>`.
- **Redirect URLs**: `<dominio>/auth/callback**`, `<dominio>/auth/confirm**`, `<dominio>/invite/**`,
  `<dominio>/portal/**`, `<dominio>/reset`, `<dominio>/onboarding`.
- Authentication → Providers → MFA: **TOTP habilitado** (default).

### A3 · Variables de Vercel (Settings → Environment Variables → **Production**)
Cargá o confirmá. El boot de Production valida: un faltante frena el build y el log nombra la variable.

**Obligatorias (sin ellas el build falla):**

| Variable | Valor |
|---|---|
| `DATABASE_URL` | la de prod (la que ya está; pooler) |
| `DIRECT_URL` | la de prod (pooler de sesión, 5432) |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key de prod |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key de prod |
| `NEXT_PUBLIC_APP_URL` | `<dominio>` (nunca localhost) |
| `RESEND_API_KEY` | la de A1 |
| `EMAIL_FROM` | `Consultorio Online <no-reply@mail.consultorio-online.com>` (dominio verificado en A1) |

**De esta salida (recomendadas):**

| Variable | Valor | Para qué |
|---|---|---|
| `SIGNUP_MODE` | `assisted` | Las altas las hacés vos desde /plataforma (no hay alta abierta) |
| `PLATFORM_INBOX_EMAIL` | tu email | Te llega un aviso por cada ticket nuevo |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | tu email de soporte | «¿Preferís el mail?» en /contacto |
| `EMAIL_REPLY_TO` | tu email de soporte | Reply-To de los mails |
| `CRON_SECRET` | `openssl rand -hex 32` (si no está) | Los dos crons; sin él responden 503 |
| `SECRET_BOX_KEYS` | `k1:<base64 32 bytes>` (si no está) | `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`; guardala en el gestor de contraseñas |
| `PROD_SUPABASE_REF` | `<ref>` en **Production, Preview y Development** | Guard que impide que un Preview apunte a prod |
| `REALTIME_DRIVER` | `supabase` (si ya funcionaba) | Agenda y Sala en vivo. Requiere `SUPABASE_JWT_SECRET` |
| `SUPABASE_JWT_SECRET` | el JWT secret de prod | Solo con `REALTIME_DRIVER=supabase` |

**Apagadas para salir (o sin setear):** `SAAS_BILLING_MODE=off` (el plan se elige igual; no se generan cargos),
`MP_CONNECT_MODE=off`, `WHATSAPP_MODE=off`, `DIRECTORY_MODE=off`, `TENANT_ACCESS_ENFORCEMENT` sin setear (o `banner`).

**Borrar si aparecen:** `KINESOFT_ALLOW_DEMO_ACTOR`, `TURNERO_CHECKOUT`, `EMAIL_TRANSPORT`, `MAILPIT_URL`,
`ALLOW_DEV_REMOTE_SUPABASE`, `ALLOW_DEV_REMOTE_DB`, `PERF_TIMING`, cualquier `…fake…`/`127.0.0.1`, y
`SUPERADMIN_2FA_BYPASS` (vas a enrolar la 2FA de nuevo en F2).

Opcional antes del push: completar `LEGAL_ENTITY` en `lib/legal.ts:27` (razón social, CUIT, domicilio) en un commit. Si
no, `/terminos` y `/privacidad` salen sin esa línea.

---

## B · Reset (desde acá la app vieja queda caída hasta el push; ≈ 15-20 min en total)

### B1 · Base: SQL Editor de prod (una sola corrida)

```sql
-- La policy de Realtime (M5) depende de una función de public: se suelta antes para no depender del CASCADE.
DROP POLICY IF EXISTS kinesoft_agenda_read ON realtime.messages;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public TO postgres, service_role;
```

No se le vuelve a dar `USAGE` a `anon`/`authenticated`: la app no usa la Data API (M2 además revoca las tablas).
Verificación:

```sql
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';        -- 0
SELECT count(*) FROM pg_policies WHERE schemaname = 'realtime';   -- 0
```

### B2 · Usuarios: Authentication → Users
1. **Borrá todos los usuarios** (también el tuyo y el del cliente demo): así no quedan factores 2FA viejos ni cuentas
   demo que choquen con el alta del cliente.
2. **Add user → Create new user**: tu email, una contraseña nueva, **Auto Confirm User** tildado.
3. Anotá el **User UID** que aparece (lo usás en D3).

### B3 · Storage (opcional, recomendado): vaciá los objetos demo
Storage → buckets `patient-files`, `patient-documents`, `billing-receipts` → seleccionar todo → Delete. Los buckets
quedan (privados). Si en A0 decidiste no conservar la biblioteca, vaciá también `exercise-media`.

### B4 · Permisos de los roles de la app (ANTES de C)
`DROP SCHEMA public` se lleva los permisos que `prisma/roles.supabase.sql` les había dado a `kinesoft_app` y
`kinesoft_service` (USAGE del schema y los DEFAULT PRIVILEGES). Si `DATABASE_URL` o `DATABASE_URL_SERVICE` usan esos
roles, la app quedaría sin poder leer ninguna tabla. Re-darlos ANTES de migrar hace que cada tabla nueva nazca con
permiso. Es seguro correrlo aunque las URLs usen `postgres` (si el rol no existe, no hace nada). SQL Editor:

```sql
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['kinesoft_app', 'kinesoft_service'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);
      RAISE NOTICE 'permisos re-dados a %', r;
    END IF;
  END LOOP;
END $$;
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%';
```

Después de C, verificá (tiene que dar `t` en cada rol que exista):

```sql
SELECT r.rolname, has_table_privilege(r.rolname, '"Tenant"', 'SELECT,INSERT,UPDATE,DELETE') AS tablas,
       has_sequence_privilege(r.rolname, (SELECT oid FROM pg_class WHERE relkind = 'S' AND relnamespace = 'public'::regnamespace LIMIT 1), 'USAGE') AS secuencias
  FROM pg_roles r WHERE r.rolname LIKE 'kinesoft%';
```

(Si no hay secuencias en `public`, la segunda columna sale NULL: está bien.)

---

## C · Migraciones desde cero (terminal)

```bash
npm run db:prod:status      # → 47 migraciones sin aplicar (no hay tabla _prisma_migrations)
npm run db:prod:deploy      # aplica las 47 en orden; tarda 1-3 min
npm run db:prod:status      # → "Database schema is up to date!"
```

Si falla (P3009 u otro error): **no reintentes**. 📋 Pegá la salida. Con la base vacía no se pierde nada: se corrige,
se repite B1 y se vuelve a C.

Postcheck (una tx READ ONLY):

```bash
KINESOFT_CONFIRM_PROD=<ref> npm run db:prod:precheck -- --post
```

Esperado: `0 FAIL` (sin `--booking-relfilenode` ese chequeo se saltea). Y en el SQL Editor:

```sql
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'realtime';
-- → 1 fila: kinesoft_agenda_read | SELECT | {authenticated}
SELECT c.relname FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
   AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
-- → 0 filas
```

---

## D · Datos base

### D1 · Catálogo global (especialidades, prácticas, obras sociales y prepagas)

```bash
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts            # dry-run: 📋 resumen
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts --apply    # escribe
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts            # → 0 cambios
```

### D2 · CIE-11 (diagnósticos de las fichas; necesita el archivo de la OMS en `data/icd11/`)

```bash
F=data/icd11/SimpleTabulation-ICD-11-MMS-es.txt     # el nombre real de tu archivo
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/diagnosis-import.ts --file=$F --release=2025-01
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/diagnosis-import.ts --file=$F --release=2025-01 --apply --by=martin
```

Sin el archivo, las fichas igual funcionan con diagnósticos propios y texto libre; lo podés importar después.

### D3 · Tu superadmin
La cuenta de B2 todavía no tiene perfil en la app (se crea al loguearse por mail/Google o al crear un consultorio).
Creá el perfil en el SQL Editor y después dale superadmin con el script (que deja el registro en la auditoría de
Plataforma):

```sql
INSERT INTO "UserProfile" (id, email, "fullName")
SELECT id::text, lower(email), 'Martin Navarro' FROM auth.users WHERE email = 'martin.navarro.dev@gmail.com';
-- → INSERT 0 1
```

```bash
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/set-platform-admin.ts martin.navarro.dev@gmail.com
KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/set-platform-admin.ts --list   # → tu email
```

---

## E · Push a `main` (lo hacés vos)

```bash
git checkout main
git pull --ff-only origin main
git merge --ff-only develop          # es fast-forward: main es ancestro de develop (227 commits)
git push origin main
git checkout develop
```

El build de Production corre `prisma migrate deploy` antes de `next build`: con C hecho es un no-op («No pending
migrations to apply»). Si el build falla por una variable, el log la nombra: corregila en Vercel → Redeploy.

---

## F · Verificación y primer consultorio

### F1 · Smoke
- `<dominio>` → landing con «Consultorio Online»; `/terminos` y `/privacidad` cargan.
- `curl -s -o /dev/null -w '%{http_code}\n' <dominio>/api/cron/daily` → `401` (`503` = falta `CRON_SECRET`).

### F2 · Tu cuenta
1. `<dominio>/login` con el email y la contraseña de B2 (podés dejar tildado «Mantenerme conectado»).
2. Sin consultorio propio vas a ver el alta de consultorio: **no la completes**. Andá directo a `<dominio>/cuenta/seguridad`
   y activá la **verificación en dos pasos** (App autenticadora; los factores viejos se fueron con B2). Las acciones de
   Plataforma de más riesgo la piden.
3. `<dominio>/plataforma` → `/plataforma/sistema`: Resend presente, `CRON_SECRET` presente, cobros online `off`.

### F3 · Consultorio del cliente
1. `/plataforma/consultorios` → **Nuevo consultorio**: nombre, tipo (Kinesiología / Clínica general), plan, y el
   **email y nombre del titular**. Crear.
2. Al cliente le llega «Activá tu acceso…» por mail. Si el mail no sale, en el resultado del alta (y en Plataforma →
   Usuarios → el titular → «Mandar link de acceso») tenés el link para copiar y mandárselo por WhatsApp.
3. El cliente: abre el link → elige su contraseña (`/reset`) → **acepta Términos y Privacidad** (`/aceptar-terminos`) →
   entra a su panel como **Titular**. Desde Configuración elige o cambia el plan (Plan y uso), invita a su equipo
   (Usuarios) y, si quiere turnos online, los prende en Configuración → General.
4. Verificá en `/plataforma/consultorios/<id>` que figure el titular y el plan.

---

## G · Después (sin apuro, cada uno con su redeploy)
Upstash (`UPSTASH_REDIS_REST_URL/_TOKEN`), Sentry (`SENTRY_DSN`), Google OAuth en Supabase, precios en
`/plataforma/precios` + `SAAS_BILLING_MODE=manual` cuando quieras cobrar, MP Connect y WhatsApp con sus sandboxes
(PUSH-DIA §G y [EXTERNAL-CONFIG.md](EXTERNAL-CONFIG.md)). QA manual: [QA.md «PV»](QA.md).

**Rollback:** si el deploy sale mal, Vercel → Deployments → el anterior → «Promote to Production» (la base ya es la
nueva: el código viejo no la entiende del todo, así que lo correcto es corregir y redeployar `main`).
