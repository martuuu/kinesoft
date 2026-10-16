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
> - **E2E (capa 4):** Playwright no está instalado (Bloque B, S26).
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

### Build local (`next build`) — por qué con `-v NODE_ENV=production`

`.env.local` define `NODE_ENV`, y `next build` con ese valor falla en el
prerender. Para el gate de build contra el Docker:

```bash
npx dotenv -e .env.local -v NODE_ENV=production -- npx next build
```

`-v` pisa solo esa clave para el build, sin tocar `.env.local`. La alternativa es sacar `NODE_ENV` de
`.env.local`. Sin DSN, el build no carga Sentry (no-op).

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

### Capa 4 — E2E en navegador real (Playwright, gateado)

Flujos completos: **wizard de reserva pública** (el que cobra por MP — camino dorado), login con
feedback de error, y el portal del paciente. Cubre hidratación, navegación, prefetch, CSP real.
Corre gateado (rama principal / pre-corte), porque es lo más lento y ruidoso.

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
6. **E2E gateado** — al final, solo en `main` / pre-corte.

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
