# KineSoft — Configuración externa (servicios del dueño)

> **Qué es este documento.** Los servicios de terceros que dependen **exclusivamente del dueño del
> proyecto** — no se resuelven con código. Separado de la auditoría técnica para que ninguno de los
> dos se pierda entre el otro (spec 3.5 del [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md)). Cada
> integración del lado del código está construida con **fallback no-op** y se "prende" con un flag
> cuando el dueño completa su parte (patrón listo-para-activar) — sin rework técnico en ese momento.
>
> **Cómo usarlo:** el campo **Gate de activación** es la env var / flag que enciende la integración.
> El campo **Bloquea** dice qué ítem del checklist de corte a producción depende de esto.

Estado: 🔴 pendiente · 🟡 en progreso · 🟢 hecho.

---

### 0. Bloque A0 — chequeos y tareas del dueño (2026-09-29) 🔴

Antes de cualquier migración nueva. Anotá acá los resultados (sin valores secretos).

**A0a · chequeos (solo lectura, salvo el backup):**
1. **Backup:** crear `.env.prod.local` (ver MIGRACIONES-RUNBOOK §0) y `npm run db:prod:backup`. En Supabase →
   Database → Backups: plan, backups diarios, PITR.
2. **Migraciones:** `npm run db:prod:status` + la query de `_prisma_migrations` (RUNBOOK §2) + el último build de
   Production en Vercel.
3. **Vercel → Environment Variables:** qué scopes tienen `DATABASE_URL`, `DIRECT_URL`, `DATABASE_URL_SERVICE`,
   `SUPABASE_SERVICE_ROLE_KEY`, `MP_*`, `NEXT_PUBLIC_APP_URL`. **¿El scope Preview apunta a la DB de prod?**
   Settings → Git (¿se buildean previews de `develop`/`feat/*`?) y Deployment Protection de los previews.
4. **Roles:** `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%';` — si existen, rotarlos
   ya con `prisma/roles.supabase.sql` (se habrían creado con el password placeholder del repo).
5. **Tenant vivo:** `SELECT slug, name, plan FROM "Tenant" ORDER BY "createdAt";` — ¿existe `movare`,
   `demo-kinesoft` o `test-%`?
6. **Servicios:** `SELECT name, "durationMin", "maxConcurrent" FROM "Service" WHERE "tenantId" = '<vivo>';` — si
   Osteopatía está en `NULL` (ilimitado), pasarla a 1 desde Configuración.
7. **Turnero público:** ¿está en uso? ¿hay reservas PENDING viejas?
8. **Supabase Auth:** JWT expiry y reuse interval, ¿Custom SMTP?, Site URL + Redirect URLs, plantillas; policies de
   `storage.objects` para `patient-files`/`exercise-media` (¿existen los buckets? ¿privados?).
9. **Screenshot borrado** (en el historial desde `eb0ee8b`): si tiene PHI del cliente, decidir purgar el historial.
10. ¿Alguna vez se corrieron `prisma/seed.ts`, `seed-sprint13` o `seed-santiago` contra prod?

**A0d · Staging aislado:**
1. Proyecto Supabase **staging** (o Branching): DB + Auth + Storage propios, buckets privados.
2. Vercel → env del scope **Preview** → staging (DB, Supabase URL/keys) y MP en **sandbox**.
3. Deployment Protection (Vercel Authentication) en los Previews.
4. `.env.local` (dev) → Auth/Storage de **staging** (hoy dev crea usuarios y gasta la cuota de SMTP de prod).
5. En staging: `migrate deploy` + `roles.supabase.sql` con passwords propios. Catálogo sí; **nunca** el seed demo.
6. Verificar: el log de un Preview dice `[vercel-build] skip migrate (VERCEL_ENV=preview)` y la app conecta a
   staging.

### 0.1 Bloque A3 — tareas del dueño **antes de desplegar A3** (30-sep-2026) 🔴

El código de A3 está completo (A3a, A3b y A3c; Bloque A cerrado el 30-sep). **Desde IAM (14-oct) el SMTP propio
en Supabase y las plantillas de Supabase ya no hacen falta:** la app manda los mails por Resend y arma sus propios links
(ADR-007). Los puntos 1-3 originales (Custom SMTP, plantillas con `token_hash`, URL Configuration) se reemplazan por
**§0.4**. Siguen vigentes:

4. **"Confirm email" ON** (Authentication → Providers → Email): el signup crea la cuenta sin confirmar con
   `generateLink(signup)` y el login rechaza un email sin confirmar (`email_not_confirmed`); con la opción OFF GoTrue
   deja entrar sin verificar.
   - **"Secure password change" OFF** (misma pantalla). Si está ON, `updateUser({ password })` exige un nonce
     por mail y el `/reset` de A3c falla.
5. **Upstash Redis** en **sa-east-1**, una DB para **prod** y otra para **staging** (§4). Las claves ya llevan
   prefijo por entorno, pero bases separadas evitan que un QA agote la cuota de prod.
6. **`SENTRY_DSN`** (§5) en Production y en Preview/staging, scope **build + runtime**.
7. **Vercel → Settings → Environment Variables → "Automatically expose System Environment Variables" ON.** CSP,
   HSTS y `allowedOrigins` se calculan en el build con `VERCEL_ENV`; sin esto, Production se buildea como si no
   fuera Production (sin HSTS, con localhost en `allowedOrigins`).
8. *(Opcional)* Registrar el dominio en **hstspreload.org** si se quiere el preload real (el header ya lo
   declara; salir de la lista tarda meses: hacerlo solo con el dominio definitivo).

### 0.2 B-pre — tareas del dueño (01-oct-2026) 🔴

B-pre **no suma servicios externos, env vars ni configuración de consola**. Lo único del dueño, además del deploy
(MIGRACIONES-RUNBOOK §2.2):

1. **Confirmar que `DIRECT_URL` en Vercel (Production) es el owner** (`rolsuper` o `rolbypassrls`): el backfill de
   `agenda_foundations` corre con `row_security = off` y, sin BYPASSRLS, la migración falla a propósito.
2. **Import del catálogo global** (staging primero, después prod): backup → dry-run → `--apply` → dry-run = 0
   cambios → Plataforma → Catálogo → Importaciones → "Refrescar catálogo". Comandos en MIGRACIONES-RUNBOOK §2.2
   paso 6. Usa `.env.prod.local` (owner) y `KINESOFT_CONFIRM_PROD=<project-ref>`.
3. **Curado inicial en Plataforma** (cuando quiera, no bloquea): las 37 siglas ambiguas sin alias, los planes
   Sancor 1000/1500 y las especialidades de Mendoza (AUDIT §2 "Hallazgos de B-pre").

Mails: desde IAM no hace falta SMTP propio en Supabase; lo que hace falta es Resend con dominio propio (§0.4).

### 0.3 SV — tareas del dueño (Sala de Espera en vivo, 14-oct-2026) 🔴

SV suma **tres variables** y configuración de consola de Supabase. No bloquea el deploy (prod arranca con
`REALTIME_DRIVER=off`, idéntica a SR); bloquea **prender** la sala en vivo. Todo en **§3.1** (abajo):

1. **R1-R4** en staging y prod (solo lectura + R4 en la consola): `realtime.messages`, policies, Data API, tipo de
   clave JWT (crear una HS256 si no hay), «Allow public access» OFF.
2. Variables `REALTIME_DRIVER`, `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_KID` en Vercel.
3. **V1-V7** en staging con `scripts/realtime-verify.ts`; recién después, prod en `supabase`.

### 0.4 IAM — Mails (Resend) y Auth de Supabase (14-oct-2026) 🔴

Desde IAM **la app manda todos los mails y Supabase solo emite tokens** (ARCHITECTURE ADR-007). Orden:

1. **Dominio propio en Vercel** (§2) y `NEXT_PUBLIC_APP_URL` = ese dominio (Production). Los links de los mails salen
   de esa variable: con un valor local, en Production el mail sale `blocked`.
2. **Resend**: agregar el subdominio de envío `mail.<dominio>` y cargar en el DNS los registros que da Resend: **DKIM**
   (CNAME/TXT), **SPF** (MX + TXT del subdominio) y **DMARC** (`_dmarc.mail.<dominio>` TXT, arrancar con `p=none`).
   Esperar «Verified».
3. **Variables en Vercel** (Production; en Preview no hacen falta: Preview siempre cae a `log`):

   | Variable | Valor | Nota |
   |---|---|---|
   | `RESEND_API_KEY` | key de Resend con permiso de envío | server-only, nunca `NEXT_PUBLIC_` |
   | `EMAIL_FROM` | `KineSoft <no-reply@mail.<dominio>>` | el remitente sale como «Consultorio X vía KineSoft» |
   | `EMAIL_REPLY_TO` | opcional | Reply-To por defecto si el emisor no pasa uno |
   | `EMAIL_TRANSPORT` | **no cargar en prod** | solo pesa fuera de Production: `mailpit` en local, `resend` para el script |

   Sin `RESEND_API_KEY` o `EMAIL_FROM` en Production la app arranca igual (warning, no error) y los mails van a `log`.
4. **Supabase → Authentication → URL Configuration** (prod):
   - **Site URL** = el dominio real (`https://<dominio>`; mientras tanto `https://kinesoft.vercel.app`). Nunca localhost.
   - **Redirect URLs**: `<APP_URL>/auth/callback**`, `<APP_URL>/auth/confirm**`, `<APP_URL>/invite/**`,
     `<APP_URL>/portal/**`, `<APP_URL>/reset`, `<APP_URL>/onboarding`.
   - Solo **Google OAuth** depende de la Site URL y de esta lista (`/auth/callback`). Los links de mail los arma la app.
5. **Plantillas de Supabase** («Invite user», «Confirm signup», «Reset password», «Magic link»): **la app ya no las
   usa** (no llama `inviteUserByEmail`, `auth.signUp`, `resetPasswordForEmail` ni el magic link de Supabase). No hace
   falta editarlas ni configurar Custom SMTP. Los links viejos con `token_hash` que hayan quedado en buzones siguen
   funcionando en `/auth/confirm`.
6. **Diagnóstico** (los corre Martin, nunca imprimen secretos):
   - Mail: `scripts/diagnose-email.ts` recorre el `sendEmail` real y dice en qué escalón se corta.
     ```bash
     # local con mailpit
     EMAIL_TRANSPORT=mailpit npx tsx --conditions=react-server scripts/diagnose-email.ts --to vos@ejemplo.com --all
     # Resend de verdad (manda un mail REAL; exige --confirm)
     RESEND_API_KEY=… EMAIL_FROM="KineSoft <no-reply@mail.<dominio>>" EMAIL_TRANSPORT=resend \
       npx tsx --conditions=react-server scripts/diagnose-email.ts --to vos@ejemplo.com --url https://<dominio> --confirm
     ```
   - Auth: `scripts/diagnose-auth.ts` verifica contra Supabase real los supuestos del fake de GoTrue
     (`tests/helpers/gotrue-fake.ts`). **Importan sobre todo S4** (magic link a un email sin cuenta la crea), **S6**
     (signup sobre cuenta sin confirmar re-emite sin password), **S7** (invite), **S8** (mínimo de contraseña) y **S11**
     (`emailConfirm:false` no des-confirma). Crea y borra solo sus propias cuentas; no manda mails.
     ```bash
     npx dotenv -e .env.prod.local -- npx tsx --conditions=react-server \
       scripts/diagnose-auth.ts --email diag+auth@<dominio> --confirm=<project ref>
     ```
     Sale con código 1 si algún supuesto da FAIL: avisar (se corrige el fake y el puerto, no el test).
7. **Local:** mailpit (`docker compose --profile mail up -d mailpit`, UI en http://localhost:8025) y
   `EMAIL_TRANSPORT="mailpit"` en `.env.local`. Sin eso, los mails de dev quedan en el log.

### 0.5 BO — Back-office, MFA, cron y mantenimiento (14-oct-2026) 🔴

Orden del deploy en [MIGRACIONES-RUNBOOK «Deploy de BO»](MIGRACIONES-RUNBOOK.md). Variables nuevas (Vercel → Production;
vacías = default; cambiar cualquiera pide **redeploy**):

| Variable | Default | Cuándo cambiarla |
|---|---|---|
| `TENANT_ACCESS_ENFORCEMENT` | `banner` (`off` \| `banner` \| `enforce`) | `banner`: la prueba vencida o el impago solo muestran la banda; suspender y dar de baja desde /plataforma **sí** cortan. `enforce`: el consultorio vencido (después de la gracia de 7 días de prueba o 10 de impago) queda en **solo lectura** (nunca se bloquea leer). `off`: interruptor de emergencia (ni la suspensión corta). Pasar a `enforce` cuando decidas cobrar de verdad |
| `PLATFORM_MFA_ENFORCEMENT` | `off` (`off` \| `enforce`) | `enforce` después de enrolarte (pasos abajo). Desde PL-2 queda en `off` (§20.5.5): la 2FA es por usuario y «Entrar como soporte» ya no la exige |
| `MAINTENANCE_MODE` | `off` (`off` \| `on`) | `on` + redeploy para cerrar la app con 503 durante una migración larga. Sin bypass para superadmin; Mercado Pago, `/api/health` y los crons siguen. Probar el rewrite una vez en un Preview |
| `MAINTENANCE_MESSAGE` | vacía | Una línea que ve **cualquiera** en `/mantenimiento` (máx. 280): nada interno |
| `CRON_SECRET` | — | Cargarla ya: `openssl rand -hex 32`, solo Production. Vercel la manda como `Authorization: Bearer` a los crons; sin ella responden 503 y no corren |
| `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_REPLY_TO` | — | Ya documentadas en §0.4. BO suma mails: activación del titular, link de acceso, «soporte entró», recordatorio de prueba, resumen diario de salud y pedido de export. Sin Resend, el alta de consultorio muestra el link para copiar |

**MFA de superadmin (Supabase TOTP; PL-2: la 2FA por usuario está en `/cuenta/seguridad`, ADR-017):**
1. Supabase → Authentication → **Multi-Factor** → TOTP **habilitado** (viene así por defecto; si está apagado, enrolar
   da error en pantalla).
2. Deploy con `PLATFORM_MFA_ENFORCEMENT` en `off`.
3. Cada superadmin entra a **`/plataforma-mfa/configurar`**, escanea el QR con su app de autenticación y confirma con un
   código.
4. Probar **`/plataforma-mfa/verificar`** (cerrar sesión, volver a entrar, poner el código).
5. `PLATFORM_MFA_ENFORCEMENT=enforce` + redeploy. Desde ahí `/plataforma` pide el código al entrar y otra vez (cada 10
   min) para acciones de riesgo: suspender/dar de baja/cambiar slug, cortar acceso, transferir titular, deshabilitar
   usuarios, dar superadmin, entrar como soporte, pedir export.
6. **Recuperación** si se pierde el teléfono: `PLATFORM_MFA_ENFORCEMENT=off` + redeploy y volver a enrolar, o borrar el
   factor en Supabase → Authentication → Users → el usuario → MFA factors.
7. La CSP de `/plataforma` es bloqueante: la toolbar de Vercel no aparece ahí en los Preview (es esperado).

**Con `PLATFORM_MFA_ENFORCEMENT=off` (el default desde PL-2), PL-Z:** las acciones de **riesgo alto** de Plataforma
(suspender/dar de baja, cambiar slug, cortar acceso, transferir titular, permisos y «¿Atiende?» de un equipo,
deshabilitar usuarios, link de acceso, dar superadmin, reset de 2FA, entrar como soporte, pedir export, cobros, precios y
cambiar de plan; `PLATFORM_ACTIONS` en `lib/platform-actor.ts`) piden igual el código de la **2FA por usuario** del superadmin (`/cuenta/seguridad`,
ventana de 10 min). **Cada superadmin tiene que activarla** antes de operar: sin 2FA activa, la acción pide activarla y no
corre. Un superadmin no puede resetear la 2FA de otro superadmin (recuperación: pasos 6 o Supabase → Users → MFA factors).

**Vercel: Hobby vs Pro.**
- Crons: en Hobby corren **una vez por día y a una hora inexacta** dentro de la hora configurada; en Pro, a la hora exacta.
  Solo en Production. Desde PL-2 hay **uno solo**: `/api/cron/daily` a las 11:00 UTC (§0.6).
- `maxDuration`: Hobby 60 s (el export del consultorio está en 60 s; uno grande puede cortarse), Pro hasta 300 s
  (subirlo en `vercel.json`). Pro además es el plan para uso comercial (§19.9 del plan).

**Monitor externo:** apuntar un monitor (UptimeRobot o similar) a `GET /api/health` cada 1-5 min: `200 { ok: true }`;
`503` = base caída; `maintenance: true` = cerrado a propósito.

### 0.6 PL-2 — Facebook, comprobantes, cron único, cobro y bandeja (15-oct-2026) 🔴

| Qué | Dónde | Cuándo |
|---|---|---|
| `CRON_SECRET` | Vercel → Production | Ya estaba (§0.5). Ahora lo usa el **único** cron, `/api/cron/daily` (11:00 UTC = 08:00 AR): cobros + invitaciones + recordatorios de prueba + resumen de salud. Las rutas viejas (`/api/cron/trial-reminders`, etc.) quedan solo para dispararlas a mano con el mismo `Bearer` |
| `SAAS_BILLING_MODE` | Vercel → Production | Default `off`: se deploya sin cobrar (no genera cargos ni manda mails de cobro). Pasar a **`manual`** cuando cargues los precios en /plataforma y quieras empezar a cobrar por transferencia. `mp` existe en el enum pero **en esta etapa se comporta como `manual`** (sin Mercado Pago para la suscripción) |
| `SAAS_BILLING_TRANSFER_INFO` | Vercel → Production | **PL-Z (A2).** Texto libre (hasta 500 caracteres) con los datos para transferir: alias, CBU, titular y CUIT. Lo ve el consultorio en Configuración → Facturación. Sin ella **no se ofrece «Informar pago»**: el consultorio no tiene a dónde pagar. **Bloquea pasar `SAAS_BILLING_MODE` a `manual`**: cargarla antes (o en el mismo redeploy). Solo datos de cobro, nada interno |
| `PLATFORM_INBOX_EMAIL` | Vercel → Production | La casilla que recibe los avisos de mensajes de consultorios y de leads de la web. Sin ella los mensajes quedan en /plataforma → Mensajes, pero no llega aviso por mail |
| Bucket **`billing-receipts`** | Supabase → Storage → New bucket | **Privado** (Public bucket apagado), límite 4 MB, tipos `application/pdf, image/jpeg, image/png, image/webp`. Sin policies para `anon`/`authenticated`: la app lo usa con service-role y entrega URLs firmadas de 60 s. Crearlo **antes** de pasar a `manual` (sin bucket, subir un comprobante da error) |

**Facebook (Meta + Supabase), solo si se quiere ofrecer el botón:**
1. developers.facebook.com → crear app → caso de uso **«Autenticar y solicitar datos a usuarios con el inicio de sesión con
   Facebook»**.
2. Inicio de sesión con Facebook → Configuración: **Inicio de sesión con OAuth web** y **Forzar HTTPS** prendidos, **modo
   estricto** para URI de redireccionamiento prendido, URI válida = `https://<ref>.supabase.co/auth/v1/callback`.
3. Permisos: `email` y `public_profile` (sin revisión de Meta para estos dos).
4. Configuración básica: URL de política de privacidad, de condiciones y de **eliminación de datos** (las tres públicas),
   ícono y categoría. Pasar la app a **Live** (en modo desarrollo solo entran los testers).
5. Supabase → Authentication → Providers → **Facebook**: App ID y App Secret. **«Allow users without an email»
   apagado** (si no, Facebook puede entregar un usuario sin email; igual la app lo rechaza con `oauth_no_email`, H-PL2).
6. Verificar: `GET https://<ref>.supabase.co/auth/v1/settings` → `"facebook": true`. Mientras esté en `false`, el botón
   termina en «Ese método de ingreso no está disponible por ahora».
7. La CSP ya permite `www.facebook.com`/`m.facebook.com` en `form-action` y el avatar de `platform-lookaside.fbsbx.com`.

### 1. Hosting / plataforma de despliegue — Vercel
- **Qué configura:** proyecto en Vercel (región `gru1` ya fijada en `vercel.json`); env vars de prod;
  branch protection en `main` exigiendo el check de CI como required; `KINESOFT_ALLOW_DEMO_ACTOR`
  **unset** en prod; `DIRECT_URL` presente (lo usa `prisma migrate deploy` del `buildCommand`).
- **Bloquea:** corte E1 #11, #15.
- **Responsable:** dueño.
- **Estado:** 🟡 (deploy activo; falta branch protection + verificación de env).
- **Gate de activación:** —

### 2. DNS y dominio
- **Qué configura:** dominio productivo del SaaS + apuntar a Vercel; subdominios si el modelo
  `/c/<slug>` migra a `slug.dominio`.
- **Bloquea:** email transaccional (SPF/DKIM viven acá), corte E2.
- **Responsable:** dueño.
- **Estado:** 🔴
- **Gate de activación:** —

### 3. Base de datos gestionada — Supabase (Postgres + Auth + Storage)
- **Qué configura:**
  1. **Rol de app sin BYPASSRLS `kinesoft_app`** (residual único de la RLS wholesale): hoy prod usa
     `postgres.<ref>`, que tiene BYPASSRLS → las policies no se evalúan. El script ya está escrito:
     correr `prisma/roles.supabase.sql` en el SQL editor (crea el rol `NOSUPERUSER NOBYPASSRLS` +
     GRANT DML + default privileges), reemplazar los passwords placeholder, y apuntar `DATABASE_URL`
     a ese rol. Verificar con `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%'`.
     **En local ya está hecho** (`prisma/roles.local.sql`, `.env.local` → `kinesoft_app`) y el test
     `tests/integration/rls-isolation.test.ts` pasa en verde; falta solo el flip de prod.
  2. **Rol de servicio `kinesoft_service` (BYPASSRLS) + `DATABASE_URL_SERVICE`** — lo crea el mismo
     `prisma/roles.supabase.sql`. Es el canal de `prismaService` (`lib/db.ts`) para las superficies
     **sin Actor** (webhook MP, booking público, auditoría de jobs) **y para todas las escrituras del
     panel Plataforma al catálogo global**. Sin esta env var, apenas se flipee `DATABASE_URL` al rol
     con RLS forzada el superadmin **no puede escribir el catálogo global**: el rol de app no puede
     tocar filas `tenantId IS NULL` (`exercise_write` exige `tenantId = app_current_tenant_id()`) y
     `ExerciseMedia`/`ExerciseArticle` no tienen policy de escritura. En local no hace falta: cae a
     `DIRECT_URL` (el owner del Docker, superuser).
  3. **Bucket `patient-files` PRIVADO** — verificación bloqueante del corte E1 (el auditor no pudo
     confirmarlo). Debe ser privado; el acceso es solo por signed URL (`getDownloadUrl`, 10 min).
  4. **Bucket `exercise-media` PRIVADO** (nuevo, Ronda 7) — video/imagen/GIF de los ejercicios del
     catálogo global. **Hay que crearlo a mano en el proyecto Supabase de producción**: no lo crea
     el código ni ninguna migración. Privado; se sirve con **signed URLs de 1 h**
     (`lib/exercise-media.ts`). Allow-list de MIME: `video/mp4`, `video/webm`, `video/quicktime`,
     `image/png`, `image/jpeg`, `image/webp`, `image/gif`; tope **50 MB** por archivo; extensión
     saneada con `/^[a-z0-9]{1,5}$/`. Sin el bucket, toda subida desde `/plataforma/ejercicios`
     falla (la media tipo YOUTUBE sigue andando: guarda un link, no un archivo).
  5. **Password policy** de Supabase Auth (complejidad) alineada con `password-policy`.
  6. ~~Custom SMTP propio~~: desde IAM (14-oct) la app no usa los mails de Supabase (ADR-007); ver §0.4 y §7.
- **Bloquea:** RLS real en prod (residual de la Ola 2.2 / Ronda 4), escritura del catálogo global
  desde Plataforma, subida de media de ejercicios, corte E1 #14, `password-policy`.
- **Responsable:** dueño (roles/buckets/policy) + ejecutor técnico (cambio de connection strings).
- **Estado:** 🟡 (DB productiva activa; roles, `DATABASE_URL_SERVICE`, bucket `exercise-media` y
  verificación de `patient-files` pendientes).
- **Gate de activación:** `DATABASE_URL` → `kinesoft_app`; `DATABASE_URL_SERVICE` → `kinesoft_service`;
  buckets `patient-files` y `exercise-media` creados y privados.

### 3.1 Supabase Realtime y JWT Signing Keys (SV, 14-oct-2026) 🔴

La Sala de Espera en vivo (SV) usa **Broadcast privado** de Supabase Realtime: el server publica «el turno X cambió»
(sin datos del paciente) en el canal `tenant:<id>:agenda`, y cada pestaña del consultorio lo escucha con un token
corto que firma nuestro server. Diseño en [ARCHITECTURE.md ADR-006](ARCHITECTURE.md); seguridad en
[SECURITY.md §17](SECURITY.md). **Hasta que esto esté hecho, prod corre con `REALTIME_DRIVER=off`** (la app es igual
que antes de SV y `/sala` se actualiza cada 60 s).

- **Qué configura:** prechecks R1-R4 en prod y staging; una clave HS256 si el proyecto no la tiene; «Allow public
  access» OFF; tres variables de entorno; verificación V1-V7 en staging.
- **Bloquea:** prender `REALTIME_DRIVER=supabase` (no bloquea el deploy: con `off` todo funciona).
- **Responsable:** dueño.
- **Estado:** 🔴 (R1-R4 sin correr; anotá acá los resultados, sin valores secretos).
- **Gate de activación:** `REALTIME_DRIVER=supabase` + redeploy.

**Qué es R4, en criollo.** Supabase firma los tokens de sesión con una clave del proyecto. Históricamente era un
**secreto compartido (HS256)**: quien lo tiene puede firmar tokens que Supabase acepta, y nuestro server lo necesita
para acuñar el token del canal. Los proyectos nuevos pueden usar **claves asimétricas** (ES256/RS256): Supabase firma
con una clave privada que no se puede exportar, y nadie de afuera puede firmar. Si el proyecto está así, hay que
**agregar una clave HS256** y poner su secreto y su `kid` en el env. Por eso el token lleva `kid` opcional: el mismo
código sirve con el secreto legacy (sin `kid`) y con una clave del sistema nuevo (con `kid`).

**R1 — existe `realtime.messages`** (SQL editor, solo lectura):
```sql
select to_regclass('realtime.messages') is not null as realtime_messages;   -- esperado: true
select c.relkind, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'realtime' and c.relname = 'messages';                  -- esperado: 'p', true
```
**R2 — no hay otras policies abiertas en `realtime`:**
```sql
select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'realtime';
-- antes de M5: 0 filas. Después: 1 fila  kinesoft_agenda_read | SELECT | {authenticated} | … | (sin with_check)
```
Cualquier otra fila (sobre todo `INSERT` o `ALL`) se borra antes de prender el driver: dejaría publicar o leer a otros.

**R3 — Data API:** Settings → API → Data API **desactivada** (o `public` fuera de «Exposed schemas»), y la query de
[VERTICALES.md §1](VERTICALES.md) (`has_table_privilege('anon', oid, 'UPDATE')` todo `false`). Es lo que hace que el
token del canal, si se filtra, no lea tablas.

**R4 — JWT keys, API keys y Realtime:**
1. Settings → **JWT Keys** (JWT Signing Keys): ¿está activo el «Legacy JWT secret» (HS256), o el proyecto pasó a
   claves asimétricas con el legacy revocado?
   - **Legacy HS256 activo** → `SUPABASE_JWT_SECRET` = ese secreto; `SUPABASE_JWT_KID` vacío.
   - **Solo asimétricas** → crear una clave nueva de tipo **Shared secret (HS256)** como *standby* (si la consola deja
     importar el secreto, generalo con `openssl rand -base64 48`; si lo genera ella, copialo al crearla). En la lista
     de claves, cada una muestra su **Key ID**: eso va en `SUPABASE_JWT_KID`. Correr V1 con la clave en standby; si V1
     da `CHANNEL_ERROR`, promoverla a *current* («Rotate keys»): Supabase Auth pasa a firmar con HS256 y la app no
     cambia (el login no lee el tipo de clave).
2. Settings → **API Keys**: legacy `anon`/`service_role` o nuevas `sb_publishable_…`/`sb_secret_…`. Las dos sirven:
   el socket acepta cualquiera como `apikey` y el POST de Broadcast acepta la service/secret. Anotá cuál se usa.
3. Settings → **Realtime**: **«Allow public access» OFF** (solo canales privados). Con ON, cualquiera con la anon key
   (que viaja en el bundle) abre canales públicos; V7 lo verifica.

**Variables** (Vercel, Production y Preview/staging cada uno con las suyas; server-only, nunca `NEXT_PUBLIC_`):
`REALTIME_DRIVER` (`off` → `supabase`), `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_KID` (opcional). Con `supabase` en
Production el build falla si falta el secreto, la service key, `NEXT_PUBLIC_SUPABASE_URL` o `_ANON_KEY`. Detalle en
[DEPLOYMENT.md](DEPLOYMENT.md) («Required environment variables»).

**V1-V7 en staging** (con `REALTIME_DRIVER=supabase` en staging y un tenant de prueba; necesita `ws`, ya en
devDependencies). Lee el env del proceso, no imprime secretos, rechaza localhost y exige `--confirm` = project ref:
```bash
npx dotenv -e .env.staging.local -- npx tsx --conditions=react-server scripts/realtime-verify.ts \
  --tenant <tenantId> --confirm=<project-ref>
```
| # | Qué verifica | PASS |
|---|---|---|
| V1 | Token propio → canal privado `tenant:<id>:agenda` | `SUBSCRIBED` |
| V2 | Token de otro tenant / sin token / vencido | `CHANNEL_ERROR` (nunca `SUBSCRIBED`) |
| V3 | `channel.send` de un cliente con token propio | no llega a otro suscriptor (sin policy INSERT) |
| V4 | El token fuera del canal: PostgREST (`/rest/v1/Tenant`), GoTrue (`/auth/v1/user`), Storage (**POST** `/storage/v1/object/list/patient-files`) | rechazado (401/403/404/42501) o lista vacía por RLS |
| V5 | Publish REST con la service key | **202** y llega al listener de V1 |
| V6 | 20 publicaciones | p95 de recepción < 1 s |
| V7 | «Allow public access» OFF: join **público** sin token al mismo topic | rechazado; si suscribe, el mensaje no cruza al canal privado (y avisa que hay que apagarlo) |

Sale con código 1 si algún chequeo falla. V5/V6 publican mensajes efímeros `availability` en el topic del tenant de
prueba (una pestaña abierta ahí hace un `router.refresh()`, nada más). A mano: `/sala` en dos navegadores de staging,
«Llegó» en uno aparece en el otro en < 2 s.

**Rotación** (sin código): crear la clave HS256 nueva como standby → cargar su secreto y `kid` en Vercel → redeploy
→ V1 → promoverla → revocar la vieja cuando no queden tokens vivos (duran 10 min). Si se rota el **secreto legacy**,
cambia también la anon/service legacy: actualizar esas variables en el mismo redeploy.

**Orden** (RUNBOOK «Deploy de SV»): M5 en la cadena única → deploy con `off` → env → staging `supabase` + V1-V7 →
prod `supabase` + redeploy. Volver atrás = `REALTIME_DRIVER=off` + redeploy.

### 4. Rate-limiting gestionado — Upstash Redis
- **Qué configura:** crear una DB Redis en Upstash (región **sa-east-1**; una para prod y otra para
  staging) y setear `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` en Vercel (Production y
  Preview). El código ya rutea a Upstash cuando están; sin ellas cae a memoria per-lambda (inútil en
  serverless). Desde A3a (30-sep-2026) un Upstash caído o lento (>1,5 s) cae a memoria con el log
  `rate_limit.upstash_fallback` en vez de romper el login, y las claves llevan prefijo `rl:<VERCEL_ENV>:`.
- **Bloquea:** corte E1 #1 (rate-limit real en superficies públicas). Findings `c1-ratelimit-inmemory`,
  `rate-limit-inmemory-activo-prod`.
- **Responsable:** dueño.
- **Estado:** 🔴
- **Gate de activación:** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` presentes.
- **No tocar:** el fallback a `memory()` ante error de transporte debe preservarse.

### 5. Monitoreo de errores — Sentry
- **Qué configura:** cuenta Sentry + proyecto. Desde A3b (30-sep-2026) `@sentry/nextjs` está instalado y es
  **no-op total sin DSN**. Variables (Vercel, scope build + runtime):
  - `SENTRY_DSN` — obligatoria para activar; también define a dónde van los reportes de CSP.
  - Opcionales: `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` (sin ellas no se suben sourcemaps),
    `SENTRY_TRACES_SAMPLE_RATE` (default 5% en prod, 0 en el resto), `SENTRY_DEBUG`.
  - Solo servidor/edge: **no hay SDK de cliente** (presupuesto de bundle) → errores del navegador fuera hasta C1.
- **Bloquea:** corte E1 #8; A3 (QA de observabilidad). Findings `m1-sentry-no-wired`, `sentry-no-cableado`.
- **Responsable:** dueño.
- **Estado:** 🔴 (código listo; falta el DSN).
- **Gate de activación:** `SENTRY_DSN` presente.

### 6. Pagos — Mercado Pago
- **Qué configura:**
  1. **Checkout de turnos (existente):** credenciales de prod + `MP_WEBHOOK_SECRET` verificado en
     Vercel (la ruta ya da 503 sin él); credenciales **sandbox** para el QA de `payment-amount-anclado`.
  2. **Preapproval / suscripción:** **no por ahora** (decisión de Martin 16-oct). La suscripción se cobra por
     transferencia con comprobante (PL-2b, §0.6); el webhook de MP queda solo para los turnos.
- **Bloquea:** checkout de turnos (corte E1 #2). Ya no bloquea el cobro del plan: es manual (PL-2b, §0.6; la Ola 2.4 quedó superada por PL).
- **Responsable:** dueño.
- **Estado:** 🟡 (checkout de turnos funcional; secret/credenciales prod y sandbox por verificar).
- **Gate de activación:** `MP_WEBHOOK_SECRET` + credenciales prod; sandbox para QA.

### 7. Email transaccional
- **Qué configura:** Resend con dominio propio (subdominio `mail.<dominio>`, SPF/DKIM/DMARC) para invitaciones,
  verificación de signup, recuperación de contraseña, reset por admin y portal. La app lo llama por `fetch`
  (`lib/email/resend.ts`); Supabase no manda nada. Detalle en **§0.4**.
- **Bloquea:** que los mails lleguen en prod. Sin `RESEND_API_KEY`/`EMAIL_FROM`, Production cae a `log` (aviso al
  boot) y la UI de invitaciones ofrece copiar el link.
- **Responsable:** dueño.
- **Estado:** 🔴 (dominio + Resend pendientes).
- **Gate de activación:** `RESEND_API_KEY` + `EMAIL_FROM` en Vercel (Production) con el dominio verificado.

### 8. Identidad / OAuth
- **Qué configura:** proveedores OAuth adicionales. **Google** ya está cableado. **Facebook**: el código está
  (PL-2e, `/api/auth/oauth/facebook`); falta la app de Meta y el provider en Supabase (§0.6). **Apple** requiere
  cuenta de Apple Developer (paga).
- **Bloquea:** sesión `oauth-extra` (Ola 2.6) — opcional.
- **Responsable:** dueño.
- **Estado:** 🟢 Google · 🟡 Facebook (código listo, consola pendiente) · 🔴 Apple.
- **Gate de activación:** credenciales del proveedor en Supabase Auth.

### 9. Analítica de producto/uso — GA / Vercel Analytics / Google Business
- **Qué configura:** cuentas + tags (con gate de consentimiento antes de inyectar cualquier tag de
  terceros). SEO técnico (`sitemap.ts`/`robots.ts`) es código → sesión `seo-analytics`.
- **Bloquea:** validación del SaaS productivo (no bloquea corte). Finding `sin-sitemap-robots` (código).
- **Responsable:** dueño (cuentas/tags) + ejecutor técnico (SEO técnico).
- **Estado:** 🔴
- **Gate de activación:** IDs de medición + consentimiento cableado.

### 10. Observabilidad de performance — APM
- **Qué configura:** APM / monitoreo de query-perf (diferido).
- **Bloquea:** nada del corte. Finding `m3-no-apm`.
- **Responsable:** dueño.
- **Estado:** ⏸ diferido.
- **Gate de activación:** ≥5 tenants activos O primer incidente de latencia p95.

### 11. Legal — bucket D
- **Qué configura:** términos y condiciones, política de privacidad, y el marco regulatorio de
  historia clínica en Argentina (**Ley 26.529** — retención/derechos del paciente). Afecta la
  retención de HC y un eventual borrado a pedido del paciente.
- **Bloquea:** corte E2 (signup público). Mitigado: desde A2 (30-sep-2026) no existe el borrado
  definitivo de pacientes, solo Archivar.
- **Responsable:** asesor legal / decisión de negocio.
- **Estado:** 🔴
- **Gate de activación:** revisión legal completada.

### 12. Marca — bucket E
- **Qué configura:** dominio de marca, favicons, `manifest`/PWA, assets. La landing se trabaja aparte.
- **Bloquea:** corte E2 (sin datos fabricados / assets en su lugar).
- **Responsable:** dueño / diseño.
- **Estado:** 🔴
- **Gate de activación:** assets entregados.

### 13. Mensajería — WhatsApp Business API — bucket C
- **Qué configura:** una cuenta de **WhatsApp Business API** para **enviar** recordatorios de turno
  automáticos (hoy no hay nada configurado). Requiere: (a) elegir proveedor — **Twilio**
  (más caro por mensaje, integración y soporte más simples) o **360dialog** (BSP oficial, tarifa
  Meta directa, más barato a volumen, alta más burocrática); (b) verificar el negocio en Meta
  Business Manager; (c) un número de teléfono dedicado (no puede ser el mismo que ya usa la app
  WhatsApp normal del consultorio); (d) **registrar y aprobar plantillas** (message templates) —
  Meta las revisa una por una y todo mensaje iniciado por el negocio fuera de la ventana de 24 h
  tiene que ser una plantilla aprobada.
- **Contexto (qué hay hoy):** en la **Ronda 5** se entregó "Compartir turno" en el booking-drawer
  con un link **`wa.me`** (`components/agenda/booking-drawer/share-actions.tsx`) + recordatorio imprimible/PDF
  client-side. Ese camino **no requiere ninguna configuración ni costo**: abre WhatsApp con el
  texto pre-cargado y el profesional aprieta enviar. Cubre el caso real de hoy (1 cliente,
  volumen bajo). La API oficial es lo que hace falta **solo** para envíos **automáticos** (cron de
  recordatorios 24 h antes, confirmación automática al reservar) sin intervención humana.
  Diferidos relacionados de la Ronda 5: envío por email/WhatsApp-API del recordatorio y el export
  PDF/JPEG completo. **Gap conocido:** la landing publicita WhatsApp sin implementación real —
  alinear el copy cuando esto exista (o antes).
- **Costo aproximado:** Meta cobra **por conversación de 24 h**, no por mensaje, y por categoría.
  En Argentina las de **utility/servicio** (que es la categoría del recordatorio de turno) están
  en el orden de **USD 0,03-0,05 por conversación**; marketing es varias veces más caro. Twilio
  suma su fee por mensaje encima de la tarifa Meta (~USD 0,005-0,01); 360dialog cobra una
  suscripción mensual fija (del orden de USD 20-50) y pasa la tarifa Meta a costo. Para un
  consultorio con ~200 turnos/mes el costo de plataforma domina al de conversaciones. **Verificar
  los números vigentes antes de decidir** — Meta reajusta la tabla de precios por país
  periódicamente.
- **Decisión pendiente:** proveedor (Twilio vs 360dialog) y si el recordatorio automático es una
  feature del plan base o un add-on facturable (afecta el billing SaaS de la Ola 2.4).
- **Bloquea:** nada del corte E1/E2 — el link `wa.me` cubre el flujo manual. Bloquea los
  recordatorios automáticos y el ítem (d) diferido de la Ronda 5.
- **Responsable:** dueño (cuenta, número, verificación de negocio, plantillas) + ejecutor técnico
  (cliente de envío + cron, patrón listo-para-activar con fallback no-op).
- **Estado:** 🔴 (nada configurado; el dueño todavía no lo arrancó).
- **Gate de activación:** **demanda real del cliente** — recién cuando el cliente vivo pida
  recordatorios automáticos (o haya ≥2 consultorios pidiéndolo). No adelantarse: la API tiene
  costo fijo y alta burocrática, y el link `wa.me` no cuesta nada.
- **Env vars que haría falta:** `WHATSAPP_PROVIDER` (`twilio` | `360dialog`), `WHATSAPP_FROM`
  (número en formato E.164) y el par de credenciales del proveedor —
  Twilio: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`;
  360dialog: `WHATSAPP_API_KEY` (+ `WHATSAPP_API_URL` si el endpoint no es el default).
  Más `WHATSAPP_TEMPLATE_REMINDER` (nombre de la plantilla aprobada) y, si se implementa el
  callback de estado de entrega, `WHATSAPP_WEBHOOK_SECRET`. Ausentes → el envío queda no-op y la
  UI sigue ofreciendo solo el link `wa.me`.
