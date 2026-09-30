# KineSoft — Performance: baseline medido y cómo medir

> Creado en el Bloque **A1.2** (2026-09-29/30). Es **solo medición**: nada de `lib/` ni `app/` cambió. Los fixes van
> en **C1**, contra estos números. Hasta entonces los tests de perf **no fallan por números**; los presupuestos
> (baseline +10%) se activan en C1.

## Cómo correrlo

| Qué | Comando | Dónde |
|---|---|---|
| Cargas de página + write-paths | `npm run test:perf -- tests/perf/loaders.perf.test.ts` | Docker local (:5433). Nunca prod |
| Presión de pool | `npm run test:perf -- tests/perf/pool-pressure.perf.test.ts` | Docker local |
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
- Resultados crudos: `tests/perf/baseline.json` y `tests/perf/pool-pressure.json` (se regrabaron en cada corrida).

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

## Qué confirman o refutan estos números (hallazgos de la auditoría del 23-sep)

| Hallazgo | Veredicto con datos | Destino |
|---|---|---|
| `runwithrls-interactive-tx-per-read` (P) | **Confirmado.** Una tx interactiva por lectura: 15 tx en el dashboard, 14 en el perfil y 9 en la agenda. Con un pool chico todo se serializa, y una query lenta tira P2028 al resto | C1 |
| `bulk-writes-one-tx-per-row` / `write-paths-tx-secuenciales` | **Confirmado.** `createBooking` abre 7 tx para 1 turno; el batch, 23 tx para 20 turnos, en serie | C1 (y el motor de Planes de B lo hace en 1 tx) |
| `agenda-loads-full-patient-directory` | **Confirmado.** `listPatients()` sola cuesta más wall-clock (135 ms) que los turnos de la semana (69 ms) con 1.000 pacientes, y hace un Seq Scan de Booking. Crece con el directorio | C1 |
| **NUEVO** `session-exercise-count-full-scan` | El `_count` de ejercicios por sesión del perfil (`getPatientProgramsLite`) agrega la tabla `SessionExercise` **entera** (de todos los tenants), con RLS fila por fila, antes de filtrar: 250-380 ms con 24k filas. **Crece con el tamaño de la plataforma**, no del paciente | C1 |
| `missing-fk-indexes` (`Coverage.patientId`) | **Confirmado** en el plan de la suma de "OS percibido": Seq Scan de `Coverage` por cada turno | C1 (migración chica de índices) |
| Dashboard ~1 s | **Refutado como problema de prod:** era un artefacto de estadísticas vacías (sin `ANALYZE` el planner arrancaba por los 10k turnos). Con estadísticas reales, 43 ms. Queda como lección: después de imports masivos, correr `ANALYZE` | — |
| `service-channel-direct-url-pool-prod` (P) | Sin medir: depende del `DATABASE_URL` real de Vercel (tarea A0a del dueño). El test de pool da el mecanismo | A0a → C1 |

## Bundle (first-load JS gzip, raíz + layouts + página)

Baseline en `scripts/bundle-baseline.json`. Las más pesadas: `/agenda` 176,6 kB · `/pacientes/[id]` 174 kB ·
`/plataforma/ejercicios` 167 kB. Presupuesto del workspace: ≤ 180 kB. Las públicas quedan **al borde** de su
presupuesto de 150 kB: `/c/[slug]/booking` 147,3 kB · `/signup` 143,8 kB · `/portal/*` 139-141 kB. framer-motion
(~35 kB gz) viaja en el root layout a todas las rutas → C1.
