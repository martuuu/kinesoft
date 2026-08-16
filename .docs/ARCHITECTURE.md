# KineSoft — Architecture

Multi-tenant SaaS for Argentinian kinesiologists / physical therapists. The
single live client is a kinesiólogo-osteópata (high clinical expertise). The
product is built in 3 stages — see [ROADMAP.md](ROADMAP.md) (MVP base →
diagnosis guide → local AI).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 (App Router, RSC + server actions) |
| Language | TypeScript (`strict`, **not** `noUnusedLocals`) |
| ORM / DB | Prisma 5.22 · PostgreSQL |
| Hosting | Vercel (region `gru1`) · Supabase (Postgres + Auth + Storage) |
| Auth | Supabase Auth (email/password + Google OAuth) |
| Payments | Mercado Pago (checkout + webhook) |
| Styling | Tailwind + CSS variables · framer-motion |
| Rate limit | Upstash Redis (prod) / in-memory (dev) — `lib/rate-limit.ts` |

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
   added in Ola B2 + the 2 split-policy catalog tables). Direct-`tenantId`
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

## Server-side conventions

- **`"use server"` files** (`lib/bookings.ts`, `lib/patients.ts`, …): every
  export must be `async` (they're RPC endpoints). Types/constants live in
  sibling `*-types.ts` / `*-constants.ts` so client components import them
  without dragging the server module.
- **`server-only` helpers** (`lib/billing-internal.ts`,
  `lib/insurers-internal.ts`, `lib/public-booking-internal.ts`,
  `lib/notifications-internal.ts`): internal functions that must NOT be
  exposed as RPC. Marked with `import "server-only"`.
- **Audit**: every PHI read/write writes an `AuditEvent` (`lib/audit.ts` +
  the read-audit extension). File-download URL minting is audited too.

## Timezone (a core invariant)

Argentina is fixed UTC−3, **no DST**. All wall-clock logic uses the helpers in
`lib/datetime-ar.ts` — `localToARIso`, `toARDateKey`, `toARDow` (0=Sun..6=Sat
in AR), `toARHour`. Host-TZ math (`getUTCDay`/`getDay`/`setHours`) drifts on
UTC hosts (Vercel) — this caused the week-grid misalignment and the
wrong-days multi-turno bug. Client `toLocaleString` on DB instants MUST pass
`timeZone: "America/Argentina/Buenos_Aires"` (else hydration mismatch + wrong
date). **Exception**: a `<input type="date">` value (parsed UTC-midnight) must
NOT get AR tz, or the day shifts back.

## Domain model (key entities)

**Scheduling.** `Booking` is the turno — `scheduledFor`, `durationMin`,
`status` (PENDING/CONFIRMED/COMPLETED/NO_SHOW/CANCELLED), `copagoCents`
(per-turno override), `insurerPaidAt` (OS reimbursement confirmation),
`seriesId` (groups a multi-turno batch), `title` / `description` (per-turno
mini-diagnosis, defaulted from `Patient.diagnosisTitle` / `diagnosisNote`),
`idempotencyKey`, `updatedAt` (optimistic-concurrency token). Bookings have
**no FK** to `Session`/`TreatmentProgram` — they live in parallel.

- **Single turno**: `createBooking` (conflict/sobreturno UX + next-free-slot).
- **Multi-turno**: `createBookingsBatch` (count + weekdays, AR-correct days,
  shared `seriesId`, individual `Booking` rows — **not** a plan).
- **Edit/delete**: `updateBooking` / `deleteBooking` / `setBookingStatus`,
  all under `runWithRls`, all guarded by `expectedUpdatedAt`
  (optimistic concurrency) so a stale drawer can't mutate a changed row.

**Capacity + anti-duplicate — four layers** (Rondas 4 and 6):

1. **Professional capacity.** `Service.maxConcurrent` (`null` = unlimited, the
   default — overlapping turnos are normal in kinesiología) caps how many
   patients may share a window. Pure helper `overlapBlocks()` in
   `lib/booking-capacity.ts`: blocked when `overlapCount >= maxConcurrent`.
2. **Patient guard.** `patientDayStatus()` (same file, pure + unit-tested)
   looks at the patient's other non-cancelled turnos on the same **AR day**,
   across all professionals: an overlap is a **hard stop**; a second turno the
   same day is a **soft confirm**; nothing else is free. `createBooking` runs
   it with a 240-min look-back for AR-midnight crossings and excludes its own
   row by `idempotencyKey` so an idempotent retry can't self-block.
3. **`idempotencyKey` is CLIENT-generated.** One `crypto.randomUUID()` per
   modal instance (`components/agenda/booking-modal.tsx`), with a server
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

**Agenda day view** (Ronda 9). `components/agenda/views/timeline-view.tsx`
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
  in place.
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

## Build / verify

- `npm run dev` — local Next.js against Docker Postgres (`.env.local`).
- `npm run build` = `prisma generate && next build`.
- Verify: `npx tsc --noEmit` + `npx next build` (clear `.next` on stale
  "Cannot find module for page" cache errors). `scripts/` is excluded from tsc.
- Migrations + env split: see [DEPLOYMENT.md](DEPLOYMENT.md).
