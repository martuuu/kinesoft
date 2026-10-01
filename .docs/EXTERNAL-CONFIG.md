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

El código de A3 está completo (A3a, A3b y A3c; Bloque A cerrado el 30-sep). **A3 no se despliega sin estos puntos**: sin SMTP propio los
mails de verificación del signup no llegan a externos y nadie puede darse de alta. Orden sugerido: 1 → 2 → 3 →
4 en **staging**, QA con un email real, y después lo mismo en prod.

1. **SMTP propio** (Resend o Postmark):
   - dominio verificado con **SPF, DKIM y DMARC** (registros DNS en el dominio, §2);
   - Supabase → Authentication → **SMTP Settings → Custom SMTP** con esas credenciales (prod y staging, cada uno
     con el suyo).
2. **Plantillas de email en es-AR** (Supabase → Authentication → Email Templates). Todos los links van a
   `/auth/confirm` con el `token_hash` (no al link por defecto de Supabase, que usa PKCE y falla si el mail se
   abre en otro dispositivo). Texto exacto del link:

   | Plantilla | Link |
   |---|---|
   | **Confirm signup** | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}` |
   | **Reset password** | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset` |
   | Invite user / Magic link | mismo formato con `type=invite` / `type=magiclink` y `next={{ .RedirectTo }}` |

   - Confirm signup usa `type=email` (el tipo vigente de `verifyOtp`); `/auth/confirm` acepta también `signup`
     por compatibilidad (`app/auth/confirm/route.ts:36`), pero la plantilla va con `email`.
   - `{{ .RedirectTo }}` es el `emailRedirectTo` que manda el signup: `/onboarding` en un alta normal y
     `/invite/<token>` en la unión por invitación. `/auth/confirm` lo reduce a path con `safeNextFromUrl`.
   - En `recovery` la ruta deja la cookie firmada `ks_recovery` (15 min, un solo uso): con ella `/reset` no pide
     la contraseña actual.
   - El código manda como `emailRedirectTo`/`redirectTo` el **destino final** (`<APP_URL>/onboarding`,
     `<APP_URL>/invite/<token>`, `<APP_URL>/reset`): esas URLs tienen que estar en Redirect URLs (punto 3).
3. **URL Configuration** (Supabase → Authentication): Site URL = el dominio de prod (en staging, el de staging) y
   **Redirect URLs**: `<APP_URL>/auth/confirm**`, `<APP_URL>/auth/callback`, `<APP_URL>/invite/**`,
   `<APP_URL>/onboarding`, `<APP_URL>/reset` y `<APP_URL>/portal/**`. Si un `emailRedirectTo` / `redirectTo` no está en la lista,
   Supabase lo reemplaza por la Site URL sin avisar.
4. **"Confirm email" ON** (Authentication → Providers → Email). Junto con el signup de A3c es lo que cierra H5:
   sin esto `auth.signUp` devuelve sesión con el email sin verificar (el código lo detecta y loguea
   `signup.confirm_email_disabled`, pero la cuenta ya quedó creada sin verificar).
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
  6. **Custom SMTP propio** (§0.1 y §7): el SMTP default de Supabase no entrega a externos; es
     bloqueante de A3.
- **Bloquea:** RLS real en prod (residual de la Ola 2.2 / Ronda 4), escritura del catálogo global
  desde Plataforma, subida de media de ejercicios, corte E1 #14, `password-policy`.
- **Responsable:** dueño (roles/buckets/policy) + ejecutor técnico (cambio de connection strings).
- **Estado:** 🟡 (DB productiva activa; roles, `DATABASE_URL_SERVICE`, bucket `exercise-media` y
  verificación de `patient-files` pendientes).
- **Gate de activación:** `DATABASE_URL` → `kinesoft_app`; `DATABASE_URL_SERVICE` → `kinesoft_service`;
  buckets `patient-files` y `exercise-media` creados y privados.

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
  2. **Preapproval / suscripción (Ola 2.4):** habilitar pago recurrente para el billing SaaS al
     consultorio (integración separada del checkout de turnos).
- **Bloquea:** corte E1 #2; Ola 2.4 (billing SaaS).
- **Responsable:** dueño.
- **Estado:** 🟡 (checkout de turnos funcional; secret/credenciales prod y sandbox por verificar).
- **Gate de activación:** `MP_WEBHOOK_SECRET` + credenciales prod; sandbox para QA.

### 7. Email transaccional
- **Qué configura:** proveedor de email transaccional propio (Resend o Postmark) para verificación de
  signup, invitaciones, reset de password y portal, con dominio verificado (SPF/DKIM/DMARC) y cargado como
  Custom SMTP en Supabase Auth. Detalle y plantillas en §0.1.
- **Bloquea:** **despliegue de A3** (signup verificado + stepper, decisión del dueño del 30-sep-2026): con el
  SMTP default de Supabase los mails no llegan a externos.
- **Responsable:** dueño.
- **Estado:** 🔴 (usando SMTP default de Supabase).
- **Gate de activación:** dominio verificado + credenciales SMTP propias.

### 8. Identidad / OAuth
- **Qué configura:** proveedores OAuth adicionales. **Google** ya está cableado. **Apple** requiere
  cuenta de Apple Developer (paga). **Meta/Facebook** requiere app + review.
- **Bloquea:** sesión `oauth-extra` (Ola 2.6) — opcional.
- **Responsable:** dueño.
- **Estado:** 🟢 Google · 🔴 Apple/Meta.
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
  con un link **`wa.me`** (`components/agenda/booking-drawer.tsx`) + recordatorio imprimible/PDF
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
