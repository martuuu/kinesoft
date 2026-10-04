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
