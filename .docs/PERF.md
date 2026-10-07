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
Seguimiento. El chunk compartido de zod (13 kB) ya estaba en el layout. **Decisión de Martin** (recomendado: aceptar,
es lo que piden C9/S22f; el presupuesto bloqueante está diferido a C1 por §14.4). Fila `bundle-es3-sobre-criterio` en
AUDIT; el split de helpers de `slot-cell` es C1.

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
