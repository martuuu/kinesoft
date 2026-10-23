# KineSoft — Deployment y operación

Cómo encajan los entornos, cómo viajan las migraciones y los procedimientos que muerden si se hacen mal.
**El día del push de T3-T7 se sigue [PUSH-DIA.md](PUSH-DIA.md)** (el único checklist); este documento es la referencia.

## Los entornos (leer primero)

| Archivo | Apunta a | Lo usan |
| --- | --- | --- |
| `.env` | El objetivo es **solo DEV**, pero **puede apuntar a PRODUCCIÓN** (AGENTS §4): se trata como prod. Nunca se leen ni se imprimen sus valores | Prisma CLI y `@prisma/client` (lo cargan solos); `next dev` y `next build` (debajo de `.env.local`) |
| `.env.local` | **Docker local** (`localhost:5433`, rol app `kinesoft_app`) | `npm run dev:local`, los scripts `prisma:*`, los tests |
| `.env.prod.local` | **Supabase prod** (owner: `DIRECT_URL` + `DATABASE_URL`; para `qa-tenants` también las de Auth) — gitignored, lo crea Martin | solo `db:prod:*` y los scripts de PUSH-DIA F (`npx dotenv -e .env.prod.local -- …`) |

**La trampa:** Next carga `.env.local` por encima de `.env`, pero **el Prisma CLI y `@prisma/client` cargan `.env`**, y lo
que `.env.local` no define (p. ej. las claves de Supabase) Next lo toma de `.env`. Por eso:

- los scripts locales van con `dotenv -e .env.local`; lo de prod, **solo** por `db:prod:*` (`.env.prod.local`);
- cada seed/script llama a `assertSafeTarget` (`scripts/lib/assert-safe-target.ts`): imprime el destino real, rechaza una
  base remota en los seeds locales y exige `KINESOFT_CONFIRM_PROD=<project ref>` en los pocos scripts que van a prod;
- ⚠️ **nunca `next build` pelado en el repo:** inlinea en el bundle los `NEXT_PUBLIC_SUPABASE_*` que encuentre, y si
  `.env.local` no los trae salen los de `.env` (posible prod). El build local va aislado, con valores falsos explícitos:

  ```bash
  npx dotenv -e .env.local -v NODE_ENV=production -v NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54398 \
    -v NEXT_PUBLIC_SUPABASE_ANON_KEY=dev-mpfake-anon-key-no-real -v SUPABASE_SERVICE_ROLE_KEY=build-local-no-real \
    -v SUPABASE_JWT_SECRET=dev-mpfake-jwt-secret-solo-local-0123456789abcdef -- npx next build
  ```

- **`npm run dev` ahora es seguro** (`scripts/dev-safe.mjs`, INF-DEV): resuelve el Supabase y la base que vería
  `next dev` (mismo orden que `@next/env`) y **no arranca** si alguno es remoto o coincide con `PROD_SUPABASE_REF`
  (overrides separados: `ALLOW_DEV_REMOTE_SUPABASE=1`, `ALLOW_DEV_REMOTE_DB=1`). Nunca imprime valores.
  **El comando diario es `npm run dev:local`** (= `dev:mpfake` = `dev:wafake`: Docker + simuladores de MP y de Meta,
  `scripts/dev-mp-fake.mjs`).

```bash
npm run dev:local          # diario: Docker :5433 + simuladores (nunca lee el Supabase de .env)
npm run prisma:seed        # → Docker local (lo corre Martin; un agente nunca corre seeds)
npm run prisma:studio      # → Docker local
npm run prisma:reset       # migrate reset → Docker local (¡borra todo! solo Martin)
npm run db:prod:status     # prisma migrate status   (.env.prod.local) → PROD (lectura)
npm run db:prod:precheck   # prechecks/postchecks READ ONLY (--pre | --post) → PROD (lectura)
npm run db:prod:backup     # pg_dump -Fc → ~/kinesoft-backups/ → PROD (lectura; pg_dump ≥ versión del server)
npm run db:prod:deploy     # prisma migrate deploy   (.env.prod.local) → PROD (solo Martin)
```

`npm run prisma:migrate` (= `migrate dev`) **no se usa**: detecta drift, propone resetear y puede borrar los índices
parciales escritos a mano.

## Desarrollo local

```bash
npm ci
docker compose up -d db
npx dotenv -e .env.local -- npx prisma migrate deploy    # 46 migraciones al 23-oct
npx prisma generate
npm run dev:local                                        # http://localhost:3000
```

`KINESOFT_ALLOW_DEMO_ACTOR=1` en `.env.local` deja trabajar sin sesión de Supabase (cae al tenant demo `movare`).
**Nunca en prod** (`lib/session.ts` además lo corta con `NODE_ENV === "production"`).

## Migraciones

SQL escrito a mano en `prisma/migrations/<timestamp>_<nombre>/migration.sql`. Después de tocar el schema:

1. Editar `prisma/schema.prisma` (a mano, solo el bloque que cambia: nada de `prisma format`).
2. `npx prisma generate`.
3. Escribir el SQL (aditivo, con el porqué en la cabecera).
4. `npx dotenv -e .env.local -- npx prisma migrate deploy` → **local**; verificar objeto por objeto y correr la
   integración con los dos roles.
5. Commit (Martin; los agentes nunca commitean ni pushean).

### Migraciones en el deploy (solo Production, desde A0b)

`vercel.json` → `node scripts/vercel-build.mjs`:

```
VERCEL_ENV=production → prisma migrate deploy && prisma generate && next build
cualquier otro        →                          prisma generate && next build
```

**Solo los deploys de Production aplican migraciones** (idempotente: lo aplicado se saltea; una migración que falla
frena el deploy). Hasta A0b cada Preview migraba también y compartía la base de prod (AUDIT H6).

**Orden para una tanda con migraciones (sin staging, sin reset):**
1. `npm run db:prod:precheck -- --pre` (solo lectura) → Martin pega la salida;
2. `npm run db:prod:backup`;
3. `npm run db:prod:deploy` **antes** del push (todas aditivas y compatibles con el código viejo);
4. `npm run db:prod:precheck -- --post`;
5. push a `main` → el build de Production migra en vacío (no-op).

> ⚠️ **Vercel necesita `DIRECT_URL`** (no solo `DATABASE_URL`): `migrate deploy` usa la conexión directa.

### Estado de las migraciones

46 en el repo. Las 15 de base (aplicadas en prod desde el principio):

| # | Migración |
| --- | --- |
| 1 | `20260518134107_init` |
| 2 | `20260519013041_sprint5` |
| 3 | `20260519234538_sprint_9_plans_favorites_templates` |
| 4 | `20260520170944_sprint_13_insurers_invitations_manual_therapy` |
| 5 | `20260523234642_sprint_16_perf_indexes` |
| 6 | `20260524002341_sprint_16_patient_share` |
| 7 | `20260525000000_sprint_17_business_hours` |
| 8 | `20260525001000_sprint_17_custom_conditions` |
| 9 | `20260614120000_sprint_18_audit_fixes` |
| 10 | `20260615120000_sprint_18_copago_overrides` |
| 11 | `20260615140000_sprint_18_insurer_paid` |
| 12 | `20260616120000_booking_series_id` |
| 13 | `20260723213701_payment_expected_amount_and_delete_restrict` |
| 14 | `20260725120000_rls_policies` |
| 15 | `20260730120000_service_max_concurrent` |

Las 31 siguientes, con qué hace cada una y su estado en prod: [MIGRACIONES-RUNBOOK §2 «Tabla de migraciones»](MIGRACIONES-RUNBOOK.md).
Prod tiene **40** (hasta M11); **pendientes: M12 → M14 → M18 → M17 → M15 → M16** ([PUSH-DIA.md](PUSH-DIA.md) A y D).

## Variables de entorno

Inventario completo: el schema de `lib/env.ts` + todo lo que el código lee por `process.env` (grep del 23-oct sobre
`app/`, `lib/`, `components/`, `middleware.ts`, `next.config.mjs`, `instrumentation.ts`, `sentry.*.config.ts` y
`scripts/`). `.env.example` tiene la misma lista con comentarios. El boot de Production (`productionSchema`) falla con el
nombre de la variable, nunca el valor. «Martin» = la carga él en Vercel (o en su `.env*.local`).

**Scope:** P = Production · Pv = Preview · L = local. «Secreta» = server-only, nunca `NEXT_PUBLIC_`, va al gestor de
contraseñas.

### Base, Supabase y dominio

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | P Pv L | — (**obligatoria en P**) | Martin | sí | Runtime de la app (pooler 6543, `pgbouncer=true&connection_limit=3`). Objetivo: rol `kinesoft_app` **sin** BYPASSRLS (OPS-3, pendiente: hoy prod conecta con BYPASSRLS y el `where: { tenantId }` es la barrera) |
| `DIRECT_URL` | P Pv L | — (**obligatoria en P**) | Martin | sí | Owner, 5432 sin pooler: `migrate deploy` y fallback del canal service |
| `DATABASE_URL_SERVICE` | P | cae a `DIRECT_URL` | Martin | sí | `kinesoft_service` (BYPASSRLS) para superficies sin Actor. Recomendada en P (aviso al boot) |
| `NEXT_PUBLIC_SUPABASE_URL` | P Pv L | — (**obligatoria en P**) | Martin | no | Se inlinea en el build (ver «nunca `next build` pelado») |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | P Pv L | — (**obligatoria en P**) | Martin | no (pública) | Recortada: un `\n` rompía el socket (HF-1a) |
| `SUPABASE_SERVICE_ROLE_KEY` | P Pv | — (**obligatoria en P**) | Martin | **sí** | Auth admin, Storage, Broadcast |
| `NEXT_PUBLIC_APP_URL` | P Pv L | `http://localhost:3000` | Martin | no | En P **no** puede ser localhost (el boot lo rechaza): links de mails, `notification_url` de MP, redirect de OAuth |
| `PROD_SUPABASE_REF` | **P Pv L** (mismo valor) | sin setear | Martin | no | Ref de prod. Activa el [guard de Preview](#guard-de-preview-ops-1c), `dev-safe` y `qa-tenants --target local` |
| `NODE_ENV` | — | lo pone Next/Vercel | — | no | No se carga a mano |
| `VERCEL_ENV` / `VERCEL` | P Pv | los pone Vercel | — | no | «Automatically expose System Environment Variables» **prendido**: CSP/HSTS y el rechazo de `fake` dependen de esto |
| `LOG_LEVEL` | P Pv L | `info` | Martin | no | `debug`/`info`/`warn`/`error` |

### Sala en vivo (realtime)

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `REALTIME_DRIVER` | P Pv L | `off` | Martin | no | **P: `supabase` (ya está).** `local` solo dev (en P frena el boot); `supabase` exige las 4 de Supabase + `SUPABASE_JWT_SECRET`. Se lee al cargar: cambiarla pide redeploy |
| `SUPABASE_JWT_SECRET` | P | — | Martin | **sí** | Firma el token corto del canal (y el del dispositivo de TV). Recortado (HF-1a) |
| `SUPABASE_JWT_KID` | P | sin setear | Martin | no | Solo con las JWT Signing Keys nuevas (R4) |

### Mails, soporte y bandeja

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `RESEND_API_KEY` | P | sin setear (= mails a log, aviso al boot) | Martin | **sí** | [EXTERNAL-CONFIG §0.4](EXTERNAL-CONFIG.md) |
| `EMAIL_FROM` | P | sin setear (= log) | Martin | no | `KineSoft <no-reply@mail.<dominio>>` |
| `EMAIL_REPLY_TO` | P | sin setear | Martin | no | Reply-To por defecto |
| `EMAIL_TRANSPORT` | **L** | — | dev | no | `mailpit`/`resend`/`log`; Production lo ignora. **No cargar en P** |
| `MAILPIT_URL` | **L** | `http://localhost:8025` | dev | no | Solo local |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | P | sin setear | Martin | no | Canal de soporte público (banda de acceso, /suspendido) |
| `PLATFORM_INBOX_EMAIL` | P | sin setear (los mensajes quedan en /plataforma) | Martin | no | Aviso por mail de mensajes y leads |

### Observabilidad y rate limit

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `SENTRY_DSN` | P | sin setear (no-op, aviso al boot) | Martin | no | Errores + reportes de CSP. PUSH-DIA G3 |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | P (build) | sin setear (sin sourcemaps) | Martin | token **sí** | Solo `next.config.mjs`, para subir sourcemaps |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | P | sin setear (memoria por lambda, aviso al boot) | Martin | token **sí** | sa-east-1. PUSH-DIA G2 |

### Interruptores de producto

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `TENANT_ACCESS_ENFORCEMENT` | P | `banner` | Martin | no | `off`/`banner`/`enforce`. `enforce` cuando Martin decida |
| `PLATFORM_MFA_ENFORCEMENT` | P | `off` | Martin | no | Enrolar el TOTP con `off` → `enforce` + redeploy |
| `SIGNUP_MODE` | P | `open` | Martin | no | `assisted` = alta solo desde /plataforma |
| `MAINTENANCE_MODE` / `MAINTENANCE_MESSAGE` | P | `off` / sin setear | Martin | no | `on` = 503 a todo salvo webhooks, health y crons. El mensaje es público (280) |
| `DIRECTORY_MODE` | P | `off` | Martin | no | `off`/`preview`/`public` (directorio público) |
| `NEXT_PUBLIC_PWA` | P | sin setear (= prendido) | Martin | no | `off` desregistra los service workers (emergencia, MB-D6) |
| `PATIENT_FILES_SIGNED_UPLOAD` | P | sin setear (= prendido) | Martin | no | `0`/`false`/`off` apaga la subida firmada de archivos (FC-2f) |
| `SUPERADMIN_2FA_BYPASS` | P | **sin setear** | Martin | no | `<userId>@AAAA-MM-DD[,…]`, falla cerrado (HF-3). Solo temporal; se borra al terminar |

### Crons

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `CRON_SECRET` | P | — (sin él: **503** y los crons no corren) | Martin | **sí** | `openssl rand -hex 32`. Vercel lo manda como `Authorization: Bearer` |

`vercel.json` tiene **2 crons** (solo corren en Production; en Hobby disparan dentro de la hora indicada):

| Ruta | Schedule (UTC) | Hora AR | Qué hace |
| --- | --- | --- | --- |
| `/api/cron/daily` | `0 11 * * *` | 08:00 | Cobros de la suscripción, invitaciones vencidas, recordatorios de prueba, resumen de salud (60 s) |
| `/api/cron/whatsapp` | `0 21 * * *` | 18:00 | Recordatorios de WhatsApp del día siguiente, re-drenado de la cola, sync de plantillas y calidad (60 s). Con `WHATSAPP_MODE=off` no hace nada |

Sin `Bearer` correcto → **401**; sin `CRON_SECRET` en Production → **503** (`lib/cron-auth.ts`).

### Mercado Pago: checkout legado (cuenta de la plataforma)

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `MP_ACCESS_TOKEN` | P | sin setear | Martin | **sí** | Token de la **plataforma**. Desde T6 lo usa la suscripción con `SAAS_BILLING_MODE=mp` (obligatorio ahí) |
| `MP_PUBLIC_KEY` | P | sin setear | Martin | no | — |
| `MP_WEBHOOK_SECRET` | P | — | Martin | **sí** | Obligatoria si hay `MP_ACCESS_TOKEN`; sin ella el webhook da 503. Firma también la rama SaaS (`?scope=saas` y preapproval) |
| `TURNERO_CHECKOUT` | — | **sin setear** | — | no | Deprecada (T5): ya no la lee nadie; `platform` solo loguea un aviso |

### Mercado Pago Connect (cobros online con la cuenta del vendedor, T5)

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `MP_CONNECT_MODE` | P Pv L | `off` | Martin | no | `off`/`fake`/`sandbox`/`live`. `fake` en Vercel frena el boot. `sandbox`/`live` en P exigen las de abajo |
| `MP_OAUTH_CLIENT_ID` / `MP_OAUTH_CLIENT_SECRET` | P | sin setear | Martin | secret **sí** | De la app de MP con OAuth + PKCE ([EXTERNAL-CONFIG §0.12](EXTERNAL-CONFIG.md)) |
| `MP_CONNECT_WEBHOOK_SECRET` | P | sin setear | Martin | **sí** | Obligatoria con firma `required` |
| `MP_CONNECT_WEBHOOK_SIGNATURE` | P | `required` | Martin | no | `fetch-only` solo si el sandbox (S3) lo pide |
| `SECRET_BOX_KEYS` | P Pv (distintas) | sin setear (en L hay clave dev; en Vercel no sella) | Martin | **sí** | `k2:<b64 32 B>,k1:<b64 32 B>`, la primera sella. Sella tokens de MP y de WhatsApp. Se rota con `scripts/secret-box-rotate.ts --store=mp\|wa\|all`. **Cargarla antes del push** |

### Suscripción SaaS (T6, MPS)

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `SAAS_BILLING_MODE` | P | `off` | Martin | no | `off` → `manual` → `mp` ([EXTERNAL-CONFIG §0.14](EXTERNAL-CONFIG.md)). `mp` exige `MP_ACCESS_TOKEN` |
| `SAAS_BILLING_TRANSFER_INFO` | P | sin setear (no se ofrece «Informar pago») | Martin | no | Alias, CBU, titular y CUIT (≤ 500). Antes de `manual` |
| `MP_MIN_DEBIT_CENTS` | P | sin setear (= 1500, $ 15) | Martin | no | Entero en centavos; un valor roto frena el deploy |
| `SAAS_MP_CHECKOUT_NOTIFY` | P | `scope` | Martin | no | `panel` = sin `notification_url` por preferencia (solo si el sandbox lo pide) |

### WhatsApp (T6)

| Variable | Scope | Default seguro | Quién | Secreta | Nota |
| --- | --- | --- | --- | --- | --- |
| `WHATSAPP_MODE` | P Pv L | `off` | Martin | no | `off`/`fake`/`sandbox`/`live`. `fake` en Vercel frena el boot; `live` en Preview se lee `off`. `sandbox`/`live` en P exigen las 4 de abajo + `SECRET_BOX_KEYS` |
| `WHATSAPP_APP_ID` | P | sin setear | Martin | no | App de Meta (separada de la de Facebook Login) |
| `WHATSAPP_APP_SECRET` | P | sin setear | Martin | **sí** | Firma el webhook (`X-Hub-Signature-256`) |
| `WHATSAPP_CONFIG_ID` | P | sin setear | Martin | no | Configuración de Embedded Signup v4 |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | P | sin setear | Martin | **sí** | ≥ 32 caracteres (`openssl rand -hex 32`) |
| `WHATSAPP_GRAPH_VERSION` | P | `v23.0` | Martin | no | `vNN.0`; se sube a mano, sandbox antes |
| `WHATSAPP_SIGNUP_FEATURE` | P | sin setear | Martin | no | `whatsapp_business_app_onboarding` (coexistencia), después del sandbox |

### Solo local o solo scripts (nunca en Vercel)

| Variable | Dónde | Nota |
| --- | --- | --- |
| `KINESOFT_ALLOW_DEMO_ACTOR` | `.env.local` | Bypass de login local. 🚫 **Nunca en prod** |
| `ALLOW_DEV_REMOTE_SUPABASE` / `ALLOW_DEV_REMOTE_DB` | línea de comando | Overrides de `npm run dev` (`scripts/dev-safe.mjs`) |
| `PERF_TIMING` / `PERF_TIMING_IDLE_MS` | línea de comando | Server-Timing de diagnóstico (`lib/server-timing.ts`) |
| `POOLER_HOST` / `POOLER_PORT` | `.env.local` | Solo `tests/helpers/pooler.ts` (`npm run test:pooler`) |
| `KINESOFT_CONFIRM_PROD` | línea de comando | `<ref>` que exigen los scripts que van a prod (`assertSafeTarget`) |
| `QA_EMAIL_BASE` / `QA_PASSWORD` | `.env.prod.local` | `scripts/qa-tenants.ts` (PUSH-DIA F2) |
| `CI` | CI | Lo lee `next.config.mjs` |

## Setup de prod que va una sola vez (Martin)

### 1. Roles de la base (OPS-3, opcional; destraba RLS real)

`prisma/roles.supabase.sql` con **psql** y la conexión owner, **después** de `migrate deploy`. Las contraseñas van como
variables de psql (nunca en el archivo) y re-correrlo las **rota**. **`-hex` y no `-base64`:** `/`, `+` y `=` rompen las
URLs de conexión.

```bash
set -a; . ./.env.prod.local; set +a
APP_PW="$(openssl rand -hex 24)"; SVC_PW="$(openssl rand -hex 24)"
psql "$DIRECT_URL" -v app_password="$APP_PW" -v service_password="$SVC_PW" -f prisma/roles.supabase.sql
```

- `kinesoft_app` (`NOSUPERUSER NOBYPASSRLS`) → **`DATABASE_URL`**. Este cambio es el que hace que RLS deje de ser inerte
  en prod.
- `kinesoft_service` (`BYPASSRLS`) → **`DATABASE_URL_SERVICE`** (cargarla **antes** del cambio).

Verificar: `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%';`. Los `ALTER DEFAULT PRIVILEGES`
cubren tablas futuras **solo si las crea `postgres`**; ante la duda, re-correr los dos bloques de GRANT.

### 2. Buckets de Storage (privados)

`exercise-media`, `patient-files`, `practice-assets`, `patient-documents` y `billing-receipts`, todos **privados**
(URLs firmadas). Límites y tipos en [EXTERNAL-CONFIG §0.6 y §0.11](EXTERNAL-CONFIG.md); el `--pre` del precheck revisa
los cuatro que usa el código nuevo.

### 3. Superadmin de plataforma

`UserProfile.isPlatformAdmin` se marca en la base con `scripts/set-platform-admin.ts` y la conexión owner (sin fallback a
localhost; prod exige `KINESOFT_CONFIRM_PROD=<ref>`):

```bash
DATABASE_URL="<owner>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts vos@ejemplo.com
DATABASE_URL="<owner>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts alguien@x.com --revoke
DATABASE_URL="<owner>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts --list
```

## Reset de la base

- **Local:** `npm run prisma:reset` (solo Martin).
- **Prod:** no hay reset (decisión del 14-oct: prod conserva sus datos). Si algún día se decide, es un procedimiento
  aparte con backup, aviso y re-carga; nunca `prisma/seed.ts` (es demo y aborta contra una base remota).

## Flujo de deploy

```
local (Docker, .env.local) → gate → commit (Martin) → prod precheck --pre → backup → db:prod:deploy
  → precheck --post → push develop → main (Martin) → Vercel Production:
     prisma migrate deploy (no-op) → prisma generate → next build → vivo → smoke
```

Sin staging (OPS-0 queda opcional). Las migraciones siempre aditivas (expand/contract). Historia de los deploys de
B-pre (01-oct) y BO (14-oct): [MIGRACIONES-RUNBOOK «Deploy de BO» y Apéndice](MIGRACIONES-RUNBOOK.md).

### Guard de Preview (OPS-1c)

`lib/env.ts` hace **fallar el build de Preview** (`VERCEL_ENV=preview`) si `DATABASE_URL`, `DIRECT_URL`,
`DATABASE_URL_SERVICE` o `NEXT_PUBLIC_SUPABASE_URL` contienen `PROD_SUPABASE_REF`. En las URLs de base mira el host
**y el usuario**: en el pooler de Supabase el host es compartido y el ref va en `postgres.<ref>`. El error nombra la
variable, nunca la URL. Production, Development y local no se miran (Production apunta a prod a propósito).

- Sin `PROD_SUPABASE_REF` en Preview: solo `console.warn` en el log del build (el guard queda apagado).
- Un ref con forma inválida (no 15-40 `[a-z0-9]`) frena el Preview: un valor roto apagaría el guard en silencio.
- Si un Preview sale rojo por esto: el scope Preview de esa variable apunta a prod → cambiala (staging u otro proyecto)
  y redeployá. No se saltea borrando `PROD_SUPABASE_REF`.

### Pooler en modo transacción (OPS-1b)

Prod va por el pooler de transacción (6543, `pgbouncer=true&connection_limit=3`); `migrate deploy` necesita sesión
(`DIRECT_URL` al 5432). Para reproducirlo en local: `docker compose --profile pooler up -d pgbouncer` (127.0.0.1:6433)
y `npm run test:pooler` (los dos roles: GUC de `runWithRls`, advisory locks, `SET LOCAL`, `transaction_read_only`).
`npm run diagnose:db` (solo lectura; otro entorno: `npx dotenv -e <archivo> -- npx tsx scripts/diagnose-db.ts`) muestra
por cada URL el rol, si saltea RLS, el modo de pool y avisos (6543 sin `pgbouncer=true`, `DIRECT_URL` en 6543, sin
`connection_limit`). Nunca imprime la contraseña.
