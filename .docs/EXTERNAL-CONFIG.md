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
  6. Límites del SMTP default (mientras no haya email propio).
- **Bloquea:** RLS real en prod (residual de la Ola 2.2 / Ronda 4), escritura del catálogo global
  desde Plataforma, subida de media de ejercicios, corte E1 #14, `password-policy`.
- **Responsable:** dueño (roles/buckets/policy) + ejecutor técnico (cambio de connection strings).
- **Estado:** 🟡 (DB productiva activa; roles, `DATABASE_URL_SERVICE`, bucket `exercise-media` y
  verificación de `patient-files` pendientes).
- **Gate de activación:** `DATABASE_URL` → `kinesoft_app`; `DATABASE_URL_SERVICE` → `kinesoft_service`;
  buckets `patient-files` y `exercise-media` creados y privados.

### 4. Rate-limiting gestionado — Upstash Redis
- **Qué configura:** crear una DB Redis en Upstash y setear `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` en Vercel prod. El código ya rutea a Upstash cuando están; sin ellas
  cae a memoria per-lambda (inútil en serverless).
- **Bloquea:** corte E1 #1 (rate-limit real en superficies públicas). Findings `c1-ratelimit-inmemory`,
  `rate-limit-inmemory-activo-prod`.
- **Responsable:** dueño.
- **Estado:** 🔴
- **Gate de activación:** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` presentes.
- **No tocar:** el fallback a `memory()` ante error de transporte debe preservarse.

### 5. Monitoreo de errores — Sentry
- **Qué configura:** cuenta Sentry + DSN de prod. La sesión `sentry-observabilidad` deja el SDK
  cableado en modo no-op; el DSN lo activa.
- **Bloquea:** corte E1 #8. Findings `m1-sentry-no-wired`, `sentry-no-cableado`.
- **Responsable:** dueño.
- **Estado:** 🔴
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
- **Qué configura:** proveedor de email transaccional propio (invitaciones, reset de password,
  confirmaciones de turno) con verificación de dominio (SPF/DKIM). Mientras tanto se usa el SMTP
  default de Supabase (suficiente para el cliente único).
- **Bloquea:** corte E2 (signup self-serve abierto). Sesión `onboarding-pulido`.
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
  historia clínica en Argentina (**Ley 26.529** — retención/derechos del paciente). Afecta el
  "eliminar definitivamente" de pacientes y la retención de HC.
- **Bloquea:** corte E2 (signup público). Mitigado en E1 por el gate de rol + type-to-confirm.
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
