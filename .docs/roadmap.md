# KineSoft — Roadmap

> **Qué es este documento.** El camino completo de KineSoft dividido en **sesiones** ejecutables.
> Cada sesión es un tema acotado con ownership de archivos disjunto, pensada para dejar 2-3 agentes
> trabajando en paralelo mientras el dueño hace QA. Se apoya en la auditoría ([AUDIT.md](AUDIT.md)),
> la configuración externa ([EXTERNAL-CONFIG.md](EXTERNAL-CONFIG.md)) y el estándar de testing
> ([TESTING.md](TESTING.md)), siguiendo el proceso E3-E5 del
> [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md).
>
> **Las 3 etapas de producto:**
> 1. **Etapa 1 — MVP pre-producción.** Cerrar bugs QA de agenda + hardening crítico. Cliente único.
> 2. **Etapa 2 — Producción SaaS.** Multi-profesional completo, billing SaaS, RLS real, tests,
>    portal v2, adjuntos + timeline de HC, soporte/owner panel. Vendible a consultorios.
> 3. **Etapa 3 — Productiva final.** Guía de diagnóstico completa, planes, IA local, módulo
>    contable, features Pro.

## Cómo se pilotea una sesión

- **Un tema por sesión.** Objetivo único, verificable.
- **Ownership disjunto.** Dentro de una **ola**, cada sesión es dueña de un set de archivos que no
  se superpone con las demás → se corren en paralelo. Sesiones que tocan el mismo archivo van
  **seriadas** (misma ola, orden explícito).
- **Gate implícito de toda sesión:** `npx tsc --noEmit` + `npx next build` verdes. QA de timezone
  **siempre con `TZ=UTC`** (Docker o preview de Vercel) para reproducir prod — en dev AR-local los
  bugs de fecha se esconden.
- **Preserve = contrato.** El prompt de cada sesión debe incluir los patrones a preservar de su área
  ([AUDIT.md §5](AUDIT.md)). No "arreglar" lo que es intencional.
- **Migraciones serializan.** El `buildCommand` de Vercel auto-migra (`prisma migrate deploy`): dos
  ramas paralelas con migraciones = conflicto de deploy. Toda sesión con migración encabeza su ola,
  sola.
- **Referencias:** cada sesión lista los **slugs** de [AUDIT.md](AUDIT.md) que cierra.

---

## ETAPA 1 — MVP pre-producción

Objetivo de corte: cerrar los bugs QA de agenda, anclar el dinero, y dejar la red mínima
(CI + boundaries + rate-limit real) para no meter regresiones. Ver **Checklist de corte** al final
de la etapa.

### Ola 1.0 — Fundaciones (3 sesiones en paralelo)

**`ci-gate-minimo`** — CI (typecheck + build) como required check + vitest capa-1 sobre helpers YA
correctos, para congelar la fundación antes de tocar fechas.
- Cierra: `no-ci-triple-gate` (creación), `c2-no-tests-ci` (paso 1), `no-test-suite` (capa 1).
- Own: `.github/workflows/**`, `vitest.config.ts`, `tests/unit/**`, `package.json`.
- Tests capa-1: `lib/datetime-ar.ts`, `lib/format.ts`, `resolveBookingCopagoCents`.
- Gate: CI verde en PR de prueba; branch protection en `main`; `npm test` local pasa.
- Dep: —

**`error-loading-boundaries`** — Boundaries por route-group + 404/403 en español con retry.
- Cierra: `sin-error-loading-boundaries`, `sin-not-found-403-custom`.
- Own: `app/global-error.tsx`, `app/(app|booking|portal)/error.tsx`, `app/not-found.tsx`,
  `app/(app)/{agenda,pacientes,dashboard}/loading.tsx`.
- Gate: QA con throw simulado → pantalla en español + `reset()` funciona.
- Dep: —

**`login-error-feedback`** — Threadear `searchParams.error` a `LoginScreen` + banner.
- Cierra: `login-sin-feedback-error`.
- Own: `app/(auth)/login/page.tsx`, `components/screens/login-screen.tsx`.
- Gate: QA credenciales inválidas → banner; login válido sin banner.
- Dep: —

### Ola 1.1 — Bugs QA de agenda (3 tracks paralelos; serial dentro de cada track)

> Resuelve la colisión de ownership: **un solo track por archivo grande**.

**Track A — dueño de `agenda-client.tsx`:**

**`fix-timeline-oncreate`** — Matar `bookings[0]?.scheduledFor ?? new Date()` + `setHours` +
`toISOString`; threadear `todayKey` a TimelineView; construir `baseIso` con `localToARIso`. Verificar
que WeekGridView no repita el patrón.
- Cierra: `timeline-oncreate-wrong-day-hour`, `agenda-client-emptyslot-sethours`.
- Own: `components/agenda/agenda-client.tsx`.
- Gate: QA `TZ=UTC` — click en slot de un día sin turnos precarga **ese** día y **esa** hora.
- Dep: `ci-gate-minimo`.

**`agenda-visibilidad-statustag`** — Turnos fuera de business-hours / a la media hora visibles
(overflow o expansión de ventana); StatusTag exhaustivo por estado (patrón de `booking-drawer:676`)
+ labels unificados; usar `formatARS` en el archivo.
- Cierra: `turnos-fuera-de-horario-o-media-hora-no-visibles`, `statustag-no-exhaustivo`,
  `statustag-label-drift`, `formateadores-moneda-duplicados` (parte agenda).
- Own: `components/agenda/agenda-client.tsx`.
- Gate: QA — turno 21:30 y turno :30 visibles; estados con label correcto.
- Dep: `fix-timeline-oncreate` (mismo archivo, serial).

**Track B:**

**`fix-public-booking-tz`** — Slots públicos como instantes AR (`localToARIso` para slot/dayStart/
dayEnd, `toARDow`, label con tz AR); "hoy"/navegación del wizard en AR; diferenciar "esperá"
(rate-limit) de "sin horarios" **sin** filtrar densidad de agenda.
- Cierra: `public-booking-slots-host-tz`, `public-booking-wizard-today-utc`, `public-slots-ratelimit-vacio`.
- Own: `lib/public-booking.ts`, `components/booking/public-booking-wizard.tsx`.
- Gate: QA preview UTC — slot "08:00" aparece 08:00 en la agenda del kine; choques en ventana AR.
- Dep: `ci-gate-minimo`.

**Track C — dueño de `lib/bookings.ts`:**

**`fix-bookings-tz`** — `suggestNextFreeSlot` con `toARDow`/`toARHour` (dejar redondeo 15 min);
`getDayCounts` agrupando por `toARDateKey`.
- Cierra: `suggest-next-free-slot-host-tz`, `getdaycounts-utc-slice`.
- Own: `lib/bookings.ts`.
- Gate: QA `TZ=UTC` — sugerencia dentro de horario AR, respeta sáb/dom.
- Dep: `ci-gate-minimo`.

**`booking-concurrencia`** — `idempotencyKey` determinística + `upsert` (replicar
`public-booking:314-328`) en `createBooking` y `createBookingsBatch`; `orderBy` en el clash-check;
optimistic lock en `setBooking*Paid`. **No** agregar unique/exclusion (rompe sobreturno).
- Cierra: `booking-overlap-race-no-cas-no-unique`, `conflict-findfirst-sin-orderby`,
  `booking-paid-toggles-no-optimistic-lock`, `batch-create-overlap-race-and-no-rls` (parte idempotencia).
- Own: `lib/bookings.ts`.
- Gate: QA — doble-click en "Crear turno" produce UN turno; sobreturno forzado sigue funcionando.
- Dep: `fix-bookings-tz` (mismo archivo, serial).

### Ola 1.2 — Sweep de timezone restante (3 en paralelo, archivos disjuntos)

**`tz-dashboard`** — KPIs hoy/semana/mes al día AR; mini-calendario y campana en AR.
- Cierra: `dashboard-buckets-utc`, `mini-calendar-days-getdate-utc`, `dashboard-page-getmonth-utc`,
  `mini-calendar-today-browser-tz`, `notifications-bell-no-tz`.
- Own: `lib/dashboard.ts`, `app/(app)/dashboard/page.tsx`, `components/dashboard/**`.

**`tz-vistas`** — Bucket "Hoy" de Seguimiento anclado en AR + displays con tz AR en seguimiento,
búsqueda global (+ date-link con `toARDateKey`), portal, listado pacientes, session-detail.
- Cierra: `seguimiento-today-bucket-and-display`, `search-booking-toLocale-no-tz`,
  `portal-session-date-no-tz`, `pacientes-lastvisit-no-tz`, `session-detail-no-tz`.
- Own: `app/(app)/seguimiento/page.tsx`, `lib/search.ts`, `app/(portal)/portal/c/[slug]/page.tsx`,
  `app/(app)/pacientes/page.tsx`, `components/seguimiento/session-detail.tsx`.

**`tz-server-exports`** — Ventana semanal del export ICS en AR; `startDate` de planes anclado a
medianoche **AR**.
- Cierra: `ics-export-week-window-host-tz`, `plan-startdate-utc-midnight`.
- Own: `app/api/agenda/export/route.ts`, `lib/diagnosis.ts`.

Gate de las tres: QA `TZ=UTC` por vista (checklist de [TESTING.md](TESTING.md)). Dep: ninguna dura.

### Ola 1.3 — Dinero (serial por schema) + pacientes (paralelo)

**`payment-amount-anclado`** *(migración — encabeza la ola)* — `Payment.expectedAmountCents`; crear
la fila `Payment` en **ambos** checkouts al generar la preferencia; webhook compara contra el monto
anclado y persiste `Payment FAILED` en mismatch (no perder traza); mover el chequeo de idempotencia
dentro de la tx; validar `practitionerId ∈ tenant` en checkout.
- Cierra: `c3-payment-amount`, `mp-webhook-idempotency-check-outside-tx`, `checkout-practitionerid-sin-validar`.
- Own: `prisma/schema.prisma`, `prisma/migrations/**`, `lib/mercadopago.ts`,
  `app/api/booking/checkout/route.ts`, `lib/public-booking.ts` (solo bloque payment).
- Gate: QA sandbox MP — pago OK → PAID; edición de precio en vuelo → `Payment FAILED` registrado.
  **Preservar** firma HMAC/replay/redact.
- Dep: `fix-public-booking-tz` (public-booking.ts, ola previa), Upstash/MP sandbox (EXTERNAL-CONFIG).

**`delete-guard-booking`** *(migración — serial tras la anterior)* — `Payment.onDelete → Restrict` +
`deleteBooking` rechaza si existe `Payment` o `paymentStatus ∈ {AUTHORIZED,PAID,REFUNDED}`.
- Cierra: `booking-hard-delete-payment-cascade` (**crítica**).
- Own: `prisma/schema.prisma`, nueva migración, `lib/bookings.ts`.
- Gate: QA — borrar turno pagado da error claro; sin pago se borra normal.
- Dep: `payment-amount-anclado` (schema serial), `booking-concurrencia` (bookings.ts).

**`patients-integridad`** *(paralelo, archivos disjuntos)* — Gate de rol OWNER/ADMIN en
`deletePatient` y `deleteProgram`/`deleteSession`; decrement atómico de `totalSessions`; schema zod
compartido para `setPatientCoverage`. **No** tocar el type-to-confirm existente.
- Cierra: `patient-hard-delete-cascades-hc` (gate), `program-session-hard-delete` (gate),
  `session-totalsessions-read-modify-write`, `coverage-sin-schema-zod`.
- Own: `lib/patients.ts`, `lib/validation.ts`.
- Gate: QA — PRACTITIONER no puede hard-delete; cobertura inválida rechazada con error de campo.

**`money-input-parser`** *(paralelo)* — `parseARS` en `lib/format.ts` (formato AR: miles ".",
decimal ",") + componente `MoneyInput` compartido; reemplazar los `Number()*100`. Fundación del
módulo contable de Etapa 3.
- Cierra: `money-input-sin-parser-ar`.
- Own: `lib/format.ts`, `components/ui/money-input.tsx` (nuevo), y los call-sites
  `configuracion-client.tsx:565,778,779` + `agenda-client.tsx:218` — **coordinar** con el track A de
  Ola 1.1 si sigue abierto (mismo `agenda-client.tsx`): serial, no paralelo.
- Gate: unit de `parseARS` ("1.500,50" → 150050 cents); QA de inputs de precio/copago.

### Ola 1.4 — Hardening de runtime/config

**`headers-seguridad`** — CSP (arrancar `Report-Only`) + headers estándar; `allowedOrigins` de
server actions por env para prod.
- Cierra: `sin-headers-seguridad-csp`, `serveractions-allowedorigins-localhost`.
- Own: `next.config.mjs`.
- Gate: `curl` de headers en preview; app funciona con CSP report-only sin violaciones propias.

**`sentry-observabilidad`** *(serial tras headers — mismo next.config.mjs)* — `@sentry/nextjs` en
modo no-op (gate de activación = `SENTRY_DSN`, patrón listo-para-activar); `logger.warn` en los
catches de `notifications-internal` y `audit-extension`; audit de lectura PHI con `waitUntil`/await
para que no se pierda en freeze serverless.
- Cierra: `m1-sentry-no-wired`, `sentry-no-cableado`, `m2-silent-catches`, `audit-fire-and-forget`.
- Own: `lib/logger.ts`, `lib/notifications-internal.ts`, `lib/audit-extension.ts`,
  `instrumentation.ts`, `sentry.*.config.*`, `package.json`, `next.config.mjs`.
- Gate: build sin DSN = no-op limpio; con DSN de prueba un error llega a Sentry.
- Dep: `headers-seguridad`, cuenta Sentry (EXTERNAL-CONFIG).

**`configuracion-ux`** *(paralelo)* — Reemplazar `window.confirm/alert` por `useConfirm`/
`ConfirmDialog` in-house; toast de éxito al guardar datos del consultorio.
- Cierra: `native-confirm-alert`, `basics-sin-feedback-exito`.
- Own: `components/configuracion/configuracion-client.tsx`.

**`password-policy`** *(paralelo)* — Mínimos de complejidad en el zod de auth + config Supabase.
- Cierra: `password-sin-complejidad`.
- Own: `lib/auth.ts` (+ setting Supabase, EXTERNAL-CONFIG).

**`invitation-token-hash`** *(paralelo)* — Hashear el token de `Invitation` (guardar digest, comparar
por hash) en vez de guardarlo en claro.
- Cierra: `invitation-token-en-claro`.
- Own: `lib/invitations.ts`, `app/invite/[token]/**`, migración (columna del digest — **serial** si
  cae en la misma ronda que otra migración).

### Checklist de corte a producción — Etapa 1 (cliente único)

**Bloqueantes** (no hay corte sin esto):

| # | Ítem | Depende de |
|---|---|---|
| 1 | Rate-limiting distribuido en superficies públicas (Upstash env en Vercel) | **Upstash (C)** |
| 2 | `MP_WEBHOOK_SECRET` + credenciales MP prod seteadas | **MP (C)** |
| 3 | Monto de pago anclado + `Payment FAILED` en mismatch | `payment-amount-anclado` |
| 4 | `deleteBooking` no destruye `Payment` (Restrict + guard) | `delete-guard-booking` |
| 5 | Doble-submit de turno neutralizado (idempotency determinística) | `booking-concurrencia` |
| 6 | Bugs QA de agenda cerrados y verificados con `TZ=UTC` | Olas 1.1-1.2 |
| 7 | Headers de seguridad + `allowedOrigins` prod (CSP al menos report-only) | `headers-seguridad` |
| 8 | Sentry cableado (no-op sin DSN acepta corte; DSN real dentro de la semana) | `sentry-observabilidad` + Sentry (C) |
| 9 | Error/loading/404 en español con retry | `error-loading-boundaries` |
| 10 | Login con feedback de error | `login-error-feedback` |
| 11 | CI typecheck+build como required check + branch protection | `ci-gate-minimo` + Vercel (C) |
| 12 | Checklist de QA manual versionado, corrido completo en preview UTC | [TESTING.md](TESTING.md) |
| 13 | Gate de rol en hard-deletes (paciente/programa/sesión) | `patients-integridad` |
| 14 | Verificado: bucket Supabase `patient-files` **privado**; `.env` prod fuera de git (rotar si estuvo expuesta) | **Supabase (C)** |
| 15 | Sin datos fabricados en prod (`KINESOFT_ALLOW_DEMO_ACTOR` unset en Vercel) | verificación |
| 16 | Logging sin PII/secretos (`redactPayload` ya existe) | verificación |
| 17 | Inputs de dinero con parser AR estandarizado | `money-input-parser` |

**Diferido-con-gate** (registrado en el tracker de abajo): RLS real, suite de integración/E2E,
guard estático, password policy reforzada, email transaccional propio, APM, legal (Ley 26.529),
env fail-fast total.

---

## ETAPA 2 — Producción SaaS

Objetivo de corte: un consultorio distinto al demo puede **onboardearse, pagar su plan, operar con
varios profesionales y pacientes con cuenta**, con aislamiento real (RLS) y una suite de tests que
protege las costuras de dinero y PHI.

### Ola 2.0 — Split de archivos gigantes (foundation-first, 4 en paralelo)

Va **primero**: multi-profesional, realtime, soft-delete y el timeline de HC necesitan tocar estos
archivos; trocearlos antes evita que 3 agentes choquen en un archivo de 2000+ líneas. Regla: **cero
cambio de comportamiento** (QA visual + tsc).

- **`split-agenda-client`** — `components/agenda/**`.
- **`split-patient-profile`** — `components/patients/**` (+ `provider-value-inline-bulk-select`,
  resto de `formateadores-moneda-duplicados` → `formatARS`).
- **`split-diagnostico-screen`** — `components/screens/diagnostico-screen.tsx` → `components/diagnostico/**`.
- **`split-configuracion-y-wizard`** — `configuracion-client`, `public-booking-wizard`, `biblioteca-client`.
- Cierra: `h2-oversized-components`, `deuda-archivos-grandes`. Dep: Etapa 1 completa.

### Ola 2.1 — Testing completo + extracción + guards

- **`extraccion-logica-pura`** — Sacar lógica de negocio de archivos `"use server"` y componentes
  cliente a módulos puros (precondición 4.2). Cierra `logica-en-use-server-y-cliente`,
  `export-type-en-use-server`. Dep: Ola 2.0.
- **`suite-integracion`** — Fábrica de tenant efímero (4.3) + impersonación (4.6) + tripwire de
  aislamiento cross-tenant + test de concurrencia de booking + migrar scripts ad-hoc + E2E Playwright
  del wizard público. Cierra `no-test-suite` (cierre), `c2-no-tests-ci` (cierre),
  `scripts-adhoc-como-tests`, `sin-test-tripwire-aislamiento`. Dep: `extraccion-logica-pura`.
- **`ci-pipeline-completo-y-guard`** — Pipeline 4.8 (rápido→caro, coverage ratchet) +
  `scripts/guard-tenant-isolation.mjs`. Cierra `no-ci-triple-gate` (cierre), `no-static-security-guard`.
  Dep: `suite-integracion`.

### Ola 2.2 — RLS wholesale (SERIAL — no dejar estado intermedio)

> Workstream acoplado (§0 de AUDIT). Requiere el tripwire de `suite-integracion` **antes**, para
> detectar qué módulo rompe al forzar RLS.

- **`rol-db-sin-bypassrls`** — Rol dedicado sin SUPERUSER/BYPASSRLS en dev (Docker) y prod (Supabase,
  parte C); GRANT DML; verificación `pg_roles`. Cierra `rls-bypassed-by-superuser-role`.
- **`cliente-tenant-unico-guc`** — Plegar el `SET LOCAL` del GUC en un único cliente tenant-scoped y
  enrutar **todos** los módulos (incluye batch, toggles de bookings, sessions/services/insurers).
  Cierra `runwithrls-solo-en-2-modulos`, `gettenantprisma-dead-code`, `batch-fuera-de-runwithrls`,
  `batch-create-overlap-race-and-no-rls` (parte RLS), y el residual de `h1-rls-optin`.
- **`policies-tablas-faltantes`** — RLS para PatientFile/PatientShare/Insurer (prioridad 1) +
  user-scoped (prioridad 2; **ojo** `UserPreferences.tenantId` nullable requiere refactor antes de
  policy ciega); automatizar apply de `policies.sql`. Cierra `tenant-tables-sin-rls-ni-filtro`,
  `rls-coverage-gaps`. Gate: tripwire verde con RLS forzado + guard sin drift + suite completa verde.

> ⚠️ `batch-fuera-de-runwithrls` es **latente**: hoy anda porque el rol bypassea RLS. Si se hace
> `rol-db-sin-bypassrls` sin `cliente-tenant-unico-guc`, "Múltiples turnos" pasa a fallar en
> silencio. Serializar estricto.

### Ola 2.3 — Multi-profesional completo

- **`practitioner-multi-tenant`** *(migración)* — `@@unique([tenantId,userId])`,
  `UserProfile.practitioner` → array, accept-action crea siempre `Practitioner`, fix
  `scripts/create-tenant.ts`. Cierra `practitioner-userid-unique-blocks-multitenant`. Dep: Ola 2.2.
- **`capabilities-matrix`** — Matriz central de capabilities por rol (extender `lib/plan-gating.ts`;
  `Actor` lleva `role`). Cierra `role-gating-disperso-sin-matriz-central`. *Foundation de S13/S18.*
- **`roles-assistant-billing`** — Capabilities reales para ASSISTANT (recepcionista) / BILLING; no
  crear `Practitioner` bookeable para roles no clínicos. Cierra `roles-assistant-billing-cosmeticos`.
  Dep: `capabilities-matrix`, `practitioner-multi-tenant`.
- **`tenant-switcher`** — Setter de cookie `kine_tenant` + UI (hoy no existe). Dep: `practitioner-multi-tenant`.
- **`realtime-agenda`** — Supabase Realtime para agenda compartida (canal por tenant, invalidación
  por cache-tags). Cierra `no-realtime-agenda-compartida`. Dep: `split-agenda-client`, `practitioner-multi-tenant`.

### Ola 2.4 — Billing SaaS completo

Regla de dominio: *cada consultorio paga su plan con límite de asientos; el tenant puede deslinkear
al kine; los profesionales no pagan.*

- **`subscription-entitlements`** *(migración)* — Model `Subscription(tenantId, plan, mpPreapprovalId,
  status, currentPeriodEnd, seats)` + `tenantEntitlements()` leyendo `subscriptionStatus`/`trialEndsAt`.
  Cierra `plan-fields-inert-no-upgrade-no-enforcement`. Dep: `capabilities-matrix`.
- **`mp-preapproval-webhook`** — Integración MP Preapproval separada del checkout de turnos; el
  webhook como **único** write-path de `Tenant.plan`/`subscriptionStatus`. Cierra
  `no-saas-billing-charge-clinic`. Dep: `subscription-entitlements`.
- **`paywall-trial-ui`** — Upgrade/downgrade + gate en layout para `PAST_DUE`/`CANCELLED`/trial
  vencido. Dep: los dos anteriores.
- **`seats-limits`** — Límites de asientos/uso por plan (cuenta `Practitioner` por tenant); deslinkeo
  de kine por el tenant. Cierra `no-seat-usage-limits`. Dep: `practitioner-multi-tenant` + `subscription-entitlements`.

### Ola 2.5 — Integridad restante + portal base

- **`soft-delete-wholesale`** *(migración)* — `archivedAt` en Booking; soft-delete de programas/
  sesiones; `@@unique([programId,index])` en Session. Cierra `session-index-no-unique-constraint` +
  residuales de `patient-hard-delete-cascades-hc`/`program-session-hard-delete`. Dep: `split-patient-profile`.
- **`copago-snapshot`** — *(decisión de producto)* persistir `copagoCents` al crear/completar el
  turno para que reemplazar cobertura no mute importes históricos. Cierra
  `retroactive-copago-on-coverage-replace`. Dep: `suite-integracion` (test de regresión de la
  escalera de precedencia — preservar `resolveBookingCopagoCents`).
- **`files-magic-bytes`** — Validar magic bytes además del MIME declarado. Cierra `upload-sin-magic-bytes`.
  Own: `lib/files.ts`.

### Ola 2.6 — Cuentas de paciente + Portal v2 (feature A, mobile-first)

> Base existente: portal mobile-first (<150kB), invitación por email, check-in EVA. Regla de dominio:
> **una cuenta Paciente nunca puede ser Usuario de una clínica** (emails distintos, enforced).

- **`portal-userid-link`** *(migración/refactor)* — Migrar la auth del portal de match-por-email a
  `Patient.userId`. Cierra `portal-auth-por-email-no-userid`. Dep: Ola 2.2. *(Primera del bloque.)*
- **`patient-signup`** — Alta self-serve de paciente con validación dura zod + rate-limit + regla
  email-no-clínica + honeypot; endurecer contra injection/exploits en superficies públicas.
- **`patient-invite-poderoso`** — Link del kine que lleva al paciente **directo a selección de
  turnos** + portal como "invitado" con sugerencia de crear cuenta (para no perder datos). Incluye
  **revisión de seguridad dedicada** del flujo guest (que el acceso directo no filtre datos de otros).
  Conecta con el ítem heredado "link manual guest→Patient con emails distintos".
- **`portal-turnos`** — Ver/confirmar/cancelar/reagendar desde el portal.
- **`portal-cuenta`** — Cambio de contraseña + datos personales editables.
- **`portal-hc-visible`** — HC pública del consultorio + planes con historial + guías/ejercicios
  aconsejados. Cierra parcialmente `l1-portal-minimo`.
- **`crud-usuarios-admin`** — Reset de password admin→miembro; CRUD de paciente/usuario desde el panel
  del tenant (y futuro owner panel). *(Se distingue de la config de portal del owner-organización,
  que es aparte.)*
- **`oauth-extra`** *(condicional)* — Apple/Meta como proveedores. Gate: cuenta dev Apple (paga) / app
  review Meta → EXTERNAL-CONFIG. Google ya está.
- Dep del bloque: Ola 2.2 (RLS/PHI), Ola 2.3 (roles).

### Ola 2.7 — Adjuntos en booking + Timeline de HC (features B y C)

- **`booking-adjuntos`** — Upload en el wizard público **y** en el flujo autenticado (placas,
  recetas, informes, estudios previos, DICOM); sumar `application/dicom` + `.dcm` al allow-list; el
  mensaje descriptivo ya existe (`Booking.notes`). Cierra `dicom-fuera-de-allowlist`. **Gate:** magic
  bytes (`files-magic-bytes`) + decisión de virus-scan (`l2-no-virus-scan`) **antes** de habilitar
  upload de pacientes.
- **`hc-timeline-profesional`** — Rediseño de `patient-profile` como **timeline clínico unificado**
  (hoy 9 tabs desorganizadas). Sesión dedicada. Dep: `split-patient-profile`.
- **`hc-portal-basico`** — Vista básica mobile del timeline para el paciente (lado paciente = lo
  esencial por ahora).

### Ola 2.8 — Plataforma de soporte + owner panel (feature D)

- **`ticket-model`** *(migración)* — Modelos `Ticket`/`Report` + reporte de error in-app por
  usuarios. Captura errores internos y de página que hoy se pierden.
- **`owner-panel`** — Panel superadmin de **plataforma cross-tenant** (concepto nuevo; **diseño de
  authz propio**, aparte del `Role` tenant-scoped). Bandeja de tickets + mensajes de contacto.
- **`landing-contacto`** — Form de contacto en la landing → bandeja del owner.
- **`seo-analytics`** — `sitemap.ts`/`robots.ts`/metadata + GA/Google Business/Vercel Analytics.
  Cierra `sin-sitemap-robots`. Mitad bucket C (cuentas/tags).

### Ola 2.9 — Onboarding + cierre de etapa

- **`onboarding-pulido`** — Polish del self-serve + email transaccional propio (bucket C: dominio
  verificado, SPF/DKIM — gate del corte E2). Dep: `paywall-trial-ui`.

**Checklist de corte E2 (adicional al de E1):** RLS real forzado + tripwire verde · suite integración
+ E2E + concurrencia en verde · guard estático en CI · billing SaaS operativo con un tenant de prueba
· multi-profesional verificado (kine en 2 tenants) · email transaccional propio con dominio verificado
· env fail-fast total.

---

## ETAPA 3 — Productiva final (épicas)

Grueso, no sesiones. Se detallan cuando el dueño baje la visión de cada una.

- **`definicion-ejercicios-maniobras`** — ⏸ **GATE:** sesión de QA + visión con el dueño (él bajará
  la idea de la sección). Es el prerrequisito de todo lo clínico: recién después es fácil implementar
  Planes y luego IA.
- **`guia-diagnostico-completa`** — Residual real de `h3-etapa2-stub`: UI de autoría
  `ConditionExerciseLink`, matching para custom conditions, templates condicionados, biblioteca de
  maniobras ampliada. Dep: la épica anterior.
- **`planes-v2`** — Entidad "plan" que regrupa turnos vía `Booking.seriesId` (ya poblado).
- **`ia-local-clinica`** — IA local privada como asistente clínico sobre HC/EVA. Dep: Etapa 2
  completa (RLS real + tests, porque toca PHI). El schema se construyó como ground-truth para esto.
- **`modulo-contable`** — Gastos/ingresos/métricas/beneficios sobre la base de `money-input-parser` +
  la facturación existente (copago/OS). Inputs validados y estandarizados para fórmulas precisas.
- **`features-pro`** — Features gateadas por los entitlements de la Ola 2.4.
- **`portal-self-service-avanzado`** — Cierre de `l1-portal-minimo` (autogestión completa del paciente).
  Prerrequisito: `l2-no-virus-scan` si habilita uploads de pacientes.
- **`paciente-multi-consultorio`** — Rediseño de `Patient`/`PatientTenantLink`
  (`patient-tenancy-single-home-row`).

---

## Tracker de diferido-con-gates

Nada se difiere por omisión. Cada ítem se revisa al cierre de cada ola.

| Ítem | Gate de desbloqueo |
|---|---|
| RLS real (rol sin BYPASSRLS + GUC universal + policies) | Antes de onboardear el 2º tenant (Ola 2.2). Mientras: el `where tenantId` es la autoridad, documentado en AUDIT.md §0 |
| Suite integración/E2E + concurrencia + tripwire | Antes de abrir signup self-serve / 2º tenant (Ola 2.1) |
| Guard estático de seguridad en CI | Junto con Ola 2.1-2.2 |
| Password policy reforzada | Antes de signup público abierto (o `password-policy` en E1 si entra) |
| Email transaccional propio (SPF/DKIM) | Antes de signup self-serve (corte E2). Mientras: SMTP default de Supabase para el cliente único |
| APM / query-perf (`m3-no-apm`) | ≥5 tenants activos O primer incidente de latencia p95 |
| Virus-scan de uploads (`l2-no-virus-scan`) | Antes de habilitar upload de archivos desde el portal (Ola 2.7) |
| Paciente multi-consultorio (`patient-tenancy-single-home-row`) | Primer caso real de paciente atendido en 2 consultorios del sistema |
| CSP de report-only a enforce | 2 semanas de report-only sin violaciones propias |
| Diagnosis / ejercicios / maniobras | Sesión de QA + visión con el dueño (Etapa 3) |
| Apple/Meta OAuth | Cuenta dev Apple / app review Meta (EXTERNAL-CONFIG) |
| Env fail-fast total (hoy zod optional) | Corte E2 (con Upstash/Sentry ya obligatorios) |
| Catálogo de clases de bug propio del producto | Post-Etapa 1, cuando haya ≥2 rondas de fixes que catalogar |
| Legal AR (Ley 26.529 HC, términos, privacidad) | Asesor legal (bucket D); mitigado por gate de rol + type-to-confirm en hard-deletes |

---

## Herencia del roadmap anterior (nada se pierde)

El `roadmap.md` viejo (87 KB, recuperado del commit `49e528c`) era el log histórico de sprints 1-18.
Su contenido de proceso quedó consolidado en ARCHITECTURE/SECURITY/AUDIT/DEPLOYMENT. Su **backlog
pendiente** se preserva acá:

**Backlog menor (anexar a olas futuras):**
- Videos de ejercicios inline en el timeline del portal (Supabase Storage / referenciar YouTube-Vimeo
  por egress) → `hc-portal-basico` / `portal-self-service-avanzado`.
- Recibos descargables (PDF) → diferido (MP ya emite comprobantes).
- Push notifications (`web-push`) → Etapa 2/3.
- Link manual guest→Patient cuando los emails difieren → `patient-invite-poderoso`.
- Bulk-assign de ejercicios a un programa existente (`bulkAddSessionExercises`) → `guia-diagnostico-completa`.
- Filtros avanzados en Pacientes (edad, último diagnóstico, rango de alta) → Etapa 2.
- `getDashboardData` split por widget con TTLs independientes si el dashboard sigue lento.
- Threading del precio Particular en las billing cards del perfil.

**Descartados-con-gate** (baja prioridad / mejor alternativa; reabrir si aparece demanda real):
PDF HC export, drag-to-reschedule en agenda, WhatsApp reminder (Twilio/360dialog), comparador de Dx
side-by-side, videos inline por egress, receipt PDF.

**Out-of-scope v1:** app nativa, HL7/FHIR export, multi-currency (solo ARS).
