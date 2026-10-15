# KineSoft — Performance: baseline medido y cómo medir

> Creado en el Bloque **A1.2** (2026-09-29/30). Es **solo medición**: nada de `lib/` ni `app/` cambió. Los fixes van
> en **C1**, contra estos números. Hasta entonces los tests de perf **no fallan por números**; los presupuestos
> (baseline +10%) se activan en C1.

## Cómo correrlo

| Qué | Comando | Dónde |
|---|---|---|
| Cargas de página + write-paths | `npm run test:perf -- tests/perf/loaders.perf.test.ts` | Docker local (:5433). Nunca prod |
| Presión de pool | `npm run test:perf -- tests/perf/pool-pressure.perf.test.ts` | Docker local |
| Agenda multi-profesional (B4.6) | `npm run test:perf -- tests/perf/agenda-multi.perf.test.ts` | Docker local |
| Bundle por ruta | `npx next build && npm run perf:bundle` (`-- --write-baseline` para regrabar) | local y CI (paso "Presupuesto de bundle", solo reporte) |
| TTFB por página contra `next start` (PF-0) | `npx dotenv -e .env.local -- node scripts/perf/ttfb.mjs [--no-build] [--auth-latency=ms] [--db-rtt=ms]` | Docker local; se niega si `DATABASE_URL` no es localhost. Ver §PF-0 |
| Líneas por request (PF-0) | `PERF_TIMING=1` en el server (`lib/server-timing.ts`) → `[perf] {route, spanMs, authMs, actorMs, txCount, stmtCount, dbMs, roundTrips}` | solo diagnóstico; apagado = cero costo |

- **Harness** (`tests/helpers/query-counter.ts`): instrumenta los clientes `prisma` y `prismaService` de `lib/db` con
  eventos `query` y llama a los **loaders reales** con los mismos argumentos que la página. Cuenta statements,
  transacciones (`BEGIN`), ms de DB y wall-clock. La mediana sale de 3 corridas, después de un warm-up.
- **Fixture de volumen** (`tests/perf/volume-fixture.ts`): tenant **efímero**, creado y borrado en cada corrida (no
  es un seed). Tiene:
  - 1.000 pacientes (la mitad con cobertura) y 2 profesionales;
  - 10.000 turnos;
  - 200 planes × 20 sesiones × 6 ejercicios;
  - 50.000 AuditEvent.

  Termina con `ANALYZE`: sin eso, el planner trabaja con estadísticas vacías y la medición no representa prod (ver la
  nota sobre el dashboard).
- `EXPLAIN (ANALYZE, BUFFERS)` automático de la query más lenta de cada escenario; se reportan los Seq Scan de más de
  500 filas.
- Resultados crudos: `tests/perf/baseline.json` y `tests/perf/pool-pressure.json`. `baseline.json` es el de A1 y
  **no se regrabó** (ni al cierre del Bloque A ni en ES3): sigue siendo la referencia de los presupuestos de C1. Conserva
  la clave `createProgram.16` como histórico (§ES3).

## Baseline (2026-09-30, rol `kinesoft_app` con RLS, Docker local)

| Escenario | Statements | Tx | app/service | DB ms | Wall ms | Seq Scan |
|---|---|---|---|---|---|---|
| GET /agenda (6 loaders en paralelo) | 48 | 9 | 24/24 | 45 | 126 | Booking |
| · solo `listBookingsInRange` (semana) | 14 | 3 | 10/4 | 13 | 69 | — |
| · solo `listPatients()` (dropdown del modal) | 13 | 2 | 9/4 | 47 | 135 | Booking |
| GET /dashboard | 45 | **15** | 25/20 | 74 | 43 | — |
| GET /pacientes/[id] (plan de 20 sesiones) | 63 | 14 | 30/33 | 254 | **411** | **SessionExercise** |
| GET /seguimiento | 8 | 1 | 4/4 | 5 | 15 | — |
| GET /biblioteca | 40 | 6 | 12/28 | 0 | 13 | — |
| POST `createBooking` (1 turno) | 12 | **7** | 7/5 | 0 | 16 | — |
| POST `createBookingsBatch` (20 turnos) | 68 | **23** | 63/5 | 2 | 74 | — |
| POST `createProgram` (16 sesiones) | 9 | 1 | 4/5 | 5 | 9 | — |

> **Cómo leer la columna service:** en los tests, `cache()` de React es pass-through (no existe fuera de Next), así
> que `getActor()` se resuelve en cada llamada. En un **render RSC** real se deduplica por request, así que en las
> **cargas de página** las queries "service" (membership + practitioner) están **sobrecontadas**. En las **Server
> Actions** (los POST) coinciden con prod, porque ahí `cache()` tampoco deduplica (hallazgo
> `react-cache-no-deduplica-en-server-actions`).

**Presión de pool** (`connection_limit=1`, 10 dashboards + 10 agendas concurrentes): 0 errores y p95 entre 1,1 y
2,6 s según la corrida. Todo se serializa detrás de una conexión. En una corrida con estadísticas vacías, una query
lenta retuvo la conexión más de 2 s y **17 de 20 requests fallaron con P2028** (timeout al abrir la transacción).

## Re-medición al cierre del Bloque A (30-sep)

Misma fixture, mismo rol (`kinesoft_app`), después de A2 + A3. Sin regresiones graves. `tests/perf/baseline.json`
**no se regrabó**: sigue siendo el de A1, que es contra el que se fijan los presupuestos de C1.

| Escenario | Statements A1 → A | Tx A1 → A | Nota |
|---|---|---|---|
| GET /agenda (6 loaders) | 48 → 48 | 9 → 9 | igual |
| · `listBookingsInRange` (semana) | 14 → 14 | 3 → 3 | igual |
| · `listPatients()` | 13 → 13 | 2 → 2 | igual |
| GET /dashboard | 45 → 48 | 15 → 16 | acceso resuelto fuera del `unstable_cache` (A2b-S-vis) |
| GET /pacientes/[id] | 63 → 63 | 14 → 14 | igual |
| GET /seguimiento | **8 → 28** | 1 → 1 | 15 → 47 ms: 4 buckets + filtro de acceso (A2a-S03). Sigue en 1 tx; va a C1 (`seguimiento-7-queries`) |
| GET /biblioteca | 40 → 40 | 6 → 6 | igual |
| POST `createBooking` | 12 → 17 | **7 → 6** | más validaciones (IDOR, key de otro tenant, capacidad) en menos tx |
| POST `createBookingsBatch` (20) | 68 → 72 | 23 → 22 | validación de practitioner/paciente ∈ tenant |
| POST `createProgram` (16) | 9 → 11 | 1 → 1 | |

**Bundle al cierre del Bloque A** (`next build` + `perf:bundle`, first-load gzip):

| Ruta | A1 | Cierre A | Presupuesto |
|---|---|---|---|
| `/agenda` | 176,6 kB | **183,8 kB** | ≤ 180 kB → **excedido** |
| `/c/[slug]/booking` | 147,3 kB | 149,7 kB | ≤ 150 kB (al borde) |
| `/login` | — | 141,5 kB | ≤ 150 kB |

Parte del aumento general (~2 kB por ruta) es el upgrade de Next 14.2.18 → 14.2.35 (A3b-S-obs). `/agenda` creció
~7 kB y quedó por encima de los 180 kB (en A1 estaba debajo): el reporte de CI es solo informativo, así que no
rompe el build; el recorte va a C1 (presupuesto de bundle; framer-motion en el root layout ya estaba anotado).

## B4.6 — agenda multi-profesional (B-pre, 01-oct-2026)

`tests/perf/agenda-multi.perf.test.ts` → `tests/perf/agenda-multi.json`. Rol `kinesoft_app` (RLS), Docker local,
mediana de 3 corridas. Fixture efímera de **volumen de Secretaria**: 6 profesionales (3 de gimnasio con cupo, 3 de
osteopatía), 2 sedes, 1.000 pacientes, 6.885 turnos, **1.365 en la semana medida** (28-sep-2026).

| Escenario | Statements | Tx | DB ms | Wall ms | A1 (st/tx/wall) | Resultado |
|---|---|---|---|---|---|---|
| `listBookingsInRange` (vieja), semana, 6 prof. | 14 | 3 | 11 | 78 | 14/3/69 | 1.365 filas, 786 kB |
| `listAgendaBookings` (nueva), semana, 6 prof. | 15 | 2 | 17 | 60 | — | 1.365 filas, **1.036 kB** |
| · solo sede principal | 15 | 2 | 12 | 57 | — | 1.275 filas, 967 kB |
| · 2 profesionales | 15 | 2 | 6 | 34 | — | 455 filas, 345 kB |
| GET /agenda con la proyección vieja | 84 | 14 | 94 | 109 | 48/9/126 | |
| GET /agenda como queda (11 loaders) | 85 | 13 | 100 | 81 | 48/9/126 | |
| `getAgendaAvailability`, semana | 17 | 2 | 4 | 31 | — | 6 prof. × 7 días, 3 bloqueos |
| `listAvailableSlots` "cualquier profesional" | 21-22 | 2 | 3-4 | 29-32 | — | 3 elegibles, primer libre |
| `listAvailableSlots` un profesional | 20 | 2 | 0 | 12 | — | 38 slots |
| `previewRecurrence` semanal × 20 | 22 | 2 | 2 | 47 | — | |
| `previewRecurrence` **mensual × 20** | **106** | 2 | 0 | 52 | — | → C1 |
| `createBooking` | **34** | 5 | 0 | 20 | 12/7/16 | → C1 |
| `createBooking` con conflicto | 44 | 5 | 0 | 27 | — | aviso de sobreturno |
| `createBookingsBatch` × 20 | **166** | **22** | 0-2 | 95-113 | 68/23/74 | → C1 |

CPU del layout (`lib/agenda-layout.ts`, presupuesto de frame 16 ms):

| Escenario | Turnos | Celdas | Mediana | p95 | Máx |
|---|---|---|---|---|---|
| `buildPractitionerColumns` día, zoom 30 | 273 | 144 | 1,36 ms | 1,63 | 1,9 |
| ídem zoom 15 | 273 | 288 | 1,45 ms | 1,8 | 2,15 |
| ídem ×2 turnos | 546 | 288 | 2,37 ms | 2,77 | 3,26 |
| ídem ×4 turnos | 1.092 | 288 | 5,14 ms | 5,66 | 5,83 |
| `weekOccupancy` semana, zoom 30 | 1.365 | 168 | **9,32 ms** | 9,74 | 9,75 |

Lectura:
- **Lecturas de 12 a 60 ms y layout < 2 ms por día cargado: no hace falta virtualizar** la vista Por profesional.
- La proyección nueva evita el grafo paciente → coberturas → programas (60 vs 78 ms), pero el **payload de la
  semana es ~1 MB** (suma sede, recepción y telemedicina por fila) → C1 (`perf-agenda-payload-1mb`).
- GET /agenda pasó de 48 a 85 statements (11 loaders: sedes, franjas, disponibilidad, prefs) con menos wall-clock
  que la proyección vieja en el mismo fixture.
- `createBooking` 12 → 34 statements y el batch 68 → 166: el motor carga franjas/bloqueos/PS y el lock de cupo, más
  el re-chequeo de bloqueos dentro de la tx. Siguen < 120 ms; juntar en una tx es C1 (`perf-batch-una-tx`,
  `perf-create-booking-34-statements`). `previewRecurrence` mensual (106) carga por mes → C1.
- `weekOccupancy` es O(turnos + filas) (~10 ms/semana): dentro del frame pero el más caro → C1.
- ⚠️ **Falso positivo de EXPLAIN en el harness de A1.** `loaders.perf.test.ts` pasa los parámetros como `$n`
  tipados: un `Date` viaja como `timestamptz` y Postgres castea la **columna** `timestamp(3)`, así que el índice
  `(tenantId, scheduledFor)` deja de servir y el EXPLAIN muestra un Seq Scan que la query real de Prisma no hace.
  El harness de B4.6 inlinea literales sin tipo (`tests/perf/agenda-multi.perf.test.ts:275-283`). **Los Seq Scan
  de Booking del baseline de A1 pueden ser este artefacto**; pasar `loaders.perf.test.ts` a literales es C1
  (`perf-harness-explain-params-tipados`). Los Seq Scan que todavía muestra B4.6 sobre Booking devuelven 1.365 de
  6.885 filas del tenant (~20 %): ahí es elección legítima del planner, no el artefacto.
- `Coverage.patientId` sin índice se re-confirmó → C1 (`missing-fk-indexes`).

**Bundle al cierre de B-pre** (`next build` + `perf:bundle`, first-load gzip):

| Ruta | Cierre A | B-pre | Presupuesto |
|---|---|---|---|
| `/agenda` | 183,8 kB | **195,3 kB** (238,4 antes de la carga diferida) | ≤ 180 → excedido |
| `/configuracion` | — | **209,3 kB** | ≤ 180 → excedido |
| `/pacientes/[id]` | — | 193,9 kB | ≤ 180 → excedido |
| `/onboarding` | — | 185,1 kB | ≤ 180 → excedido |
| `/plataforma/ejercicios` | — | 183,7 kB | ≤ 180 → excedido |
| `/diagnostico` | — | 180,3 kB | ≤ 180 → al borde |
| `/plataforma/catalogo/*` | — | 163,5-179,3 kB | ≤ 180 |
| `/c/[slug]/booking` | 149,7 kB | **153,2 kB** | ≤ 150 → excedido |
| `/signup` | — | 146,4 kB | ≤ 150 |
| `/login` | 141,5 kB | 141,7 kB | ≤ 150 |

El layout compartido creció 10-16 % (columna "vs baseline" del reporte: casi todas las rutas de la app +10-12 %).
La carga diferida de modal, drawer, candado, Recepción y Por profesional bajó `/agenda` de 238 a 195 kB. El reporte
de CI sigue siendo informativo; el recorte va a C1 (`bundle-sobre-presupuesto-bpre`).

## ES3 — Planes P3 (08-oct-2026)

Gate en solitario sobre el Docker local, con `PERF_OUT_DIR` (medir fuera del árbol) + `tests/perf/compare.ts` contra
los versionados. **Sin regresiones fuera de umbral** en los 28 escenarios. Los versionados **no se regrabaron**.

- **Escenario nuevo `createPlan.16`** (alta de un plan de 16 sesiones por el motor): **36 statements / 1 tx**. Reemplaza
  a `createProgram.16`, que se retiró con `createProgram` (S27a). `tests/perf/baseline.json` **conserva la clave
  `createProgram.16`** como histórico (es versionado y no se edita; el grep del gate de retiro lo excluye) y
  `compare.ts` reporta `createPlan.16` como "new". Las filas `createProgram` de las tablas de arriba son historia.
- **Informativos** (contra el versionado que compara `compare.ts`; crecen por lectores nuevos, no por regresión):

| Escenario | Statements versionado → ES3 | Por qué |
|---|---|---|
| `listAgendaBookings` (semana) | 16 (= ES2b) | igual: el DTO compacto C9 no suma queries |
| GET /dashboard | 45 → 52 | ingresos reales (S14r: MP + copagos manuales + OS aparte) |
| GET /pacientes/[id] | 63 → 84 | lectores de planes y saldos (`getPatientPlans` / `getPatientPlanBalances`) |
| GET /seguimiento | 8 → 20 | buckets "Sin turno" / "Sin evolución" y ordinal |

- **Payload de la agenda ≤ +5 %:** no se midió aparte. El DTO compacto (C9, `components/agenda/agenda-utils.ts`)
  omite los neutros y los statements quedaron igual que en ES2b.

**Bundle** (first-load gzip). La columna ES2b se midió compilando `58ec36f` con `git archive` en un directorio aparte
(scratchpad), no desde un reporte viejo:

| Ruta | ES2b (`58ec36f`) | ES3 | Criterio de PLANES §11 |
|---|---|---|---|
| `/pacientes/[id]` | 198,9 kB | **205 kB** (240,6 antes de la carga diferida) | no empeora → **no cumplido** |
| `/agenda` | 196,6 kB | **202 kB** | no empeora → **no cumplido** |
| `/diagnostico` | 182,1 kB | 180,1 kB | no empeora → cumplido |
| `/seguimiento/[sessionId]` | 177 kB | 184,9 kB | — |
| `/dashboard` | 180,3 kB | 184 kB | — |
| `/planes` | — | **184,5 kB** | ≤ 180 → **no cumplido** |

Lo que se difirió para llegar acá: pestañas no default del perfil, el editor (`next/dynamic`) y el modal de agendar de
Seguimiento. El chunk compartido de zod (13 kB) ya estaba en el layout. **Aceptado por Martin el 08-oct** (es lo que
piden C9/S22f; el presupuesto bloqueante sigue en C1 por §14.4). Fila `bundle-es3-sobre-criterio` en AUDIT; el split de
helpers de `slot-cell` es C1.

## SR — Salas/Consultorios (08-oct-2026)

Gate en solitario sobre el Docker local, `compare.ts` contra los versionados (no se regrabaron). **Sin regresiones
fuera de umbral** en los 28 escenarios. Los estrictos quedan iguales: `f.createBooking` 35 = base, `f.createBookingsBatch.20`
186 = base (sin salas en el fixture).

- **Sin sala = 0 sentencias nuevas** en create, update, batch y `listAgendaBookings`: todas las queries de sala son
  condicionales. Lo fijan los tests de statements de `bookings-rooms` y `bookings-core-rooms`.
- **Con sala** (medido por las sesiones, no en `compare.ts`): alta +1 con sede explícita (+3 con sede null: con sala
  corren `lockTenantLocationsShared`, la validación de la sala y el conteo, que antes no corrían); edición +2
  (SR3a: 30 → 32). El cupo y la sala se lockean en **una** sentencia (C2 (1b)); la ocupación es una sentencia UNION
  ALL; el batch carga los turnos de la sala una vez.
- **Bootstrap de `/agenda`:** +1 sentencia / +1 tx (`listRoomOptions`, aparte de `listAgendaBookings`; escenarios
  `agenda` 48 → 49 y `a.page.*` +1). Configuración: `getPractitionerSchedule` sin salas = 0 queries nuevas, con salas +3.
- **Dashboard 19 → 15 tx, mismas sentencias (52).** `getDashboardData` abría 6 tx interactivas de ingresos en
  paralelo con las de los counts → "Unable to start a transaction in the given time" intermitente (riesgo real en
  prod, con el pool chico de Vercel). Ahora `loadRevenue` es **una** tx con las lecturas en serie
  (`revenueAmountsInTx`, `lib/dashboard.ts:585,642`): con todo en paralelo `Promise.all` no ganaba nada salvo
  conexiones. **Diferido C1 perf:** `_loadDashboardCounts` (`lib/dashboard.ts:153`) sigue abriendo ~8 `runWithRls`
  en paralelo, el mismo patrón (AUDIT `dashboard-counts-tx-paralelas`).

**Bundle** (first-load gzip, `npm run perf:bundle`):

| Ruta | ES3 | SR | Criterio de §17.3 (≤ +1 kB) |
|---|---|---|---|
| `/agenda` | ~202 kB | **204,5 kB** | **no cumplido** |
| `/configuracion` | ~212,5 kB | **216,2 kB** | **no cumplido** |
| `/dashboard` | 184 kB | 184,6 kB | cumplido |
| `/pacientes/[id]` · `/planes` · `/seguimiento/[sessionId]` · `/diagnostico` | 205,3 · 184,6 · 185 · 180,3 kB | sin cambios | — |

Lo que ya va diferido: "Por sala" (`RoomDayPanel`) y `RoomFilter` con `dynamic()` en `/agenda`; `RoomsSection` con
`dynamic` al abrir en `/configuracion`. `buildRoomColumns` se separó a `lib/agenda-layout-rooms.ts` (sin re-export desde
`agenda-layout.ts`): webpack no separa un módulo por export y viajaba en el first load (~−0,83 kB gz, proxy de esbuild
de SR-U6). **Decisión de Martin** (recomendado: aceptar; el bloqueante está en C1). Mejora concreta: el `WeekDrawer`
del editor de horarios con `dynamic` (C1). Fila `bundle-sr-sobre-criterio` en AUDIT.

## SV — Sala de Espera realtime (13/14-oct-2026)

El publish es un POST HTTP después del commit: **0 sentencias SQL nuevas** en los write-paths. Lo que cuesta es
wall-clock: se **espera** (SV-D7) con tope de 1,5 s, y con el breaker abierto (3 fallos → 30 s) no se hace el POST. En
tests y perf el publisher es un fake (`tests/helpers/realtime-fake.ts`, mock global en `integration-setup.ts`): nunca
se toca Supabase.

- **Escenarios nuevos `rt.*`** (`tests/perf/realtime-publish.perf.test.ts`; informativos, sin referencia versionada:
  `compare.ts` los lista como «nuevo»): `rt.createBooking.lat0` (publish instantáneo, mismos statements que
  `f.createBooking`), `rt.createBooking.lat1500` (el publisher tarda el tope: el alta paga ~1,5 s **una vez**; es el
  techo, no el caso normal) y `rt.createBookingsBatch.20.posts` (batch de 20 = **1** llamada con 20 refs).
- **Del lado del cliente:** cada lote relevante dispara un re-pedido coalescido (250 ms, uno en vuelo) de la semana
  visible o de hoy en `/sala`; los avisos re-piden hoy por pestaña (C1: medir con el tenant perf, AUDIT
  `arrival-alerts-refetch-por-pestana`). Con `off` no hay re-pedidos: la agenda es la de SR y `/sala` pollea cada 60 s.
- **Bundle:** `@supabase/realtime-js` entra solo por `import()` dentro de `connect()` (guard (e)): no está en ningún
  first-load. El provider, el indicador y los avisos sí van en el layout `(app)` (todas las rutas del workspace).

**Números del gate (14-oct, tenant perf):**

| Escenario | Statements / tx | wallMs | Nota |
|---|---|---|---|
| `f.createBooking` | 35 / 5 (=) | 29 | el publish es HTTP: 0 sentencias |
| `f.createBookingsBatch.20` | 186 / 22 (=) | 160 | 1 publish con 20 refs |
| `a.listAgendaBookings.week` | 16 / 2 (= ES2b) | 65 | `calledAt` es una columna más, 0 sentencias |
| `rt.createBooking.lat0` | 35 / 5 | 22 | publisher fake sin latencia |
| `rt.createBooking.lat1500` | 35 / 5 | 1543 | peor caso acotado por el timeout (1,5 s) + breaker |
| `rt.createBookingsBatch.20.posts` | 186 / 22 | 138 | afirma 1 sola llamada |

**Bundle (gz, first-load):** `/dashboard` 184,6 → **189,1** (+4,5 = provider realtime + prefs de avisos + toast extendido);
`/agenda` 204,5 → **212,3**; `/configuracion` 216,2 → 220,8; `/sala` 198,7 (nueva). El motor de avisos, sus controles y el
hub del cliente van por `import()` dinámico; `@supabase/realtime-js` solo en un chunk async. Decisión en AUDIT Ronda 20.

## PF-0 · lentitud general (15-oct-2026, H-SLOW)

Martin nota lentitud en **todas** las páginas. PF-0a mide el costo por request de la app REAL (`next build` + `next
start`), no de los loaders sueltos como el harness de arriba. Es la tabla «antes» de PF-0b/c/d.

### Cómo se midió

- `lib/server-timing.ts` (`PERF_TIMING=1`): acumulador por request colgado del `requestAsyncStorage` de Next (envuelve
  layout, página y server actions). Marcas: `auth` (antes de PF-0b `getVerifiedSessionUser`, la llamada real a GoTrue; desde PF-0b `getSessionUser`, local; `auth-strict` = `getStrictSessionUser`), `access`
  (`loadAccessMemberships`), `actor` (`resolveActor` entero), cada `runWithRls` (cantidad y duración) y cada op de
  Prisma de los dos canales (`$use`). El middleware emite `Server-Timing: mw-session;dur=…` (su refresh de sesión).
  Apagado no se instala nada (`$use` incluido) y `timeAsync` devuelve la misma promesa.
- `scripts/perf/ttfb.mjs`: build + start en :3100 con un **GoTrue falso** (127.0.0.1:3199, `GET /auth/v1/user`) y una
  cookie `sb-127-auth-token` de verdad. El actor demo (`KINESOFT_ALLOW_DEMO_ACTOR=1`) **no sirve** con `next start`:
  `lib/session.ts` lo habilita solo con `NODE_ENV !== "production"`. Así el camino es el de prod: middleware →
  `getUser()` por HTTP → membresías → actor → layout → página. Las 7 claves del `.env` (que puede apuntar a prod) se
  pisan en el proceso hijo.
- **Latencia de red simulada**: `--auth-latency` demora el GoTrue falso; `--db-rtt` mete un proxy TCP (127.0.0.1:5499)
  que demora cada paquete RTT/2 por sentido. Con eso el wall-clock incluye el **camino crítico** real: las tx en
  paralelo se solapan y las en serie se suman.
- Tenant `movare` del Docker (8 pacientes, 23 turnos), rol OWNER, mediana de 5 corridas (1 de calentamiento
  descartada), requests en serie. **Volumen chico a propósito**: mide el costo fijo por request (auth, actor, layout,
  idas y vueltas), no el de volumen (eso está en las secciones de arriba).
- Se midió sobre un snapshot `git archive HEAD` (d2092e6) + la instrumentación, en el scratchpad, por el bloqueante
  de abajo.

> **Bloqueante encontrado (clase A, develop sin pushear):** con `next build` **todas** las páginas de `(app)` dan 500
> (`TypeError: b is not a function`). `app/(app)/layout.tsx:131` llama a `shellTenantChoice`, que vive en
> `components/layout/support-banner.tsx` (`"use client"`): en un build de producción un import de un módulo cliente
> desde un server component es una *client reference*, no la función. Viene de BO3 (`280c96f`). Para medir se aplicó el arreglo solo en el snapshot (la función a un módulo sin `"use client"`); el
> arreglo real es un handoff (ver el reporte de PF-0a).

### Tabla «antes» (ms, mediana)

Escenarios: **local** (sin latencia), **misma región** (auth 30 ms, DB RTT 3 ms ≈ Vercel `gru1` ↔ Supabase
`sa-east-1` por Supavisor), **10 ms** (auth 40, DB 10) y **cruzado** (auth 150, DB 120 ≈ Supabase en `us-east-1`).
`txs`/`ops`/`RT` son por request: ops = operaciones de Prisma (un `include` puede ser más de una sentencia) y
RT = ops + 3 por tx (BEGIN, `set_config`, COMMIT). **D** = idas y vueltas a la DB **en serie** (camino crítico),
estimado como `(total₁₂₀ − total₁₀ − Δauth) / ΔRTT`.

| Ruta | TTFB / total local | TTFB / total misma región | total 10 ms | TTFB / total cruzado | auth · access · actor (misma región) | txs | ops | RT | **D** |
|---|---|---|---|---|---|---|---|---|---|
| `/dashboard` | 48 / 60 | 113 / 171 | 481 | 1.741 / **3.428** | 37 · 18 · 55 | 5 | 18 | 33 | 26 |
| `/agenda` | 53 / 78 | 111 / 182 | 531 | 1.617 / **5.349** | 38 · 17 · 54 | 9 | 35 | 62 | 43 |
| `/pacientes` | 45 / 56 | 103 / 143 | 351 | 1.599 / **2.726** | 37 · 18 · 54 | 4 | 13 | 25 | 21 |
| `/pacientes/[id]` | 45 / 78 | 90 / 226 | 762 | 1.600 / **6.088** | 35 · 16 · 50 | 13 | 38 | 77 | 47 |
| `/configuracion` | 37 / 39 | 151 / 153 | 463 | 3.264 / **3.267** | 36 · 17 · 51 | 12 | 35 | 71 | 25 |
| `/sala` | 38 / 43 | 115 / 134 | 287 | 1.720 / **2.111** | 37 · 18 · 55 | 4 | 14 | 26 | 16 |
| `/seguimiento` | 73 / 76 | 180 / 183 | 418 | 2.794 / **2.798** | 34 · 18 · 53 | 2 | 19 | 25 | 21 |
| `router.refresh()` de `/agenda` (GET `RSC: 1`) | 13 / 53 | 12 / 203 | 491 | 16 / **3.794** | 34 · 15 · 49 | 9 | 35 | 62 | 29 |
| `router.refresh()` de `/pacientes` | 9 / 33 | 11 / 139 | 353 | 17 / **2.615** | 34 · 20 · 56 | 4 | 13 | 25 | 20 |
| action `listAgendaBookings` (semana) | 37 / 39 | 104 / 105 | 277 | 1.980 / **1.981** | 34 · 17 · 51 | 2 | 7 | 13 | 15 |

Lo que no cambia entre escenarios: middleware 1-3 ms (`getSession()` sin red con el token vigente); 1 sola llamada a
GoTrue y 1 solo armado del actor por request (la memo de `cache()` funciona en las páginas; la action medida llama a
`getActor()` una sola vez, así que no dice nada de `react-cache-no-deduplica-en-server-actions`); render +
framework (total − span del servidor, local) 17-33 ms. HTML: 52-80 kB (`/seguimiento` 160 kB). Dashboard en 5 tx (no
15) porque los counts salen de `unstable_cache` después del calentamiento. Crudo: `ttfb-a{auth}-d{rtt}.json` del
scratchpad de la sesión (no versionado; se regenera con el script).

### Diagnóstico: causas en orden

Modelo que ajusta a las cuatro corridas: **total ≈ local + RTT_auth + D × RTT_db** (D entre 15 y 47).

1. **Región de Supabase (sin confirmar) — decide todo.** Vercel está en `gru1` (`vercel.json:3`). Si el proyecto de
   Supabase está en `sa-east-1`, el servidor tarda 100-230 ms por página; si está en `us-east-1` (RTT ~120 ms desde São
   Paulo), **2,1-6,1 s por página y ~2 s por action**: es exactamente «lento en todas las páginas». En local no se
   puede medir la red real. **Martin confirma** en Supabase → Settings → General → Region (o mirando el host del pooler
   en la `DATABASE_URL` de Vercel: `aws-0-<región>.pooler.supabase.com`). Si no es `sa-east-1`, mover el proyecto es
   la causa principal y se decide aparte (es una migración de proyecto, no de schema).
2. **Costo fijo por request, antes de la página: actor + layout ≈ 1 HTTP a GoTrue + ~11 idas y vueltas en serie.**
   Es el TTFB de las páginas con `loading.tsx` en el escenario cruzado (~1,6 s = auth 160 + membresías 512 + layout
   ~950). Desglose: `getUser()` 1 HTTP (misma región ≈ 35 ms, **~33 % del TTFB**); `loadAccessMemberships` ~4-5 RT en
   serie (un `select` anidado de Prisma = una query por relación); el layout de `(app)` encadena
   `getTenantChoiceState` → tx de tenant+rol (4 RT) → `getUserPreferences` → `realtimeBootstrap`, todo con `await` en
   serie. **Lo paga cada página y cada server action** (la action de lectura: actor = 51 de 105 ms en misma región).
3. **Una tx interactiva por lectura (`runwithrls-interactive-tx-per-read`).** Cada tx suma 3 RT de marco: son
   27 de 62 RT en la agenda, 39 de 77 en el perfil y 36 de 71 en configuración (**~45-50 % de las idas y vueltas**
   de las tres páginas pesadas). Sobre el camino crítico (D) se estima ~35-45 %. Misma región: ~30-60 ms por página
   pesada; cruzado: 1,5-2,5 s.
4. **Doble render (`revalidatePath` + `router.refresh()`).** El refresh es un render ENTERO de la página: +203 ms en
   la agenda y +139 ms en pacientes por cada mutación en misma región (3,8 s y 2,6 s cruzado), encima de la action
   que ya devolvió el árbol revalidado.
5. **Navegación percibida.** `/configuracion` y `/seguimiento` (y planes, biblioteca, plataforma…) no tienen
   `loading.tsx`: TTFB = total, el click no responde hasta que termina todo. Con `loading.tsx` (dashboard, agenda,
   pacientes, sala) el esqueleto sale apenas termina el layout. La transición de `(app)/template.tsx` (framer) se suma
   después.
6. **Render en el servidor y JS: no es la causa.** 17-33 ms de render; middleware 1-3 ms. El JS inicial
   (`next build`: agenda 198 kB, configuración 214, perfil 199, dashboard 181) pesa en la hidratación de equipos
   lentos; es PF1/VX-F, no PF-0.
7. **No medido, a revisar en Vercel:** arranques en frío (con un solo cliente casi todos los requests pueden caer en
   una función fría: Prisma + conexión nueva = varios RTT más) y si la `DATABASE_URL` usa `pgbouncer=true` (sin
   statements preparados cacheados cada query puede costar 2 RT). Ver «Init Duration» en los logs de Functions.

### Recomendación para PF-0b/c/d y PF2

- **PF-0b (sesión local + costo fijo), primero.** _Hecho (ver «PF-0b» abajo)._ (a) `getVerifiedSessionUser` verifica el JWT local: `getClaims()` si
  el proyecto usa claves asimétricas (JWKS cacheado); si sigue con el secreto HS256, verificación HMAC con
  `SUPABASE_JWT_SECRET` (ya existe en `lib/env.ts`). −1 HTTP por request y por action (misma región ≈ −35 ms; cruzado
  −150 ms). Revocación: el token vale hasta su `exp` (≤ 1 h); lo cubren `disabledAt` (se sigue leyendo en cada
  request) y `getUser()` en los puntos sensibles (contraseña, 2FA, cobros, Plataforma). (b) `loadAccessMemberships` en
  **una** query (raw SQL con joins, o `relationLoadStrategy: "join"` de Prisma): −3/−4 RT por request. (c) **Sumar al
  dueño de PF-0b el layout de `(app)`**: `getTenantChoiceState`, la tx de tenant+rol, `getUserPreferences` y
  `realtimeBootstrap` en `Promise.all` (dependen solo del actor): −4/−6 RT por página. Con las tres, el costo fijo
  pasa de ~1 HTTP + 11 RT a ~5 RT (misma región: TTFB ~110 → ~50 ms; cruzado: 1,6 → ~0,6 s).
- **PF-0c (percibida):** `loading.tsx` en configuración, seguimiento, planes, biblioteca, diagnóstico, reportes y
  plataforma (y uno propio en `/pacientes/[id]` con forma de perfil); `template.tsx` a CSS de 120 ms. No baja el total
  pero el click responde en el TTFB del layout.
- **PF-0d (doble render):** sacar `router.refresh()` después de actions con `revalidatePath` en agenda (crear, mover,
  estado, cobro), pacientes y Recepción: ahorra un render entero por mutación (agenda ~200 ms misma región). Volver a
  medir con `ttfb.mjs` (filas `router.refresh()`).
- **PF2 (una tx por loader): adelantarlo a después de PL — sí, acotado a agenda, perfil y configuración.** El marco de
  tx es la categoría más grande de idas y vueltas en esas tres páginas (~45-50 %) y PL suma loaders. En dashboard,
  pacientes, sala y seguimiento manda el costo fijo (punto 2), no las tx: ahí alcanza con PF-0b. Si la región resulta
  ser `us-east-1` y no se mueve el proyecto, PF2 pasa a urgente (−1,5-2,5 s por página pesada).

### PF-0b · sesión sin ida y vuelta a GoTrue + costo fijo (15-oct-2026)

Qué se hizo (detalle de seguridad en SECURITY.md §11.1):

- **JWT local** (`lib/session-user.ts` `getSessionUser` + `lib/session-jwt.ts`): el actor ya no llama a
  `auth.getUser()`. HS256 con `SUPABASE_JWT_SECRET` (o `getClaims()` con JWKS si el proyecto usa claves asimétricas);
  lo que no se puede probar local cae a GoTrue (nunca se acepta por descarte). Memo por request de Next y por token
  (también en server actions, donde `cache()` no deduplica). `getStrictSessionUser()` (= `getVerifiedSessionUser`)
  sigue con GoTrue para invitación, alta, portal, turnero, reset y Plataforma (handoff).
- **Membresías en una sentencia** (`loadAccessMemberships`): SQL con `LEFT JOIN` en vez del `select` anidado de Prisma
  (4 queries en serie). `createBooking` baja de **34 a 31 sentencias** y `updateBooking` de 30 a 27 (el techo estricto
  de `tests/integration/bookings-rooms.test.ts` se actualiza por handoff).
- **Layout `(app)`**: rol y `onboardingCompletedAt` salen de la foto de acceso (sin la tx de tenant+rol: −1 tx, −4 RT
  por página); las preferencias se piden en paralelo con el gate.
- `scripts/perf/ttfb.mjs` ahora firma el token de la cookie con un secreto propio (`SUPABASE_JWT_SECRET` del hijo) y el
  `iss` del GoTrue falso: mide el camino de prod. `--legacy-auth` lo firma con otra clave (cae a GoTrue: el «antes»).

**Antes / después.** Medido sobre snapshots `git archive HEAD` (`1553192`) con y sin SOLO los archivos de PF-0b (las
otras sesiones de la ola tocaban `loading.tsx`/`template.tsx` a la vez y el TTFB de las páginas sin esqueleto cambia
con eso). `next build` + `next start`, mismo Docker. Misma región = auth 30 / DB 3 ms, mediana de 5. Cruzado = auth
150 / DB 120 ms, mediana de 3; su «antes» es la corrida del inicio de la sesión sobre el working tree (el snapshot
limpio se colgó dos veces con 120 ms de RTT): en configuración y seguimiento ya tenía el esqueleto de PF-0c, por eso
ahí se compara el total. TTFB / total en ms; `HTTP` = llamadas a GoTrue por request.

| Ruta | misma región antes | **después** | cruzado antes (total) | **después** | txs / ops / RT antes → después | HTTP |
|---|---|---|---|---|---|---|
| `/dashboard` | 117 / 174 | **45 / 113** | 1.895 / 3.780 | **299 / 2.610** | 5/18/33 → 4/15/27 | 1 → 0 |
| `/agenda` | 112 / 216 | **40 / 179** | 1.604 / 5.302 | **423 / 3.260** | 9/35/62 → 8/32/56 | 1 → 0 |
| `/pacientes` | 108 / 150 | **36 / 103** | 1.503 / 2.643 | **303 / 2.115** | 4/13/25 → 3/10/19 | 1 → 0 |
| `/pacientes/[id]` | 112 / 289 | **54 / 179** | — / 5.471 | **931 / 5.268** | 13/38/77 → 12/35/71 | 1 → 0 |
| `/configuracion` (sin esqueleto) | 168 / 170 | **116 / 119** | — / 3.203 | **— / 2.990** | 12/35/71 → 11/32/65 | 1 → 0 |
| `/sala` | 105 / 130 | **41 / 73** | 1.461 / 2.074 | **295 / 1.449** | 4/14/26 → 3/11/20 | 1 → 0 |
| `/seguimiento` (sin esqueleto) | 174 / 177 | **104 / 107** | — / 2.698 | **— / 2.269** | 2/19/25 → 1/16/19 | 1 → 0 |
| `router.refresh()` `/agenda` | 15 / 197 | 14 / 124 | 16 / 3.630 | 12 / 3.232 | 9/35/62 → 8/32/56 | 1 → 0 |
| `router.refresh()` `/pacientes` | 16 / 142 | 14 / 90 | 16 / 2.740 | 17 / 2.193 | 4/13/25 → 3/10/19 | 1 → 0 |
| action `listAgendaBookings` | 109 / 111 | **69 / 71** | 1.989 / 1.990 | **1.451 / 1.452** | 2/7/13 → 2/7/13 | 1 → 0 |

Lectura:

- **Costo fijo por request** (marca `actor`: sesión + membresías + soporte): misma región **54-57 → 6-10 ms**; cruzado
  **663-685 → 131-137 ms**. `access` (membresías) 15-20 → 4-8 ms y 490-522 → 128-132 ms (1 ida y vuelta en vez de
  4). GoTrue: 1 → 0 llamadas en todas las rutas y en la action. Más el layout: −1 tx (−4 RT) por página.
- El TTFB de las páginas con esqueleto (lo que tarda en responder el click) baja de ~110 a **~35-55 ms** en la misma
  región y de ~1,5-1,9 s a **~0,3-0,4 s** cruzado. Cada server action ahorra ~40 ms (misma región) / ~540 ms
  (cruzado).
- El total de las páginas pesadas sigue mandado por sus loaders (una tx por lectura): agenda, perfil y configuración
  cruzadas quedan en 3-5,3 s. Eso es PF2 (y la región, punto 1 del diagnóstico).
- Crudo: `pf0b-clean0.json` / `pf0b-clean{,-x}.json` / `pf0b-before-x.json` del scratchpad de la sesión (no versionado; se regenera con el script).

## EV2-Z — Evoluciones (15-oct-2026)

`compare.ts` sin regresiones fuera de umbral (31 escenarios; techo estricto de turnos igual: `f.createBooking` 31,
`f.createBookingsBatch.20` 182). `seguimiento` da **8 → 17** (info) contra la fila de A1, pero **no es de EV2**: es el
mismo crecimiento ya explicado en ES3 (8 → 20, buckets «Sin turno» / «Sin evolución» y ordinal; PF-0b lo bajó). EV2-2d
solo sumó un `NOT EXISTS` (raíz viva de evolución del turno activo, EV2-D18) **dentro** de la sentencia de «Sin
evolución» que ya existía (`lib/sessions.ts`, `listOpenSessions`): +0 sentencias, 1 tx. El detalle de una sesión
(`/seguimiento/[id]`) suma el turno activo en el mismo `findFirst` (include) y `getBookingClinicalNote` en paralelo con
`listSchedulablePlanSessions`.

## Qué confirman o refutan estos números (hallazgos de la auditoría del 23-sep)

| Hallazgo | Veredicto con datos | Destino |
|---|---|---|
| `runwithrls-interactive-tx-per-read` (P) | **Confirmado.** Una tx interactiva por lectura: 15 tx en el dashboard, 14 en el perfil y 9 en la agenda. Con un pool chico todo se serializa, y una query lenta tira P2028 al resto | C1 |
| `bulk-writes-one-tx-per-row` / `write-paths-tx-secuenciales` | **Confirmado.** `createBooking` abre 7 tx para 1 turno; el batch, 23 tx para 20 turnos, en serie | C1 (y el motor de Planes de B lo hace en 1 tx) |
| `agenda-loads-full-patient-directory` | **Confirmado.** `listPatients()` sola cuesta más wall-clock (135 ms) que los turnos de la semana (69 ms) con 1.000 pacientes, y hace un Seq Scan de Booking. Crece con el directorio | C1 |
| **NUEVO** `session-exercise-count-full-scan` | El `_count` de ejercicios por sesión del perfil (`getPatientProgramsLite`, **retirada en ES3**; falta re-verificar los lectores nuevos) agrega la tabla `SessionExercise` **entera** (de todos los tenants), con RLS fila por fila, antes de filtrar: 250-380 ms con 24k filas. **Crece con el tamaño de la plataforma**, no del paciente | C1 |
| `missing-fk-indexes` (`Coverage.patientId`) | **Confirmado** en el plan de la suma de "OS percibido": Seq Scan de `Coverage` por cada turno | C1 (migración chica de índices) |
| Dashboard ~1 s | **Refutado como problema de prod:** era un artefacto de estadísticas vacías (sin `ANALYZE` el planner arrancaba por los 10k turnos). Con estadísticas reales, 43 ms. Queda como lección: después de imports masivos, correr `ANALYZE` | — |
| `service-channel-direct-url-pool-prod` (P) | Sin medir: depende del `DATABASE_URL` real de Vercel (tarea A0a del dueño). El test de pool da el mecanismo | A0a → C1 |

## Bundle (first-load JS gzip, raíz + layouts + página)

Baseline de A1 en `scripts/bundle-baseline.json` (no se regrabó; el estado al cierre de B-pre está en §B4.6). Las
más pesadas en A1: `/agenda` 176,6 kB · `/pacientes/[id]` 174 kB ·
`/plataforma/ejercicios` 167 kB. Presupuesto del workspace: ≤ 180 kB. Las públicas quedan **al borde** de su
presupuesto de 150 kB: `/c/[slug]/booking` 147,3 kB · `/signup` 143,8 kB · `/portal/*` 139-141 kB. framer-motion
(~35 kB gz) viaja en el root layout a todas las rutas → C1.
