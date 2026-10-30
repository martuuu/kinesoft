# KineSoft — Estándar de testing (diagrama de la suite)

> **Qué es este documento.** El diseño de la suite de tests de KineSoft — la Parte 4 del
> [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md) instanciada para este producto. **Es un diagrama,
> no la implementación:** define las capas, qué se testea en cada una, los guards estáticos y el
> checklist de QA manual. La implementación se ejecuta en las sesiones `ci-gate-minimo` (capa 1) y
> `suite-integracion` / `ci-pipeline-completo-y-guard` (capas 3-4 + guards) del [ROADMAP.md](ROADMAP.md).
>
> **Estado actual (01-oct-2026, cierre de B-pre; los conteos de ES1 y ES2a están en los gates de AUDIT §Ronda 14 y 15):**
> - **Unit (capa 1):** **1156 tests en 51 archivos** (`tests/unit/*`), sin DB ni red. Corren en CI y deben pasar
>   con `TZ=UTC` **y** con `TZ=America/Argentina/Buenos_Aires`. Al cierre del Bloque A eran 252/19. B-pre sumó el
>   motor (`availability-{day,ranges,slots,classify,next-free,recurrence}`), `public-booking-engine`,
>   `booking-schedule` (caracterización), `capabilities`, `catalog-{normalize,import-core,data}`, `agenda-layout`,
>   `reception-state`, `schedule-validate` y los estados puros de la UI (`*-state.test.ts`).
> - **Render tests (capa 2 liviana):** `tests/unit/render/*.test.tsx` (agenda-client, practitioner-day-view,
>   day-lock, reception-view, public-booking-wizard) con `renderToStaticMarkup` en entorno node, sin jsdom ni
>   testing-library (`vitest.config.ts`: `esbuild: { jsx: "automatic" }` + include de `*.test.tsx`). Afirman el
>   markup visible (columnas, ocupación, badges, estados), no la interacción.
> - **Integración (capa 3):** **28 archivos en `tests/integration/`, 395 tests** (rol `kinesoft_app`; con owner
>   BYPASSRLS, 379 + 16 skip). Al cierre del Bloque A eran 13/175. B-pre sumó `agenda-backfill`, `agenda-defaults`,
>   `authz`, `availability-actions`, `availability-loader`, `bookings-availability`, `bookings-reception`,
>   `catalog-admin`, `catalog-import`, `catalog-tenant`, `day-lock`, `locations-schedule`, `practitioner-config`,
>   `tenant-business-hours` y `time-blocks`. Corre las **server actions reales** con `getActor()` real; solo se
>   mockean la cookie/headers, la red de Supabase (+ el admin client, para que ningún test mande mails reales) y
>   el runtime de cache de Next (`tests/helpers/integration-setup.ts`). CI la corre con **los dos roles**.
> - **E2E (capa 4):** Playwright (OPS-6, 18-oct): **49 tests en 19 specs** al cierre de T6/T7 (23-oct; + el login del
>   proyecto `setup`) (`tests/e2e/`), `npm run test:e2e`. Ver «Capa 4». Los conteos de unit e integración de arriba son
>   del 01-oct: al 23-oct hay 463 archivos de unit y 274 de integración (los números de tests, en el gate de cada ronda).
> - **CI:** typecheck → unit (TZ=UTC y TZ=AR) → guard → build → reporte de bundle; y el job `integration`
>   (Postgres efímero, migraciones desde cero, rol app + owner). En todas las PR y ramas de trabajo.
> - **Performance:** baseline de A1 y multi-profesional de B4.6 en [PERF.md](PERF.md) (`npm run test:perf`, solo
>   local). Agenda multi: `npm run test:perf -- tests/perf/agenda-multi.perf.test.ts`.
> - **Catálogo:** `npm run catalog:import` (dry-run contra el Docker local; `-- --apply` escribe). Los tests de
>   integración corren el import solo contra local. tsc de `scripts/`: `npx tsc -p scripts/tsconfig.json --noEmit`
>   (el tsconfig raíz excluye `scripts/`).

### Cómo correr la integración (A1.1)

```bash
docker compose up -d db                      # Docker :5433 con las migraciones aplicadas
npm run test:integration                     # rol kinesoft_app (RLS aplicada)
npm run test:integration:owner               # owner BYPASSRLS (= prod hoy); el tripwire RLS se saltea avisando
npm run test:integration -- <archivo|patrón> # uno solo
```

- La fábrica (`tests/helpers/tenant-factory.ts`) crea tenants efímeros con el cliente owner y los borra en orden
  explícito. La limpieza vieja fallaba siempre en silencio y dejaba tenants huérfanos.
- Identidad del actor por test: `asUser(userId)` (`tests/helpers/actor.ts`).
- Algunos comportamientos difieren según el rol: `appRoleBypassesRls()` (`tests/helpers/db-role.ts`).

### Contrato A2: bugs conocidos escritos como `it.fails` — ✅ todos dados vuelta (30-sep-2026)

A1.1 los escribió con la expectativa **correcta** (fallaban por la aserción, no por setup). A2 los dio vuelta a
`it(...)` como parte del gate de cada sesión; ya no queda ningún `it.fails` en `tests/` y la matriz
`authz-matrix` no tiene filas con `failsUntil`. Los títulos conservan el prefijo `[sesión]` para rastrearlos.

| Sesión | Test | Archivo | Estado |
|---|---|---|---|
| A2-S06 · H1 | `deleteBooking` de un turno con copago cobrado a mano → rechaza | bookings-write | ✅ |
| A2-S06 · H1 | `deleteBooking` de un turno con la OS confirmada → rechaza | bookings-write | ✅ |
| A2-S06 | toggle de cobro con `expectedUpdatedAt` viejo → rechaza | bookings-write | ✅ |
| A2-S06 | reactivar un CANCELLED sobre cupo lleno → pide sobreturno | bookings-write | ✅ |
| A2-S06 | alargar la duración sobre cupo lleno → pide sobreturno | bookings-write | ✅ |
| A2-S06 | `createBookingsBatch` con paciente de otro tenant → rechaza sin escribir | bookings-write + authz-matrix | ✅ |
| A2-S06 | `createBooking` con profesional de otro tenant → rechaza sin escribir | bookings-write + authz-matrix | ✅ |
| A2-S06 · `p2002-target-null-bajo-rls` | bajo RLS, el P2002 con `target: null` da el mensaje accionable, no un segundo turno | bookings-write | ✅ |
| A2-S08 · H2 | re-guardar la misma obra social conserva `Coverage.copagoCents` | patient-coverage | ✅ |
| A2-S08 | `updatePatient` con email vacío lo borra | patient-coverage | ✅ |
| A2-S08 | preview de copago del modal = lo que cobra el turno (OS libre) | patient-coverage | ✅ |

### Convenciones nuevas de A2/A3

- **Webhook de MP por la ruta firmada** (`tests/integration/mp-webhook.test.ts`): el test llama al `POST` real de
  `app/api/webhooks/mercadopago/route.ts` con una firma HMAC real (secreto de test) → `verifyWebhookSignature` →
  `consumeWebhook` → Postgres. Lo único mockeado es el SDK `mercadopago` (`Payment.get`, el detalle del pago) y el
  rate-limit. No se llama a `consumeWebhook` directo: se saltearía la firma y el anti-replay.
- **Rate-limit en integración:** los tests que mandan dos veces al mismo destinatario (invitaciones, portal)
  llaman a `__rateLimitInternals.reset()` (`lib/rate-limit.ts`) entre llamadas, porque el bucket de 1 cada 10 min
  por destinatario es compartido y el segundo caso daría "Probá de nuevo en N s". En unit, `rate-limit.test.ts`
  mockea `fetch` para Upstash (error de red → fallback, timeout, respuesta inválida, purga, claves compuestas).
- **Reloj explícito:** `isHoldingCapacity`, `buildPublicSlots`, `paymentHoldState` y `listOpenSessions` reciben
  `now`; los tests lo fijan en TZ=UTC en vez de mockear `Date`.

### Patrones nuevos de B-pre

- **Oráculo literal + paridad.** Antes de reemplazar un camino viejo se lo congela como oráculo
  (`lib/booking-schedule.ts` = el código de ef3281f, caracterizado en `tests/unit/booking-schedule.test.ts`) y el
  nuevo se compara contra él sobre una **matriz** (horarios × duraciones × cupos × sets de turnos) y una **semilla**
  aleatoria fija: `nextFreeSlot` ↔ suggest viejo, `buildPublicSlots` viejo ↔ nuevo, barrido optimizado ↔
  `classifyInstant` paso a paso. `tests/unit/public-slots.test.ts` quedó **sin cambios**. El oráculo no recibe
  callers nuevos: se borra en el contract.
- **Carrera determinística con `pg_locks`.** Para probar un lock sin `sleep`: la tx A toma el lock y queda abierta;
  la B se lanza y el test espera (polling) a ver una fila `pg_locks` con `locktype = 'advisory' AND NOT granted`;
  recién ahí A commitea y se afirma que B vio la fila de A (`tests/integration/bookings-availability.test.ts:441`).
  Sin el lock, el test falla siempre, no a veces.
- **Test que lee el SQL de la migración.** `tests/integration/agenda-backfill.test.ts` extrae del archivo de la
  migración el bloque entre `>>> BACKFILL agenda_foundations BEGIN` y `<<< … END`, lo parte por `;` y lo ejecuta
  contra tenants efímeros (acotado con el GUC `kinesoft.backfill_tenants`): prueba el SQL literal que corre en prod,
  la idempotencia (segunda corrida = 0 cambios) y que `updatedAt` no se toca. Regla del bloque: sin `;` dentro de
  una sentencia.
- **Barrido de tenants de test** solo de más de 30 min (`sweepOrphanTestTenants`, `tests/helpers/tenant-factory.ts:208`):
  con varias corridas a la vez, un barrido más agresivo borraba el tenant de otra corrida en curso.
- **Gate de integración en solitario:** el gate de ola corre la integración sin otras sesiones usando el mismo
  Docker (comparten la base: tests de carrera y de conteo se contaminan con la corrida vecina).

### Patrones nuevos de ES2a (M1 `plans_booking_link`, 04-oct-2026)

- **Fixtures de Planes por insert directo:** `tests/helpers/plan-factory.ts` (planes, sesiones, turnos vinculados y un
  **fixture legacy**: `totalSessions` ≠ filas, 00:00Z, sin `practitionerId`) con el cliente owner. No pasa por actions:
  un test de schema tiene que probar que **la base** rechaza, no la validación de una action. `deleteTenantDeep` borra
  `ProgramAuthorization` y `PatientChangeRequest` antes que planes y pacientes.
- **Tests de schema:** `plans-m1-schema` (objetos con su nombre, cada CHECK, únicos parciales con su `indexdef`,
  RESTRICT, idempotencia por tenant, `Prisma.DbNull`), `plans-m1-backfill` (lee el bloque `>>> BACKFILL
  plans_booking_link` literal, como `agenda-backfill`), `plans-m1-new-tables` (las 2 tablas nuevas e identidad del
  portal), bloque M1 en `rls-isolation` (B no lee ni escribe lo de A con `kinesoft_app`) y `plans-dedupe` convertido a
  post-M1 (dry-run = 0).
- **Tests que solo valen en un rol, con skip visible.** Las FKs compuestas son la única red bajo BYPASSRLS: con
  `kinesoft_app` RLS frenaría antes y el verde no probaría nada. Esos bloques usan `describe/it.skipIf(!BYPASS)` y, si
  se saltean, imprimen un `console.warn("[archivo] SKIP …")` que dice con qué comando corren
  (`npm run test:integration:owner -- <archivo>`). Al revés, la guarda "sin BYPASSRLS falla fuerte" del backfill solo
  corre con el rol app. Un skip silencioso es un falso verde: siempre el aviso.
- **Mapa de RLS de las tablas viejas fijado** en `plans-m1-schema.test.ts` (`relrowsecurity`/`relforcerowsecurity` de
  cada tabla: forzadas vs. sin RLS). Si una migración futura cambia el RLS de una tabla existente o agrega una tabla
  vieja a la lista, **se actualiza el mapa a propósito** en la misma sesión, con el porqué; si falla sin que nadie lo
  haya buscado, es una regresión.
- **Códigos de error:** un CHECK llega como 23514, un único como P2002 y un RESTRICT/FK como **23503** (P2003), no 23001.
  `pgCode` en `plans-m1-schema.test.ts` normaliza las tres formas en que Prisma los devuelve.

### Patrones nuevos de EV0 (verticales y /plataforma, 07-oct-2026)

- **Factory con entitlements:** `createEphemeralTenant` (`tests/helpers/tenant-factory.ts`) acepta `vertical`, `plan` y `publicBookingEnabled`. Los **turnos
  online arrancan prendidos en los tests** (`publicBookingEnabled ?? true`) y **apagados en la base** (default de M2,
  opt-in): así los tests del turnero anteriores a EV0 siguen probando el wizard, y el caso "apagado" se pide explícito
  (`public-booking-disabled.test.ts`). Un test que dependa del default real de la base no usa la factory.
- **Mocks de `getActor` necesitan `entitlements`** (`{vertical, plan, publicBookingEnabled}`): sin eso,
  `modulesFor(actor.entitlements)` revienta (TypeError) y el test falla por la razón equivocada.
  Las sesiones de ES2b/ES3 que mockean el actor lo suman (enmienda S22b).
- **Vertical General como control negativo:** los gates de módulo se prueban con un tenant `GENERAL` (OWNER) que
  intenta escribir y lee `[]`, **más** el control Kine que sí puede (`module-guards`, `exercise-entitlements`,
  `ev0-review-fixes`). Una fuga cross-tenant que solo existe con BYPASSRLS (facetas, prefill) se prueba con el rol
  owner.
- **M2 con roles temporales:** `tenant-verticals-m2.test.ts` extrae el bloque `>>> REVOKE_DATA_API` del SQL y lo corre
  contra roles `anon`/`authenticated` creados en el test (el Docker no los tiene). Los marcadores no se mueven.

### Patrones nuevos de ES2b (Planes P2, 07-oct-2026)

- **Carreras con orden de llegada fijo: `raceBehind`** (`tests/integration/plans-concurrency.test.ts:147`). Un
  "holder" (tx del owner) toma la clave advisory por la que se compite; cada competidor se lanza **de a uno** y se espera
  a que entre a la cola (`waitForAdvisoryWaiter(db, key, {minWaiters: i+1})`) antes de lanzar el siguiente; recién
  ahí se suelta el holder. La cola de un lock exclusivo de Postgres es **FIFO**, así que cada orden de llegada es un
  caso determinista (`it.each` sobre los órdenes) y se afirman **los dos lados**: quién gana, que el otro no escribió
  nada y que nadie terminó en error genérico; más los invariantes que valen en cualquier orden (cupo 1, sin turnos
  duplicados del paciente). Sin sleeps.
- **Carreras de filas con `pg_blocking_pids`, transitivo.** Para locks de fila (no advisory) se espera con
  `waitBlockedBy(pid, n)` sobre `pg_blocking_pids`. Ojo: el segundo que espera **la misma fila** figura bloqueado por el
  **primer waiter**, no por el holder; la query lo cubre con el `EXISTS` de un nivel
  (`plans-concurrency.test.ts:112-115`, `plans-engine-fixes.test.ts:96-99`). Filtrar solo por el pid del holder deja
  el test colgado o falso verde.
- **"Sin 40P01" se prueba por el resultado.** `applyDayLock`, `createTimeBlock`, `createBooking` y `updateBooking` no
  reintentan y tapan cualquier excepción con un error genérico: que terminen con un resultado de dominio prueba que
  ningún deadlock los tocó. Las escrituras de Planes reintentan una vez (`withTxConflictRetry`): que terminen bien cubre
  "40P01 no persistente". Los tests de carrera de S11x corren en los **dos roles**, con un tenant propio de un
  profesional y un servicio con cupo 1 y días futuros distintos por test.
- **`plan-factory`** (`tests/helpers/plan-factory.ts`, de ES2a) siembra planes, sesiones y turnos vinculados por
  **INSERT directo**, nunca por las actions que se testean, y trae el fixture legacy (R-LEGACY). `nextSlot()` da un
  instante único por turno para que el único paciente-instante no interfiera con lo que se mide. **Cambio de ES2b:**
  `deleteTenantDeep` (`tenant-factory.ts`) borra antes los planes de **otros** tenants que apuntan a sede, servicio o
  profesional del tenant (FKs simples): sin eso el sweep fallaba.
- **Tests post-integración** (C14): los que ejecutan código de otra sesión de la misma ola (motor contra el verificador
  real, core con la sincronía) se corren en la mini-integración, no en el gate de la sesión.
- **Presupuesto de statements** con `tests/helpers/query-counter.ts`: el alta de un plan de 20 filas es un test
  (≤ 60, `plans-create.test.ts:460`); mover, re-planificar y el dashboard miden con el mismo helper. Medidos en ES2b:
  agenda 16 (techo), Seguimiento 20, Biblioteca 35. Un fix que suma una sentencia lo dice en el comentario (fixer del
  motor: replan +1, generar/vincular/adoptar +1).

### Patrones nuevos de SR (Salas, 08-oct-2026)

- **Cache real opt-in y la clave afirmada:** `useRealUnstableCache()` (`tests/helpers/integration-setup.ts:43`) prende
  un Map real con la clave que arma Next 14.2 y **devuelve `{ keyParts }`**, el registro de los `keyParts` de cada
  llamada. Los tests de cache **afirman la clave** (`own:<pid>` / `tenant`, `dashboard-revenue-scope.test.ts:223-240`),
  no solo "cada actor ve su número": el mock también serializa los argumentos y `practitionerId` viaja como argumento,
  así que el test viejo seguía verde aunque se borrara el scope de los `keyParts` (revisión (a) de SR). Es opt-in: un
  cache real en toda la suite volvería stale las lecturas de los tests que escriben y leen sin revalidar.
  `usePassthroughUnstableCache()` lo apaga.
- **`installQueryCounter()` reusa un singleton por proceso** (`tests/helpers/query-counter.ts:31-50`), como `lib/db.ts`.
  Motivo: antes cada archivo que mockeaba `@/lib/db` creaba 2 clientes Prisma (con su pool) que nunca se cerraban; con
  los tests de SR que miden statements (varios con concurrencia) la integración completa agotaba las 100 conexiones de
  Postgres y fallaban tests ajenos. Pico medido después: 60. No crear clientes Prisma por archivo en un helper.
- **Tests "de hoy" con piso en el inicio del día AR.** Un instante "una hora antes de ahora" cae **ayer** entre las
  00:00 y las 01:30 AR, y Recepción (con razón) rechaza un turno de otro día. `todaySlot` usa
  `max(now − 1 h, dayWindow(toARDateKey(now)).start)` (`plans-sync-bookings.test.ts:74-82`). Todo fixture relativo a
  "hoy" lleva ese piso.
- **Sin salas = igual, contra HEAD.** Los cambios de UI que tienen que dejar igual a un consultorio sin salas se
  compararon contra el markup de `ad50059` con tests temporales (agenda 15/15 byte a byte) y el test de
  `practitioner-day-view` quedó sin diff. El golden fijo queda en C1 (AUDIT `golden-sin-salas`).
- **Módulo aislado por bundle con test:** `tests/unit/agenda-layout.test.ts:533-539` afirma que `agenda-layout.ts` no
  re-exporta `buildRoomColumns` (si vuelve, el first load de `/agenda` lo paga).
- **Concurrencia de sala:** holder con la clave de sala o de sedes + `waitForAdvisoryWaiter({minWaiters: 2})` para alta
  contra alta, bloqueo de sala contra alta, `archiveRoom` contra alta y guardados de Configuración simultáneos
  (`locks-room`, `bookings-rooms`, `bookings-core-rooms`, `locations-schedule-rooms`). Los índices únicos parciales
  muerden fixtures con `new Date()`: escalonar los instantes (`dashboard-revenue-scope.test.ts:90-104`).

### Patrones nuevos de SV (Sala de Espera realtime, 13/14-oct-2026)

- **Publisher fake global, a mano.** `tests/helpers/integration-setup.ts:125` mockea `@/lib/realtime-publisher-internal`
  con `realtimeFake` (`tests/helpers/realtime-fake.ts`) en **toda** la integración **y** el perf (comparten el setup):
  el `.env.local` puede traer una service key real y ningún test puede publicar de verdad (segunda defensa: driver
  default `off`). Registro a mano (`calls`, `fail`, `latencyMs`, `reset()`), no `vi.fn`: con vitest 2.1.9 un `vi.fn`
  que tira a través de un mock rompía el test aunque el código lo atrapara; por eso `fail` devuelve `{ok:false}` (como
  el real) en vez de tirar. Los unit del hook usan `__setRealtimePublisherForTests`.
- **«Post-commit» con `onCall`.** `realtimeFake.onCall` corre antes de que el publish responda: el test lee la fila ahí
  y afirma que ya está commiteada (si el hook corriera dentro de la tx, la lectura desde otra conexión no la vería).
- **Emisión por write-path** (`tests/integration/realtime-emission.test.ts`): **una llamada = un POST** por action, con
  los refs exactos (`practitionerId`, `roomId`, `kind`, `prev` en movimientos); batch de 20 → 1 llamada con 20 refs;
  estado de plan sin turnos → 0; `fail=true` → la action sigue `ok` y la fila quedó. Incluye Planes, turnero, webhook
  y candado. Los huecos encontrados se escribieron como `[SV08-gap]` con la expectativa correcta y los dio vuelta el
  fixer. Un write-path nuevo de `Booking` suma su caso acá.
- **`fetch` fake** (`tests/helpers/fetch-fake.ts`, `makeFetchFake({status, delayMs, rejectWith})` → `{fetch, calls}`):
  respeta `signal.abort`, así el timeout de 1,5 s y el breaker se prueban con fake timers sin red.
- **Drivers con `deps` inyectables** (`lib/realtime-client-supabase.ts`, `-local.ts`): `RealtimeClient`,
  `EventSource`, timers y `getToken` entran por parámetro; Node 20 no tiene `WebSocket`/`EventSource` y los tests corren
  sin jsdom con `vi.useFakeTimers`. Mismo patrón en el chime, el título de pestaña, el motor de avisos
  (`createArrivalAlertsEngine`) y el polling de `/sala` (`startSalaOffPolling`): lo que no es cableado de React se
  testea directo.
- **Tabla de verdad SQL con stubs en ROLLBACK** (`tests/integration/reception-call-m5.test.ts`): el Docker local no
  tiene schema `realtime`, `auth.jwt()` ni roles `anon/authenticated`. El test extrae el bloque guardado de M5 entre
  los marcadores `REALTIME_POLICY`, crea los stubs (`realtime.messages` con RLS, `realtime.topic()` y `auth.jwt()`
  leyendo GUCs, rol `authenticated`) en una tx que termina en ROLLBACK y afirma la policy real (una sola, `SELECT`,
  sin `with_check`) y la visibilidad con claims propios/ajenos. No se mueven ni renombran los marcadores.
- **Render «`off` = SR».** `tests/unit/render/agenda-client.test.tsx` con `useRealtime` mockeado en `off` y snapshot:
  con el driver apagado la agenda no cambia.
- **`guard-realtime` probado por mutación.** `GUARD_REALTIME_ROOT=<copia del árbol>` corre el guard sobre una copia
  mutada (policy `FOR ALL`, `SECURITY DEFINER`, `NEXT_PUBLIC_` en el secreto, write-path sin hook, import estático de
  realtime-js) sin tocar el repo. Corre dentro de `npm run guard:isolation`.

### Patrones nuevos de IAM (Identidad y acceso, 14-oct-2026)

- **Fake de GoTrue** (`tests/helpers/gotrue-fake.ts`): implementa `AuthAdminPort` en memoria (usuarios, links
  emitidos, `email_exists`, `failNext`, registro a mano de `calls`). Se inyecta con
  `__setAuthAdminForTests(fake)` y se limpia en el `afterEach` con `__setAuthAdminForTests(null)`. Cada supuesto
  sobre GoTrue está marcado **[S1]…[S11]** en el archivo y lo verifica `scripts/diagnose-auth.ts` contra Supabase real
  (lo corre Martin). Si un supuesto cae, se corrige el fake y el puerto, **no el test**. Sin fake, el puerto devuelve
  `code: "config"` (el setup de integración mockea `getSupabaseAdminClient` a `null`).
- **Transporte de mail de test + sink de `EmailLog`:** `__setEmailTransportForTests(fn)` (`lib/email/index.ts:65`)
  reemplaza solo el despacho; normalización, log y el sink a `EmailLog` siguen corriendo, así el test afirma el mail
  (kind, destinatario, link a `/auth/confirm` con el `next` esperado) **y** la fila de `EmailLog` (`emailToHash`, sin
  email en claro ni link). Patrón en `tests/integration/team-admin.test.ts`, `invitations-email.test.ts`,
  `portal-auth.test.ts`, `signup.test.ts`. Los transportes reales (Resend/Mailpit) se prueban en unit con
  `tests/helpers/email-fetch-fake.ts` (body JSON y headers de respuesta, respeta `signal`).
- **Guards estáticos de identidad** (unit, sin DB):
  - `tests/unit/email-match.test.ts` — ningún `email: { equals, mode: "insensitive" }` a mano en `lib/`/`app/`
    (con canario del detector).
  - `tests/unit/email-confirm-guard.test.ts` — `email_confirm: true` / `emailConfirm: true` solo en la activación, el
    puerto, `create-tenant` y `diagnose-auth` (AUDIT §5.26).
  - `tests/unit/actor-practitioner-guard.test.ts` — `actor.practitionerId` nunca crudo en un `where`, en `===`/`!==`
    contra algo que no sea `null` ni en SQL; más los helpers (`ownPatientsWhere`, `isActorPractitioner`,
    `revenueScopeFor`, `canManageBlocksFor`) con `null`.
  - `tests/integration/invitations-email.test.ts` — `lib/invitations.ts` sin cliente admin ni `inviteUserByEmail`;
    `signup.test.ts` afirma que no se llama `auth.signUp` ni `resetPasswordForEmail`.
- **Lógica de acceso pura** (`lib/access-logic.ts`, `tests/unit/access-logic.test.ts`): `resolveAccessState` y
  `chooseActiveTenant` se prueban por tabla (aceptada/pendiente/suspendida × con/sin `Practitioner` × rol); el bucle
  [A] quedó como caso «kine de A acepta B» en `tests/integration/access-loop.test.ts`.
- **M6 objeto por objeto:** `tests/integration/identity-m6.test.ts` (índices de `Practitioner`, columnas nuevas,
  `EmailLog` con RLS) en los 2 roles; mismo molde que `rooms-m4` y `reception-call-m5`.

### Patrones nuevos de EV2 (Evoluciones de HC, M9, 15/16-oct-2026)

- **Carreras check → escritura con `pg_blocking_pids`.** Para probar la ventana entre el chequeo de la app y el
  INSERT/DELETE (turno borrado mientras se crea la nota, nota creada mientras se borra el turno, share quitado entre
  dos envíos): una tx «sostenedora» toma el lock de la fila y queda abierta; el test lanza la action real y espera con
  `waitBlockedBy(pid)` (`tests/integration/clinical-notes-write.test.ts:73`, polling de `pg_stat_activity` con
  `pid = ANY(pg_blocking_pids(a.pid))`) a que la action quede bloqueada; recién ahí la sostenedora commitea. Sin
  sleeps: el orden es determinístico y el test falla siempre si falta la traducción del 23503/P2003/23505.
- **Presupuesto de sentencias por página** (`tests/integration/clinical-notes-timeline-perf.test.ts`):
  `installQueryCounter()` (`tests/helpers/query-counter.ts`) en el `vi.mock("@/lib/db")` cuenta las sentencias de
  datos del símbolo real (`getPatientTimeline`) y las compara entre un paciente con 10 notas y uno con 1.000 + 200
  sesiones (≤ 4, constante: anti N+1); además hace `EXPLAIN` de la sentencia **exacta** registrada (texto +
  parámetros, después de `ANALYZE`) y afirma que no hay Seq Scan sobre `ClinicalNote`. **Una medición de calentamiento
  antes de la primera que se afirma:** la integración corre en un solo fork con los clientes contados compartidos entre
  archivos, y en la corrida completa la primera medición sumaba una sentencia ajena (8 vs 7; solo el archivo pasaba).
- **Guard de superficies** (`tests/unit/clinical-notes-guard.test.ts`, unit sin DB): recorre portal, ⌘K, turnero
  público, Plataforma, sala, realtime, notificaciones, mails, CSV y exports internos y falla si alguno menciona
  `clinicalNote`/`ClinicalNote`; también que nadie escriba `revision:` en un write de `clinicalNote` (la sube el
  trigger). El detector de `revision:` tiene su canario (anti falso verde) y el guard falla si no encuentra superficies.
- **M9 objeto por objeto** en los 2 roles (`tests/integration/clinical-notes-m9.test.ts`): triggers que rechazan
  DELETE/TRUNCATE **también al owner**, ventana de 24 h + 10 min, revisión por trigger, parcial de una viva por turno,
  FKs compuestas. Las notas sembradas se limpian con `deleteTenantDeep` (modo réplica, solo superusuario local).

### Patrones nuevos de VX (cara pública y cimientos visuales, 15/16-oct-2026)

Todos unit (corren en `TZ=UTC npm test`, sin DB ni server) y sobre el **árbol real** de archivos; cada uno falla si
su alcance queda vacío (anti falso verde).
- **`tests/unit/public-surface-imports.test.ts`** (C-F3): recorre el grafo de imports real (no un grep plano) desde
  cada superficie pública de C-F7 (landing, auth, estado, invite, 404, turnero, portal) y falla si alcanza
  `framer-motion` o una primitiva con motion/provider (`toast`, `modal`, `drawer`, `confirm-dialog`, `UIProviders`).
- **`tests/unit/public-claims.test.ts`** (§3.4 del brief): lista de claims prohibidos (WhatsApp, Google
  Calendar, AFIP, AES-256, HIPAA, testimonios, porcentajes, «pantalla de la sala», «Matrícula», IA…; más un caso
  propio: la landing no promete cobrar turnos con Mercado Pago) sobre los archivos públicos; una
  excepción se justifica en el código con `// claim-ok: <evidencia archivo:línea>`.
- **`tests/unit/ui-ratchets.test.ts`** + `ui-ratchets.baseline.json` (C-F5): conteos que **solo bajan** —
  `<Link>` con `<Button>` adentro, `outline: none`, placeholders demo («Movare»/«Camila»), literales de estado del mapa
  de F2. Si sube, falla; si baja, imprime el número y el integrador de la ola regraba el JSON (nunca una sesión).
- **`tests/unit/tokens-contract.test.ts`** (C-F1): los tokens de `:root` existen con su valor y las clases de C-F2
  los consumen. Complementa `design-tokens.test.ts` (todo `var(--x)` usado está definido; las variables de `next/font`
  van en su allowlist). `tests/unit/input-placeholder-contrast.test.ts` calcula el contraste AA del placeholder con el
  valor del token.
- **`tests/unit/bundle-groups.test.ts`** (C-F6): cada ruta del build cae en un grupo de `scripts/bundle-groups.mjs` y
  el orden de match es el esperado. El presupuesto en sí lo corta `node scripts/check-bundle-budget.mjs` después de
  `next build` (bloqueante para public/turnero/portal en CI). `tests/unit/csp-public.test.ts`: CSP sin Google Fonts.
- **`tests/unit/module-wall-page-cut.test.ts`** (VX-Z B1): todo `page.tsx` bajo un `layout.tsx` con `moduleWall`
  corta al inicio con `moduleWall(...) !== "ok"` (layout y página corren en paralelo; sin el corte la página consulta y
  loguea `ForbiddenError` en cada visita al muro).
- **`tests/unit/codemod-status-colors.test.ts`**: el codemod de F2 es idempotente (segunda corrida = 0 cambios) y
  respeta sus exclusiones (mails, `next/og`, atributos SVG).
- **Formularios sin JS:** las pantallas de auth y el portal usan `useFormState` con una server action directa
  (`components/auth/auth-form-actions.ts`, `app/(portal)/portal/portal-link-action.ts`); el estado se deriva del
  resultado, así el form funciona antes de hidratar (`tests/unit/auth-form-actions.test.ts`).

### Patrones nuevos de ES4 (portal, matrices, soak y perf de planes, 15/16-oct-2026)

- **Matrices de permisos como tabla viva.** `tests/integration/authz-matrix.test.ts` (staff: XT, OWNER, BASIC,
  ASSISTANT, BILLING, GENERAL, SUPPORT × cada action) y `tests/integration/portal-authz-matrix.test.ts` (portal: P, P-otro,
  P-sinvínculo, P-sinverif, STAFF, consultorio suspendido × cada superficie). Cada celda llama al **símbolo real** y
  afirma el efecto (fila escrita o intacta, `{ ok:false }` con el copy). Lo que la tabla dice y el código no hace queda
  como celda `fails: "<sesión>"` (= `it.fails`) con su slug de AUDIT; el día que se arregla, el test avisa y se da vuelta.
  Las respuestas del portal se comparan con el **copy literal** (un cambio de texto rompe la matriz a propósito).
- **DTO por allowlist recorrido entero.** `portal-account.test.ts` y la matriz del portal recorren todas las claves del
  DTO contra un `Set` literal (`ALLOWED_KEYS`): una clave nueva (aunque la UI no la pinte) rompe el test hasta que se
  agrega a mano. Sumar una clave es una decisión de PHI, no un refactor.
- **Soak** (`tests/integration/plans-soak.test.ts`): N rondas concurrentes de alta de plan, doble clic, reprogramación
  cruzada y turno suelto sobre las mismas claves de cupo. Afirma: ninguna action tira, ningún P2002/40P01 crudo, cupo 1
  respetado y `pg_stat_database.deadlocks` sin subir (cuenta los 40P01 que el retry absorbe).
- **Perf de planes y del portal** (`tests/perf/plans.perf.test.ts`, `npm run test:perf`): cuenta sentencias con el
  harness de `agenda-multi` sobre ~6.900 turnos y 150 planes vinculados. Presupuestos: `createPlan` 20 filas ≤ 60 en 1 tx,
  `previewPlan` ≤ 30, agenda con planes ≤ +5 % contra `agenda-multi.json`, `requirePortalPatient` ≤ 3, home del portal
  ≤ 1 por consultorio; el resto con techo medido. Un presupuesto incumplido es `it.fails("[ES4-S26s] …")` hasta el fix
  (los tres de S26s se dieron vuelta en P4.Z). `PERF_OUT_DIR=<scratchpad>` para no ensuciar el árbol.
- **Flakes por la hora:** un test que arma un turno «dentro de una hora» cae mañana pasadas las 23:00 AR. Para «hoy» se
  usa un instante de HOY en AR (`localToARIso(`${toARDateKey(now)}T12:00`)`), nunca `now + Δ` (ES4-Z,
  `support-session.test.ts`).
- **Redirects de server actions:** `redirect()` tira un error con `digest = "NEXT_REDIRECT;<tipo>;<url>;<status>"`; los
  tests leen la URL del digest (`redirectOf` en `portal-invite.test.ts` y `portal-identity.test.ts`).

### Patrones nuevos de PF2 (una tx por loader, actor memoizado, 16-oct-2026)

- **Presupuesto de transacciones por página** (`tests/integration/pf2-{dashboard,profile,agenda,config}-budget.test.ts`):
  se mide el loader REAL con los mismos argumentos que la página (`loadAgendaPage(actor, { monday, patientId })`,
  `loadPatientProfilePage(actor, id, noteBookingId)`…) con el contador de `tests/helpers/query-counter.ts` (instalado
  con `vi.mock("@/lib/db")`, sin tocar el loader) y se afirma `transactions ≤ N` y sentencias con techo. Además, paridad:
  lo que el loader entrega es igual a lo que armaban los lectores de antes (un lector copiado que diverge pone el test
  rojo). Corre en los dos roles.
- **Actor memoizado** (`tests/integration/actor-memo.test.ts`, `pf2-tx-budget.test.ts`): cada «request» es un
  `requestAsyncStorage.run(store, …)` propio; el store lleva el usuario de Supabase y el frasco de cookies de ese
  request (mocks de `next/headers` y `@/lib/supabase/server` que leen del store), así dos requests concurrentes
  (`Promise.all`) pueden ser de usuarios/consultorios distintos. Una resolución = una lectura de acceso por el canal de
  servicio (contador real). Casos fijos: N `getActor()` = 1; concurrentes no comparten; `switchTenant` invalida; un
  negativo no se memoiza; fuera de Next (sin store) no hay memo.
- **`AsyncLocalStorage` global en el setup de integración** (`tests/helpers/integration-setup.ts`): `next start` lo
  instala antes de cargar Next; la suite corre en un solo fork y Node cachea la instancia de
  `request-async-storage` entre archivos, así que si un archivo la cargaba antes sin el global quedaba la falsa
  («Invariant: AsyncLocalStorage accessed…»). Pasaba solo con el orden de `test:integration:owner`.
- **Contar sentencias con un cliente con `log: query`:** los eventos de Prisma llegan por un canal aparte y pueden
  entregarse después de que resuelve la query. No vaciar el array y medir: delimitar cada medición con una sentencia
  marcadora y esperar a verla (`availability-loader.test.ts`, «no suma statements»).
- **Perf:** `loaders.perf` mide `agenda.page` y `paciente` sobre los loaders de la página; `compare.ts` aplica la regla
  estricta absoluta `agendaPayloadBytes ≤ 400 000` (`tests/unit/perf-compare.test.ts`).
- **TTFB:** `scripts/perf/ttfb.mjs` hace su propio `next build` con las URLs del GoTrue falso (`NEXT_PUBLIC_*` se
  inlinean al compilar): con `--no-build` sobre un build normal todas las rutas dan 307.

### Patrones nuevos de T6/T7 (TV, WhatsApp, suscripción con MP y QA por plan, 22/23-oct-2026)

- **Simuladores, siempre.** Nada contra Meta, Mercado Pago ni una TV reales:
  - **Meta falso** (`lib/whatsapp/fake-graph.ts` + `app/api/whatsapp/fake/[...path]`, 404 fuera de `WHATSAPP_MODE=fake`):
    alta embebida, plantillas, media, mensajes con estados por webhook **firmado** a la ruta real, números mágicos
    (131026, 131042, timeout, 130429) y panel en `/api/whatsapp/fake/panel`. En tests, `tests/helpers/whatsapp-fake.ts`
    (`installFakeGraph`, `connectFakeWhatsApp`, `pressButton`, `sendInbound`) y `fakeGraphEmitStatus` del simulador
    para el `failed` asíncrono (`lib/whatsapp/fake-graph.ts:394`).
  - **MP falso de la suscripción** (`lib/mp-connect/fake-mp-saas.ts`, sobre el de T5): preapprovals, débitos, checkout,
    reintegro y «cancelar desde MP», con webhooks firmados con `MP_WEBHOOK_SECRET`. En tests,
    `tests/helpers/mp-saas-fake.ts` (`installSaasFakeMp`, `walkFakeSubscriptionCheckout`).
  - `npm run dev:local` (= `dev:mpfake` = `dev:wafake`) prende los dos; los `diagnose-*` (S1-S13 de WhatsApp, S1-S10 de
    la suscripción) corren contra el simulador por defecto y `--sandbox` lo corre solo Martin.
- **Matriz por plan** (`tests/integration/plan-routing-matrix.test.ts`, QA-M): 4 planes × 2 verticales × roles contra el
  **oráculo** (`modulesFor` + cupos de `lib/saas-plans-logic.ts`), sin duplicar la tabla a mano: muros por segmento, menú,
  pestañas de Configuración, cupos, estados de acceso (prueba vencida → solo lectura, `past_due`, suspendido con HC
  legible) y overrides de Plataforma. Corre con los dos roles.
- **Escenarios de costo en integración.** WhatsApp en `off` = 0 sentencias en el hook, con control de que el contador sí
  las ve prendido (`wa-s2-hook.test.ts:145`); la agenda en `off` sin query extra (`wa-s7-agenda.test.ts:127`); la
  conciliación con reloj falso del 3/4/5 y corte por presupuesto (`mps-2b-sync.test.ts:269,302`).
- **`mp-webhook.test.ts` intacto.** La rama SaaS se prueba en `mps-2b-webhook.test.ts`; el legado tiene que seguir verde
  sin tocar su test (AUDIT §5.4).
- **Guards nuevos en la unit:** `whatsapp-guard` (`tests/unit/whatsapp-guard.test.ts:9-16`: Graph solo en
  `lib/whatsapp/graph.ts` y el simulador; tablas `WhatsApp*` solo desde `lib/whatsapp/*-internal.ts`; el simulador solo
  desde su ruta y los tests; plantillas sin servicio, notas ni diagnóstico; logs sin teléfono), `tv-csp`, `inf-dev-safe`
  y el grupo `display` en `bundle-groups`. Ninguno corre dentro de `guard:isolation` (AUDIT `t6t7 wa-guard-fuera-de-isolation`). `public-claims` prohíbe
  «whatsapp» en el turnero y el portal salvo `// claim-ok:`.
- **E2E en serie, nunca dos builds a la vez.** Cada sesión corre su spec y al final la suite entera. Para corridas largas
  (suite completa, gate) en la Mac: `caffeinate -i npm run test:e2e` (si la Mac se duerme, el `next start` y el GoTrue
  falso se cortan y la corrida falla a mitad).

### Patrones nuevos de PV (antes de vender, 27-oct-2026)

- **Tests primero por ID:** `[TK-1..21]`, `[LG-1..8]`, `[IN-1..6]`, `[BR-1..9]`, `[HD-1..16]` arrancaron como `it.fails` y
  se dieron vuelta. Símbolos reales: el POST del sign-out (`hd2-sign-out`), el del webhook de MP (`hd4-mp-webhook-cap`),
  `createBooking` en HD-13 y HD-16, `listPatients` y `exportPatientsCsv` en `hd10-patients-pagination`.
- **Carreras con advisory lock:** `tk-s1-ticket-cap-race` lanza envíos simultáneos del mismo usuario y afirma que el
  tope diario no se pasa (ZA B5).
- **`m19-support-tickets`** verifica los objetos de M19 en los dos roles (SERVICE_ONLY de `SupportTicketNote`
  invisible para `kinesoft_app`).
- **E2E con reloj falso:** `idle.spec` usa `page.clock`; bajo el reloj falso el fade de framer no termina (ni con `clock.resume()`), así que `toBeVisible` es lo máximo que se puede afirmar de un `Modal`: la opacidad se verifica a mano (QA.md «PV»).
- **Guards nuevos en la unit:**
  - `tests/unit/server-surface-guard.test.ts` (HD-1): todo export de un `"use server"` tiene llamador (o auto-llamada
    desde otro export del mismo módulo) o está en `ALLOWLIST` con motivo ≥ 20 caracteres (25 al cierre); una entrada
    que ganó llamador o cuyo export ya no existe falla; todo `*-internal.ts` lleva `import "server-only"`.
  - `tests/unit/brand-literal.test.ts` **estricto** desde BR-Z: «KineSoft» / «Kinesoft» = 0 en `app`, `components`,
    `lib`, `hooks`, `scripts`, `public` y los `.ts`/`.mjs` de la raíz; el literal nuevo solo en `lib/brand.ts`;
    allowlist vacía. Los identificadores en minúscula o mayúscula sostenida no cuentan.
  - `[BR-9]` (`tests/unit/br-brand.test.tsx:213`): los identificadores preservados (cookies `kine_*`/`ks_*`, claves
    `kinesoft:*`, roles, cache del SW, UID del ICS) **siguen existiendo** con la grafía vieja.
  - `zf1b-idle-surfaces` fija que exports, `/cuenta` y `/plataforma` chequean `kine_idle`.

### Patrones nuevos de CF (feedback del cliente, M20, 30-oct-2026)

- **Tests primero por ID** (§28.6): `[CF-M1..2]`, `[CF-K1..3]`, `[CF-E1..7]` (motor en TZ=UTC), `[CF-L1..4]` (locks),
  `[CF-C1..3]`, `[CF-W1..5]`, `[CF-P1..4]`, `[CF-A1..5]`, `[CF-PL1..3]`, `[CF-F1..3]`, `[CF-I1]`, `[CF-N1]`, `[CF-H1]`,
  `[CF-RT1]`. Ojo: `[CF-D1]`/`[CF-D2]` son tests del **formulario del turnero**, no los defaults CF-D1/D2 (CLAUDE.md).
- **Carve-out de paridad:** la regla nueva va en tests nuevos (`cf-e-engine`); los fijados
  `availability-classify.test.ts:372` y `booking-schedule.test.ts:434` **no se editan** (AUDIT §5.27).
- **Carreras `[CF-R1..3]` en los dos roles** (`tests/integration/cf-race-two-services.test.ts`, `cf-locks-pday`): 09:30 + 60'
  vs 10:00 + 60' de servicios distintos → entra una; turnero vs staff; plan vs alta sin 40P01. Quien espera, espera en
  `pday` (lo afirman con `pg_locks`). Fixtures que pisan servicios a propósito (`as2-interval-cap`, `as2l-…`) llevan
  `allowParallelServices: true`.
- **`m20-cf-agenda-rules`** verifica los objetos de M20 en los dos roles y que el INSERT viejo de `Practitioner` toma el
  DEFAULT.
- **E2E `cf-*`** (`tests/e2e/cf-{agenda-rules,config,day-lock,misc,secretaria,turnero}.spec.ts`, fixture
  `tests/e2e/support/cf.ts`). El del candado arrancó con `test.fail` por el bug del diálogo (anterior a CF) y se da
  vuelta con ZF2.
- **Guard post-build de server actions** (`npm run check:actions`, `scripts/check-server-actions.mjs`): todo
  `createServerReference("<id>")` de `.next/static/chunks/**` existe en `.next/server/server-reference-manifest.json`.
  Corre **después del build seguro** (abajo), exit 0 obligatorio; contra un `.next` viejo da 1. Unit con fixtures:
  `tests/unit/cf-rt-check-server-actions.test.ts`. Existe porque el realtime pasó en verde meses sin andar: el E2E corre
  con `REALTIME_DRIVER=off` y el driver `local` no usa la action.
- **Perf `[CF-PERF1]`:** `f.createBooking` 31/5, lote 182/22 y update con las mismas sentencias con la regla prendida y
  apagada. `tests/perf/plans.perf.test.ts` no tiene JSON de referencia: `compare.ts` no lo vigila (AUDIT «Ronda CF»).
- `vitest --project unit` no existe en este repo: `npm test` o `npx vitest run <archivos>`.

### Build local (`next build`) — siempre con el env local explícito

Dos problemas. `.env.local` define `NODE_ENV`, y `next build` con ese valor falla en el prerender. Y, más grave, `next build`
**inlinea** `NEXT_PUBLIC_SUPABASE_URL` y la anon key del `.env` del repo, que puede ser **prod** (TV-I). Para el gate de build
y las mediciones de bundle:

```bash
npx dotenv -e .env.local -v NODE_ENV=production \
  -v NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54398 \
  -v NEXT_PUBLIC_SUPABASE_ANON_KEY=dev-mpfake-anon-key-no-real \
  -v SUPABASE_SERVICE_ROLE_KEY=build-local-no-real \
  -v SUPABASE_JWT_SECRET=dev-mpfake-jwt-secret-solo-local-0123456789abcdef \
  -- npx next build
```

`-v` pisa esas claves solo para el build, sin tocar `.env.local`; los literales son de prueba. Sin DSN, el build no carga
Sentry (no-op). Regla del incidente de FC-4i: **nunca** build ni E2E en una copia del árbol que tenga `.env*` (ver
«Capa 4»). El E2E y `dev:local` ya pisan todo lo externo solos.

## Regla de oro: los fixes de timezone van ANTES que la suite de integración

Si la suite se escribe contra el comportamiento actual, **consagra los bugs de host-tz**
(F-A2/A3/A4/A5). Por eso Etapa 1 solo siembra **capa 1** sobre helpers que ya son correctos
(`lib/datetime-ar.ts`, `lib/format.ts`, `resolveBookingCopagoCents`) — la referencia contra la que
se corrigen los bugs — y la suite completa (capas 2-4) llega en la Ola 2.1, con las olas 1.1-1.2 ya
cerradas.

Corolario operativo: **todo QA de fechas se corre con `TZ=UTC`** (Docker o preview de Vercel). En dev
AR-local los bugs de fecha no se reproducen.

---

## La pirámide de 4 capas — instanciada

### Capa 1 — Unit de lógica pura (vitest; sin red ni DB)

Corre en milisegundos. Candidatos **ya puros** (arrancar acá, Etapa 1):

| Módulo | Qué protege |
|---|---|
| `lib/datetime-ar.ts` | `localToARIso`/`toARDateKey`/`toARDow`/`toARHour` — el corazón del correctness de fechas. Casos borde: cambio de día cerca de medianoche AR, string con offset vs pelado, dow domingo=0. |
| `resolveBookingCopagoCents` (`lib/billing-internal.ts`) | La escalera de precedencia de copago (Booking → Coverage → insurer → Particular → service); que `0` sea intencional en cada nivel. |
| `lib/format.ts` | `formatARS` (salida) y el futuro `parseARS` (entrada: `"1.500,50"` → 150050 cents) de la sesión `money-input-parser`. |
| `lib/diagnosis-engine.ts` | Ranking por overlap región+síntoma+trigger (cuando Etapa 3 lo active). |

Precondición para lo que hoy **no** es puro (sesión `extraccion-logica-pura`, Ola 2.1): sacar la
lógica de negocio de archivos `"use server"` y componentes cliente a módulos puros que reciben sus
dependencias (cliente Prisma, reloj, generador de ids) como argumento. La acción queda como shell
fino: autenticar → autorizar → I/O → delegar. Findings `logica-en-use-server-y-cliente`,
`export-type-en-use-server`.

### Capa 2 — Component con I/O mockeado (vitest + testing-library)

Render + interacción + estados de carga/error, con timers falsos y las server actions mockeadas en
el borde. Prioridad tras el split (Ola 2.0): el `BookingModal` (creación de turno), el StatusTag
exhaustivo de la agenda, los tres estados de las vistas de datos (skeleton / vacío real /
error-con-retry — finding `sin-error-loading-boundaries`).

### Capa 3 — Integración con tenant efímero contra Postgres real (Docker 5433)

La costura más peligrosa (RLS, constraints, concurrencia). Dos piezas la sostienen:

- **Fábrica de tenant efímero reusable** (una función compartida, no copiada) que crea tenant +
  credenciales reales + datos base, atravesando la auth real para que las policies se ejerciten de
  verdad. Base a partir de `prisma/seed.ts` / `scripts/create-tenant.ts` (hoy scripts ad-hoc que
  cumplen rol de test — finding `scripts-adhoc-como-tests`).
- **Barredor de huérfanos** al inicio de la suite (limpia tenants de corridas que crashearon).

Tests obligatorios de esta capa:

1. **Tripwire de aislamiento cross-tenant** (finding `sin-test-tripwire-aislamiento`): crea 2 tenants
   y falla si uno lee datos del otro. **Es el test que valida que la Ola 2.2 (RLS real) funciona** —
   debe correr con el rol sin BYPASSRLS.
2. **Concurrencia de booking**: N `createBooking` simultáneos sobre el mismo `(practitionerId, slot)`
   → exactamente uno gana (valida `booking-concurrencia`); el sobreturno intencional sigue posible.
3. **Impersonación de actores**: setear el claim de sesión (identidad/rol/tenant) dentro de una tx
   que se descarta, para cubrir en segundos "actor sin sesión", "actor de otro tenant", "PRACTITIONER
   no puede hard-delete" — sin un login real por combinación.
4. **Regresión de copago** al reemplazar cobertura (valida `copago-snapshot`).

### Capa 4 — E2E en navegador real (Playwright, OPS-6)

`@playwright/test` 1.63.0 (dev), `playwright.config.ts`, `tests/e2e/**`. Chromium contra `next build && next start` +
el Docker local; el server en **TZ=UTC** (como Vercel) y el browser en `America/Argentina/Buenos_Aires` + `es-AR`.

```bash
npx playwright install chromium     # una vez
npm run test:e2e                    # build + start en :3300 + suite (carga .env.local: la DB es la del Docker)
npm run test:e2e -- agenda          # un spec
E2E_SKIP_BUILD=1 npm run test:e2e   # reusa el .next que haya
E2E_APP_DIR=<snapshot> npm run test:e2e   # buildea/sirve otro árbol (p. ej. `git archive HEAD`) si hay sesiones
                                          # editando el repo: el .next es uno solo
E2E_KEEP_DATA=1 npm run test:e2e    # no borra el tenant al final (para mirar un fallo)
```

> ⚠️ **Regla del incidente de FC-4i (19-oct, AUDIT «Ronda T4»):** **nunca** `next build`, `next start` ni E2E en una
> copia del árbol que tenga `.env` o `.env.prod.local`. Next inlinea `NEXT_PUBLIC_SUPABASE_URL` del `.env` (puede ser
> PROD) y el E2E le pega: pasó una vez, con un login de un usuario de prueba inexistente que Supabase rechazó. El
> snapshot de `E2E_APP_DIR` se arma con `rsync --exclude '.env*'` (o `git archive`, que no trae los `.env`), y los builds
> de medición, con las variables del E2E/fake. El gate oficial usa los scripts npm.

- **Server** (`tests/e2e/support/start-server.mjs`, el `webServer` de la config): un **GoTrue falso** en
  127.0.0.1:3299 + `next build` + `next start -p 3300`. El falso atiende `token?grant_type=password|refresh_token`,
  `user` y `logout` contra `tests/e2e/.state/users.json`, y firma el JWT con un secreto propio que el server recibe como
  `SUPABASE_JWT_SECRET`: el camino es el de prod (form de /login → cookie `sb-127-auth-token` → middleware →
  `getSessionUser`). El actor demo **no sirve** (solo con `NODE_ENV !== "production"`, y cae en el seed). Se niega a
  arrancar si la DB no es localhost, y pisa con vacío / `log` / `off` todas las claves con efecto externo (MP, Resend,
  Sentry, Upstash, realtime) porque `next start` carga el `.env`, que puede ser de prod. Mercado Pago va con el **falso** (`MP_CONNECT_MODE=fake`, firma
  `required` con un secreto literal de prueba; sin `VERCEL*`, que frenaría el boot). Desde T6/T7 también
  `SAAS_BILLING_MODE=mp` (suscripción contra el MP falso), `WHATSAPP_MODE=fake` (Meta falso) y
  `TENANT_ACCESS_ENFORCEMENT=enforce` (`tests/e2e/support/start-server.mjs:281-289`).
- **Datos** (`tests/e2e/global-setup.ts`): un tenant efímero con `tests/helpers/tenant-factory.ts` (**nunca seeds**):
  OWNER, sede, franjas 08-19 los 7 días, un servicio con cupo 1 (el de la factory es ilimitado: sin conflicto), un
  paciente por familia de specs, turnos de hoy / mañana / ayer en hora AR, una evolución de hace 3 días (enmienda) y una
  usuaria del portal sin Membership (`Patient.userId`). `global-teardown.ts` lo borra con `deleteTenantDeep`; una
  corrida cortada la barre `sweepOrphanTestTenants` a los 30'. Los ids quedan en `tests/e2e/.state/fixture.json`.
  Desde QA-E, 3 consultorios más para `plans-matrix` (`tests/e2e/support/plans.ts`, misma factory): Consultorio General
  con Secretaría, Clínica Kine con 2 salas e Individual Kine en solo lectura, cada usuario con su `storageState`.
- **Auth:** el proyecto `setup` (`auth.setup.ts`) entra por el form real y guarda `storageState`. Login, turnero y
  portal usan un contexto limpio.
- **Serial** (`workers: 1`): los specs comparten tenant y agenda.
- **Anti-false-green:** cada spec que escribe afirma la fila en la base (owner client), no solo el toast.

| Spec | Qué prueba |
|---|---|
| `login` | clave mala → `?error=invalid_credentials` + copy, sin sesión; clave buena → `/dashboard`, sobrevive al reload |
| `pacientes` | Drawer «Nuevo paciente» → `/pacientes/[id]` + fila con el DNI |
| `agenda` | turno nuevo; segundo turno a la misma hora con cupo 1 → aviso + «Forzar sobreturno», no entra; «Reprogramar» 09→15 |
| `recepcion` | «Llegó» en el drawer del turno de hoy → `arrivedAt`; WhatsApp: `wa.me/<E.164>?text=` con la hora AR |
| `cobro` | Facturación → «Confirmar» el copago → «Cobrado» + `copagoPaidAt` |
| `fichas` · `ficha-share` · `ficha-documentos` · `ficha-import` | (T4) ficha con formato a 390, editar en 24 h, enmienda, anular; compartir con el paciente y dejar de compartir; PDF/Word y respaldo OPFS; importar un .docx |
| `plan` | plan de 2 sesiones los lunes desde la ficha → 1 programa con 2 turnos |
| `portal` | pantalla de entrada sin sesión; con sesión, «Hola, Ana» y el turno de mañana |
| `turnero` | ventana de 5 días («Siguientes ›» / «‹ Anteriores»), reserva sin cobro → «¡Turno reservado!» + turno UNPAID |
| `mp-connect` | (T5) el profesional conecta la cuenta del MP falso → «Conectada · Simulador local» → delegación |
| `turnero-cobro` | (T5) REQUIRED total → aprobado → comprobante → drawer «Pagado por Mercado Pago»; OPTIONAL con seña → cobrar el resto en efectivo → Ingresos = seña + resto; a 390 |
| `payment-link` | (T5) perfil → «Nuevo link de pago» → `/pagar` anónimo a 390 → «¡Pago recibido!» → /cobros «Pagado» → reintegro → «Reintegrado» |
| `tv` | (T7) «Pantallas» en `/sala` → código → `/tv` vincula → llamar → nombre corto (sin apellido) → desvincular → vuelve al vínculo; CSP y manifest de `/tv` |
| `subscription` | (T6) débito autorizado en el MP falso → «Débito activo»; débito aprobado → cargo Pagado; «Pagar con Mercado Pago»; baja → banda con la fecha → «Deshacer baja»; subida con el proporcional en la vista previa |
| `whatsapp` | (T6) conectar con el Meta falso; consentimiento en el alta; «Turno agendado» hasta «Leído»; recordatorio → «Confirmo» → badge; «No puedo ir» → campana sin cancelar; BAJA; ALTA → compartir ficha; turnero a 390 con la casilla destildada; desconectar |
| `plans-matrix` | (QA-E) menú por plan; muros por URL directa; Secretaría sin HC y cobrando con medio; Clínica con `/sala` y «Pantallas»; solo lectura según el modo; cupo lleno al invitar; General sin módulos Kine |
| `tickets` | (PV) lead de precios → «Web · precios» → Tomar → nota → Marcar resuelto → Reabrir con filtros; `/contacto?motivo=plan` con consultorio usable → Soporte con borrador; suspendido y deshabilitado abren su ticket con el email de la sesión; sin `mailto:` en la landing |
| `legal` | (PV) `/terminos` y `/privacidad` (versión, AAIP, subencargados); links legales en login, turnero y landing; alta por email sin casilla no crea nada; activación de invitación con la casilla obligatoria |
| `idle` | (PV, `page.clock`) sin «Mantenerme conectado»: aviso a T−60 s, «Seguir conectado», cierre a T y reingreso al path; el server corta recién a T+60 s con la cookie de la misma sesión; tildado no avisa nunca. La opacidad del `Modal` no se puede afirmar con `page.clock` (ZB M4): va al QA manual |
| `brand` | (PV) pestaña y wordmark de landing y login sin la marca vieja ni duplicada; template «X · Consultorio Online»; manifest (`short_name` «Consultorio»); sidebar expandido sin desborde y topbar solo con la baldosa |

Fuera por ahora: «informar pago». El rate limit del turnero es 5 reservas cada 5' por IP: un spec nuevo que reserve tiene
que contar con eso. `tv.spec` falló una vez en la suite completa (Server Action con id viejo): si vuelve, subir
`TV_LATENCY_MS` (`tests/e2e/tv.spec.ts:25`) a 25 s.

**CI:** job `e2e` en `ci.yml`, después de `verify`, con Postgres efímero (owner) y **`continue-on-error: true`**
(no bloqueante 2 semanas, OPS-D5); sube `tests/e2e/.report/` y `.results/` como artefacto.

> **Qué NO testear** (decisión explícita, no descuido): no mockear los internals de Next para invocar
> server actions "directo" (harness frágil); no reproducir el contrato de la API de Mercado Pago en
> un mock (usar el no-op documentado + un smoke test aislado con sandbox); el copago/precisión de
> dinero se cubre en capa 1, no en E2E.

---

## Guards estáticos de seguridad (capa de mayor apalancamiento)

Corren en CI **sin levantar DB ni server**, parseando el repo. Sesión `ci-pipeline-completo-y-guard`.

- **`scripts/guard-tenant-isolation.mjs`** (`npm run guard:isolation`) — parsea `prisma/schema.prisma` y
  **todas** las `prisma/migrations/*/migration.sql` en orden (desde B-pre; antes solo la de
  `20260725120000_rls_policies`). **Falla** si un modelo con `tenantId` no tiene ENABLE + FORCE + policy, o si una
  tabla de `GLOBAL_READONLY` (Specialty, Practice, PracticeSpecialty, Payer, CatalogImportRun) pierde ENABLE/FORCE
  o gana una policy de escritura. Reporta (suave) llamadas `prisma.<model>` sin wrap; las lecturas de las tablas
  GLOBAL_READONLY quedan afuera de ese reporte a propósito.
- **Allowlist del admin client** — falla si `getSupabaseAdminClient` (service-role, bypassa RLS)
  aparece importado fuera de un allowlist estático documentado.
- **`scripts/guard-realtime.mjs`** (SV; corre después del anterior en `guard:isolation`) — reglas (a)-(e): una sola
  policy `FOR SELECT TO authenticated` sobre `realtime.messages`, la función pura sin `SECURITY DEFINER` ni GRANT a
  los roles de la Data API, todo write-path de `Booking` emite, secretos server-only y realtime-js solo por `import()`
  dinámico. Detalle en [SECURITY.md §17](SECURITY.md).
- **Guards de identidad (IAM)** — corren dentro de `TZ=UTC npm test` (unit), no en `guard:isolation`:
  `email-match`, `email-confirm-guard` y `actor-practitioner-guard` (ver «Patrones nuevos de IAM»). Faltan como guard
  estático `auth.admin.` solo en el puerto y `auth.getUser()` solo en `getVerifiedSessionUser` (AUDIT
  `guard-auth-admin-y-getuser`, BO).
- **Guards de T6/T7** — en la unit: `whatsapp-guard`, `tv-csp`, `inf-dev-safe` (ver «Patrones nuevos de T6/T7»).
- **Guards de PV** — en la unit: `server-surface-guard` (superficie RPC), `brand-literal` estricto y `[BR-9]` (ver
  «Patrones nuevos de PV»).
- **Guard de CF** — **después del build**: `npm run check:actions` (toda action referenciada por el cliente está en el
  manifest del server; ver «Patrones nuevos de CF»).
- **Guards de la cara pública (VX)** — también en la unit: `public-surface-imports`, `public-claims`, `ui-ratchets`,
  `tokens-contract`, `bundle-groups`, `module-wall-page-cut` (ver «Patrones nuevos de VX»). El presupuesto de bundle
  corre después del build (`check-bundle-budget.mjs`).

---

## Forma del pipeline de CI (rápido → caro)

Sesión `ci-gate-minimo` arranca con los pasos 1 y 3; `ci-pipeline-completo-y-guard` completa el resto.

1. **Rápidos sin credenciales** — `tsc --noEmit`, lint, guards estáticos. Corren primero.
2. **Unit + coverage** — capas 1-2 con **umbral ratchet** (se fija apenas por debajo del coverage
   medido; sube con mejoras, nunca baja sin decisión explícita).
3. **Build** — `next build` (atrapa la clase de errores de runtime que el typecheck no ve).
4. **Gate de credenciales** — verifica que la DB de integración / secretos estén presentes; si
   faltan, la etapa de integración se **saltea de forma visible** en vez de fallar confuso.
5. **Integración serial** con concurrency group por rama (dos corridas no escriben el mismo entorno).
6. **E2E** — job `e2e` en paralelo a `integration`, no bloqueante (`continue-on-error`) hasta que se decida (OPS-D5).

**Anti-false-green** (se revisa en cada test nuevo): (1) testear el **símbolo real** que corre en
prod, no una réplica local — mockear la dependencia externa (reloj, cookie, cliente de red), no la
función bajo test; (2) afirmar el **efecto observable** (el registro quedó en el estado esperado, el
evento se emitió con el payload correcto), no solo "no lanzó excepción / devolvió 200".

---

## Checklist de QA manual por ronda (versionado)

Se corre completo en **preview UTC** antes de cada corte / ronda de cambios significativa. Cierra el
finding `no-qa-checklist-versionado`. Marcar ✅/❌ por ítem, con captura si aplica.

**Agenda / turnos (siempre `TZ=UTC`):**
- [ ] Crear turno haciendo click en un slot de un día **sin turnos** → cae en ese día y esa hora (no HOY, no −3h).
- [ ] Crear turno en un día con turnos existentes → día/hora correctos.
- [ ] "Múltiples turnos" (batch) → todos en los días AR correctos.
- [ ] Turno a las 21:30 y turno a la media hora → **visibles** en grilla y timeline.
- [ ] Estados (PENDING/CONFIRMED/COMPLETED/NO_SHOW/CANCELLED) → label correcto en el StatusTag.
- [ ] Doble-click en "Crear turno" → **un** solo turno.
- [ ] Editar un turno con un drawer viejo (movido en otra pestaña) → rechazo por optimistic concurrency.
- [ ] Sugerencia de "próximo turno libre" → dentro de las franjas del profesional (o del horario del consultorio si no tiene), saltea bloqueos y domingos sin excepción.

**Reserva pública (preview UTC):**
- [ ] Elegir slot "08:00" → aparece **08:00** en la agenda del kine (no 05:00).
- [ ] Checkout MP sandbox → turno PAID; monto correcto.
- [ ] Cambiar el precio del servicio mientras hay un checkout en vuelo → `Payment FAILED` registrado (no silencioso).

**Pacientes / dinero:**
- [ ] No existe "Eliminar definitivamente" paciente (se quitó en A2): solo Archivar, y archivar exige acceso completo.
- [ ] Borrar un turno **pagado** (MP, copago cobrado a mano u OS confirmada) → error claro "cancelalo" (no destruye nada).
- [ ] Input de precio/copago con "1.500,50" → se guarda 150050 cents.

**Auth / boundaries:**
- [ ] Login con credenciales inválidas → banner de error en español.
- [ ] Forzar un error en un server component → pantalla de error en español con retry (no "Application error").
- [ ] Ruta inexistente → 404 custom en español.

**Fechas transversales (preview UTC):** dashboard "hoy"/semana/mes, Seguimiento "Hoy", búsqueda
global, portal del paciente, listado de pacientes "última visita", export ICS → todos muestran la
fecha/hora **AR**, no la del host.
