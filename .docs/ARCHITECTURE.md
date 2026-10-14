# KineSoft — Architecture

Multi-tenant SaaS for Argentinian kinesiologists / physical therapists. The
single live client is a kinesiólogo-osteópata (high clinical expertise). The
product is built in 3 stages — see [ROADMAP.md](ROADMAP.md) (MVP base →
diagnosis guide → local AI).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14.2.35 (App Router, RSC + server actions) — patched from 14.2.18 in A3b (CVE-2025-29927 and later) |
| Language | TypeScript (`strict`, **not** `noUnusedLocals`) |
| ORM / DB | Prisma 5.22 · PostgreSQL |
| Hosting | Vercel (region `gru1`) · Supabase (Postgres + Auth + Storage) |
| Auth | Supabase Auth (email/password + Google OAuth) |
| Payments | Mercado Pago (checkout + webhook) |
| Styling | Tailwind + CSS variables · framer-motion |
| Rate limit | Upstash Redis (prod) / in-memory (dev and fallback) — `lib/rate-limit.ts` |
| Errors | Sentry `@sentry/nextjs` 11.1.0 — server/edge only, no-op without `SENTRY_DSN` (ADR-002) |

## Multi-tenancy (the spine)

Every domain table carries `tenantId`. Two layers of isolation:

1. **App layer (primary gate).** Every mutating server action and
   authenticated route calls `getActor()` (`lib/session.ts`) → returns
   `Actor { tenantId, practitionerId, userId }` or throws. All queries filter
   by `actor.tenantId`. The `kine_tenant` cookie selects the active tenant and
   is honoured only if the user is a real `Membership`. `middleware.ts` strips
   client-supplied `x-tenant-slug`/`x-tenant-id` headers (anti-smuggling).
2. **RLS (real backstop since Ronda 4).**
   `prisma/migrations/20260725120000_rls_policies/migration.sql` is the single
   source of truth (`prisma/migrations/policies.sql` is now just a redirect
   stub): ENABLE + FORCE ROW LEVEL SECURITY on **26 tables** (17 original + 7
   added in Ola B2 + the 2 split-policy catalog tables). Later migrations carry
   their own policies in the same file (e.g. B-pre's `catalog_global` and
   `agenda_foundations`); since B-pre the guard parses **every**
   `migrations/*/migration.sql`, not just this one. Direct-`tenantId`
   tables get a generated `tenantId = app_current_tenant_id()` policy; tables
   that reach tenancy through a parent get `EXISTS`-subquery policies
   (`Coverage`/`EmergencyContact` → `Patient`, `Payment` → `Booking`,
   `Session` → `TreatmentProgram`, `SessionExercise`, `EvaScore`); `Tenant`
   gets self read + update. The catalog tables `Condition`/`Exercise` get
   **split policies** — read = `tenantId IS NULL` (global) OR own, write = own
   only, so a tenant can never mutate the global catalog.
   `runWithRls(tenantId, fn)` (`lib/rls.ts`) sets the **transaction-local**
   `app.current_tenant_id` GUC (mandatory: Supavisor pools in transaction
   mode); `withTenantDb(tenantId, db, fn)` threads a caller's `tx` or opens a
   fresh one, so shared helpers work standalone or nested.
   **Adoption is wholesale** — ~23 Actor-facing `lib/*` modules run their reads
   and writes inside a wrap, and `scripts/guard-tenant-isolation.mjs` fails the
   build if a model gains `tenantId` without a policy (plus a soft report of
   unwrapped `prisma.<model>` calls).
   **Locally RLS actually evaluates**: the app connects as `kinesoft_app`
   (`NOSUPERUSER NOBYPASSRLS`, created by `prisma/roles.local.sql`) while
   `DIRECT_URL` stays on the owner for migrations, and
   `tests/integration/rls-isolation.test.ts` is green
   (`npm run test:integration`, gated on `RLS_IT=1`).
   **Residual (owner task, prod only):** Supabase still connects with a
   BYPASSRLS role. Until `prisma/roles.supabase.sql` is run and prod's
   `DATABASE_URL` flips to `kinesoft_app`, RLS is inert **in production** and
   the app-layer `tenantId` filter is the only gate there. See AUDIT.md
   (Ronda 4) + EXTERNAL-CONFIG.md §3.

**Patient visibility** (`lib/visibility.ts`): owner (`assignedPractitionerId`)
or an explicit `PatientShare` → `full` access; everyone else → `basic` (name,
DNI, next appointment only; PHI nulled at the projection, not just hidden in
UI). `bulkPatientAccess()` resolves N patients in one share lookup.
Tenant-wide `sharedPatientView` flag grants everyone full access.
**Basic = view only** (owner decision, 30-sep-2026): every write on a patient
(bookings, coverage, sessions, files, clinical history, archive) requires
`full`, enforced server-side; guest bookings stay operable. Matrix in
SECURITY.md §1.1.

## Server-side conventions

- **`"use server"` files** (`lib/bookings.ts`, `lib/patients.ts`, …): every
  export must be `async` (they're RPC endpoints). Types/constants live in
  sibling `*-types.ts` / `*-constants.ts` so client components import them
  without dragging the server module.
- **`server-only` helpers** (`lib/billing-internal.ts`,
  `lib/insurers-internal.ts`, `lib/public-booking-internal.ts`,
  `lib/notifications-internal.ts`, `lib/bookings-export-internal.ts`,
  `lib/patients-export-internal.ts`): internal functions that must NOT be
  exposed as RPC. Marked with `import "server-only"`. The two exports moved
  here in A2 because, as `"use server"` exports, they were callable as RPC and
  skipped their route's rate-limit and range cap; the route is now the only
  door.
- **Audit**: every PHI read/write writes an `AuditEvent` (`lib/audit.ts` +
  the read-audit extension). File-download URL minting is audited too.

## Modules added in Bloque A2/A3 (30-sep-2026)

Pure logic lives outside `"use server"` files so it can be unit-tested
(AGENTS.md §3). The ones other code must reuse instead of re-implementing:

| Module | What it owns |
| --- | --- |
| `lib/booking-capacity.ts` | **Capacity contract.** `isHoldingCapacity(b, now)`: every non-cancelled booking holds its slot except a public reservation that is PENDING + UNPAID/FAILED and older than 30 min (`PENDING_PUBLIC_HOLD_MS`). `isPublicReservation({idempotencyKey, patientId})` decides "public" **by the key** (`pub:<tenant>:<uuid>` or the pre-A2 `<tenant>:<prof>:<ISO>:<patientId>`); when in doubt it holds. Also `overlapBlocks`, `patientDayStatus`. Pure, `now` injected. Used by the availability engine (`lib/availability/*`, B-pre), create/update/batch, the public booking and the MP webhook. AUDIT §5.18 |
| `lib/public-booking-slots.ts` | `buildPublicSlots` / `checkPublicSlot`: the public grid — the same check on list and on submit. Since B-pre a stable-signature wrapper over the engine (`buildSlots` + `workingRanges`: per-practitioner ranges, exceptions, blocks; 45-min step, lead `minLeadMinutes ?? 60`, only PUBLIC + enabled services) |
| `lib/bookings-export-internal.ts` · `lib/patients-export-internal.ts` | ICS and CSV exports (`server-only`, basic rows masked, CSV audited) |
| `lib/csv.ts` | `csvCell`/`csvRow` + `neutralizeFormula` (`= + - @`, TAB/CR) against CSV injection |
| `lib/client-ip.ts` | `clientIp(headers)`: the single place that reads the client IP (replaced 8 copies) |
| `lib/safe-next.ts` | `safeNext` / `safeNextFromUrl` (own paths only) + `isAllowedOrigin` for auth POSTs. Pure, edge-safe |
| `lib/recovery-cookie.ts` | signed `ks_recovery` cookie (`<userId>.<exp>.<hmac>`, 15 min) set by `/auth/confirm` and required by the reset |
| `lib/supabase/cookie-options.ts` | Supabase cookie flags (httpOnly, secure in prod, lax) |
| `lib/redact.ts` | PII/secret redaction by key and by value; used by `lib/logger.ts` and Sentry's `beforeSend*` |
| `lib/observability-config.ts` | Sentry options (env, sample rate, redaction hooks); `null` without DSN |
| `lib/agenda-filters.ts` | agenda visibility toggles (cancelled / no-show), hidden counts, localStorage key per user, "Pendiente de pago · vencida" state |
| `lib/form-dirty.ts` + `components/ui/use-form-dirty.ts` | dirty-check of uncontrolled forms (snapshot vs current) for the Drawer guard |
| `components/ui/money-input.tsx` + `parseMoneyInput`/`formatMoneyInput` (`lib/format.ts`) | **the** control for typed ARS amounts: text + `inputMode="decimal"`, integer cents, string math (no float), invalid text blocks submit. Replaced every `type=number` money input |
| `Drawer` `dirty` / `dirtyMessage` (`components/ui/drawer.tsx`) | Esc / backdrop / X ask for confirmation when the form is dirty; `ConfirmDialog` stops Esc in the capture phase so it doesn't close the drawer below |
| `PlanDialogShell` (`components/planes/plan-edit-dialogs.tsx:276`, ES3) | `Modal` and `Drawer` of the design system **do not use a portal**: inside the booking drawer (framer-motion `transform`) a `position: fixed` child is pinned to the panel, and `Modal` (z 40) rendered under the drawer (z 46). The shell portals to `document.body` at z 60 (below `ConfirmDialog`, z 80), stops Esc in capture and reuses the Drawer's dirty-guard copy. Use it for a dialog that opens from inside a drawer |

## Modules added in Planes ES1 (04-oct-2026)

| Module | What it owns |
| --- | --- |
| `lib/sessions-internal.ts` (`server-only`) | **The only door to close and reopen a plan session**: `completeSessionInTx` (doesn't gate, doesn't touch Booking, doesn't autocomplete; `'booking'` writes only `completedAt`) and `reopenSessionIfUntouchedInTx`. Seguimiento uses it today; the agenda sync (ES2b) reuses it. PLANES C8 |
| `lib/storage-internal.ts` (`server-only`) | Supabase Storage via the **service role** only (upload / sign / remove, `{ error }` checked, fails closed without the env). `lib/files.ts` and exercise media go through it |
| `lib/exercise-media-internal.ts` (`server-only`) | `signExerciseMedia(mediaId)`: signs the key stored in the row, never a client key |
| `lib/patient-access-internal.ts` · `lib/programs.ts` | `hcAccessError` moved out of `patients.ts`. `lib/programs.ts` only keeps `setProgramStatus`, `deleteProgram` and `deleteSession` (no app callers since ES3; retirement pending Martin's decision, recommended EV1). `createProgram`/`updateProgram` were retired in ES3 (S27a) |
| `lib/booking-field-access.ts` · `lib/plan-lock.ts` · `lockCapacityMany` | field rule for bookings; plan-patient lock and one-statement capacity locks (PLANES C2) |
| `lib/availability/plan.ts` · `lib/plan-schedule.ts` · `lib/plan-pricing.ts` · `lib/plan-display.ts` · `loadAvailabilityInputsForDays` | pure plan engine, schedule v1, money and display, and the per-day loader. Consumed by the ES2b engine (below) |
| `lib/plans-dedupe*.ts` + `scripts/plans-dedupe-session-index.ts` | pre-M1 dedupe of `Session(programId, index)` (MIGRACIONES-RUNBOOK §2.3) |

## Módulos de Planes ES2b (07-oct-2026, commit `58ec36f`)

Todo server. Desde ES3 la UI llama directo a estos módulos y las altas legacy (`createProgram`, `updateProgram`,
`assignDiagnosisAndCreateProgram`, `applyPlanTemplate`, `addCustomSession`) se retiraron (S27a/S27b). Firmas en [PLANES.md §4 C8](PLANES.md); orden de locks en
ADR-004. Regla común: los `*InTx` **no gatean ni emiten**; el export `"use server"` gatea (`assertPlan*InTx`), corre
la tx con `withTxConflictRetry` y después del commit llama una vez a `afterBookingsCommitted(refs)`.

| Módulo | Qué es |
| --- | --- |
| `lib/bookings-core.ts` (`server-only`) | **Core de turnos** extraído de `lib/bookings.ts` (S07c, S12): gate de la Secretaria y `bookingFieldAccess` **adentro** de `applyBookingUpdateInTx` (así "mover", "este y los siguientes" y la sincronía no lo saltean), `validateBookingRefsInTx`, `buildBookingCreateData` (nunca escribe el vínculo), sincronía turno→sesión (`syncPlanSessionAfterBookingWriteInTx`, I3, reactivación, `planStampData`). Devuelve outcomes, nunca tira por stale ni emite. Copys en `lib/bookings-constants.ts` |
| `lib/booking-events-internal.ts` (`server-only`) | `afterBookingsCommitted(tenantId, refs, opts?)`: único post-commit de un write-path que toca `Booking`. Revalida días y dashboard (salvo `invalidateCaches:false`) y **después publica** los refs en el canal realtime (SV; firma intacta, C-SV3); `refs: []` no publica. `afterAvailabilityCommitted(tenantId, {practitionerId, day: string\|null}, opts?)` para candado y bloqueos (`day:null` = varios días, 1 aviso). Nunca tira. Ver §Sala de Espera realtime |
| `lib/plans.ts` + `lib/plans-engine-internal.ts` + `lib/plans-load-internal.ts` | **Motor**: `previewPlan`/`createPlan`; primitivas `previewProgramRowsInTx` → `reclassifyOrThrowStaleInTx` → `commitPlanRowsInTx` (modos `create`/`generate`/`replan`/`add`), `createPlanInTx` (con hook `clinicalCase` para Diagnóstico), `validatePlanRefsInTx` (la FK `locationId`/`practitionerId`/`serviceId` es simple: validar contra el tenant es obligatorio). Keys `plan:<generationId>:<index>`. Solo `createPlanInTx` gatea |
| `lib/plans-read.ts` (+ `-internal`, `-types`) | Lecturas: `listPlans`, `getPlanDetail`/`getPlanHistory` (solo full), `getPatientPlans`, `getPatientPlanBalances` (saldo P7 en el server), `listSchedulablePlanSessions` (allowlist sin título). Devuelven `PlanReadResult<T>` |
| `lib/plans-lifecycle.ts` (+ `-internal`, `-state` puro) | Estados (D7: futuros impagos cancelar/mantener), `updatePlanDetails` (título y notas, CAS), `archivePlan`, `restoreProgram`; L9 (archivar paciente → pausa sus planes) |
| `lib/plans-move.ts` (+ `-internal`) | "Este y los siguientes" (`movePlanSeries`, `plans.schedule`) y re-planificar desde la sesión N (`replanPlan`, `plans.manage`) |
| `lib/plans-edit.ts` (+ `-internal`, `lib/plan-pricing-internal.ts`) | Agregar/archivar/restaurar sesiones, reprecio C5 de dos ramas con CAS por fila, renovar la autorización de la OS |
| `lib/plans-adopt.ts` (+ `-internal`) | Generar turnos de sesiones pendientes (`plans.schedule`), vincular un turno suelto, adoptar una serie, sacar del plan |
| `lib/plan-invariants-internal.ts` | **Verificador** I1-I8: `assertProgramInvariantsInTx` al final de cada tx del motor (3 sentencias); una violación tira `ProgramInvariantViolation` (rollback + Sentry). No corre en los write-paths de turnos sueltos |
| `lib/agenda-plan-projection-internal.ts` | Proyección C9 de la agenda (chip, ordinal, "Fuera de plan"): queries planas, sin módulo `planes` = neutra sin queries, nunca la autorización de la OS |
| `lib/plan-authz-internal.ts` · `lib/plan-predicates.ts` · `lib/plans-schemas.ts` · `lib/plans-types.ts` | Gates de Planes; predicados Prisma únicos ("sin turno", vivo, vinculado, adoptable, con pago); zod; tipos re-exportados de `lib/availability/plan.ts` (una sola fuente) |
| `lib/diagnosis-internal.ts` | `createPlanFromDiagnosis` por el motor (caso + diagnóstico + plan + turnos en una tx) y la rampa por fase. La superficie RPC de `lib/diagnosis.ts` es una **lista blanca** testeada (`tests/integration/plans-doors-diagnosis-authz.test.ts:206-215`): un export nuevo es una RPC pública |
| `lib/patient-search.ts` (P2-FX1) | `searchPatientsForBooking`: buscador del `PatientPicker` de la agenda (nombre + DNI, sin gate de módulo). El picker elige con `source` (`components/patients/patient-picker-search.ts`) |
| `lib/services-discipline.ts` | Disciplina sugerida de un servicio desde las especialidades (puro) |

## Módulos de Planes ES3 (08-oct-2026, commit `ad50059`)

UI de Planes sobre el motor de ES2b. Contratos en [PLANES.md §4 C9/C10/C13](PLANES.md); decisiones en PLANES §11.

| Módulo | Qué es |
| --- | --- |
| `lib/plans-deeplink.ts` | **Único parser** de los deep-links C10 (zod, `prefill` ≤ 2 kB, tab `planes` con alias `plan`). `PlanEditorPrefill` sin texto libre: sin `authorization` |
| `lib/agenda-highlight.ts` · `lib/agenda-client-state.ts` | Resaltado de la agenda (`AgendaHighlight`: servicio / plan / sueltos; resalta, no filtra) y filtros extensibles `AgendaFilters` `{practitionerIds, locationId, roomId}` + `AGENDA_FILTER_DIMENSIONS` (`roomId` lo sumó SR sin rehacer el modelo, `:239-298`) |
| `components/agenda/agenda-utils.ts` (`compactPlanFields` / `expandPlanFields`) | DTO compacto C9 en el cable: omite los neutros y la disciplina del servicio sale del catálogo en el cliente |
| `components/planes/plan-editor-drawer.tsx` · `plan-form.tsx` · `lib/plan-editor-state.ts` | **Editor único** (Drawer 600 px, modos `create`/`generate`/`replan`) para las 4 puertas; estado puro testeable. Lo monta una vez el shell del perfil y lo abren Diagnóstico, `/planes` y la agenda por deep-link |
| `components/planes/plan-preview-table.tsx` | "Revisá los turnos" (C13): estados, resoluciones, stale y ordinal (`ordinalOf`). La reusan el editor, los diálogos y el modal de Seguimiento |
| `components/seguimiento/schedule-session-modal.tsx` | "Agendar" una sesión sin turno: modal de **una fila** sobre `previewGeneratePlanBookings`/`generatePlanBookings` (sin montar el editor) |
| `lib/plan-templates.ts` (+ `-types`) | CRUD de plantillas (CAS opcional, autor o admin, módulo `plantillas`) y `getTemplatePrefill` para el editor |
| `lib/dashboard-revenue.ts` · `getRevenue` (`lib/dashboard.ts`) · `updateDashboardPrefs` (`lib/preferences.ts:158`) | Ingresos reales (S14r): MP + copagos manuales por `copagoPaidAt` + OS aparte por `insurerPaidAt`; Mes/Semana en `UserPreferences.dashboardPrefs` (M3a). Desde SR, por rol (SR-D5I, ver §Salas) y en **una** tx (`loadRevenue`, `lib/dashboard.ts:642`) |
| `components/planes/plan-balance.tsx` · `plan-booking-groups.ts` | Turnos y Facturación agrupados por plan con el saldo del server |
| `components/patients/archive-patient-dialog.tsx` | Diálogo L9 (archivar paciente → pausar/cancelar planes) |

## Salas (SR, 08-oct-2026, commit `5811ea2`)

Corrida SR sobre `ad50059`, planning en el plan vigente §17 + §17.5. Antes solo había sedes y nada impedía que dos
profesionales usaran el mismo lugar a la misma hora. **Un consultorio sin salas cargadas ve todo igual que antes**
(markup de la agenda idéntico byte a byte, 0 statements nuevos en create/update/batch/agenda). Aplica a General y
Kinesiología sin módulo nuevo ([VERTICALES.md](VERTICALES.md)).

### Modelo (M4 `20261009120000_rooms`)

```
Location ──< Room (kind CONSULTORIO|BOX|GIMNASIO|SALA, capacity 1..50, active, sortOrder)
               ▲
               ├── PractitionerSchedule.roomId?  (NO ACTION)  "AP atiende en el Consultorio 1 los lunes 9-13"
               ├── Booking.roomId?               (RESTRICT)   CHECK Booking_room_location_check: sala ⇒ sede
               └── TimeBlock.roomId?             (CASCADE)    CHECK TimeBlock_room_scope_check: sede y sin profesional
ScheduleException.ranges[].roomId?  (solo zod, sin DDL)
```

- `Room` con RLS ENABLE + FORCE + `Room_tenant_isolation`; sin GRANT (DEFAULT PRIVILEGES). FK `(locationId, tenantId)`
  → `Location_id_tenantId_key` (índice nuevo, destino de la FK compuesta).
- Las tres columnas `roomId` llevan FKs compuestas `(roomId, tenantId)` (misma empresa) y `(roomId, locationId)` (misma
  sede): una sala de otra sede o de otro consultorio no entra ni por RPC (las FK saltean RLS). RESTRICT y NO ACTION se
  chequean igual al final de la sentencia.
- Quien cambia `Booking.locationId` recalcula o limpia `roomId` en el **mismo UPDATE**; si no, 23503.
- Índice parcial `Room_locationId_name_active_key` (`lower(btrim(name))` WHERE `active`): no se expresa en Prisma y
  no se borra si `migrate dev` lo propone. Drift aceptado documentado en el SQL y en `schema.prisma` («SR M4: DRIFT
  ACEPTADO», `prisma/schema.prisma:1736`).

### Reglas (SR-D1..D9 + §17.5)

| # | Regla | Dónde |
|---|---|---|
| SR-D1 | `capacity` = **profesionales a la vez**, no pacientes (el cupo de pacientes sigue en `Service.maxConcurrent`). El mismo profesional **no ocupa su sala dos veces**: `roomOccupancyAt` lo excluye; si no, un kine con varios pacientes chocaría consigo mismo | `lib/availability/rooms.ts:107-140` |
| SR-D2 | Forzar sala (`allowRoomConflict`) **no es sobreturno**: no marca `isOverbooked` ni escribe `[SOBRETURNO]`. Copy "Asignar igual" / "Agendar igual" / "Moverlo igual (sala ocupada)" | `lib/bookings-core.ts:1395,1712` · `lib/booking-force-flags.ts:36,83` |
| SR-D3 | Planes, "este y los siguientes" y el turnero **estampan** la sala (`defaultRoomFor`; archivada → sin sala) y **no** chequean ocupación ni toman clave de sala. La barrera es la validación de Configuración. `rescheduleSession` y las ediciones sueltas sí chequean | `lib/plans-engine-internal.ts` · `lib/public-booking.ts` |
| SR-D4 | En Configuración, choque **duro** entre plantillas de profesionales distintos (con la vigencia de cada franja); contra excepciones futuras, solo aviso | `lib/room-schedule-validate.ts:172` · `lib/practitioner-schedule.ts` |
| §17.5 | **Bloquear sala** entra en SR: `TimeBlock.roomId`, alcance "Una sala" del candado. Para la ocupación cuenta como sala llena (`room-busy` con `blocked: {reason}`), con aviso y forzado | `lib/time-blocks.ts:189-209` · `lib/booking-rooms-internal.ts:193` |
| SR-D6 | Sala ⇒ sede explícita (CHECK). Con sala y sede null se estampa la principal | M4 · `lib/bookings-core.ts` |
| SR-D7 | El batch omite las fechas con sala ocupada salvo forzar (casilla aparte); re-cuenta bajo lock | `lib/bookings.ts` |
| SR-D8 | `archiveRoom` se niega con franjas vigentes, turnos futuros o excepciones futuras; los **bloqueos** futuros no bloquean: se borran (soft delete) en la misma tx | `lib/rooms.ts:276` |
| SR-D9 | Nombre único por sede entre las activas (índice parcial) → `fieldErrors.name` | M4 · `lib/rooms.ts` |

- **Sala por defecto:** el turno toma la sala de la franja que lo contiene (`defaultRoomFor`, `lib/availability/rooms.ts:54`,
  sobre franjas **crudas** con `roomRangesFor`, no `scheduledRanges`: §5.27 no cambia). Sala archivada → sin sala.
- **Elegir sala no cambia la sede:** una sala de otra sede → `bad-room` (`BAD_ROOM_ERROR`, `lib/bookings-constants.ts:57`).
  La sede no se cambia desde el drawer.
- **Un bloqueo de sala NUNCA es "todos".** Antes `practitionerId` null = "todo el equipo"; un bloqueo de sala también
  tiene `practitionerId` null (por CHECK), así que **todo lector de `TimeBlock` excluye `roomId`**: `liveBlocksInTx`
  (`lib/bookings-core.ts:534-550`, `roomId: null`; el gate encontró que bloqueaba a todos los profesionales), el
  loader (separa `roomBlocks`), `listTimeBlocks`, `removeDayLock` y el reuso del candado (`NOT_ROOM_BLOCK`,
  `lib/time-blocks-schemas.ts:201`). Un lector nuevo de `TimeBlock` suma ese filtro.
- **Ocupación** (`lib/booking-rooms-internal.ts`, `server-only`): `lockActiveRoomInTx` (`:63`), `countRoomOverlapsInTx`
  (`:193`, **una** sentencia UNION ALL turnos + bloqueos) y `loadRoomBookingsInTx` (`:242`, el batch la carga una vez).
  Lookback `ROOM_LOOKBACK_MIN = 480` (`:23`) = el máximo de `Service.durationMin`; el de cupo sigue en 240. Con 240, un
  turno de 6 h de otro profesional no contaba (revisión (a)).
- **Locks:** enmienda C2 (1b) en ADR-004.
- **Ingresos por rol (SR-D5I) y Facturación (SR-D4F)** entraron en la misma corrida: ver [SECURITY.md §16](SECURITY.md).

### Módulos

| Módulo | Qué es |
| --- | --- |
| `lib/rooms.ts` (+ `-types`, `-constants`, `-schemas`) | CRUD de salas: `listRooms` (`:111`), `listRoomOptions` (`:156`, bootstrap de la agenda, solo activas de sedes activas), `createRoom`/`updateRoom`/`archiveRoom`/`restoreRoom` con `schedule.configure` + sedes exclusivo + `auditInTx` |
| `lib/availability/rooms.ts` | Motor puro: `defaultRoomFor`, `roomOccupancyAt`, `roomAssignmentsFor` ("Asignada: AP 9–13" de la vista "Por sala") |
| `lib/booking-rooms-internal.ts` | Ocupación y validación de sala dentro de la tx (arriba) |
| `lib/room-schedule-validate.ts` | Validación pura entre profesionales (`roomScheduleConflicts`), la usan el server y el editor de horarios |
| `lib/agenda-layout-rooms.ts` | Layout puro de "Por sala" (`buildRoomColumns`, `:137`). **Módulo aparte por bundle:** `agenda-layout.ts` está en el first load de `/agenda` y webpack no separa un módulo por export (~0,83 kB gz). Solo lo importan `room-day-panel.tsx`, `room-day-view.tsx` y tests; **`agenda-layout.ts` no lo re-exporta** (hay test); los helpers comunes se importan de `agenda-layout.ts`, no se duplican |
| `components/agenda/views/room-day-panel.tsx` · `room-day-view.tsx` · `day-columns-grid.tsx` | Vista "Por sala" con `dynamic()` (`agenda-client.tsx:123`); el shell `DayColumnsGrid` se comparte con "Por profesional" (su test quedó intacto) |
| `components/agenda/room-filter.tsx` | Filtro de sala (radiogroup, "Sin sala", solo con ≥ 2 salas en el alcance), `dynamic()` |
| `components/configuracion/panels/rooms-section.tsx` | Configuración › Sedes › Salas, `dynamic()` al abrir (`locations-panel.tsx:47`) |
| `components/agenda/booking-drawer/room-row.tsx` | Fila Sala del drawer ("Cambiar" con `canOperate`, "Asignar igual" por `useConfirm`) |

### Agenda

- **El filtro de sala es del cliente** (`applyAgendaFilters`, dimensión `roomId` en `lib/agenda-client-state.ts:296`),
  igual que la sede: `listAgendaBookings` ya trae la semana entera y mandar `roomId` al server sumaría un viaje por
  cada cambio de chip. Persiste en `agendaPrefs.roomId` (se limpia al cambiar de sede; null se omite del blob).
- **"Por sala" no aplica el filtro de profesionales** y oculta los chips (`agenda-client.tsx:551,817`): con un chip
  puesto, una sala ocupada por otro profesional se veía libre y la Secretaria forzaba sin ver por qué (revisión (b) M2).
  "Asignada:" usa todos los profesionales (`roomPractitionerById`, `:445`). Con "Todas las sedes" usa la sede
  principal y lo dice; "Sin sala" se filtra a la sede del alcance.
- El bootstrap (`app/(app)/agenda/page.tsx:65`) carga `listRoomOptions` aparte de `listAgendaBookings` (que no suma
  queries). Un turno con sala fuera del catálogo se muestra "Sala archivada".
- SV publica `roomId` y `prev.roomId` de cada `BookingChangeRef` en el mensaje realtime (§Sala de Espera realtime).

## Sala de Espera realtime (SV, 13/14-oct-2026)

Corrida SV sobre `5811ea2` (planning en el plan vigente §18; decisiones SV-D1..D16; contratos C-SV1..10). Antes,
Recepción no se actualizaba entre usuarios: la Secretaria marcaba «Llegó» y el profesional no se enteraba. Ahora todo
cambio de turno commiteado se publica **una vez, después del commit, sin PHI**, y llega a las pestañas del consultorio
en < 1 s; `/sala` es el tablero compartido con el estado nuevo **«Llamado»**; hay avisos «Llegó» / «Pase …». Con
`REALTIME_DRIVER=off` (default) la app es idéntica a SR. Decisión de transporte en **ADR-006**; seguridad en
[SECURITY.md §17](SECURITY.md); consola en [EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md).

### Flujo

```
action → runWithRls (commit) → afterBookingsCommitted(tenantId, refs)
   → revalidateTag (si corresponde) → await publishBookingChanges  (1 POST, tope 1,5 s, breaker, nunca tira)
   → Supabase Broadcast privado  tenant:<id>:agenda
   → RealtimeProvider (zod, coalesce 250 ms) → cada vista re-pide con SUS actions → diff → animación / aviso
```

- **Driver** (`REALTIME_DRIVER`, `lib/env.ts`): `off` (nada) · `local` (bus en memoria `globalThis` + SSE
  `/api/realtime/local`, solo dev; prohibido en Production) · `supabase` (POST a `/realtime/v1/api/broadcast` con la
  service key; el browser se suscribe con un token HS256 de 10 min que acuña `mintRealtimeToken`).
- **Mensaje** (C-SV2, sin PHI): `{v:1, kind: booking|reception|called|availability, bookingId?, practitionerId, day
  (AR), roomId?, prev?, at}`. Más de 20 en un commit → colapso por `(practitionerId, day)`, después por profesional con
  `day:null`, y con más de 20 profesionales a **un solo** mensaje `{practitionerId:null, day:null}` (SV-D10).
- **Hook** (`lib/booking-events-internal.ts`): antes de SV, `invalidateCaches:false` hacía early return y Recepción
  «llegó» no emitía; ahora el flag solo apaga la invalidación. Se invalida **antes** de publicar (el refetch que
  dispara el evento no puede leer cache viejo).
- **Write-paths cableados en SV** (antes no pasaban por el hook): turnero (alta y hold vencido reemplazado), webhook de
  MP (emite **siempre que escribió `Booking`**, incluido `amount_mismatch` sobre un turno impago que pasa a FAILED;
  replay no), `devMarkBookingPaid`, candado del día (`applyDayLock` devuelve refs; `afterAvailabilityCommitted` para el
  bloqueo) y alta/baja de bloqueos. Un bloqueo de varios días = 1 aviso con `day:null` + 1 invalidación.
  `guard-realtime` (c) impide un write-path nuevo sin emitir.
- **Mover un turno a otro día AR** limpia `arrivedAt/calledAt/attendingAt` (`lib/bookings-core.ts:1732`): el estado de
  sala es del día, no viaja con el turno.

### Estado «Llamado» (M5, SV-D5)

- `Booking.calledAt` + CHECK `calledAt ⇒ arrivedAt`. Derivación en `lib/reception-state.ts`: `attendingAt` > `calledAt`
  > `arrivedAt` > demorado / por llegar. «Llamar» exige `en-sala` y solo hoy; «Deshacer» desde `llamado` → `en-sala`,
  desde `en-atencion` → `llamado` si hubo llamado. No hay «Volver a llamar». La Secretaria llama en nombre del
  profesional; BILLING no opera.
- Contadores: **«En sala» incluye a los llamados** (todavía no entraron al box) y «Llamados» es ese subconjunto, en
  Recepción y en `/sala` (`lib/sala-board-state.ts:274`).

### Cliente

- `RealtimeProvider` (en `AppShell`, todo el workspace) → `useRealtime(): {state, subscribe, onResync, resync}`. Con
  `off` no importa nada de realtime-js. `@supabase/realtime-js` entra solo por `import()` dentro de `connect()`
  (guard (e)): no está en ningún first-load. Backoff `min(30 s, 1 s·2^n)` con jitter, refresh del token al 80 % del
  TTL, resync al volver la pestaña / `online` / reconectar, `polling` de 60 s con 2 fallos seguidos u offline.
  `LiveIndicator`: «En vivo» · «Reconectando…» · «Sin conexión en vivo · se actualiza cada 60 s» · oculto con `off`.
- **Agenda en vivo** (`agenda-client.tsx` + `lib/agenda-client-state.ts`): `messagesTouchRange` decide si el lote toca
  la semana visible → re-pide `listAgendaBookings` (coalescido, uno en vuelo) → `changedBookingIds` → `k-flash` en las
  `BookingCard` cambiadas por otro (no las propias: `OWN_ACTION_QUIET_MS`); `availability` → `router.refresh()`. El
  drawer guarda `{id, updatedAt}` y deriva el turno de la lista viva (`agenda-client.tsx:313-317`): ve la hora nueva y
  guardar con la versión vieja da stale. Con `off` el markup es el de SR (snapshot) y **no hay polling**.
- **`/sala`** (`app/(app)/sala/*`, `components/sala/*`; módulo `salaEspera` + `agenda.reception`, BILLING →
  `/agenda`; solo hoy AR, SV-D8): columnas por profesional o por sala (SV-D13, «Por sala» solo con ≥ 1 sala activa,
  recordado en `agendaPrefs.salaGroupBy`); cada columna es **una `<ul>`** con bandas En atención → Llamado → En sala →
  Demorados → Próximos (≤ 60 min) y «N más tarde», así la card se desliza de banda (`layout`) en vez de remontarse.
  Lee con `listSalaBookings` (proyección sin PHI clínica **en el server**, ventana ≤ 36 h). Banda «Pase María G. ·
  Consultorio 2» `aria-live` 8 s (no mueve el tablero). Con `off`, `/sala` pollea sola cada 60 s y al volver la
  pestaña (`startSalaOffPolling`).
- **Avisos** (`components/providers/arrival-alerts.tsx` + `lib/arrival-alert-state.ts`, SV-D4 enmendada / D9 / D16):
  prefs `agendaPrefs.arrivalAlert` / `.callAlert` (`visual` default, `sound`, `off`). Llegada → el profesional del
  turno, solo con `clinical.read`; llamado → quien tiene `agenda.operateAll` y no es ese profesional. Por diff del
  refetch de hoy, idempotente por `bookingId+arrivedAt/calledAt`; la pestaña que actuó no se auto-avisa
  (`lib/arrival-local-notes.ts`); ≥ 3 en un lote → un toast; tras resync o en polling, sin sonido. En `/sala` el
  llamado no da toast (lo anuncia la banda). Chime WebAudio (`lib/arrival-chime.ts`) y `(1) Llegó …` en el título
  (`lib/tab-title.ts`). La Card «Avisos de la sala de espera» (Configuración → General) se ve aunque el driver esté
  `off`, con una nota.

### Módulos

| Módulo | Qué es |
| --- | --- |
| `lib/realtime-constants.ts` · `lib/realtime-events.ts` | C-SV1/C-SV2, puros y client-safe: topic, topes, `RealtimeAgendaMessageSchema`, `buildRealtimeMessages` (día AR, dedupe, colapso), `availabilityMessage`, `RealtimeBootstrap` |
| `lib/realtime-publisher-internal.ts` (`server-only`) | C-SV4: `publishBookingChanges` / `publishAvailability` por driver; timeout 1,5 s, breaker `{3 fallos, 30 s; 300 s por config}`, log throttled sin secretos; `__setRealtimePublisherForTests` |
| `lib/realtime-local-bus.ts` · `app/api/realtime/local/route.ts` | Driver `local`: bus por tenant en `globalThis` (sobrevive HMR) + SSE con heartbeat 25 s |
| `lib/realtime-token-internal.ts` · `lib/realtime-token.ts` · `lib/realtime-bootstrap.ts` | C-SV5: firma/verificación HS256 con `kid`; action `mintRealtimeToken`; `realtimeBootstrap` / `realtimeAllowed` |
| `lib/realtime-client-{types,state,supabase,local}.ts` | C-SV7: estado puro (coalescer, backoff, poll, refresh, `deriveConnectionState`) y drivers con `deps` inyectables |
| `components/providers/realtime-provider.tsx` · `components/realtime/live-indicator.tsx` | Provider (`createRealtimeHub`) e indicador |
| `lib/sala-board-state.ts` · `lib/sala-bookings.ts` · `components/sala/*` | Tablero puro (bandas, columnas, contadores, `salaActions`, `callAnnouncement`, `diffSala`, polling `off`), lectura con proyección en el server, UI |
| `lib/arrival-alert-state.ts` · `lib/arrival-chime.ts` · `lib/tab-title.ts` · `lib/arrival-local-notes.ts` · `lib/patient-short-name.ts` | Avisos: diff puro y textos, chime, título, notas de la pestaña que actuó, nombre corto único (lo comparten tablero y avisos sin arrastrar deps al bundle del provider) |
| `scripts/guard-realtime.mjs` · `scripts/realtime-verify.ts` | Guards (a)-(e) en `guard:isolation`; verificación V1-V7 en staging |

## Timezone (a core invariant)

Argentina is fixed UTC−3, **no DST**. All wall-clock logic uses the helpers in
`lib/datetime-ar.ts` — `localToARIso`, `toARDateKey`, `toARDow` (0=Sun..6=Sat
in AR), `toARHour`. Host-TZ math (`getUTCDay`/`getDay`/`setHours`) drifts on
UTC hosts (Vercel) — this caused the week-grid misalignment and the
wrong-days multi-turno bug. Client `toLocaleString` on DB instants MUST pass
`timeZone: "America/Argentina/Buenos_Aires"` (else hydration mismatch + wrong
date). **Exception**: a `<input type="date">` value (parsed UTC-midnight) must
NOT get AR tz, or the day shifts back.
B-pre fixed `toARMinutes`/`toARHour` at AR midnight (Intl with `hour12:false`
returns "24" → 1440/24; now `% 24`, `lib/datetime-ar.ts:77-83`). The engine
works in **dayKeys** (`YYYY-MM-DD` AR) and AR minutes; `@db.Date` columns go
through `dbDateToDayKey`/`dayKeyToDbDate` (`lib/availability/day.ts`).

## Domain model (key entities)

**Scheduling.** `Booking` is the turno — `scheduledFor`, `durationMin`,
`status` (PENDING/CONFIRMED/COMPLETED/NO_SHOW/CANCELLED), `copagoCents`
(per-turno override), `insurerPaidAt` (OS reimbursement confirmation),
`copagoPaidAt` (M3a, ES3: when the copago was marked paid by hand; written and
cleared only by `toggleBilling`/`setBookingCopagoPaid`, kept on re-mark; with
`insurerPaidAt`, it is the date the dashboard revenue widget counts by),
`seriesId` (groups a multi-turno batch), `title` / `description` (per-turno
mini-diagnosis, defaulted from `Patient.diagnosisTitle` / `diagnosisNote`),
`idempotencyKey`, `updatedAt` (optimistic-concurrency token). Since M1
(`plans_booking_link`, ES2a, 04-oct-2026; local only until the end-of-B deploy)
a booking can belong to a plan: `programId` + `sessionId` (both or neither),
`pricedByPlan`. Without `programId` it is a standalone ("fuera de plan")
booking. Only the plan engine writes the link (ES2b, ADR-001; AUDIT §5.38).

**Plans after M1 (summary; SQL in [PLANES.md](PLANES.md) §3).**
- `TreatmentProgram`: `discipline` (KINESIOLOGY/OSTEOPATHY), responsible
  `practitionerId` (backfilled from the first session), `serviceId`,
  `locationId` (null = main), `templateId`, `durationMin` 15..240, `schedule`
  (JSON object; clear it with `Prisma.DbNull`, never `JsonNull`),
  `pricingMode` PER_SESSION | PACKAGE with exactly one price (CHECK with
  `IS NOT DISTINCT FROM`), `idempotencyKey` unique **per tenant**, `updatedAt`,
  `archivedAt`.
- `Session`: `title`, `priceCents`, `archivedAt`, `updatedAt`; `index` is unique
  among live sessions only (`Session_programId_index_live_key`) and archiving
  does not renumber.
- `Booking`: one active booking per session (`Booking_session_active_key`,
  excludes CANCELLED and NO_SHOW); composite FKs force same tenant, same
  patient and session-of-that-plan; a guest booking can't be a plan booking.
- Everything linked is `ON DELETE RESTRICT` (SQLSTATE 23503 / P2003): plans
  and sessions are archived, not deleted.
- New tenant tables with RLS: `ProgramAuthorization` (OS authorization with
  history, one current per plan) and `PatientChangeRequest` (portal "Mis datos"
  requests, one PENDING per patient).
- `Patient.userId` is unique **per tenant** (`Patient_tenantId_userId_key`);
  `UserProfile.patients` is 1:n (a portal account with records in N clinics).
- Objects Prisma can't express (partial uniques, composite FKs, CHECKs,
  policies) live only in the SQL; `migrate diff` shows exactly the 3 composite
  FKs of Booking as accepted drift.

- **Single turno**: `createBooking` (conflict/sobreturno UX + next-free-slot;
  since B-pre also soft warnings `blocked` / `outOfHours`, forced with
  `allowBlocked` / `allowOutOfHours` — see §Agenda profesional y catálogo).
- **Multi-turno**: `createBookingsBatch` (count + weekdays, AR-correct days,
  `frequency` weekly/biweekly/monthly since B-pre, shared `seriesId`, individual
  `Booking` rows — **not** a plan).
- **Sobreturno** is `Booking.isOverbooked` since B-pre (backfilled from the
  `[SOBRETURNO]` notes prefix, which writers keep adding until the contract).
- **Edit/delete**: `updateBooking` / `deleteBooking` / `setBookingStatus`,
  all under `runWithRls`, all guarded by `expectedUpdatedAt`
  (optimistic concurrency) so a stale drawer can't mutate a changed row.

**Capacity + anti-duplicate — four layers** (Rondas 4 and 6):

1. **Professional capacity.** The effective cupo is per practitioner +
   service: `PractitionerService.maxConcurrent` when `concurrencyOverride`,
   else `Service.maxConcurrent` (`null` = unlimited, the default — overlapping
   turnos are normal in kinesiología). Pure helper `overlapBlocks()` in
   `lib/booking-capacity.ts`: blocked when `overlapCount >= maxConcurrent`.
   Since B-pre the count and the write run in the same tx behind the
   capacity advisory lock (`lib/booking-cap-lock.ts`), closing the cupo-1
   TOCTOU in the agenda and the public booking.
2. **Patient guard.** `patientDayStatus()` (same file, pure + unit-tested)
   looks at the patient's other non-cancelled turnos on the same **AR day**,
   across all professionals: an overlap is a **hard stop**; a second turno the
   same day is a **soft confirm**; nothing else is free. `createBooking` runs
   it with a 240-min look-back for AR-midnight crossings and excludes its own
   row by `idempotencyKey` so an idempotent retry can't self-block.
3. **`idempotencyKey` is CLIENT-generated.** One `crypto.randomUUID()` per
   modal instance (`components/agenda/booking-modal/index.tsx`), with a server
   `randomBytes(16)` fallback when the client sends none; batch turnos derive
   `<key>:<iso>` per row. It dedupes retries of the *same* submit and nothing
   more. **Before Ronda 6** the key was derived (`tenant:prof:slot:patient`)
   and combined with an upsert, so re-booking the same patient into the same
   instant silently **overwrote** the existing turno — a data-loss bug.
4. **DB backstop for the TOCTOU window.** The app guard is best-effort, so
   migration `20260803002623` adds the partial unique index
   `Booking_tenant_patient_slot_active_key` on
   `("tenantId", "patientId", "scheduledFor") WHERE "patientId" IS NOT NULL AND
   status <> 'CANCELLED'`. Two genuinely concurrent submits → one wins the
   INSERT, the other gets `P2002`, handled in **every** write path
   (`createBooking`, `updateBooking`, `createBookingsBatch`,
   `submitPublicBooking`) as a friendly overlap message. The partial predicate
   is deliberate: guests (`patientId` null) never collide and a CANCELLED turno
   frees its slot for a re-book. Partial indexes aren't expressible in the
   Prisma schema (5.22) — this index is migration-managed only; if a future
   `migrate dev` proposes to drop it, keep it.

**Agenda day view** (Ronda 9; B-pre added the "Por profesional" and
"Recepción" modes — see §Agenda profesional y catálogo). `components/agenda/views/timeline-view.tsx`
lays turnos out **in flow**, not absolutely positioned. Each business hour is
one row that grows with its content; turnos are bucketed into their start hour
and rendered in a wrapping flex row (`flexBasis: calc((100% - gaps) / 5)`,
min 186px / max 280px, `flexGrow: 0`), up to 5 per row with a "+N más" reveal
past 10. Text truncates with ellipsis + tooltip instead of stretching the card.
The old `top = hour × 56px` + overlap-group width math caused cards to bleed
across gridlines and rows not to grow; the helper it needed
(`layoutBookings` in `agenda-utils.ts`) was deleted with its tests.

**Billing.** `Insurer` (obra social) — one per tenant has `isParticular=true`
("Particular" is a real insurer row, not a magic string). `Coverage` links a
patient to an insurer (or a free-form name) with an optional copago override.
The app keeps a **single active coverage** per patient (writers replace, reads
order by `id` desc for determinism). Copago precedence
(`resolveBookingCopagoCents` in `lib/billing-internal.ts`):
`Booking.copagoCents` → `Coverage.copagoCents` → insurer copago → Particular
price → service price (each nullable, so 0 is always intentional). Free-form
insurer names are normalized + linked to the catalogue via
`resolveInsurerName` (`lib/insurers-internal.ts`).

**Diagnosis (Etapa 2 foundation).** `Condition` (global catalog + tenant
custom) ↔ `ConditionExerciseLink` (`relation` DIRECT/INDIRECT/ANTAGONIST/
PREVENTIVE × `phase` ACTIVATION/STABILITY/LOAD/PROGRESSION × weight) ↔
`Exercise` (`kind` EXERCISE | MANUAL_THERAPY). `AnatomicalRegion` +
`ConditionAnatomy` drive the body-map. The matching engine
(`lib/diagnosis-engine.ts`) ranks conditions by region+symptom+trigger
overlap; `lib/diagnosis.ts` generates a phased `TreatmentProgram` (exercises
ramped across N `Session`s). **Split status:** the exercise/catalog half of
this area *shipped* in Rondas 7-8 (see below) — authoring, media, articles,
structured tags, admin table. The **diagnosis guide itself** (authoring UI for
conditions, the guided flow, `definicion-ejercicios-maniobras`) is still
deferred to ROADMAP Etapa 3 (`guia-diagnostico-completa`) — gated on a vision
session with the owner.

**Exercise catalog (global, Rondas 7-8).** `Exercise` rows with
`tenantId IS NULL` are the platform-authored global catalog; `tenantId` set
means private to that tenant. Changes since the July baseline:

- `defaultSets` / `defaultReps` are now **optional** (an exercise can be
  read-only or time-based) and `durationSeconds` was added for isometrics /
  planks. The session picker falls back to 3×12 when both are null — every
  consumer had to be null-hardened.
- `archivedAt` is a **soft delete**: archived exercises drop out of catalog
  browse but stay referenceable by historical `SessionExercise` /
  `ConditionExerciseLink` rows. Hard delete is guarded on those counts.
- **Structured tags** via `ExerciseTag` → `Tag.kind`, with `TagKind` gaining
  `MUSCLE_GROUP` and `DISCIPLINE` alongside ZONE/SUBZONE/SYMPTOM/TRIGGER/
  PHASE/EQUIPMENT/GOAL/CHAIN. The free-text `muscleGroups` / `equipment`
  columns are kept denormalised for the cards; `/biblioteca` facets read tags.
- **`ExerciseMedia`** (1:N, ordered) — `ExerciseMediaType` VIDEO / IMAGE / GIF
  / YOUTUBE. Uploads land in the Supabase bucket `exercise-media` and store a
  storage key resolved to a 1-hour signed URL; YOUTUBE stores the link and
  renders through the `youtube-nocookie` embed (`lib/exercise-media.ts`).
- **`ExerciseArticle`** (1:1) — long-form reader content (`title`, `subtitle`,
  `focus`, `readingMinutes`, `bodyMarkdown`, `references`) rendered by
  `app/(app)/biblioteca/[slug]` through a safe markdown renderer (no raw HTML).

Both new tables are **global-catalog content: they carry no `tenantId`** —
visibility is inherited from the parent `Exercise` and gated at the app layer.
Their RLS posture is ENABLE + FORCE with `SELECT USING (true)` and **no write
policy**: the app role can read them under `runWithRls` but can never write
them; only the BYPASSRLS service channel does.

`UserPreferences.catalogPrefs` (`Json?`) stores the per-user state of the
admin catalog table (page size, sort, active filters) — a blob, like
`pinnedKpis`, so adding a filter needs no migration. It is coerced
defensively on read (`sanitizeCatalogPrefs` in `lib/preferences.ts`): a hostile
or stale blob degrades to defaults. The URL wins; with no params the saved
view is restored.

## Agenda profesional y catálogo (B-pre, 01-oct-2026)

B-pre lays the foundations Planes (Bloque B, ADR-001) builds on: a global
reference catalog, the agenda per practitioner × location, **one**
availability engine, capabilities, and the multi-practitioner agenda of the
Secretaria. Two migrations, both additive (expand): `20260930200000_catalog_global`
and `20261001090000_agenda_foundations` (deploy order in
[MIGRACIONES-RUNBOOK.md §2.2](MIGRACIONES-RUNBOOK.md)).

### Model

```
Specialty ─┐                       Payer ──< PayerPlan (tenantId null = global,
Practice ──┴─< PracticeSpecialty      │                 set = proposed by a tenant)
   ▲                                  ▲                    ▲
   │ Service.practiceId?              │ Insurer.payerId?   │ Coverage.payerPlanId?
Service ──< PractitionerService >── Practitioner ──< PractitionerSchedule >── Location
Insurer ──< PractitionerPayer   >──┘     │  ├──< ScheduleException (null = whole clinic)
                                         │  └──< TimeBlock        (null = everyone)
Booking.locationId? ──► Location (RESTRICT; null = primary)
```

- **Global catalog (no `tenantId`)**: `Specialty`, `Practice`,
  `PracticeSpecialty`, `Payer`, `CatalogImportRun`; `PayerPlan` is global
  (`tenantId` null) or a tenant's proposal. Every row carries
  `source`/`sourceRef`/`sourceDate`, `curatedAt`, `archivedAt`, `matchKey`
  (unique) and raw `aliases`. Tenant tables point at it through **nullable**
  FKs with `SET NULL`: `Insurer.payerId`, `Coverage.payerPlanId`
  (`Coverage.planName` stays as display cache) and `Service.practiceId`. No
  auto-link in the migration: the user links from the UI.
- **Agenda (tenant tables, RLS like the rest)**: `Location` (one `isPrimary`
  per tenant, partial unique index), `PractitionerSchedule` (dow 0=Sun..6=Sat as
  `toARDow`, `startMin`/`endMin` = AR minutes, optional validity, CHECKs),
  `ScheduleException` (`CLOSED` | `CUSTOM_HOURS` with ranges per location),
  `TimeBlock` (soft-deleted, `groupId` for a partial-team lock),
  `PractitionerService` (enabled, own duration, `PUBLIC`/`PRIVATE`, lead
  times, cupo override), `PractitionerPayer`, `PractitionerSpecialty`.
- **Booking (expand)**: `locationId` (RESTRICT), `isOverbooked`, `arrivedAt`,
  `attendingAt`, `isTelemedicine`, `telemedicineUrl` (https). `UserPreferences.agendaPrefs`.
- **Backfill** in the same migration (idempotent, deterministic md5 ids):
  primary location per tenant; Mon-Sat ranges = `businessHours` per accepted
  practitioner; PractitionerService as today (own service → its practitioner,
  shared → everyone accepted) plus **step 3b**: every (practitioner, service)
  pair with a non-cancelled booking stays enabled as `PRIVATE` (so the new
  "service not enabled" rejection doesn't cut what a practitioner already did);
  PractitionerPayer = accepted × active insurers; `isOverbooked` from the
  `[SOBRETURNO]` prefix; `Booking.locationId` = primary. The Booking UPDATEs do
  **not** touch `updatedAt` (it's the optimistic lock). Runs with
  `SET LOCAL row_security = off`, so a migrating role without BYPASSRLS fails
  loudly instead of backfilling 0 rows.
- **Contract (after B-pre, not now)**: `Service.practitionerId`, the
  `[SOBRETURNO]` prefix, `Tenant.businessHours*`, `lib/booking-schedule.ts`.

### ADR-003 — `PractitionerService` over `Service` (status: ACCEPTED, 30-sep-2026)

- **Context.** The plan (§11.3) called it `PractitionerPractice`: the
  practice a practitioner is enabled for, with duration, visibility, lead
  times and cupo.
- **Decision.** Key it on `Service`, not on the catalog `Practice`:
  `@@unique([practitionerId, serviceId])`. `Booking.serviceId`, the cupo, the
  copago precedence (AUDIT §5.5), billing and the MP webhook all revolve around
  `Service`; the catalog practice enters through `Service.practiceId`. Planes
  will reference `(practitionerId, serviceId)` + `locationId`.
- **Consequences.** Adjusts the letter of the plan's §11.3, not its intent.
  **Defaults without a row** (preserve, AUDIT §5.33): a service with no PS row
  is enabled/PUBLIC if `Service.practitionerId` is null or that practitioner,
  disabled if it belongs to another; an insurer with no PP row is accepted.
  New practitioners/services/insurers are born with their rows
  (`lib/agenda-defaults.ts`, same ids as the backfill). When a shared service
  is assigned to one practitioner, the other practitioners' PS rows become
  `PRIVATE` (agenda unchanged, the public booking stops offering them) —
  `lib/services.ts` (fixer).

### Availability engine

- **Pure core** `lib/availability/*` (no DB, `now` injected, all wall-clock on
  `lib/datetime-ar.ts`): `types.ts` (the contract), `day.ts` (dayKey ↔
  instants, `@db.Date` helpers), `ranges.ts` (`scheduledRanges` = template ±
  exception, **without** subtracting blocks; `workingRanges` = minus
  TimeBlocks; `dayLockState`), `slots.ts` (`buildSlots`, grid anchored at each
  range's start), `classify.ts` (`classifyInstant`: duplicate > blocked >
  out-of-hours > overbook/patient-overlap > free, reusing `isHoldingCapacity` /
  `overlapBlocks`), `next-free.ts` (`nextFreeSlot` step 15 / 14 days,
  `firstFreeAcrossPractitioners` by service + insurer), `recurrence.ts`
  (`expandDates` weekly/biweekly/monthly — monthly = same day, clamped to the
  month's last day; `RECURRENCE_MAX_COUNT=60`). Barrel `index.ts`.
- **Contract rule**: `classify` / `nextFreeSlot` receive `scheduledRanges`
  (with `workingRanges` an instant inside hours but blocked would read as
  out-of-hours). `RecurrenceInput.daysOfWeek` is 0=Mon (inherited from the
  batch) while `dow` is 0=Sun.
- **Loader** `lib/availability-loader.ts` (`server-only`) is the **only** DB
  entry: `loadAvailabilityInputs(db, {tenantId, practitionerIds, …})` with
  `db` injected — **two channels**: the `tx` of `runWithRls` (agenda, modal,
  batch, Planes) or `prismaService` (public booking, no Actor). Every query
  carries `where: { tenantId }` by hand. Loads ranges, exceptions, blocks,
  non-cancelled bookings from 240 min back, PS/PP rules, services and the
  tenant hours.
- **Fallback (permanent safety net)**: a practitioner without ranges (or
  absent from the templates) works the tenant hours Mon-Sat at the primary
  location; `Booking.locationId` null = primary; a tenant without a primary
  location uses `NO_LOCATION_ID = ""` (`lib/availability/types.ts:64`): a
  block of a concrete location doesn't subtract from it, a global one does.
- **Parity**: the old paths were characterised first (`tests/unit/booking-schedule.test.ts`
  freezes the ef3281f code as **oracle** in `lib/booking-schedule.ts` — no new
  callers) and the engine is proven equal on a matrix + seeded random sets:
  `nextFreeSlot` ↔ old suggest, `buildPublicSlots` old ↔ new; with the
  backfill applied, the output is identical for today's client.
- **Consumers**: `lib/bookings.ts` (suggest, soft warnings, batch),
  `lib/public-booking.ts` (`listPublicSlots`, `findFirstPublicSlot`, submit),
  `lib/availability-actions.ts` (`getAgendaAvailability`, `listAvailableSlots`,
  `classifyBookingInstant`, `previewRecurrence` — read-only,
  `agenda.viewAll`, **no PHI**, **no cache** on purpose: a stale "free" slot is
  a surprise overbooking).

### Write paths on the engine (`lib/bookings.ts`)

- Soft warnings: `blocked` (forced with `allowBlocked` → stored as
  sobreturno) and `outOfHours` (`allowOutOfHours`, only a warning, D12). Public
  booking and Planes treat blocks as **hard**.
- A disabled PS for that practitioner → rejection (`SERVICE_DISABLED_ERROR`,
  `lib/bookings.ts:313`); duration = PS → Service.
- Blocks are re-checked **inside** the write tx after the capacity lock
  (`lib/bookings.ts:1136-1159`): a day lock committed between classification and
  write is seen.
- **Lock order** (preserve, AUDIT §5.28), same in create/update/batch
  (`createBooking` `lib/bookings.ts:1136,1184`, `updateBooking` `:1432,1504`, batch `~:2237,~2280`), public submit
  (`lib/public-booking.ts:516,546`) and `applyDayLock`
  (`lib/time-blocks.ts:468,608-617`):
  1. **capacity** — `pg_advisory_xact_lock` per (tenant, practitioner,
     service, **AR day**), every day the turno touches, ascending
     (`lib/booking-cap-lock.ts`); the batch uses one tx per date; the day lock
     takes the keys of its scope sorted by practitioner, service;
  2. **locations, shared** — `lockTenantLocationsShared` then validate
     `where {id, tenantId, active}` (`lib/location-lock.ts`; archiving takes
     it exclusive);
  3. **rows** — count, upsert, block rows.

  Planes (ES2b) extends this order with the patient lock first and Booking → Session → TreatmentProgram for rows;
  SR adds the room key between capacity and locations (C2 (1b)): ADR-004.

### Capabilities / authz

`lib/capabilities.ts` (pure matrix) + `lib/authz.ts` (`getMembershipRole`,
`getCapabilities` with React `cache`, `requireCapability`,
`requireTenantAdmin`). OWNER/ADMIN: everything. PRACTITIONER:
`agenda.viewAll`, `agenda.reception`, `agenda.manageOwnBlocks`,
`clinical.read`. ASSISTANT (the Secretaria): `agenda.viewAll`,
`agenda.reception`, `agenda.manageBlocks`, `agenda.manageOwnBlocks` — **no**
`clinical.read`. BILLING: `agenda.viewAll`, `billing.manage`. Since Planes ES1
(04-oct): `agenda.operateAll` (OWNER/ADMIN/ASSISTANT) and `plans.manage` /
`plans.schedule` / `plans.authorize` (used from ES2b); the per-patient level
`admin` (`lib/visibility.ts`) for every role without `clinical.read`; and the
pure predicates `canOperateBooking` / `canWriteClinical` plus
`bookingFieldAccess` (`lib/booking-field-access.ts`), which every booking
write and read reuses instead of re-implementing.
`schedule.configure` and `tenant.admin` are admin-only. Replaces the six copied
`role === OWNER|ADMIN` checks (tenant-settings, services, insurers,
patients ×3, configuración). Unknown role → empty set (fails closed). UI only
hides; the action is the barrier. Details in SECURITY.md §13.

### Global catalog: RLS, import, curation

- **RLS GLOBAL_READONLY**: Specialty/Practice/PracticeSpecialty/Payer/
  CatalogImportRun have ENABLE + FORCE and **only** `FOR SELECT USING (true)`:
  the app role reads, cannot write. PayerPlan is split (read global + own,
  write own). Writers: the import script (owner connection, checks
  `rolbypassrls`) and Plataforma (`prismaService` behind `requireSuperAdmin`).
  The guard enforces it (`scripts/guard-tenant-isolation.mjs:52,188-209`).
- **Import** `scripts/catalog-import.ts` + pure `lib/catalog/{normalize,csv,import-core}.ts`:
  data in `prisma/catalog/*.csv` (SSS RNOS/RNEMP/COSSPRA payers, plans, REFEPS
  specialties, PMO/curated practices, plus the benchmark seed
  `*.seed-2026-09.csv`, `SOURCES.md` CC BY 4.0). Dry-run by default, `--apply`
  in **one** tx, upsert by slug, **never** overwrites a row with `curatedAt`
  (only adds aliases) nor un-archives, seed files create-only, one
  `CatalogImportRun` per file, second run = 0 changes. The script can't call
  `revalidateTag` → Plataforma → Catálogo → Importaciones → **"Refrescar
  catálogo"** (`refreshCatalogCache`, `lib/catalog-admin.ts:494`).
- **Curation** `lib/catalog-admin.ts` (`/plataforma/catalogo/*`): search,
  edit (sets `curatedAt`), archive, `mergePayer`/`mergePractice` (repoint FKs),
  promote proposed plans, import runs. Every write revalidates `tags.catalog()`.
- **Tenant adoption** `lib/catalog.ts` + `lib/catalog-validate.ts`: Obras
  sociales "Agregar del catálogo" / link / matchKey suggestion; practice on a
  service; patient plan picker + "Otro plan…" (`proposePayerPlan`). Ids are
  validated: global or own, not archived, plan of that payer (FKs skip RLS).

### Agenda multi-practitioner, reception, day lock

- `listAgendaBookings` (`lib/bookings.ts:673`): light projection for the
  agenda (no patient → coverages → programs graph) + `clinical.read` gate
  (`title`/`description`/notes null, `clinicalHidden` per row) on top of the
  per-patient basic gate. Filters `practitionerIds[]`, `locationId`.
- Modes Día / Semana / Lista / **Por profesional** (`views/practitioner-day-view.tsx`:
  one column per practitioner, occupancy "2/3" / "4/∞", overbooking, out of
  hours, blocked hatch, now-line, keyboard) / **Recepción**; layout math is pure
  in `lib/agenda-layout.ts`. Practitioner chips with favourites, location
  filter, mode toggle. Since SR: **Por sala** and the room filter (§Salas).
- **Reception** (`lib/reception-state.ts` pure + `markReceptionAction`,
  `lib/bookings.ts:~1706`): timestamps `arrivedAt`/`attendingAt`, not new
  `BookingStatus` values; optimistic lock; capability `agenda.reception`. It is
  administrative but scoped: a PRACTITIONER without `agenda.manageBlocks`
  operates only own bookings or patients with full access (guest ok); "Deshacer"
  goes back to PENDING for a guest or an unpaid public reservation, CONFIRMED
  otherwise (fixer).
- **Day lock** (`lib/time-blocks.ts`: `previewDayLock` → `applyDayLock` →
  `removeDayLock`): "everyone" = one TimeBlock with `practitionerId` null **and
  `roomId` null** (reaches future practitioners; a room block is never
  "everyone", §Salas); a subset = N rows with `groupId`; since SR, scope "Una
  sala" (`agenda.manageBlocks`). Apply runs
  in one tx: locks → recompute affected → if they differ from what the user saw
  → `changed`, nothing applied → create blocks → optionally
  `cancelBookingsInTx` (`lib/bookings-cancel-internal.ts`; bookings with a
  recorded payment are **skipped**, H1).
- **Agenda prefs**: `UserPreferences.agendaPrefs` (`mode` incl. `room`, `zoom`, density,
  `favoritePractitionerIds`, `locationId`, `roomId`), sanitised on read
  (`sanitizeAgendaViewPrefs`, `lib/preferences.ts:47`).
- **Lazy loading in /agenda** (`components/agenda/agenda-client.tsx:110-124`):
  `next/dynamic` for the modal, drawer, day-lock dialog, Recepción, Por
  profesional and (SR) Por sala + room filter. First load 238 → 195 kB (PERF.md
  §B4.6); 204,5 kB after SR (PERF.md §SR).
- **Render tests** `tests/unit/render/*.test.tsx` (`renderToStaticMarkup`, no
  DOM): agenda-client, practitioner-day-view, day-lock, reception-view,
  public-booking-wizard.
- **UI splits**: `components/agenda/booking-modal/*` (modes Turno / Varias
  sesiones / Bloquear horario, slot picker, telemedicine),
  `booking-drawer/*`, `agenda-toolbar.tsx`, `grid/*`; Configuración tabs
  Sedes and Profesionales (`panels/locations-panel.tsx`,
  `panels/practitioners/*`); onboarding steps Sede and Tu horario (9 steps).

## Platform superadmin tier

Orthogonal to the tenant-scoped `Role` enum, there is a **cross-tenant
platform tier**:

- `UserProfile.isPlatformAdmin` (boolean, default false) is the flag; it is
  surfaced on the session as `Actor.isPlatformAdmin` (`lib/session.ts`).
- `requireSuperAdmin()` (`lib/session.ts`) returns the `Actor` or throws
  `ForbiddenError("platform_admin_required")` (and `UnauthenticatedError` with
  no session at all).
- The `/plataforma` route group (`app/(app)/plataforma/layout.tsx`) calls it
  and redirects non-admins to `/dashboard`. The sidebar entry is only rendered
  for superadmins. Surfaces: `plataforma/ejercicios` (catalog table + drawer
  editor + media manager + article editor) and `plataforma/tags` (tag CRUD per
  kind). A superadmin browsing `/biblioteca` can also edit a global card
  in place. Since B-pre also `plataforma/catalogo/*` (prestadoras, prácticas,
  especialidades, propuestas, importaciones) over `lib/catalog-admin.ts`.
  Since EV0 (07-oct-2026) the root `/plataforma` is a summary (vertical × plan,
  trials about to expire, pending onboarding) and `plataforma/consultorios`
  lists and edits every tenant (see ADR-005). Sub-nav:
  `components/plataforma/platform-nav.tsx`.
- **Global-catalog writes go through `prismaService`** (`lib/db.ts`), the
  BYPASSRLS channel — because the RLS-forced app role *physically cannot*
  write `tenantId IS NULL` rows (`exercise_write` requires
  `tenantId = app_current_tenant_id()`, and `ExerciseMedia`/`ExerciseArticle`
  have no write policy at all). That is the point: `requireSuperAdmin()` is
  the single app-layer chokepoint, and the DB is the wall behind it.
  `lib/exercises-admin.ts`, `lib/tags-admin.ts` and `lib/exercise-media.ts`
  all follow the same shape — `requireSuperAdmin()` first, `prismaService`
  after.
- `prismaService` resolves its connection as `DATABASE_URL_SERVICE` →
  `DIRECT_URL` → `DATABASE_URL`. Local needs no extra config (the Docker owner
  is a superuser); **prod must set `DATABASE_URL_SERVICE`** to the
  `kinesoft_service` role. See DEPLOYMENT.md.
- The flag is granted only out-of-band, DB-level:
  `scripts/set-platform-admin.ts` (`<email>`, `--revoke`, `--list`). There is
  no in-app way to promote a user.

## Architecture decisions (ADR)

### ADR-001 — Booking ↔ plan/session FK (status: ACCEPTED, amended; M1 written 04-oct-2026; 2026-09-23, amended 03-oct-2026)

- **Context.** The owner requires that *every plan generates its bookings* and
  that, for the same patient, in-plan vs out-of-plan bookings are
  distinguishable. At the time, the three plan entry points (`createProgram`,
  `assignDiagnosisAndCreateProgram`, `applyPlanTemplate`; all retired in ES3)
  created `Session`s at midnight with no `Booking`. The only bridge was a ±2h heuristic in
  `rescheduleSession` that moved unrelated bookings (audit 2026-09-23); A2a
  removed it (30-sep-2026): rescheduling moves only the session and reports a
  same-day booking with a link to the agenda.
- **Decision.** Add nullable `Booking.programId` and `Booking.sessionId`
  (`ON DELETE RESTRICT`), with a partial unique index "one active booking per
  session" and CHECKs for coherence; `TreatmentProgram` gains schedule, price,
  discipline, practitioner practice and location. `seriesId` stays, now meaning
  "generation batch". Bookings without `programId` are standalone ("fuera de
  plan"). Built **after B-pre** (per-practitioner availability engine), in one
  complete version — no "Plans v1".
- **Consequences.** Nothing linked is hard-deleted (archive instead); the copago
  precedence (`lib/copago.ts`) is untouched — a plan price is stamped on
  `Booking.copagoCents` with `pricedByPlan`.
- **Amendment (owner sign-off 03-oct-2026, PD-03/PD-04; detail in
  [PLANES.md](PLANES.md) §3).** Built **on top of ADR-003**: a plan references
  `(practitionerId, serviceId) + locationId`, with no FK to
  `PractitionerService`. Three composite FKs (`Booking_plan_tenant_fkey`,
  `Booking_plan_patient_fkey`, `Booking_session_program_fkey`) are the
  integrity net under BYPASSRLS. The partial unique index excludes CANCELLED
  **and NO_SHOW**, so "Ausente" frees the session for a new booking.
  `idempotencyKey` is unique per tenant. The same migration (M1,
  `plans_booking_link`) adds `ProgramAuthorization` and `PatientChangeRequest`
  (both with RLS) and relaxes `Patient_userId_key` to one per tenant (owner
  approved exception to "additive only").
- **M1 written and verified (ES2a, 04-oct-2026):**
  `prisma/migrations/20261004120000_plans_booking_link`, applied to local
  Docker only; staging/prod go in the single end-of-B deploy
  (MIGRACIONES-RUNBOOK §2.4). Review amendment F1: the pricing CHECKs use
  `IS NOT DISTINCT FROM` (with `=`, a NULL mode made the CHECK pass with a
  price). Since ES2b the only writer of the link (`programId`/`sessionId`/`pricedByPlan=true`) is the plan engine (I8).

### ADR-002 — Sentry on server/edge only, no client SDK (status: ACCEPTED, 30-sep-2026)

- **Context.** A3b wires `@sentry/nextjs`. The public booking route
  `/c/[slug]/booking` sits at 149.7 kB First Load (budget 150 kB) and `/agenda`
  at 184 kB (already over its 180 kB budget before A3); the client SDK would add
  tens of kB to every route.
- **Decision.** Only `instrumentation.ts` + `sentry.server.config.ts` /
  `sentry.edge.config.ts`. No `sentry.client.config`. Without `SENTRY_DSN`
  nothing is loaded (`next.config.mjs` is not wrapped, `register()` returns).
  All events pass through `redact()`, `sendDefaultPii: false`.
- **Consequences.** Browser errors are not captured (the boundaries still show
  the Spanish error screen); CSP reports do reach Sentry (they are sent by the
  browser to `report-uri`, no SDK needed). Revisit in C1 together with the
  bundle work on `/agenda`.

### ADR-003 — `PractitionerService` over `Service` (status: ACCEPTED, 30-sep-2026)

See §Agenda profesional y catálogo (B-pre). Adjusts the plan's §11.3.

### ADR-004 — Orden de locks de Planes (status: ACCEPTED, ES2b, 07-oct-2026)

- **Contexto.** B-pre fijó "cupo → sedes → filas" para un turno por tx (AUDIT §5.28). Planes escribe N turnos, N
  sesiones y el plan en una tx, y compite con la agenda, Seguimiento, el candado por día y el reprecio. Sin un orden
  global, dos tx que se cruzan dan 40P01; y sin lock sobre la sesión, "cerrar en Seguimiento" y "darle un turno" no se
  serializaban (sesión realizada con un turno activo futuro = cobro doble, H-a1 de la revisión).
- **Decisión** (contrato literal en [PLANES.md §4 C2](PLANES.md); enmienda de AUDIT §5.28 y §5.40):
  1. **Paciente:** `lockPlanPatient` (`lib/plan-lock.ts:39`), siempre primero, solo en operaciones que cambian la
     estructura de un plan. Varios pacientes (L9): `lockPlanPatientsInTx`, claves ordenadas en una sentencia. Nada que
     ya tenga un lock de cupo lo pide; `applyBookingUpdateInTx` nunca.
  2. **Cupos:** `lockCapacityMany`, todas las claves `(profesional, servicio, día AR)` deduplicadas y ordenadas en
     **una** sentencia (incluye el día siguiente si cruza la medianoche AR).
  3. **Sedes:** `lockTenantLocationsShared` una vez y recién después validar la sede `{id, tenantId, active}`.
  4. **Filas:** `Booking` (`FOR UPDATE`, id asc) → `Session` → `TreatmentProgram`. El CAS del `updatedAt` del plan
     va al final. Toda escritura multi-fila hace antes `SELECT … FOR UPDATE ORDER BY id` de sus candidatas.
  - **Enmienda C2 (1b), SR (08-oct):** entre (2) y (3) va la **sala**: paciente → cupo → **sala** → sedes → filas.
    Cupo y sala en **una** sentencia (`lockCapacityAndRoomsMany`, `lib/booking-cap-lock.ts:252`, claves
    `kinesoft:room:<t>:<roomId>:<día AR>`); con sala por defecto en la edición, una 2.ª sentencia después del cupo y
    antes de las sedes. La sala se valida después del compartido de sedes y se cuenta solo con su clave tomada.
    **Configuración:** sedes compartido → `kinesoft:room-schedule:<t>` (solo si hay sala) → `schedule`/`schedexc`
    (`lib/practitioner-schedule.ts:184-196`); ningún write-path de turnos lo toma. **Bloqueo de sala:** clave de sala →
    sedes → validar (`lib/time-blocks.ts:189-203`). `archiveRoom`/`updateRoom`/`restoreRoom`: sedes exclusivo. Planes,
    serie y turnero no toman clave de sala (SR-D3). Literal en [PLANES.md §4 C2](PLANES.md).
  - **Seguimiento y `rescheduleSession`** lockean el plan con **`FOR NO KEY UPDATE`** (`lib/sessions.ts:706,996`),
    no `FOR UPDATE`: el INSERT de un turno con FK al plan pide `FOR KEY SHARE` sobre el plan, que choca con
    `FOR UPDATE` pero no con `FOR NO KEY UPDATE`. Sigue serializando dos cierres concurrentes (A4 de ES1).
  - **El motor lockea las sesiones que escribe:** `lockWrittenSessionsInTx` (`lib/plans-engine-internal.ts:737`)
    hace `FOR UPDATE ORDER BY id` de las sesiones que crea, mueve, adopta o marca, y exige que sigan abiertas; si
    Seguimiento cerró antes → `StalePlanPreview('write-conflict')`. Del otro lado, Seguimiento re-cuenta los turnos
    activos después del claim y hace rollback si apareció uno.
  - **Reintento:** P2034/40P01 → **un** reintento de la tx completa (`withTxConflictRetry`, `lib/plan-lock.ts:75`) en
    todas las escrituras de Planes, en el cierre de Seguimiento y en `rescheduleSession`.
- **Desvíos documentados (re-planificar, `replanInTx`, `lib/plans-move-internal.ts:678`):**
  - Si cambian profesional, servicio o sede, el plan se escribe (`writeRefsKeepingStampInTx`) **antes** de
    re-clasificar, porque el motor lee las refs del plan. Para que eso no invierta Session → Program, las sesiones
    de la selección se lockean id asc **antes** de esa escritura (`:719`); el commit las vuelve a pedir (reentrante).
  - Los futuros impagos se cancelan **después** de re-clasificar y antes del commit (`:748`): un cobro que entró en
    el medio deja la selección distinta → stale.
  - Toda escritura de `Session` va antes de los INSERT de `Booking` con FK a plan/sesión.
  - `stateToken` compuesto `<motor>.<hash del pedido>`.
- **Agregar sesiones** toma Booking → Session → Program en dos tandas ordenadas (`lockProgramRowsInTx`), no un orden
  global único; el reintento cubre el resto.
- **Consecuencias.** El invariante es el orden global, no "un turno por tx". Cualquier write-path nuevo sobre
  turnos o planes respeta (1)-(4) o documenta su desvío acá. **Pendiente:** `applyDayLock`, `createTimeBlock` y
  `createBooking` no reintentan P2034/40P01 y tapan la excepción con un error genérico (AUDIT, C0/C1). Las carreras
  están cubiertas por `tests/integration/plans-concurrency.test.ts` y `plans-engine-fixes.test.ts` (TESTING.md).

### ADR-005 — Verticales y módulos (status: ACCEPTED, EV0, 07-oct-2026)

- **Contexto.** Martin decidió el 07-oct vender dos tipos de consultorio: **General** (agenda, pacientes, cobros,
  Sala de Espera; sin nada clínico de kine) y **Kinesiología** (todo; base = ejercicios propios, PRO = + catálogo de
  Plataforma). No había gating por tenant: solo `Tenant.plan` para ejercicios/plantillas/favoritos, nav estático
  duplicado y segmentos sin guard. Detalle en [VERTICALES.md](VERTICALES.md).
- **Modelo.** M2 `tenant_verticals`: `Tenant.vertical` (`GENERAL`|`KINESIOLOGY`, default `KINESIOLOGY`) y
  `Tenant.publicBookingEnabled` (default `false`, opt-in). El plan sigue siendo el enum existente. Columnas
  explícitas, sin `features Json` ni tabla nueva (un Json no tiene tipos ni CHECK, y una tabla sumaba RLS y joins
  en cada request).
- **`modulesFor(entitlements)`** (`lib/tenant-modules.ts`, puro y memoizado): `{vertical, plan,
  publicBookingEnabled}` → set de módulos. Falla cerrado (valor desconocido → sin módulos Kine). Invariantes con
  test: sesiones ⇔ planes, plantillas ⇒ planes, favoritos/ejerciciosGlobales ⇒ ejercicios, Kine monótono FREE ⊆
  STARTER ⊆ PRO, GENERAL sin módulos Kine. `Actor.entitlements` sale de la fila de tenant que `buildActor` ya lee:
  cero queries extra. Sin Actor (turnero, portal): `getTenantModulesById`.
- **Guards** (`lib/authz.ts`): `requireModule` / `assertModule` en las actions (la barrera); lecturas compartidas →
  `[]`, escrituras y detalle → `ForbiddenError`. `guardModuleSegment(m)` en el `layout.tsx` de `/diagnostico`,
  `/seguimiento`, `/biblioteca`, `/terapia-manual`, `/reportes` (redirige a `/dashboard`; es UX). `lib/plan-gating.ts`
  saca `canCreate`/`canFavourite`/`canBuildTemplates`/`hasFullCatalog` y `catalogScope` de los módulos.
- **Nav único.** `lib/nav.ts` (`NAV_ITEMS`, `navFor`, `shortcutsFor`) alimenta sidebar, topbar y ⌘K; el cliente
  lee los módulos con `useTenantModules()` (`components/layout/tenant-modules-context.tsx`). Limitación aceptada:
  el nav del layout no se repinta en navegación suave después de un cambio desde /plataforma (recargar); los guards
  sí cortan.
- **Escritor único.** `applyTenantEntitlementsInTx` (`lib/tenant-entitlements-internal.ts`) es el único que escribe
  esas columnas después de `bootstrapTenant`, con allowlist por `source` (`platform`, `tenant-settings`,
  `onboarding`, `billing`), FOR UPDATE + CAS por `updatedAt`, y revalida `tenantEntitlementTags` + el layout solo si
  algo cambió. Un solo lugar para auditar y testear quién puede cambiar qué. Detalle de la allowlist en
  [SECURITY.md §14](SECURITY.md).
- **Audit de plataforma.** `auditPlatformInTx` (`lib/audit.ts`) registra en el tenant **afectado** con `action:
  "platform.*"` y `payload.platform.actorHomeTenantId`.
- **Turnos online con switch.** El turnero público (`/c/<slug>/booking`) solo abre con `turneroPublico`
  (= `publicBookingEnabled`). Apagado: página "Turnos online no disponibles" (`components/booking/booking-unavailable.tsx`,
  `noindex`, con el contacto del consultorio), slots `[]`, submit rechazado sin escribir y sin prefill; el estado de
  un turno existente sigue. Se prende desde Configuración → General ("Funciones del consultorio",
  `setPublicBookingEnabled`, último gana) o desde /plataforma (Drawer con CAS).
- **Consecuencias.** Kine FREE/STARTER dejan de ver los globales `isBasic` (solo PRO ve el catálogo de Plataforma;
  `isBasic` queda muerto hasta EV1). Toda sesión pendiente que agregue un export en un área con módulo lleva su gate
  (enmiendas de VERTICALES §5). El webhook de billing SaaS futuro entra como `source:"billing"`.

### ADR-006 — Realtime por Broadcast privado con token acuñado (status: ACCEPTED, SV, 13-oct-2026)

- **Contexto.** La sala de espera tiene que ser una sola realidad en todas las pantallas del consultorio. La sesión de
  Supabase vive en cookies httpOnly (A3: el browser no tiene el access token) y las policies de la app son por GUC
  (`app_current_tenant_id()`), que Realtime no setea. En prod la conexión tiene BYPASSRLS. Vercel congela la lambda
  al responder (Next 14.2 sin `after()`) y corta streams largos.
- **Decisión (SV-D1).** Supabase Realtime **Broadcast privado** por tenant (`tenant:<id>:agenda`). Publica solo el
  server, después del commit, desde `afterBookingsCommitted` (REST con la service key). El browser se suscribe con un
  **token HS256 propio de 10 min** (`purpose:"kinesoft-realtime"`, `sub` sintético, `kid` opcional) que la policy de
  M5 (`kinesoft_realtime_can_read`) acepta solo para su topic. El mensaje no lleva PHI y no se confía: el cliente
  re-pide con sus actions. Más SV-D5..D16 (plan §18.14): «Llamar» exige en-sala (D5), claims (D6), publish
  **esperado** con tope (D7), `/sala` solo hoy (D8), a quién se avisa (D9), colapso > 20 (D10), `local` prohibido en
  prod (D11), `refs: []` no publica y `availability` → `router.refresh()` (D12), «Por profesional | Por sala» (D13),
  una conexión por pestaña (D14), HS256 con `kid` (D15), toasts agrupados y sin sonido tras resync (D16).
- **Descartados.** Canal público (cualquiera con la anon key lee); `postgres_changes` (las policies por GUC no
  entregan nada); SSE en Vercel (`maxDuration`); Pusher/Ably (proveedor nuevo con datos de salud); trigger SQL
  (invisible en local, no sabe de `prev`); exponer el access token real al browser (rompe el httpOnly de A3);
  publish fire-and-forget (Vercel pierde las promesas sueltas).
- **Consecuencias.**
  - Cada write-path de turno paga el POST (normalmente decenas de ms; **tope 1,5 s**). Con Supabase caído, el breaker
    (3 fallos → 30 s abierto; 300 s si falta config) lo baja a 0 ms. 0 statements SQL extra (PERF §SV).
  - Hay que mantener la lista de write-paths: `guard-realtime` (c) y `tests/integration/realtime-emission.test.ts`.
  - Tres drivers (`off`/`local`/`supabase`) con la misma interfaz; los tests nunca tocan Supabase (mock global del
    publisher en `integration-setup.ts`). Lo que no se prueba en local va a V1-V7 en staging.
  - El proyecto Supabase necesita una clave **HS256** (legacy o del sistema nuevo con `kid`); la rotación es de consola
    + env, sin código (EXTERNAL-CONFIG §3.1).
  - Multi-pestaña: cada pestaña su socket y su token (leader election → C1).

## Cache & cookies (what is implemented — updated 30-sep-2026)

**Data cache** — `unstable_cache` in 9 loaders, **every key carries the
`tenantId`** (no cross-tenant leakage by key), tags from `lib/cache-tags.ts`:
catalog/facets/diagnosis 1 h · services, insurers, practitioners 5 min ·
dashboard counts and month booking-days 60 s. React `cache()` only for
`getActor` and the visibility helpers (it does NOT dedupe inside Server
Actions). Invalidation: ~120 `revalidatePath`, tag helpers (e.g.
`invalidateBookingDerivedCaches`) and ~60 client `router.refresh()`.
Agenda, patients, clinical history and sessions are **not** cached (correct).
Neither is availability (B-pre, `lib/availability-actions.ts`): no
`availability` tag on purpose. The global catalog (B-pre) reads under
`tags.catalog()`; Plataforma writes revalidate it and the import is followed
by "Refrescar catálogo". **Per-user data in a shared key is a leak:** the
dashboard revenue key carries the revenue scope explicitly
(`["dashboard:revenue", tenantId, revenueScopeKey(scope), range, dayKey]`,
`lib/dashboard.ts:679`, SR-D5I), and `monthRevenue` left the counts cache,
which is shared by patient visibility, not by practitioner.

**HTTP** — every page in `(app)`, `(portal)` and booking is dynamic
(`force-dynamic`/cookies) → `Cache-Control: private, no-store`: the CDN never
stores PHI. Exports and `/api/booking/[id]/status` set `no-store` explicitly.

**Session refresh (A3b).** `middleware.ts` refreshes the Supabase session on
every request (`createServerClient` with `getAll`/`setAll`, then
`getSession()` — no authorisation decision is taken there). Refreshed cookies
are written to the request (so the RSC render sees them) and to the response;
if a `Set-Cookie` was written the response is marked `private, no-store`.
`/_next` and `/api/webhooks` bypass it; the `x-tenant-*` strip and
`x-request-id` run on every path. Before A3b the middleware didn't refresh and
RSCs dropped the refreshed cookie, so long sessions logged out.

**Cookies** — `sb-<ref>-auth-token` (Supabase session, chunked) and the PKCE
code-verifier, now **httpOnly**, `Secure` in production and `SameSite=Lax`
(`lib/supabase/cookie-options.ts`; the `@supabase/ssr` default was httpOnly
false). `ks_recovery` (httpOnly, 15 min, HMAC-signed) only during a password
recovery. `kine_tenant` is read and validated against memberships but no code
writes it (no tenant switcher yet). No tracking/analytics cookies → no banner
needed (list them in the privacy policy). Browser storage:
`localStorage['kinesoft:tweaks']` and `kinesoft:agenda-visibility:<userId>`
(agenda toggles). Agenda mode/zoom/favourites/location live server-side in
`UserPreferences.agendaPrefs` (B-pre).

**Closed in A2/A3:** the `practitioners` tag is invalidated on accept / remove /
role change; the dashboard resolves patient access **outside** the
`unstable_cache` and re-hydrates `Date`s after a cache hit.

**Known gaps** (C1): public booking / patient creation / MP webhook don't
invalidate dashboard caches; dashboard PHI lives in the Vercel Data Cache
(owner decision); CSP still Report-Only.

## Build / verify

- `npm run dev` — local Next.js against Docker Postgres (`.env.local`).
- `npm run build` = `prisma generate && next build`. Vercel runs
  `node scripts/vercel-build.mjs`: `prisma migrate deploy` **only** when
  `VERCEL_ENV=production` (A0b), then generate + build.
- Verify: `npx tsc --noEmit` + `npx next build` (clear `.next` on stale
  "Cannot find module for page" cache errors). `scripts/` is excluded from tsc.
  Locally, `.env.local` defines `NODE_ENV`, which breaks the prerender: build
  with `npx dotenv -e .env.local -v NODE_ENV=production -- npx next build`
  (TESTING.md).
- Migrations + env split: see [DEPLOYMENT.md](DEPLOYMENT.md).
