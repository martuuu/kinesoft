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

> **Día del push (T3-T7): [PUSH-DIA.md](PUSH-DIA.md)** dice qué consola va antes (paso C: buckets y Data API) y en qué
> orden se activa el resto después (paso G: Resend → Upstash → Sentry/CSP → Google → suscripción §0.14 → MP Connect
> §0.12 → WhatsApp §0.13 → TV §0.15).

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

### 0.3 SV — tareas del dueño (Sala de Espera en vivo, 14-oct-2026) 🟢

> **16-oct:** prendido en prod (`REALTIME_DRIVER=supabase`, V1-V7 11/11). **18-oct:** la agenda no entraba en vivo por
> un `\n` al final del secreto en Vercel (H-RT1); Martin lo re-pegó y HF-1a lo recorta. Pendiente: el QA de §0.8.

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
| `CRON_SECRET` | Vercel → Production | Ya estaba (§0.5). Lo usan los **dos** crons de `vercel.json`: `/api/cron/daily` (11:00 UTC = 08:00 AR: cobros + invitaciones + recordatorios de prueba + resumen de salud) y, desde T6, `/api/cron/whatsapp` (21:00 UTC = 18:00 AR, §0.13). Las rutas viejas (`/api/cron/trial-reminders`, etc.) quedan solo para dispararlas a mano con el mismo `Bearer` |
| `SAAS_BILLING_MODE` | Vercel → Production | Default `off`: se deploya sin cobrar (no genera cargos ni manda mails de cobro). Pasar a **`manual`** cuando cargues los precios en /plataforma y quieras empezar a cobrar por transferencia. Desde T6, **`mp`** suma débito automático y «Pagar con Mercado Pago» (exige `MP_ACCESS_TOKEN`): orden `off → manual → sandbox S1-S10 → mp`, **§0.14** |
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

### 0.7 Directorio y PWA (DIR + MB, 16-oct-2026) 🔴

| Qué | Dónde | Cuándo |
|---|---|---|
| `DIRECTORY_MODE` | Vercel → Production | **Sin setear = `off`** (default seguro, DIR-D2): `/profesionales` y `/consultorios/*` dan 404 y sitemap, robots y landing quedan como antes de DIR. `preview`: las rutas responden con `noindex, nofollow`, fuera del sitemap y sin link en la landing (para revisar con el link). `public`: indexables, en el sitemap y con «Buscá un profesional» en la landing. Cualquier otro valor lo rechaza el boot (`lib/env.ts`); en runtime cae a `off`. Se lee en cada request, pero las páginas son ISR: al cambiar de modo, **redeploy** (si no, una ficha ya generada puede seguir sirviéndose hasta 10 min). Pasar a `public` **después** de M11 en prod, de revisar en `preview` y de la **revisión legal del texto de consentimiento** (DIR-D20) |
| `NEXT_PUBLIC_PWA` | Vercel → Production | **Sin setear = prendido**: el workspace y Plataforma registran `/sw.js` (instalable; offline muestra «Sin conexión», nada de datos en caché, ADR-022). `off` es el **interruptor de emergencia** (MB-D6): en la próxima carga desregistra todos los service workers. Es `NEXT_PUBLIC_*`: se inlinea en el build, así que cambiarlo **requiere redeploy** |
| Instalar la app | Teléfono / PC real | QA manual de [QA.md «MB»](QA.md): Android (Chrome «Instalar app»), iOS (Safari → Compartir → «Agregar a inicio»), macOS (Safari «Agregar al Dock» / Chrome) y Windows (Edge/Chrome). No se promociona hasta el cambio de dominio (MB-D9): una PWA instalada en el dominio viejo no migra |

### 0.8 Tanda A — turnero sin cobro, realtime y 2FA (18-oct-2026) 🔴

Sin migración. Todo es Vercel → Production y **redeploy** al cambiar una variable. Detalle en [AUDIT «Hallazgos de la
Tanda A»](AUDIT.md), [SECURITY §17 y §20.1](SECURITY.md); QA en [QA «Tanda A»](QA.md).

| Qué | Dónde | Cuándo / cómo |
|---|---|---|
| `TURNERO_CHECKOUT` | Vercel → Production | **Dejarla sin setear.** Desde T5 nadie la lee (el turnero cobra con la cuenta de cada profesional, §0.12); `platform` solo loguea un aviso al boot y otro valor lo frena |
| Holds trabados del turnero | SQL Editor de prod, **solo lectura** | Reservas que quedaron PENDING por el bug de H-TP0 (cada reintento fallaba). Correr la query de abajo y avisar a esos pacientes (el horario ya se liberó a los 30 min). No escribir nada: el agente no toca prod |
| `SUPERADMIN_2FA_BYPASS` | Vercel → Production | Formato `<tu userId>@AAAA-MM-DD` (fecha de vencimiento, inclusive, hora AR; **≤ 30 días**, recomendado 14). El userId es el de Supabase → Authentication → Users. Una entrada mal escrita o a más de 30 días se ignora (log `2fa.bypass_ignored`) y la 2FA sigue pidiéndose. No aplica con `PLATFORM_MFA_ENFORCEMENT=enforce`. Mientras dure, **con tu contraseña sola se opera Plataforma entera**: contraseña única. Cambiar o apagar la 2FA y sumar un factor siguen pidiendo el código. Al terminar, borrarla y redeploy (o dejar que venza: la banda desaparece sola) |
| `SUPABASE_JWT_SECRET` | Vercel → Production | Ya re-pegado por Martin el 18-oct sin Enter al final (H-RT1). Verificar: `/plataforma/sistema` → huella del secreto = la que imprime `scripts/realtime-verify.ts` en local, y «espacios o saltos de línea al borde: no» |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel → Production | Revisar que no tenga salto de línea al final: el server la recorta, pero la copia que el build inlinea en el navegador **no** (se usa como `apikey` del socket). Si se re-pega, redeploy |
| Node 22 en Vercel | Vercel → Settings → General → Node.js Version | Opcional: «Probar desde el servidor» de `/plataforma/sistema` necesita el `WebSocket` global de Node 22. En Node 20 dice «no disponible en este runtime» (no rompe nada). Probarlo primero en un Preview, que hoy comparte la DB de prod: solo deploy, sin QA de escritura |
| Skew Protection | Vercel → Settings → Advanced | Opcional, si el plan lo permite: evita el «Hay una versión nueva · Recargá» en pestañas y PWA abiertas durante un deploy |

**Query de holds trabados (solo lectura):**

```sql
-- Reservas del turnero (key `pub:`) que quedaron PENDING más de 30 min y todavía son a futuro.
SELECT t.slug, b.id, b."scheduledFor", b."createdAt", b."guestName", b."guestPhone", b."guestEmail",
       b.status, b."paymentStatus", p.status AS "mpStatus"
FROM "Booking" b
JOIN "Tenant" t ON t.id = b."tenantId"
LEFT JOIN "Payment" p ON p."bookingId" = b.id
WHERE b."idempotencyKey" LIKE 'pub:%'
  AND b.status = 'PENDING'
  AND b."createdAt" < now() - interval '30 minutes'
  AND b."scheduledFor" > now()
ORDER BY b."scheduledFor";
```

### 0.9 Tanda B — guard de Preview y rechazo de Resend (18-oct-2026) 🔴

Sin migración. Detalle en [AUDIT «Hallazgos de la Tanda B»](AUDIT.md) y [DEPLOYMENT «Guard de Preview»](DEPLOYMENT.md);
QA en [QA «Tanda B»](QA.md).

| Qué | Dónde | Cuándo / cómo |
|---|---|---|
| `PROD_SUPABASE_REF` | Vercel → **todos los scopes** (Production, Preview, Development) con el **mismo valor** | El `<ref>` de `https://<ref>.supabase.co` de prod (no es secreto). Con él, un build de **Preview** cuyas `DATABASE_URL` / `DIRECT_URL` / `DATABASE_URL_SERVICE` (host o usuario `postgres.<ref>` del pooler) o `NEXT_PUBLIC_SUPABASE_URL` apunten a prod **falla** en vez de escribir datos reales. En Production no hace nada; sin la variable, Preview solo avisa en el log. En `.env.local` queda vacía |
| Rechazo de Resend | Terminal de Martin, con las variables de prod en su shell (el agente no corre nada contra prod) | `RESEND_API_KEY=… EMAIL_FROM="…" EMAIL_TRANSPORT=resend npx tsx --conditions=react-server scripts/diagnose-email.ts --to <vos> --url https://<dominio> --from-name "" --expect-domain <dominio verificado> --confirm`. Avisa si `EMAIL_FROM` es de otro dominio o está mal pegada; con `--from-name ""` y con el nombre del consultorio se ve si el problema es el display-name. Después mirar `/plataforma/sistema` → «Últimos mails que no salieron»: el motivo (401 key, 403 dominio sin verificar o cuenta en prueba, 422 remitente) dice qué corregir en Resend o en `EMAIL_FROM` |
| Logo y marca | — | Martin elige el logo del prototipo → recién ahí se hace el renombrado (OPS-4) |

### 0.10 T3 — Secretaria, cobros y módulos (19-oct-2026) 🔴

**Con migración M12** (sin variables de entorno nuevas). Orden en [RUNBOOK «M12 en prod»](MIGRACIONES-RUNBOOK.md);
QA en [QA «T3»](QA.md).

| Qué | Dónde | Cuándo / cómo |
|---|---|---|
| M12 `agenda_secretaria_config` | Terminal de Martin (`db:prod:*`) | Al final de todo el planning (§22.14), **antes** del push de T3 (el build de Production migra) y antes que M14 (orden real M12 → M14 → M18 → M17 → M15/M16): precheck (a)-(g) → `db:prod:backup` → `db:prod:deploy` → postcheck |
| Admins y staff | Precheck (d) y (e) de M12 | (d) = los ADMIN que pasan a tener «Planes y pagos»; (e) = Secretaria/Facturación con «Planes y pagos» o «Configuración» que con T3 pierden lo delicado: avisarle al Titular del cliente vivo antes del deploy |
| Módulos a medida | `/plataforma` → consultorio → Suscripción → «Módulos» | Opcional, después del deploy (pide 2FA). Nada cambia mientras no se toque |
| «Sin conexión en vivo» en el Chrome de la Secretaria | Navegador de la Secretaria → indicador → «Ver detalle» | Pendiente desde §23.0: Martin pasa el paso que falla para decidir si hace falta un fix |

### 0.11 T4 — Fichas clínicas: buckets, CIE-11 y verificaciones finales (19-oct-2026) 🔴

**Con migración M14** (`fichas_clinicas`; sin variables de entorno obligatorias nuevas). Todo va **al final de todo el
planning** (§22.14: consolas, push y migraciones juntos). Orden en [RUNBOOK «M14 en prod»](MIGRACIONES-RUNBOOK.md); QA en
[QA «T4»](QA.md); diseño en [ARCHITECTURE ADR-025](ARCHITECTURE.md).

| Qué | Dónde | Cuándo / cómo |
|---|---|---|
| Bucket `patient-documents` | Supabase → Storage → New bucket | **Antes del deploy.** Privado (`public = false`), **sin policies**, límite **10 MB**, MIME permitido `application/pdf`. Guarda los PDF que se comparten con el paciente (`{tenantId}/{patientId}/{documentId}.pdf`) |
| Bucket `practice-assets` | Supabase → Storage → New bucket | **Antes del deploy.** Privado, sin policies, límite **1 MB**, MIME `image/png`, `image/jpeg`. Logo del consultorio y firmas de los profesionales |
| Límite de `patient-files` | Supabase → Storage → `patient-files` → Edit bucket | **Antes del deploy.** Sigue privado y sin policies; límite **25 MB** (la subida firmada ya no pasa por el body de 4,5 MB de Vercel) |
| Verificar los 3 buckets | SQL editor (solo lectura) | `SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id IN ('patient-documents','practice-assets','patient-files');` → 3 filas, `public = f`, con sus límites. Y `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';` → ninguna para estos buckets |
| `PATIENT_FILES_SIGNED_UPLOAD` | Vercel (opcional) | Sin setear = prendido. `off` vuelve al camino viejo de ≤ 4 MB si la subida firmada falla en el checklist de abajo (redeploy) |
| Catálogo CIE-11 (OMS) | Navegador + terminal de Martin | **Sin mail a la OMS y sin pagar nada** (decisión de Martin del 19-oct: la licencia CC BY-ND 3.0 IGO no pide aviso ni pago). **Después** de M14 y del deploy: (1) bajar gratis el «Archivo de hoja de cálculo» (SimpleTabulation) de la última release con español desde `https://icd.who.int/browse/<release>/mms/es`; (2) guardarlo **fuera del repo** en `data/icd11/` (ignorado); (3) `npm run diagnosis:import -- --file=data/icd11/<archivo> --release=<AAAA-MM> --inspect` (local: confirma el formato de `ChapterNo` y de los booleanos, que no se pudo ver sin el archivo real); (4) dry-run contra prod: `KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/diagnosis-import.ts --file=… --release=…` (lista altas, cambios y retiros; no escribe; **nunca** el script npm, que lee `.env.local`); (5) lo mismo con `--apply --by=martin`; (6) otro dry-run → 0 cambios. `--allow-mass-retire` **solo** si el dry-run explica un retiro de más de max(25, 5 %) de los vigentes (si no, aborta: un archivo truncado vaciaría el catálogo). Capítulos 01-26 y V; el X queda afuera (FC-D30). Hasta el import, el grupo CIE-11 dice «El catálogo CIE-11 todavía no está cargado» y funcionan propios, kine y texto libre |

**Verificar al final en Vercel/Supabase** (no hubo spike en Vercel por regla de Martin; todo lo de T4 se probó con
`next build` + `next start` local y Storage falso):

- [ ] **react-pdf en frío en `gru1`:** primera descarga de una ficha después de un deploy (frío) y la segunda (caliente).
  El tamaño de la función tiene que incluir `@react-pdf/*`, yoga y las fuentes Noto (`.nft.json` /
  `outputFileTracingIncludes`). Una HC completa de 300 fichas tarda 6-7 s en local: tiene que entrar en los 60 s de
  `vercel.json`.
- [ ] **Cola de render** (AUDIT B-5): los renders van en serie por proceso (`freshFonts()`, bug de ToUnicode). Dos o tres
  descargas a la vez desde dos pestañas: que ninguna pase de ~10 s ni dé 503.
- [ ] **Subida firmada** (Archivos, un PDF de 20 MB):
  - el PUT con **binario crudo** a la URL firmada funciona (supabase-js `uploadToSignedUrl` manda multipart; si Storage
    exige multipart, cambiar el PUT a `FormData` en `lib/files-upload-logic.ts`);
  - se respeta el `Content-Type` declarado;
  - **CORS** del bucket `patient-files` acepta el PUT desde el dominio de la app;
  - `info()` devuelve el tamaño, la lectura con `Range` trae 64 bytes y el `move` de `pending/` a la clave final anda;
  - la URL firmada vale **2 h** en Storage (no se puede acortar). El token propio la corta a 15 min: subir a los 16 min
    tiene que fallar en el confirm;
  - un `.exe` renombrado a `.pdf` se rechaza y no queda nada en el bucket.
- [ ] Compartir una ficha con un paciente de prueba → el PDF aparece en `patient-documents` y el mail llega sin datos
  clínicos → el portal lo baja → anular la ficha → desaparece del portal.

### 0.12 T5 — Cobros online con Mercado Pago (22-oct-2026) 🔴

**Con migración M18** (`turnero_cobros_mp`) y variables nuevas. ⚠️ Todo esto va **al final de todo el planning**
(§22.14: consolas, push y migraciones juntos), **antes del push**. Orden de la migración en
[RUNBOOK «M18 en prod»](MIGRACIONES-RUNBOOK.md); diseño en [ARCHITECTURE ADR-026](ARCHITECTURE.md); seguridad en
[SECURITY §24](SECURITY.md); QA en [QA «T5»](QA.md). En T5 nada tocó Mercado Pago real: todo corrió contra el MP falso.

**Progresión:** `MP_CONNECT_MODE=off` en el deploy (nada cambia para el usuario: se esconden «Cobros», «Mi Mercado Pago» y
«Cobros online») → consola de MP → **sandbox** S1-S11 en local por túnel → `live` + redeploy → un pago real de $ 1 y su
reintegro desde MP. En local, para QA: `npm run dev:mpfake` (MP falso, nunca lee `.env*`).

**Variables (Vercel → Production; Preview con valores propios o sin setear):**

| Variable | Valor | Cuándo / cómo |
|---|---|---|
| `SECRET_BOX_KEYS` | `k1:<base64 de 32 bytes>` | **Antes del deploy.** Generarla en tu terminal: `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`. Guardarla en el gestor de contraseñas (perderla = todas las cuentas reconectan). **Distinta** para Production y Preview. Para rotar: sumar `k2:<nueva>,k1:<vieja>` → redeploy → `scripts/secret-box-rotate.ts` (dry-run → `--apply`, lo corrés vos) → sacar `k1` |
| `MP_CONNECT_MODE` | `off` → `sandbox` → `live` | **`off` en el primer deploy.** `fake` en Vercel frena el boot (y el getter cae a `off`). `sandbox`/`live` en Production exigen `MP_OAUTH_CLIENT_ID/SECRET`, `SECRET_BOX_KEYS` y, con firma `required`, `MP_CONNECT_WEBHOOK_SECRET`; si falta una, el boot falla. Un typo también |
| `MP_CONNECT_WEBHOOK_SIGNATURE` | `required` | **Antes del deploy.** Pasar a `fetch-only` **solo** si el sandbox demuestra (S3) que los avisos de pagos cobrados con el token del vendedor no llegan firmados con el secreto de nuestra app. Con `required`, MP reintenta por días: no se pierde nada mientras se decide |
| `MP_OAUTH_CLIENT_ID` / `MP_OAUTH_CLIENT_SECRET` | de la app de MP | Al crear la app (abajo). Primero las de la app de **prueba** (sandbox), después las de producción |
| `MP_CONNECT_WEBHOOK_SECRET` | secreto de «Webhooks» de la app | De la sección Webhooks de la app de MP (abajo). No es `MP_WEBHOOK_SECRET` (ese es del checkout legado y queda como está) |
| `TURNERO_CHECKOUT` | sin setear | Ya no la lee nadie (§0.8) |

**Consola de Mercado Pago** (Tus integraciones → Crear aplicación; gratis):

| Qué | Cómo |
|---|---|
| App con OAuth | Tipo «Pagos online», con **OAuth** activado, **PKCE** (S256) activado y el scope `offline_access` (refresh token de 180 días). Términos para profesionales: la plataforma no retiene fondos ni cobra comisión (TP-D11) |
| Redirect URIs (exactas) | `https://<dominio de prod>/api/mp/oauth/callback`; la de staging/Preview si hay una URL fija (`https://<staging>/api/mp/oauth/callback`); y una URL de túnel **reservada** para el sandbox local (`https://<túnel>/api/mp/oauth/callback`). Tiene que coincidir carácter por carácter con `APP_URL` + `/api/mp/oauth/callback` |
| Webhooks | Evento **«Pagos»**, URL `https://<dominio>/api/webhooks/mercadopago` (la `notification_url` de cada preferencia agrega `?acct=…` y tiene prioridad). Generar el **secreto** → `MP_CONNECT_WEBHOOK_SECRET` |
| Usuarios de prueba | Crear **3**: 2 vendedores (para probar dos profesionales y la cuenta del consultorio) y 1 comprador. Guardar usuario y contraseña en el gestor de contraseñas |

**Sandbox S1-S11** (lo corrés vos, en local, con `MP_CONNECT_MODE=sandbox`, la app de prueba y un túnel; nunca un
agente): `scripts/diagnose-mp-connect.ts` verifica los supuestos que el MP falso hace sobre MP real. Sin flags corre
contra el fake (lo mismo que CI: `npm run diagnose:mp-connect`). Imprime ✓/✗, nunca tokens.

1. `MP_CONNECT_MODE=sandbox … npx tsx --conditions=react-server scripts/diagnose-mp-connect.ts --sandbox` → imprime la URL
   de autorización [S1]; autorizar con el vendedor de prueba 1.
2. `… --sandbox --code <code de la vuelta> --verifier-file <archivo del paso 1>` → S2, S4, S6, S8, S9.
3. Pagar la preferencia de [S6] con el comprador de prueba y mirar el log del webhook → S3, S5, S10, S11 (manuales).

| Supuesto | Qué verifica | Qué decide |
|---|---|---|
| S1 | La autorización exige PKCE S256 y la `redirect_uri` exacta, y vuelve con `code` + `state` | — |
| S2 | El canje da access + refresh + `user_id` + `expires_in`; el código es de un uso | — |
| S3 | El aviso de un pago cobrado con el token del vendedor llega firmado con el secreto de **nuestra** app | `MP_CONNECT_WEBHOOK_SIGNATURE` (`required` / `fetch-only`) |
| S4 | `/users/me` con el token del vendedor da su nickname; token inválido → 401 | — |
| S5 | MP notifica la `notification_url` de la preferencia (con `?acct=`) con `data.id` y `type=payment` | Si MP también notifica la URL del panel sin `acct`: pre-despacho por `user_id` (aditivo) |
| S6 | Crear preferencia con el token del vendedor da `id` + `init_point`; `expires`/`expiration_date_to` se respetan | — |
| S7 | `GET /v1/payments/:id` con el token de **otro** vendedor no devuelve el pago | — |
| S8 | El refresh es rotativo: el refresh usado deja de servir (`invalid_grant`) | — |
| S9 | `PUT /checkout/preferences/:id` con `expires` en el pasado vence la preferencia | — |
| S10 | El pago trae `collector_id` del vendedor, `external_reference` `oc:<id>`, ARS y el monto | — |
| S11 | Un reintegro deja el pago `refunded` con `transaction_amount_refunded` | — |

**Pasar a `live`:** credenciales de producción de la app → `MP_CONNECT_MODE=live` → redeploy → conectar tu cuenta real
desde «Mi Mercado Pago» → un turno o link de $ 1 → pagar → ver «Pagado por Mercado Pago» → reintegrarlo **desde Mercado
Pago** → ver «Reintegrado». Plataforma → Sistema → «Cobros online (Mercado Pago)» muestra modo, presencias, huellas de
las claves, firma, cuentas por estado, último webhook y última renovación.

### 0.13 T6 — Avisos por WhatsApp (Meta, 23-oct-2026) 🔴

**Con migración M15** (`whatsapp_messaging`, [RUNBOOK «M15 en prod»](MIGRACIONES-RUNBOOK.md)). Diseño en
[ARCHITECTURE ADR-029](ARCHITECTURE.md). Cada consultorio conecta **su propio número** por Embedded Signup y paga sus
conversaciones a Meta; KineSoft es el **Tech Provider**. En T6 nada tocó Meta real: todo corrió contra el Meta falso
(`npm run dev:local`). Reemplaza al viejo §13 (Twilio / 360dialog, descartados).

**Progresión:** `WHATSAPP_MODE=off` en el deploy (no se encola nada, no hay queries extra en los write paths de turnos y
no sale ningún request a Meta) → verificación del negocio → app de Meta → **sandbox** S1-S13 → `live` + redeploy.
`fake` en Vercel frena el boot; `live` en Preview se lee como `off` (D26: un «copiar de Production» no manda WhatsApps).

1. **Verificación del negocio en Meta Business Manager, desde el día 1.** Es lo que más tarda (días a semanas) y sin ella
   no hay Tech Provider ni números reales. Datos fiscales de KineSoft, dominio verificado y sitio con política de
   privacidad y condiciones.
2. **App aparte** en developers.facebook.com, de tipo **Empresa** (Business), **separada de la de Facebook Login** (§0.6):
   mezclarlas pide revisiones cruzadas y un problema en una frena la otra. Producto **WhatsApp** agregado.
3. **Tech Provider:** desde la app, solicitar el acceso de Tech Provider (proveedor de tecnología) y los permisos
   `whatsapp_business_management` y `whatsapp_business_messaging` (revisión de la app con video del alta y del envío).
4. **Embedded Signup v4:** Facebook Login for Business → Configuraciones → nueva configuración «WhatsApp Embedded Signup»
   (variante v4) → su id va en `WHATSAPP_CONFIG_ID`. Dominio permitido = el de prod (y el túnel para el sandbox). El
   `code` del popup vive **30 s** y se canjea una vez (S1). Coexistencia con la app WhatsApp Business del celular
   (`WHATSAPP_SIGNUP_FEATURE=whatsapp_business_app_onboarding`) **recién después del sandbox** (WA-D30).
5. **Webhook:** WhatsApp → Configuración → URL `https://<dominio>/api/webhooks/whatsapp` (GET verifica, POST recibe),
   token de verificación = `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (**≥ 32 caracteres**: `openssl rand -hex 32`; el boot rechaza
   uno más corto). Suscribir los campos `messages`, `message_template_status_update`, `account_update` y
   `phone_number_quality_update`. Meta firma cada POST con el **App Secret** (`X-Hub-Signature-256`, S9).
6. **Plantillas:** las da de alta la app por cada cuenta conectada (es_AR, UTILITY, con el pie «Respondé BAJA para no
   recibir más avisos.»): `cs_turno_agendado_v1`, `cs_turno_reprogramado_v1`, `cs_turnos_actualizados_v1`,
   `cs_recordatorio_turno_v1` (botones «Confirmo» / «No puedo ir») y `cs_documento_v1` (header DOCUMENT). La prueba usa
   `hello_world`. Meta las aprueba una por una (estado en Configuración → WhatsApp).
7. **Medio de pago por consultorio, en Meta:** cada consultorio carga su tarjeta en su WhatsApp Manager (la app lo muestra
   como checklist en Configuración → WhatsApp). Sin medio de pago, Meta devuelve 131042 y el aviso queda fallido con el
   motivo; la campana avisa al Titular.
8. **Variables (Vercel → Production):**

   | Variable | Valor | Nota |
   |---|---|---|
   | `WHATSAPP_MODE` | `off` → `sandbox` → `live` | `sandbox`/`live` en Production exigen las 4 de abajo + `SECRET_BOX_KEYS` (si falta una, el boot falla) |
   | `WHATSAPP_APP_ID` / `WHATSAPP_APP_SECRET` | de la app de Meta (Configuración básica) | server-only; el secret firma el webhook |
   | `WHATSAPP_CONFIG_ID` | id de la configuración de Embedded Signup | no es secreto (viaja al browser en el alta) |
   | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `openssl rand -hex 32` | ≥ 32 en cualquier entorno |
   | `WHATSAPP_GRAPH_VERSION` | sin setear (= `v23.0`) | se sube a mano, probando el sandbox antes |
   | `WHATSAPP_SIGNUP_FEATURE` | sin setear | coexistencia, después del sandbox |

   El token de cada consultorio no va en variables: queda sellado en `WhatsAppCredential` con `SECRET_BOX_KEYS`
   (propósito `wa-credential`; se rota con `scripts/secret-box-rotate.ts --store=wa|all`).
9. **Cron:** el segundo cron de `vercel.json`, `/api/cron/whatsapp` a las `0 21 * * *` (18:00 AR; en Hobby dispara dentro
   de esa hora), manda los recordatorios del día siguiente y re-drena la cola. Usa el mismo `CRON_SECRET`.
10. **Sandbox S1-S13** (lo corrés vos, en local, con la app de prueba de Meta, un número de prueba y un túnel apuntando a
    `/api/webhooks/whatsapp`; nunca un agente). Sin flags corre contra el simulador (lo mismo que CI:
    `npm run diagnose:whatsapp`). Con el sandbox:

    ```bash
    WHATSAPP_MODE=sandbox WHATSAPP_APP_ID=… WHATSAPP_APP_SECRET=… NEXT_PUBLIC_APP_URL=https://<túnel> \
      npx tsx --conditions=react-server scripts/diagnose-whatsapp.ts --sandbox \
        --code <code del popup, < 30 s> --waba <waba_id> --phone-number-id <id> --pin <6 dígitos> --to <+549…>
    ```

    S1-S7 y S12 son automáticos; S8-S11 y S13 se miran en el log del webhook (el script lo explica al final). Imprime
    ✓/✗, nunca tokens, PINs ni teléfonos completos. Lo que verifica: canje del `code` (S1), `debug_token` con los dos
    `granular_scopes` (S2), teléfonos (S3), `subscribed_apps` (S4), `register` con PIN (S5), plantilla PENDING → webhook
    (S6), `wamid` y estados (S7), botón con nuestro payload y `context.id` (S8), firma (S9), GET de verificación (S10),
    PDF por media (S11), formas de error 131026/131042/130429/190 (S12) y PARTNER_REMOVED (S13).
11. **Pasar a `live`:** app aprobada + Tech Provider → `WHATSAPP_MODE=live` → redeploy → conectar el número del cliente
    vivo desde Configuración → WhatsApp → prueba con `hello_world` → un turno real de prueba.

### 0.14 T6 — Suscripción con Mercado Pago (MPS, 23-oct-2026) 🔴

**Con migración M16** (`saas_mp_subscriptions`, [RUNBOOK «M16 en prod»](MIGRACIONES-RUNBOOK.md)). Diseño en
[ARCHITECTURE ADR-027](ARCHITECTURE.md). Cobro el **día 4** (MPS-D7) por débito automático (preapproval), «Pagar con
Mercado Pago» por cargo, o transferencia con comprobante. Usa la cuenta de Mercado Pago **de la plataforma**
(`MP_ACCESS_TOKEN`), no la de los vendedores de §0.12.

**Progresión:** `SAAS_BILLING_MODE=off` en el deploy → `saas-reanchor` (PUSH-DIA F1) → **`manual`** (precios en
/plataforma + `SAAS_BILLING_TRANSFER_INFO` + bucket `billing-receipts`, §0.6) → **sandbox S1-S10** → **`mp`** + redeploy.
`mp` = todo lo de `manual` **más** débito y checkout; en Production exige `MP_ACCESS_TOKEN` (y por eso
`MP_WEBHOOK_SECRET`).

| Qué | Cómo |
|---|---|
| Webhooks de la app de la plataforma | Tus integraciones → la app de `MP_ACCESS_TOKEN` → Webhooks: eventos **«Pagos»** y **«Planes y suscripciones»**, URL `https://<dominio>/api/webhooks/mercadopago` (sin `?scope=`; el checkout de cada cargo agrega `?scope=saas`). Firma con **`MP_WEBHOOK_SECRET`** (S3), no con el secreto de la app de OAuth |
| Usuarios de prueba | Un **vendedor** de prueba AR (su token hace de `MP_ACCESS_TOKEN` en el sandbox) y un **comprador** de prueba AR (autoriza el débito con la tarjeta de prueba) |
| `MP_MIN_DEBIT_CENTS` | Sin setear = 1500 ($ 15, el mínimo de MP). Entero en centavos; un valor roto frena el deploy |
| `SAAS_MP_CHECKOUT_NOTIFY` | Sin setear = `scope` (`notification_url …?scope=saas`). `panel` solo si el sandbox muestra que la URL por preferencia no llega firmada |

**Sandbox S1-S10** (lo corrés vos, con el webhook de la app apuntando a un túnel; nunca un agente). Sin flags corre
contra el simulador (`npm run diagnose:mp-subscriptions`, lo mismo que CI):

```bash
SAAS_BILLING_MODE=mp MP_CONNECT_MODE=off MP_ACCESS_TOKEN=<token del vendedor de prueba> \
NEXT_PUBLIC_APP_URL=https://<túnel> \
  npx tsx --conditions=react-server scripts/diagnose-mp-subscriptions.ts --sandbox --test-user-token \
    --payer-email <comprador de prueba>
# → S1 e imprime el init_point: autorizá con el comprador y la tarjeta de prueba. Después:
#   … --sandbox --test-user-token --preapproval <id>            → S2, S5, S6
#   … --sandbox --test-user-token --preapproval <id> --cancel   → S8 (cancela de verdad: al final)
# S3, S4, S7, S9 y S10 se miran en el log del webhook.
```

S1 preapproval `pending` sin tarjeta · S2 autorización en la página de MP · S3 aviso firmado con `MP_WEBHOOK_SECRET` ·
S4 primer débito (`subscription_authorized_payment`) · S5 cambio de monto y mínimo · S6 pausa/reanuda · S7 rechazo,
reintento y reintegro · S8 `cancelled` terminal · S9 link de pago de un cargo (`binary_mode`, 72 h, `?scope=saas`) ·
S10 rechazado (nunca `pending`) y preferencia vencida.

**Pasar a `mp`:** token de producción de la plataforma en `MP_ACCESS_TOKEN` → `SAAS_BILLING_MODE=mp` → redeploy → el
cliente vivo elige el método en Configuración → Facturación. Plataforma → Facturación del consultorio muestra el
estado de la suscripción en MP, el débito permitido, los ajustes y el re-anclaje.

### 0.15 T7 — TV de la sala en modo kiosco (23-oct-2026) 🟡

**Con migración M17** (`reception_displays`, [RUNBOOK «M17 en prod»](MIGRACIONES-RUNBOOK.md)). Diseño en
[ARCHITECTURE ADR-028](ARCHITECTURE.md). Sin consola externa: lo arma el consultorio. El riesgo es el navegador de cada
Smart TV: el **spike en una TV real** va al QA después del push (PUSH-DIA G8).

1. **Hardware recomendado:** un **Chromecast con Google TV** o un **Fire TV Stick** con Chrome/Silk, o una mini PC con
   Chrome. El navegador propio de las Smart TV (Tizen, webOS) es el riesgo: probarlo antes de recomendarlo.
2. **Chrome en kiosco** (mini PC o notebook conectada a la TV):

   ```bash
   google-chrome --kiosk --autoplay-policy=no-user-gesture-required https://<dominio>/tv
   ```

   (En macOS: `open -a "Google Chrome" --args --kiosk --autoplay-policy=no-user-gesture-required https://<dominio>/tv`.)
   El flag evita que Chrome frene el video por la política de autoplay. Igual, la TV arranca en silencio y muestra
   «Tocá OK para activar el sonido»: la primera tecla del control (o un toque) activa el sonido y el aviso de llamado y
   pide pantalla completa. Mantiene la pantalla encendida (wake lock) y se recarga sola a las 04:00 AR.
3. **Vincular:** en la app, **/sala → Pantallas** (solo quien opera toda la agenda, nunca en soporte) → «Agregar
   pantalla» → aparece un código de 8 caracteres, **una sola vez**, que vence a los **10 min**. En la TV, `/tv` muestra
   «Vinculá esta pantalla»: se tipea el código. Tope: 10 pantallas por consultorio. Desvincular desde el mismo drawer.
4. **Video de YouTube** (opcional, por pantalla): link de un video, vivo, lista o canal en vivo; se reproduce con
   `youtube-nocookie`. La TV no muestra datos de salud: solo el nombre corto o la hora del turno.
5. **Derechos de exhibición:** pasar música o video en una sala de espera es comunicación pública. Los derechos (SADAIC
   / AADI-CAPIF si hay música) son **del consultorio**; la app lo avisa en el formulario de la pantalla.

### <a id="marca-pv"></a>0.16 PV — Marca «Consultorio Online», legales y mails obligatorios (27-oct-2026) 🔴

**Con migración M19** (`support_tickets`, [RUNBOOK «M19 en prod»](MIGRACIONES-RUNBOOK.md)), que no pide consola. Plan
§27.6; orden del día en [PUSH-DIA](PUSH-DIA.md) B y B2. El código ya dice «Consultorio Online» (`lib/brand.ts:10`);
lo que queda son las consolas, que muestran el nombre que tengan cargado:

1. **Vercel Production: `RESEND_API_KEY` + `EMAIL_FROM` obligatorias** (HD-6, `lib/env.ts:69`): sin ellas el build de
   Production falla. `EMAIL_FROM` = `Consultorio Online <no-reply@mail.<dominio>>`; los mails de un consultorio salen
   como «<Consultorio> vía Consultorio Online» con la misma casilla (`lib/email/transport.ts`, `FROM_NAME_SUFFIX`). El
   dominio verificado en Resend sigue en §0.4 / §0.9.
2. **Google OAuth** (Google Cloud → OAuth consent screen): nombre de la app «Consultorio Online», logo (Sello C,
   `app/icon.svg`), dominio autorizado y los links **Política de privacidad** = `https://<dominio>/privacidad`
   y **Términos** = `https://<dominio>/terminos` (Google los pide para publicar la pantalla de consentimiento).
3. **Mercado Pago:** nombre visible de la app de MP Connect (§0.12) y de la cuenta de la plataforma. El
   `statement_descriptor` de los cobros de la plataforma (suscripción y checkout legado) ahora es **«Consultorio
   Online»** (ASCII, ≤ 22: `lib/mercadopago-saas.ts:417`, `lib/mercadopago.ts:78`). Los cobros online de un consultorio
   siguen con el nombre del consultorio (`lib/mp-connect/preference.ts:14`).
4. **Meta:** nombre de la app de Login (Facebook, §0.6) y de la de WhatsApp / Tech Provider (§0.13). Las plantillas de
   WhatsApp **no** se renombran (`[BR-9]`): ya aprobadas, cambiarles el nombre es volver a mandarlas.
5. **2FA:** las apps de autenticación ya enroladas siguen mostrando «KineSoft» (el issuer quedó en el alta); los códigos
   funcionan. Las nuevas salen como «Consultorio Online» (`lib/two-factor.ts:190`).
6. **Legales:** completar `LEGAL_ENTITY` (`lib/legal.ts:27`: razón social, CUIT, domicilio; en `null` la línea no se
   muestra) y la revisión del abogado (transferencias internacionales, registro de la base en la AAIP, consumo,
   retención). Versión vigente `LEGAL_VERSION="2026-10-31"` (`lib/legal.ts:12`): cambiar el texto de fondo = subir la
   versión (las cuentas existentes no reciben el pedido de volver a aceptar; decisión de PV, ver AUDIT «Ronda PV»).
7. **Identificadores que NO cambian** (`tests/unit/br-brand.test.tsx:213`): cookies `kine_*`/`ks_*`, claves
   `kinesoft:*` (locks, HMAC, secret-box), roles `kinesoft_*`, envs `KINESOFT_*`, dominio `kinesoft.app`, plantillas de
   WhatsApp y migraciones. No hay nada que renombrar en Supabase ni en Vercel.

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
     confirmarlo). Debe ser privado; el acceso es solo por signed URL (`getDownloadUrl`, 10 min). Desde T4,
     con límite de 25 MB, y dos buckets privados más: `patient-documents` y `practice-assets` (§0.11).
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
- **Estado:** 🟢 prendido en prod desde el 16-oct (V1-V7 11/11). Desde HF-1a (18-oct) es la **agenda en vivo de todos
  los planes** (no solo Sala de Espera) y `/plataforma/sistema` muestra la huella del secreto y «Probar desde el
  servidor» (§0.8).
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
  1. **Checkout de turnos (legado):** `MP_WEBHOOK_SECRET` verificado en Vercel (la ruta da 503 sin él).
     Legado: era con la cuenta de la plataforma y desde T5 no lo usa nadie (`TURNERO_CHECKOUT` sin setear). El webhook
     sigue igual (AUDIT §5.4).
  1b. **Cobros online con la cuenta del vendedor (T5, ADR-026):** app de MP con OAuth + PKCE, webhook «Pagos» con
     secreto, usuarios de prueba, sandbox S1-S11 y progresión off → sandbox → live: **§0.12**.
  2. **Suscripción:** transferencia con comprobante (PL-2b, §0.6, ADR-016) y, desde T6, débito automático y «Pagar con
     Mercado Pago» con la cuenta de la plataforma (MPS, cobro el día 4, MPS-D7, ADR-027): webhooks «Pagos» + «Planes y
     suscripciones», sandbox S1-S10 y `off → manual → mp` en **§0.14**.
- **Bloquea:** checkout de turnos (corte E1 #2). Ya no bloquea el cobro del plan: es manual (PL-2b, §0.6; la Ola 2.4 quedó superada por PL).
- **Responsable:** dueño.
- **Estado:** 🔴 cobros online (T5) en código y probados con el MP falso; app de MP, sandbox y `live` pendientes (§0.12).
- **Gate de activación:** cobros online: `MP_CONNECT_MODE` + `SECRET_BOX_KEYS` + `MP_OAUTH_CLIENT_ID/SECRET` + `MP_CONNECT_WEBHOOK_SECRET` (§0.12). Legado: `MP_WEBHOOK_SECRET`.

### 7. Email transaccional
- **Qué configura:** Resend con dominio propio (subdominio `mail.<dominio>`, SPF/DKIM/DMARC) para invitaciones,
  verificación de signup, recuperación de contraseña, reset por admin y portal. La app lo llama por `fetch`
  (`lib/email/resend.ts`); Supabase no manda nada. Detalle en **§0.4**.
- **Bloquea:** el build de Production. Desde HD-6 (PV) `RESEND_API_KEY` y `EMAIL_FROM` son obligatorias con
  `VERCEL_ENV=production` (§0.16): sin ellas el build falla. Con las dos pero el dominio sin verificar, Resend rechaza y
  la UI de invitaciones ofrece copiar el link.
- **Responsable:** dueño.
- **Estado:** 🔴 (dominio + Resend pendientes; las variables, antes del push).
- **Gate de activación:** `RESEND_API_KEY` + `EMAIL_FROM` en Vercel (Production) con el dominio verificado.
- **Si Resend rechaza:** `scripts/diagnose-email.ts --from-name "" --expect-domain <dominio>` y la tarjeta «Últimos
  mails que no salieron» de `/plataforma/sistema` (**§0.9**).

### 8. Identidad / OAuth
- **Qué configura:** proveedores OAuth. **Google** y **Facebook** están en el **código** (PL-2e,
  `POST /api/auth/oauth/{google|facebook}`, botones del login y del signup); a los dos les falta la **consola**:
  - Google: Google Cloud → credenciales OAuth (cliente web) con la redirect URI `https://<ref>.supabase.co/auth/v1/callback`
    → Supabase de prod → Authentication → Providers → **Google** (Client ID y Secret). Depende de la Site URL y de
    `/auth/callback**` en Redirect URLs (§0.4). Verificar: `GET https://<ref>.supabase.co/auth/v1/settings` →
    `"google": true`. Se prueba de verdad recién después del push (PUSH-DIA G4).
  - Facebook: app de Meta para Login (**no** la de WhatsApp, §0.13) + provider en Supabase (§0.6).
  - **Apple** requiere cuenta de Apple Developer (paga).
- **Bloquea:** nada del push: sin provider, el botón termina en «Ese método de ingreso no está disponible por ahora».
- **Responsable:** dueño.
- **Estado:** 🟡 Google (código listo, provider de prod pendiente) · 🟡 Facebook (código listo, consola pendiente) ·
  🔴 Apple. (Antes decía «🟢 Google»: era el código, no la consola; contradecía al ROADMAP, que lo tiene pendiente.)
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
- **Estado:** 🟡 desde PV (27-oct): `/terminos` y `/privacidad` publicadas (`app/(legal)/`, textos AAIP Disp. 10/2008,
  subencargados) con casilla obligatoria en el alta, el onboarding, las invitaciones y el alta asistida
  (ARCHITECTURE ADR-030/031 «Legales»). Falta `LEGAL_ENTITY` y la revisión del abogado (§0.16).
- **Gate de activación:** revisión legal completada.

### 12. Marca — bucket E
- **Qué configura:** dominio de marca, favicons, `manifest`/PWA, assets. La landing se trabaja aparte.
- **Bloquea:** corte E2 (sin datos fabricados / assets en su lugar).
- **Responsable:** dueño / diseño.
- **Estado:** 🟡 desde PV: marca «Consultorio Online» con logo Sello C, íconos, OG y manifest en código
  (`lib/brand.ts`, `app/icon.svg`, `app/apple-icon.tsx`, `app/opengraph-image.tsx`, `app/manifest.ts`). Faltan las consolas (§0.16) y el dominio de marca.
- **Gate de activación:** assets entregados.

### 13. Mensajería — WhatsApp Business (Cloud API de Meta)
- **Qué configura:** avisos automáticos por WhatsApp (turno agendado/reprogramado, recordatorio con «Confirmo» / «No
  puedo ir», compartir ficha) con el número **de cada consultorio**, por Embedded Signup v4 y la Cloud API de Meta, con
  KineSoft como Tech Provider. **Se descartaron Twilio y 360dialog** (T6, ADR-029): sin intermediario, el consultorio paga
  sus conversaciones a Meta. El link `wa.me` de «Compartir turno» sigue igual y no necesita nada.
- **Bloquea:** solo los avisos automáticos. El código está completo y probado con el Meta falso.
- **Responsable:** dueño (verificación del negocio, app, Tech Provider, sandbox) + cada consultorio (su número y su
  medio de pago en Meta).
- **Estado:** 🔴 consola de Meta pendiente; código listo (`WHATSAPP_MODE=off`).
- **Gate de activación:** `WHATSAPP_MODE` + `WHATSAPP_APP_ID/SECRET` + `WHATSAPP_CONFIG_ID` +
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN` + `SECRET_BOX_KEYS`. Paso a paso en **§0.13**.
