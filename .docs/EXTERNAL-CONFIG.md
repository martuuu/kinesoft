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
  1. **Rol de conexión sin BYPASSRLS** (crítico para la Ola 2.2): hoy la app usa `postgres.<ref>`
     que tiene BYPASSRLS → RLS nunca se evalúa. Crear un rol de login dedicado sin SUPERUSER/
     BYPASSRLS, GRANT DML, y cambiar `DATABASE_URL` a ese rol. Verificar con `pg_roles`.
  2. **Bucket `patient-files` PRIVADO** — verificación bloqueante del corte E1 (el auditor no pudo
     confirmarlo). Debe ser privado; el acceso es solo por signed URL (`getDownloadUrl`, 10 min).
  3. **Password policy** de Supabase Auth (complejidad) alineada con `password-policy`.
  4. Límites del SMTP default (mientras no haya email propio).
- **Bloquea:** Ola 2.2 (RLS real), corte E1 #14, `password-policy`.
- **Responsable:** dueño (rol/bucket/policy) + ejecutor técnico (cambio de connection string).
- **Estado:** 🟡 (DB productiva activa; rol y verificación de bucket pendientes).
- **Gate de activación:** rol nuevo en `DATABASE_URL` (Ola 2.2); `patient-files` privado.

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
