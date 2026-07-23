# KineSoft — Auditoría de estado (checklist de severidad vivo)

> **Qué es este documento.** La fuente única de verdad de "¿qué sigue abierto?" para KineSoft,
> siguiendo el proceso E1-E2 y el meta-modelo de documentación del
> [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md) (Parte 5). Cada finding tiene severidad
> verificable, un estado (ABIERTO/CERRADO) y una sesión del [ROADMAP.md](ROADMAP.md) que lo
> resuelve. Es un documento **vivo**: se actualiza el estado a medida que cada sesión cierra.
>
> **Metodología.** Auditoría E1 (documental) + E2 (sweep verificado en código) corrida el
> 2026-07-22 sobre 9 áreas del baseline, con verificación adversarial de cada finding
> crítico/alto (se refutó lo que no resistió lectura del código real). 24 findings confirmados,
> 63 menores, 2 refutados. El código es el árbitro: donde un doc decía una cosa y el código otra,
> mandó el código.
>
> **Estado global:** MVP funcional, desplegado, 1 cliente vivo. El núcleo (auth/tenancy, flujo de
> booking, visibilidad de pacientes, billing de copago, webhook MP) está **genuinamente sólido**
> (ver §Inventario de preservar). Los gaps de abajo son la distancia entre "anda para mi hermano"
> y "SaaS vendible a consultorios".

## Cómo leer la severidad

| Severidad | Criterio |
|---|---|
| **crítica** | Fuga/pérdida de datos, pérdida de dinero, o corrupción silenciosa alcanzable en prod |
| **alta** | Bug de lógica que el usuario ve, o deuda que bloquea escalar / vender |
| **media** | Riesgo latente (hoy mitigado por otra capa) o inconsistencia acotada |
| **baja** | Pulido, consistencia cosmética, deuda sin impacto inmediato |

Bucket (quién resuelve): **A** código directo · **B** hardening con decisión de alcance ·
**C** config externa del dueño · **D** legal/negocio · **E** marca.

---

## 0. Causa raíz arquitectónica (el hallazgo que orienta todo el plan)

**La segunda capa de aislamiento multi-tenant (RLS) es estructuralmente inerte.** No es un bug
suelto: es una condición de fondo que explica varios findings a la vez.

- Las policies existen y están `ENABLE + FORCE` en 17 tablas (`prisma/migrations/policies.sql`),
  pero la aplicación se conecta con un rol que tiene **BYPASSRLS** (dev: superuser `kinesoft` del
  Docker; prod: rol `postgres.<ref>` de Supabase). Un rol con BYPASSRLS/SUPERUSER **ignora RLS
  incluso con FORCE** → ninguna policy se evaluó jamás en runtime.
- `runWithRls` (que setea el GUC `app.current_tenant_id`) solo está cableado en `lib/patients.ts`
  y `lib/bookings.ts`. Las demás mutaciones usan `prisma` plano.
- 9 tablas con `tenantId` no figuran ni en las policies ni en el auto-filtro de `lib/db.ts`.

**Consecuencia:** hoy el aislamiento depende **100% del filtro `where: { tenantId }` a mano** en
cada query (que sí está presente y es correcto — ver preserve). La "defensa en dos capas" que
describen ARCHITECTURE.md y SECURITY.md es, a día de hoy, **una sola capa**. Activar RLS de verdad
es un workstream **acoplado y todo-o-nada** (rol sin BYPASSRLS + GUC en todos los módulos +
policies faltantes), no tres fixes sueltos → ver Ola 2.2 del ROADMAP. Findings:
[F-B3](#f-b3), [F-B4](#f-b4), [F-B2](#f-b2), y los menores `batch-fuera-de-runwithrls`,
`gettenantprisma-dead-code`, `rls-coverage-gaps`.

> **Enmarcado para no-técnicos:** las primeras olas de hardening (higiene de entorno, recableo del
> flujo crítico, RLS real, tests) son "fundación invisible" — trabajo sin impacto visual que
> habilita todo lo demás. No es estancamiento; es secuencia deliberada.

---

## 1. Findings confirmados (crítico / alto) — detalle

Formato por finding: ubicación · clase del catálogo · bucket · severidad (→ ajuste de la
verificación adversarial si hubo) · descripción · acción. El **slug** es el ancla que referencia
el ROADMAP.

### <a id="f-b1"></a>F-B1 — `booking-hard-delete-payment-cascade` · Borrar un turno destruye su registro de pago
- **Ubicación:** `lib/bookings.ts:594` (`deleteBooking`) + `prisma/schema.prisma:853` (`Payment.onDelete: Cascade`)
- **Clase:** C-INT (soft-delete con evidencia) · **Bucket:** B · **Severidad:** alta → **crítica** (escalada en verificación)
- **Descripción:** `deleteBooking` hace `tx.booking.delete` físico, sin flag de soft-delete
  (`Booking` no tiene `archivedAt`). El FK `Payment.booking` es `onDelete: Cascade`, así que borrar
  un turno **pagado** destruye en silencio el `Payment` asociado (`amountCents`, `externalId` de MP,
  `rawPayload` de conciliación) además del `copagoCents`/`insurerPaidAt` del propio turno. No queda
  rastro para auditar ni reconciliar el cobro. Cableado desde la agenda, el booking-drawer y el
  perfil de paciente.
- **Acción:** (1) `Payment.onDelete → Restrict` + migración del FK; (2) `deleteBooking` carga el
  `Payment`/`paymentStatus` antes de borrar y **rechaza** (o soft-delete) si existe pago o
  `paymentStatus ∈ {AUTHORIZED, PAID, REFUNDED}`. → sesión `delete-guard-booking`.

### <a id="f-a1"></a>F-A1 — `c3-payment-amount` · El webhook valida el monto contra el precio vivo, no contra un monto anclado
- **Ubicación:** `lib/mercadopago.ts:183`; checkouts en `app/api/booking/checkout/route.ts:~72` y `lib/public-booking.ts:~330`
- **Clase:** C-INT · **Bucket:** A · **Severidad:** crítica → **alta**
- **Descripción:** `consumeWebhook` compara `capturedCents` contra `booking.service.priceCents`
  **vivo**. El `Payment` se crea recién dentro del webhook, no en el checkout, así que un cambio de
  precio o de `copagoCents` entre el inicio del checkout y el settlement no queda anclado: un pago
  legítimo al precio viejo puede rechazarse, o uno menor pasar. (Este es el ítem **C3** que
  AUDIT.md de junio dejó abierto.)
- **Acción:** migración `Payment.expectedAmountCents Int`; crear la fila `Payment` en **ambos**
  checkouts al generar la preferencia con `expectedAmountCents`; comparar el webhook contra ese
  monto y persistir `Payment FAILED` en caso de mismatch (no perder traza). → sesión
  `payment-amount-anclado`.

### <a id="f-a2"></a>F-A2 — `public-booking-slots-host-tz` · La reserva pública genera y guarda turnos en la timezone del host
- **Ubicación:** `lib/public-booking.ts:113` (`new Date(input.date+"T00:00:00")`), `:117` (`getDay`), `:135` (`setHours`)
- **Clase:** C-UX-03 (fecha de negocio en UTC crudo) · **Bucket:** A · **Severidad:** crítica → **alta**
- **Descripción:** en prod (Vercel/Supabase = UTC) el paciente elige un slot rotulado p.ej. "08:00"
  pero el turno queda guardado a las 08:00 UTC = **05:00 AR**; la agenda del kine (que sí renderiza
  en AR) lo muestra a las 05:00. Además solo aparecen slots de mañana y el chequeo de choques usa
  una ventana corrida 3h. Es el flujo que **cobra por Mercado Pago**, así que el bug toca dinero.
  Se oculta en dev AR-local y solo explota en prod UTC.
- **Acción:** construir cada slot como instante AR con `localToARIso`; derivar `dayStart`/`dayEnd`
  y el dow con los helpers de `lib/datetime-ar.ts`; label con `timeZone` AR. → sesión
  `fix-public-booking-tz`.

### <a id="f-a3"></a>F-A3 — `timeline-oncreate-wrong-day-hour` · Click en el timeline precarga el turno en HOY y con la hora desfasada
- **Ubicación:** `components/agenda/agenda-client.tsx:737-743` (TimelineView)
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta** — *causa raíz dominante del síntoma QA "los turnos se crean en cualquier día"*
- **Descripción:** `const baseIso = new Date(new Date(bookings[0]?.scheduledFor ?? new Date()).setHours(h,0,0,0)).toISOString()`.
  Dos fallas: (1) **DÍA** — si el día visible no tiene ningún turno, `bookings[0]` es `undefined` y
  cae en `new Date()` = **HOY real**, no el día que el kine está mirando; (2) **HORA** — `setHours`
  usa wall-clock del host, así que en prod UTC el turno queda **-3h**. Es el único punto del
  pipeline de fechas de la agenda que sobrevivió sin migrar a AR (el resto —parseDate, startOfWeek,
  navigate, batch— ya está correcto).
- **Acción:** threadear `todayKey` (ya disponible en el padre) a TimelineView y construir `baseIso`
  con `localToARIso(\`${todayKey}T${hh}:00\`)`; eliminar el patrón `bookings[0] ?? new Date()` +
  `setHours` + `toISOString`. → sesión `fix-timeline-oncreate` (cubre también el menor
  `agenda-client-emptyslot-sethours`).

### <a id="f-a4"></a>F-A4 — `suggest-next-free-slot-host-tz` · La sugerencia de "próximo turno libre" evalúa horario en el host
- **Ubicación:** `lib/bookings.ts:246-251` (`suggestNextFreeSlot`)
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** el walker usa `cursor.getDay()`/`getHours()` (host-tz) contra
  `businessHoursStart/End` que son horas **AR**. En host UTC evalúa con 3h de corrimiento y puede
  saltear el sábado o incluir domingos. Inconsistencia dentro del mismo archivo, que ya importa y
  usa `toARDow` correctamente en `createRecurringBookings`.
- **Acción:** `toARDow`/`toARHour` para el gate de dow y horario; dejar el redondeo a 15 min tal
  cual (AR no tiene DST). → sesión `fix-bookings-tz` (con el menor `getdaycounts-utc-slice`).

### <a id="f-a5"></a>F-A5 — `seguimiento-today-bucket-and-display` · El bucket "Hoy" de Seguimiento y su display están en host-tz
- **Ubicación:** `app/(app)/seguimiento/page.tsx:13-17` y `:147`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** Server Component (host UTC): `todayStart/End` se calculan con `new Date()` +
  `setHours` en host-tz, así que la ventana "Hoy" es `[21:00 AR ayer, 21:00 AR hoy)`; una sesión de
  las 22:00 AR de hoy salta a "Próximas" y una de anoche cuenta como hoy. El display usa
  `toLocaleString` sin `timeZone`.
- **Acción:** anclar límites al día AR con `toARDateKey`/`localToARIso`; `timeZone` AR en el
  display. → sesión `tz-vistas`.

### <a id="f-a6"></a>F-A6 — `search-booking-toLocale-no-tz` · La búsqueda global formatea el horario del turno sin timezone AR
- **Ubicación:** `lib/search.ts:140` y `:148`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** `search.ts` es `"use server"` (host UTC). El sublabel usa `toLocaleString('es-AR')`
  sin `timeZone`, y el href de "ver en agenda" usa `toISOString().slice(0,10)` (fecha UTC) → para
  turnos de la noche apunta al día equivocado.
- **Acción:** `timeZone` AR en el formateo; `toARDateKey` para el date-link. → sesión `tz-vistas`.

### <a id="f-a7"></a>F-A7 — `portal-session-date-no-tz` · El portal del paciente muestra la fecha de sesión sin timezone AR
- **Ubicación:** `app/(portal)/portal/c/[slug]/page.tsx:193`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** alta → **media**
- **Descripción:** Server Component (host UTC): `toLocaleDateString('es-AR', {...})` sin `timeZone`
  para sesiones de tarde/noche; inconsistente con el bloque hermano `nextSession` del mismo archivo
  (línea 129) que sí usa AR.
- **Acción:** espejar el bloque hermano con `timeZone` AR (o formatter AR reutilizable). → sesión `tz-vistas`.

### <a id="f-a8"></a>F-A8 — `login-sin-feedback-error` · El login nunca muestra el error de credenciales
- **Ubicación:** `app/(auth)/login/page.tsx` + `components/screens/login-screen.tsx:189`
- **Clase:** C-UX (error accionable) · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** el form postea a `/api/auth/sign-in` que redirige a `/login?error=...`, pero
  `LoginPage` renderiza `<LoginScreen/>` sin props y `LoginScreen` no lee `searchParams`. El query
  se pierde y el usuario reintenta a ciegas. Es la única pantalla de auth así (signup y forgot sí
  manejan error). El texto de error ya está en español.
- **Acción:** threadear `searchParams.error` a `LoginScreen` y renderizar un banner condicional.
  → sesión `login-error-feedback`.

### <a id="f-a9"></a>F-A9 — `practitioner-userid-unique-blocks-multitenant` · Un kine no puede pertenecer a dos consultorios
- **Ubicación:** `prisma/schema.prisma:123` (`Practitioner.userId String @unique`) + `lib/session.ts:75-81`
- **Clase:** C-SEC-07 (unicidad global vs tenant-scoped) · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** `Membership` es N:N y `session.ts` documenta "switch between tenants", pero
  `Practitioner.userId` es `@unique` **global**: un kine invitado a un 2º consultorio queda
  bloqueado — accept-action no le crea `Practitioner` en el 2º tenant, y `buildActor` exige un
  `Practitioner` en el tenant elegido → `throw Unauthenticated`. Es la **única línea** que bloquea
  el modelo multi-profesional; el resto del schema ya lo soporta. Regla de dominio del dueño: *un
  kine puede ocupar silla en N consultorios* → esto hay que arreglarlo.
- **Acción:** `@@unique([tenantId, userId])` (quitar el `@unique` global); `UserProfile.practitioner`
  → array; accept-action crea **siempre** el `Practitioner` del tenant; fix de `scripts/create-tenant.ts`.
  → sesión `practitioner-multi-tenant` (Etapa 2, requiere migración).

### <a id="f-b2"></a>F-B2 — `tenant-tables-sin-rls-ni-filtro` · 9 tablas tenant-scoped sin RLS ni auto-filtro
- **Ubicación:** `prisma/migrations/policies.sql` + `lib/db.ts:29` (`TENANT_SCOPED_MODELS`)
- **Clase:** C-DB-07 · **Bucket:** B · **Severidad:** crítica → **media** (mitigado por el `where` a mano)
- **Descripción:** `Insurer` (dinero), `PatientFile` (PHI), `PatientShare` (control de acceso),
  `Invitation`, `Notification`, `Favorite`, `PlanTemplate`, `UserPreferences` y `DismissedReminder`
  tienen `tenantId` pero no están ni en `policies.sql` (sin RLS) ni en `TENANT_SCOPED_MODELS`. El
  aislamiento depende 100% del `where: { tenantId }` manual. Se agregaron en sprints 13-18 y nadie
  las sumó a ninguna de las dos capas (no había guard que lo detectara — ver F-B11).
- **Acción:** prioridad por drift real: PatientFile (PHI), PatientShare (acceso), Insurer (pricing)
  primero. → sesión `policies-tablas-faltantes` (Ola 2.2, después del rol sin BYPASSRLS).

### <a id="f-b3"></a>F-B3 — `rls-bypassed-by-superuser-role` · El rol de conexión bypassea RLS
- **Ubicación:** prod `.env` `DATABASE_URL` (rol `postgres.<ref>`, BYPASSRLS); dev `docker-compose.yml:18` (`POSTGRES_USER: kinesoft`, superuser)
- **Clase:** C-DB-08 · **Bucket:** B · **Severidad:** alta → **media** (porque hoy el `where` a mano protege)
- **Descripción:** ver §0. `FORCE RLS` no anula BYPASSRLS ni SUPERUSER; `runWithRls` setea un GUC
  que ninguna policy llega a consultar porque el motor no aplica RLS a ese rol.
- **Acción:** provisionar un rol de login dedicado **sin** SUPERUSER/BYPASSRLS en dev y prod
  (parte del dueño en Supabase); GRANT DML; verificar con `pg_roles`. → sesión `rol-db-sin-bypassrls`
  (Ola 2.2). **Ojo:** activar esto sin cablear el GUC en todos los módulos (F-B4) rompe la app.

### <a id="f-b4"></a>F-B4 — `runwithrls-solo-en-2-modulos` · El GUC de tenant solo se setea en 2 módulos
- **Ubicación:** `lib/rls.ts:19` + `lib/db.ts:76` (`getTenantPrisma`)
- **Clase:** C-DB · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** `runWithRls` solo se usa en `patients.ts`/`bookings.ts`. Si se corrige el rol
  (F-B3) sin migrar el resto, esas queries verían `app.current_tenant_id = NULL` → toda policy
  evalúa `FALSE` → cero filas / escrituras bloqueadas. `getTenantPrisma` (backstop app-layer) es
  además **código muerto** (menor `gettenantprisma-dead-code`). La aislación en dos capas es
  estructuralmente inalcanzable en el estado actual.
- **Acción:** plegar el `SET LOCAL app.current_tenant_id` en un único cliente tenant-scoped por
  request y enrutar **todos** los módulos de dominio. → sesión `cliente-tenant-unico-guc` (Ola 2.2).

### <a id="f-b5"></a>F-B5 — `booking-overlap-race-no-cas-no-unique` · Doble-submit de turno sin defensa
- **Ubicación:** `lib/bookings.ts:301-314` (clash-check) y `:352-370` (create)
- **Clase:** C-INT-08 · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** el clash-check y el create no comparten transacción (el propio comentario dice
  "safe outside the tx"), no hay unique compuesto ni exclusion sobre `(practitionerId, scheduledFor)`,
  y el `idempotencyKey` se genera con `randomBytes(16)` en cada llamada → el `@unique` de la columna
  nunca colisiona. Dos requests concurrentes (doble-click / reintento de red) crean dos turnos
  solapados. **No** conviene un unique/exclusion duro: rompería el sobreturno intencional.
- **Acción:** `idempotencyKey` **determinística** `${tenantId}:${practitionerId}:${slotISO}:${patientId}`
  + `upsert` (replicando `lib/public-booking.ts:314-328`); `orderBy` en el `findFirst` del
  clash-check. → sesión `booking-concurrencia` (cubre menores `conflict-findfirst-sin-orderby`,
  `booking-paid-toggles-no-optimistic-lock`, y la parte de idempotencia de `batch-create-overlap-race-and-no-rls`).

### <a id="f-b6"></a>F-B6 — `patient-hard-delete-cascades-hc` · Borrar un paciente destruye su historia clínica
- **Ubicación:** `lib/patients.ts:863-875` (`deletePatient`)
- **Clase:** C-INT (soft-delete) · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** `deletePatient` hace `tx.patient.delete` físico y cascada `EvaScore`/`PatientFile`/
  `Coverage`/`EmergencyContact`/`PatientShare`, dejando turnos huérfanos (`SetNull`) y rompiendo la
  facturación histórica — **conviviendo** con `setPatientArchived` (`archivedAt`) que ya provee
  borrado lógico. Son dos caminos deliberados co-presentados en el mismo modal ("Archivar" vs
  "Eliminar definitivamente"). **No** eliminar la función: falta un **gate de rol**.
  Legal AR (Ley 26.529, retención de HC) hace esto sensible (bucket D).
- **Acción:** gate de rol OWNER/ADMIN en `deletePatient` (y en `deleteProgram`/`deleteSession`,
  menor `program-session-hard-delete`), reusando el patrón de `assignPatientToPractitioner`. → sesión
  `patients-integridad` (gate mínimo E1) → residual soft-delete wholesale en `soft-delete-wholesale` (E2).

### <a id="f-b7"></a>F-B7 — `sin-error-loading-boundaries` · No existe ningún error/loading boundary en toda la app
- **Ubicación:** `app/` (0 archivos `error.tsx`/`loading.tsx`/`global-error.tsx`/`not-found.tsx`; 0 `Suspense`/`ErrorBoundary`)
- **Clase:** C-UX-05 · **Bucket:** B → A (creación) · **Severidad:** alta → **media**
- **Descripción:** un fallo de datos en un Server Component (permiso, timeout, Prisma) explota en la
  pantalla default de Next ("Application error", en inglés, sin retry). El tercer estado
  (error-con-retry) no está cubierto a nivel de ruta. Skeleton solo en `patient-profile.tsx`.
- **Acción:** boundaries por route-group + `not-found.tsx`/403 en español con retry. → sesión
  `error-loading-boundaries`.

### <a id="f-b8"></a>F-B8 — `h2-oversized-components` · Componentes gigantes
- **Ubicación:** `patient-profile.tsx` (2341), `agenda-client.tsx` (2157), `diagnostico-screen.tsx` (1627), `configuracion-client.tsx` (1581), `public-booking-wizard.tsx` (1064), `biblioteca-client.tsx` (1042)
- **Clase:** deuda estructural · **Bucket:** B · **Severidad:** **alta** (bloquea testeo/mantenimiento y el trabajo paralelo)
- **Descripción:** difíciles de testear y de tocar en paralelo. Son el **cuello de botella de
  ownership** de todo el plan: muchos findings tocan `agenda-client.tsx` y `patient-profile.tsx`.
- **Acción:** trocear por tab/modal ANTES de que multi-profesional/realtime/soft-delete los toquen
  en paralelo. → Ola 2.0 (`split-agenda-client`, `split-patient-profile`, `split-diagnostico-screen`,
  `split-configuracion-y-wizard`). Cubre menores `deuda-archivos-grandes`, `provider-value-inline-bulk-select`.

### <a id="f-b9"></a>F-B9 — `no-test-suite` / `no-ci-triple-gate` / `c2-no-tests-ci` · Cero tests, cero CI
- **Ubicación:** `package.json` (sin runner ni script `test`); sin `.github/workflows/`
- **Clase:** C-TEST · **Bucket:** B · **Severidad:** crítica → **alta**
- **Descripción:** la única verificación es `tsc` + `next build` a mano. Regresiones en
  booking/copago/auth/RLS —justo las costuras de dinero y PHI— llegan a prod sin red. La pirámide de
  4 capas del manual está vacía.
- **Acción:** paso 1 barato y de alto valor (Etapa 1): CI `typecheck` + `build` como required check
  + vitest capa-1 sobre helpers YA correctos (`datetime-ar`, `format`, `resolveBookingCopagoCents`)
  para congelar la fundación **antes** de los fixes de tz. Suite completa en Ola 2.1. → sesiones
  `ci-gate-minimo` (E1) y `suite-integracion`/`ci-pipeline-completo-y-guard` (E2).

### <a id="f-b11"></a>F-B11 — `no-static-security-guard` · Falta el guard estático de seguridad en CI
- **Ubicación:** `lib/db.ts:29`, `policies.sql`, `schema.prisma` (3 listas de tablas mantenidas a mano que ya divergieron)
- **Clase:** C-SEC-08 / C-DB-07 · **Bucket:** B · **Severidad:** **alta** (pieza de mayor apalancamiento del estándar de testing)
- **Descripción:** schema (20 modelos con `tenantId`), `TENANT_SCOPED_MODELS` (9) y `policies.sql`
  (17) deben sincronizarse a mano y ya divergieron (F-B2). Nada mecánico falla el build cuando una
  tabla nueva con `tenantId` queda fuera de RLS/auto-filtro, ni cuando el admin client aparece fuera
  de allowlist.
- **Acción:** `scripts/guard-tenant-isolation.mjs` (Node, sin deps) que parsea las 3 fuentes y falla
  ante drift. → sesión `ci-pipeline-completo-y-guard` (Ola 2.1). Detalle en [TESTING.md](TESTING.md).

### <a id="f-b12"></a>F-B12 — `no-saas-billing-charge-clinic` · No existe billing SaaS para cobrarle al consultorio
- **Ubicación:** `lib/mercadopago.ts` (solo checkout de turnos del paciente)
- **Clase:** gap de producto · **Bucket:** B · **Severidad:** **alta** (sin esto no hay SaaS vendible)
- **Descripción:** MP se usa exclusivamente para el copago del paciente. No hay modelo `Subscription`,
  ni preapproval/pago recurrente del tenant, ni facturas de suscripción, ni webhook que active/
  desactive el plan del consultorio. Regla de dominio del dueño: *cada consultorio paga su plan; los
  profesionales no son quienes pagan.*
- **Acción:** modelo `Subscription(tenantId, plan, mpPreapprovalId, status, currentPeriodEnd, seats)`
  + integración MP Preapproval separada del checkout de turnos. → Ola 2.4 (`subscription-entitlements`,
  `mp-preapproval-webhook`, `paywall-trial-ui`, `seats-limits`).

### <a id="f-b13"></a>F-B13 — `plan-fields-inert-no-upgrade-no-enforcement` · Los campos de plan del tenant están inertes
- **Ubicación:** `prisma/schema.prisma:28-30` (`plan`/`subscriptionStatus`/`trialEndsAt`)
- **Clase:** gap de producto · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** cero escrituras a esos campos: sin upgrade, sin paywall, sin lectura de
  `PAST_DUE`/`CANCELLED`/`trialEndsAt` para bloquear acceso. Todo tenant queda en `FREE` para
  siempre; `SubscriptionStatus` es decorativo. El único consumidor del plan es el catálogo de
  ejercicios (`lib/plan-gating.ts`).
- **Acción:** al implementar billing, cablear upgrade/downgrade + `tenantEntitlements()` +
  gate en layout que degrade/bloquee. → Ola 2.4.

### <a id="f-c1"></a>F-C1 — `c1-ratelimit-inmemory` · El rate-limit cae a in-memory en Vercel
- **Ubicación:** `lib/rate-limit.ts:32-38`; env de Vercel
- **Clase:** C-SEC-09 · **Bucket:** C (config del dueño, sin cambio de código) · **Severidad:** crítica → **alta**
- **Descripción:** sin `UPSTASH_REDIS_REST_URL/_TOKEN`, `rateLimit()` usa `memory()`: cada isolate de
  Vercel tiene su propio `Map` y los cold starts resetean contadores → las superficies públicas
  (booking, slots, webhook, check-in) quedan **sin protección real**. El código ya rutea a Upstash
  correctamente cuando las env están; el fallback a memory ante error de transporte **debe
  preservarse**.
- **Acción:** setear las env de Upstash en Vercel prod. → [EXTERNAL-CONFIG.md](EXTERNAL-CONFIG.md) ítem Upstash.

---

## 2. Checklist maestro (todos los findings) — estado vivo

Estado: 🔴 ABIERTO · 🟢 CERRADO · ⏸ DIFERIDO-CON-GATE. Todos abren en 🔴 salvo indicación.
La columna **Sesión** referencia el [ROADMAP.md](ROADMAP.md).

### Confirmados (24)

| Slug | Sev | Bkt | Ubicación | Estado | Sesión |
|---|---|---|---|---|---|
| booking-hard-delete-payment-cascade | crítica | B | lib/bookings.ts:594 | 🔴 | delete-guard-booking |
| c3-payment-amount | alta | A | lib/mercadopago.ts:183 | 🔴 | payment-amount-anclado |
| public-booking-slots-host-tz | alta | A | lib/public-booking.ts:113 | 🔴 | fix-public-booking-tz |
| timeline-oncreate-wrong-day-hour | alta | A | agenda-client.tsx:738 | 🔴 | fix-timeline-oncreate |
| suggest-next-free-slot-host-tz | alta | A | lib/bookings.ts:246 | 🔴 | fix-bookings-tz |
| seguimiento-today-bucket-and-display | alta | A | seguimiento/page.tsx:15 | 🔴 | tz-vistas |
| search-booking-toLocale-no-tz | alta | A | lib/search.ts:140 | 🔴 | tz-vistas |
| portal-session-date-no-tz | media | A | portal/c/[slug]/page.tsx:193 | 🔴 | tz-vistas |
| login-sin-feedback-error | alta | A | login-screen.tsx:189 | 🔴 | login-error-feedback |
| practitioner-userid-unique-blocks-multitenant | alta | A | schema.prisma:123 | 🔴 | practitioner-multi-tenant |
| tenant-tables-sin-rls-ni-filtro | media | B | policies.sql | 🔴 | policies-tablas-faltantes |
| rls-bypassed-by-superuser-role | media | B | .env / docker-compose | 🔴 | rol-db-sin-bypassrls |
| runwithrls-solo-en-2-modulos | media | B | lib/rls.ts:19 | 🔴 | cliente-tenant-unico-guc |
| booking-overlap-race-no-cas-no-unique | media | B | lib/bookings.ts:301 | 🔴 | booking-concurrencia |
| patient-hard-delete-cascades-hc | media | B | lib/patients.ts:875 | 🔴 | patients-integridad → soft-delete-wholesale |
| sin-error-loading-boundaries | media | B | app/ | 🔴 | error-loading-boundaries |
| h2-oversized-components | alta | B | components varios | 🔴 | split-* (Ola 2.0) |
| no-test-suite | alta | B | package.json | 🔴 | ci-gate-minimo → suite-integracion |
| no-ci-triple-gate | alta | B | package.json | 🔴 | ci-gate-minimo → ci-pipeline-completo-y-guard |
| c2-no-tests-ci | alta | B | package.json | 🔴 | ci-gate-minimo |
| no-static-security-guard | alta | B | lib/db.ts:29 | 🔴 | ci-pipeline-completo-y-guard |
| no-saas-billing-charge-clinic | alta | B | lib/mercadopago.ts | 🔴 | mp-preapproval-webhook |
| plan-fields-inert-no-upgrade-no-enforcement | media | B | schema.prisma:28 | 🔴 | subscription-entitlements |
| c1-ratelimit-inmemory | alta | C | lib/rate-limit.ts:38 | 🔴 | (EXTERNAL-CONFIG: Upstash) |

### Menores (63) — agrupados por tema

**Timezone (bucket A, sweep de fechas):**

| Slug | Sev | Ubicación | Sesión |
|---|---|---|---|
| dashboard-buckets-utc | media | lib/dashboard.ts:371 | tz-dashboard |
| mini-calendar-days-getdate-utc | media | lib/dashboard.ts:514 | tz-dashboard |
| dashboard-page-getmonth-utc | baja | dashboard/page.tsx:13 | tz-dashboard |
| mini-calendar-today-browser-tz | baja | mini-calendar.tsx:18 | tz-dashboard |
| notifications-bell-no-tz | baja | notifications-bell.tsx:250 | tz-dashboard |
| pacientes-lastvisit-no-tz | media | pacientes/page.tsx:326 | tz-vistas |
| session-detail-no-tz | baja | session-detail.tsx:121 | tz-vistas |
| public-booking-wizard-today-utc | baja | public-booking-wizard.tsx:606 | fix-public-booking-tz |
| agenda-client-emptyslot-sethours | baja | agenda-client.tsx:738 | fix-timeline-oncreate |
| getdaycounts-utc-slice | baja | lib/bookings.ts:163 | fix-bookings-tz |
| plan-startdate-utc-midnight | media | lib/diagnosis.ts:219 | tz-server-exports |
| ics-export-week-window-host-tz | media | agenda/export/route.ts:17 | tz-server-exports |

**Integridad / concurrencia (bucket A/B):**

| Slug | Sev | Ubicación | Sesión |
|---|---|---|---|
| conflict-findfirst-sin-orderby | media | lib/bookings.ts:301 | booking-concurrencia |
| batch-fuera-de-runwithrls | media | lib/bookings.ts:755 | cliente-tenant-unico-guc |
| batch-create-overlap-race-and-no-rls | media | lib/bookings.ts:734 | booking-concurrencia + cliente-tenant-unico-guc |
| booking-paid-toggles-no-optimistic-lock | baja | lib/bookings.ts:620 | booking-concurrencia |
| mp-webhook-idempotency-check-outside-tx | baja | lib/mercadopago.ts:193 | payment-amount-anclado |
| session-index-no-unique-constraint | baja | schema.prisma:715 | soft-delete-wholesale |
| program-session-hard-delete | media | lib/patients.ts:1316 | patients-integridad → soft-delete-wholesale |
| session-totalsessions-read-modify-write | baja | lib/patients.ts:1347 | patients-integridad |
| retroactive-copago-on-coverage-replace | media | lib/patients.ts:1053 | copago-snapshot |
| coverage-sin-schema-zod | media | lib/patients.ts:1015 | patients-integridad |

**Seguridad / config / observabilidad:**

| Slug | Sev | Ubicación | Sesión / Gate |
|---|---|---|---|
| sin-headers-seguridad-csp | media | next.config.mjs | headers-seguridad |
| serveractions-allowedorigins-localhost | baja | next.config.mjs | headers-seguridad |
| checkout-practitionerid-sin-validar | media | booking/checkout/route.ts:61 | payment-amount-anclado |
| upload-sin-magic-bytes | media | lib/files.ts:118 | files-magic-bytes |
| password-sin-complejidad | baja | lib/auth.ts:53 | password-policy (+ Supabase) |
| rate-limit-inmemory-activo-prod | media | lib/rate-limit.ts:32 | EXTERNAL-CONFIG: Upstash |
| m1-sentry-no-wired | media | lib/logger.ts:6 | sentry-observabilidad |
| sentry-no-cableado | media | lib/logger.ts:6 | sentry-observabilidad |
| m2-silent-catches | media | notifications-internal.ts:37 | sentry-observabilidad |
| audit-fire-and-forget | media | audit-extension.ts:74 | sentry-observabilidad |
| m3-no-apm | media | — | ⏸ gate: ≥5 tenants o incidente p95 |
| l2-no-virus-scan | baja | lib/files.ts:33 | ⏸ gate: antes de upload de pacientes |
| public-slots-ratelimit-vacio | media | lib/public-booking.ts:95 | fix-public-booking-tz |
| gettenantprisma-dead-code | media | lib/db.ts:76 | cliente-tenant-unico-guc |
| rls-coverage-gaps | media | policies.sql:32 | policies-tablas-faltantes |
| sin-test-tripwire-aislamiento | media | schema.prisma:19 | suite-integracion |

**UX / forms / calidad de código:**

| Slug | Sev | Ubicación | Sesión |
|---|---|---|---|
| native-confirm-alert | media | configuracion-client.tsx:1449 | configuracion-ux |
| basics-sin-feedback-exito | media | configuracion-client.tsx:185 | configuracion-ux |
| statustag-no-exhaustivo | media | agenda-client.tsx:1266 | agenda-visibilidad-statustag |
| statustag-label-drift | baja | agenda-client.tsx:1271 | agenda-visibilidad-statustag |
| turnos-fuera-de-horario-o-media-hora-no-visibles | media | agenda-client.tsx:1046 | agenda-visibilidad-statustag |
| formateadores-moneda-duplicados | media | agenda-client.tsx:95 | agenda-visibilidad-statustag + split-patient-profile |
| export-type-en-use-server | baja | lib/dashboard.ts:32 | extraccion-logica-pura |
| logica-en-use-server-y-cliente | media | lib/public-booking.ts:149 | extraccion-logica-pura |

**Deuda estructural / SaaS / docs:**

| Slug | Sev | Ubicación | Sesión / Gate |
|---|---|---|---|
| deuda-archivos-grandes | media | components varios | split-* (Ola 2.0) |
| role-gating-disperso-sin-matriz-central | media | lib/services.ts:30 | capabilities-matrix |
| roles-assistant-billing-cosmeticos | media | schema.prisma:108 | roles-assistant-billing |
| no-seat-usage-limits | media | lib/plan-gating.ts:36 | seats-limits |
| no-realtime-agenda-compartida | media | lib/cache-tags.ts:54 | realtime-agenda |
| portal-auth-por-email-no-userid | media | lib/portal.ts:52 | portal-userid-link |
| patient-tenancy-single-home-row | baja | schema.prisma:250 | ⏸ gate: 1er paciente en 2 tenants |
| l1-portal-minimo | baja | lib/portal.ts:1 | Portal v2 (Ola 2.6) |
| scripts-adhoc-como-tests | baja | scripts/create-tenant.ts:1 | suite-integracion |
| no-qa-checklist-versionado | baja | — | ✅ esta pasada (TESTING.md) |
| roadmap-vacio | media | docs/roadmap.md | ✅ esta pasada (ROADMAP.md) |
| doc-memory-inexistente | baja | CLAUDE_CODE_SKILLS.md:61 | docs-baseline |
| doc-rls-adopcion-stale | baja | AUDIT.md:44 | ✅ esta pasada |
| doc-falta-checklist-seguridad | media | SECURITY.md | ✅ este AUDIT.md |
| doc-falta-catalogo-bugs | baja | — | ⏸ gate: catálogo propio post-Etapa 1 |
| doc-falta-qa-conv-testing | baja | — | ✅ TESTING.md (parcial: convenciones diferidas) |

### Ítems nuevos de esta pasada (features + hallazgos incidentales)

| Slug | Sev | Ubicación | Sesión |
|---|---|---|---|
| invitation-token-en-claro | media | lib/invitations.ts:161 | invitation-token-hash |
| money-input-sin-parser-ar | media | configuracion-client.tsx:565, agenda-client.tsx:218 | money-input-parser |
| dicom-fuera-de-allowlist | baja | lib/files.ts:33 | booking-adjuntos |
| sin-not-found-403-custom | baja | app/ | error-loading-boundaries |
| sin-sitemap-robots | baja | app/ | seo-analytics |

---

## 3. Ítems del audit anterior (2026-06-18) — CERRADOS 🟢

Verificados como resueltos en el código actual (no vuelven como findings):

- **Optimistic concurrency** (`expectedUpdatedAt`) en `lib/bookings.ts` (6 usos) — update/delete/setStatus.
- **`updateBooking` transaccional** bajo `runWithRls` (TOCTOU cerrado).
- **Coverage reads deterministas** (order by `id` desc) y `resolveInsurerName` para free-form.
- **Catches genéricos de acción loguean** (`logger.error`): createBooking, createPatient, updatePatient,
  createService, createInsurer. (El residual de M2 son solo los catches de `notifications-internal.ts`
  y `audit-extension.ts` → menor `m2-silent-catches`.)
- **Webhook MP:** firma requerida siempre que `MP_WEBHOOK_SECRET` esté seteado, prod 503 sin secret,
  replay 5 min, consumo idempotente, payload redactado.
- **Middleware** strippea `x-tenant-slug` **y** `x-tenant-id`; auth callback gatea `email_confirmed_at`
  + no re-bind (anti-takeover).
- **RLS avanzó** respecto del snapshot de junio: `patients.ts` migrado a `runWithRls` (H1 sigue
  abierto solo para sessions/exercises/conditions/services/insurers → absorbido por
  `cliente-tenant-unico-guc`).

---

## 4. Findings refutados (verificación adversarial)

- **`h1-rls-optin`** (enunciado original: "sessions/exercises/conditions/services/insurers no usan
  `runWithRls`"). **Refutado como estaba redactado**: sobre-alcanzado y con severidad inflada. Tiene
  un núcleo real (esos módulos no tienen backstop RLS) que se absorbe en `cliente-tenant-unico-guc`,
  pero el problema de fondo no es "opt-in" sino que **RLS está globalmente inerte** (§0) — cambia el
  diagnóstico, no solo el scope.
- **`h3-etapa2-stub`** (enunciado: "módulo Etapa-2 parcialmente stub"). **Refutado**: 2 de 4 síntomas
  son falsos contra el código real y la severidad alta está inflada — es un **feature-gap
  planificado**, no un bug. El residual real (falta UI de autoría condición↔ejercicio) se planifica
  como épica `guia-diagnostico-completa` (Etapa 3), no como finding de auditoría.

---

## 5. Inventario de "preservar" (patrones correctos — NO regresar en el hardening)

Estos patrones están bien hechos. Todo prompt de sesión que toque su área debe incluir el preserve
correspondiente: el riesgo mayor de sesiones chicas en paralelo es que un agente "arregle" algo que
era intencional.

1. **`lib/rls.ts`** — `runWithRls` setea `app.current_tenant_id` vía `set_config(..., true)` local a
   la transacción. No romper la semántica local-a-tx.
2. **`lib/session.ts`** — `getActor()` throws / `tryGetActor()` null; demo actor gateado por
   `KINESOFT_ALLOW_DEMO_ACTOR` + `NODE_ENV !== "production"` + tenant `movare`. No relajar el gate.
3. **`middleware.ts:45-46`** — borra `x-tenant-slug` y `x-tenant-id` de cada request y solo re-setea
   `x-tenant-slug` para `/c/<slug>` y subdominios (anti-smuggling). Preservar el orden delete-then-set.
4. **`lib/mercadopago.ts`** — firma HMAC-SHA256 con `timingSafeEqual`, ventana de replay 5 min,
   `consumeWebhook` idempotente por `(externalId, status)`, `redactPayload` allow-list; prod 503 sin
   `MP_WEBHOOK_SECRET`. No reintroducir carve-out por `NODE_ENV` en la firma.
5. **`lib/billing-internal.ts`** — `resolveBookingCopagoCents` con precedencia estricta nullable
   (`Booking.copagoCents` → `Coverage.copagoCents` → insurer → Particular → service); 0 es
   intencional. Fuente única de copago. No duplicar el cálculo.
6. **`lib/visibility.ts`** — `patientAccessFor`/`bulkPatientAccess`; PHI **nulificado en la
   proyección**, no solo oculto en UI; sin N+1. No mover el corte de acceso a la capa de UI.
7. **`lib/bookings.ts`** — `expectedUpdatedAt` (optimistic concurrency, 6 usos); mutaciones bajo
   `runWithRls`. No quitar el chequeo de `updatedAt`.
8. **`app/auth/callback/route.ts`** — linkea `Patient` solo si `email_confirmed_at` y (`userId==null`
   o ya coincide); nunca re-bindea un `Patient` ya linkeado (anti-takeover).
9. **`lib/files.ts`** — `ALLOWED_MIME`, `SAFE_EXT_RE /^[a-z0-9]{1,8}$/` contra traversal,
   `getDownloadUrl` audita cada URL firmada. Mantener el audit por descarga.
10. **`lib/insurers-internal.ts`** — `resolveInsurerName` normaliza y linkea free-form al catálogo
    (server-only).
11. **`lib/datetime-ar.ts`** — helpers AR fijos UTC−3 sin DST (`localToARIso`, `toARDateKey`,
    `toARDow`, `toARHour`). **Correcto en su totalidad.** Toda lógica wall-clock debe pasar por acá.
    **Excepción a respetar:** el round-trip UTC-midnight de `dateOfBirth` (`<input type="date">`) NO
    debe recibir tz AR.
12. **`lib/*-internal.ts`** — billing/insurers/public-booking/notifications con `import "server-only"`;
    no exponerlos como RPC (`"use server"`).
13. **`lib/rate-limit.ts`** — ruta Upstash con `INCR`+`PEXPIRE NX` correcta; solo cae a `memory()` sin
    config o ante error de transporte. La tabla de límites de SECURITY.md §8 coincide 1:1 con el código.
14. **`lib/audit-extension.ts`** — extensión Prisma que audita reads sobre `PHI_MODELS` tras resolver
    la query. Preservar (aunque su catch debe loguear → `m2-silent-catches`).
15. **`vercel.json`** — `buildCommand` con `prisma migrate deploy && prisma generate && next build` +
    region `gru1`; `directUrl=env("DIRECT_URL")`. Auto-migración en deploy correcta.
16. **`package.json`** — scripts `prisma:*` envueltos con `dotenv -e .env.local` (evitan el footgun de
    pegarle a Supabase prod); `db:deploy` separado. `tsconfig` strict sin `noUnusedLocals`, excluye
    `scripts`.
17. **Anticipos de diseño ya presentes** — `Booking.seriesId` poblado para regrupar series sin
    migración destructiva; enum `Role` con ASSISTANT/BILLING/ENTERPRISE mirando al futuro; schema
    100% dinero en `*Cents Int`. No revertir.

---

## 6. Anexo — Estado de superficies para las features nuevas

Inventario factual (EXISTE-COMPLETO / EXISTE-PARCIAL / NO-EXISTE) de lo que ya hay para las 5
features grandes que el dueño sumó. Alimenta las olas 2.6-2.8 del ROADMAP.

**A · Cuentas de paciente + Portal — EXISTE-PARCIAL**
- Invitación de **profesional** (Membership): completa (`lib/invitations.ts`, `app/invite/[token]`).
  Token válido 7 días, un solo uso (`acceptedAt`), email debe coincidir. ⚠️ **token en claro**
  (`randomBytes(24).base64url`, buscado literal) → finding `invitation-token-en-claro`.
- Invitación de **paciente** al portal: existe pero por otro mecanismo (`sendPatientPortalInvite` →
  `supabase.auth.admin.inviteUserByEmail`, sin fila `Invitation`); vínculo por email en el callback.
- **Signup self-serve de paciente: NO-EXISTE** (solo entra por Google + email pre-cargado por el kine).
- **OAuth: solo Google** (`app/api/auth/google`). Apple/Meta: NO-EXISTE.
- CRUD de miembros en panel del tenant: completo. **Reset de password admin→otro miembro: NO-EXISTE.**
- Portal actual (mobile-first, <150kB): home con próximos turnos, `/me` solo-lectura, `/c/[slug]` con
  plan activo + check-in EVA + timeline de sesiones. Auth **por email match, no por `Patient.userId`**.
  NO existe: confirmar/cancelar/reagendar, cambio de contraseña, HC visible, datos personales
  editables, historial de planes, ejercicios/guías.

**B · Adjuntos en booking — EXISTE-PARCIAL**
- Mensaje descriptivo: **existe** (`Booking.notes`, textarea "Motivo de consulta" en el wizard,
  `z.string().max(1000)`).
- **Upload de archivos en el wizard: NO-EXISTE.** El upload (`lib/files.ts`, 25 MB, MIME allow-list)
  es solo del lado profesional (`archivos-view.tsx`). **DICOM/.dcm NO está** en el allow-list.

**C · Timeline de HC — EXISTE-PARCIAL**
- Perfil de paciente (profesional): 9 tabs (Resumen, Turnos, Sesiones, Plan, Archivos, Antecedentes,
  Evolución/EVA, Facturación, Actividad). **No hay vista timeline cronológica unificada.**
- Notas clínicas: campo libre `Patient.notes` (no hay modelo de nota por evento). EVA: `EvaScore`.
  El único timeline cronológico vive en el **portal**, no en el perfil profesional.

**D · Tickets / owner panel / contacto — mayormente NO-EXISTE**
- Sin formulario de contacto en la landing (`landing-screen.tsx` tiene copy pero ningún `<form>`).
- Sin `not-found.tsx`/error/403 custom (caen al default de Next).
- **Sin panel de owner/superadmin de plataforma** (el enum `Role` es tenant-scoped; no hay concepto
  cross-tenant). Sin modelo `Ticket`/`Report`/`Feedback`. Sin analytics (GA/Vercel). SEO parcial
  (`metadata` sí; sin `sitemap.ts`/`robots.ts`/`manifest`).

**E · Dinero — EXISTE-PARCIAL**
- Schema 100% `*Cents Int` (sin `Float`/`Decimal`). ✅
- **Inputs sin parser AR:** `Number(...) * 100` en `configuracion-client.tsx:565,778,779` y
  `agenda-client.tsx:218`. `"1.500,50"` (formato AR) daría `NaN`/valor incorrecto. `lib/format.ts`
  solo formatea salida (`formatARS`), **no hay `parseARS`/normalizador de entrada** → finding
  `money-input-sin-parser-ar`. Precondición del módulo contable de Etapa 3.

---

## Bottom line

El núcleo está bien construido y las áreas de riesgo son **conocidas y acotadas**. La causa raíz es
arquitectónica (RLS inerte, §0), no una lista de bugs sueltos. **Antes de abrir a clientes que
pagan:** cerrar los bugs QA de agenda (F-A2/A3/A4), anclar el pago (F-A1/F-B1), rate-limit real
(F-C1), CI + tests capa-1 (F-B9), y el checklist de corte a producción del [ROADMAP.md](ROADMAP.md).
Todo lo demás escala incrementalmente por olas.
