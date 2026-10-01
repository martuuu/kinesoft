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
| `lib/booking-capacity.ts` | **Capacity contract.** `isHoldingCapacity(b, now)`: every non-cancelled booking holds its slot except a public reservation that is PENDING + UNPAID/FAILED and older than 30 min (`PENDING_PUBLIC_HOLD_MS`). `isPublicReservation({idempotencyKey, patientId})` decides "public" **by the key** (`pub:<tenant>:<uuid>` or the pre-A2 `<tenant>:<prof>:<ISO>:<patientId>`); when in doubt it holds. Also `overlapBlocks`, `patientDayStatus`. Pure, `now` injected. Used by create/update/batch/`suggestNextFreeSlot`, the public booking and the MP webhook. AUDIT §5.18 |
| `lib/public-booking-slots.ts` | `buildPublicSlots` / `checkPublicSlot`: the public grid (hours, Sunday closed, 1 h lead time, 45-min step) — the same check on list and on submit |
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
**no FK** to `Session`/`TreatmentProgram` — they live in parallel. ⚠️ **Superseded
by ADR-001 (proposed, 2026-09-23)** — see §Architecture decisions: plans must
generate their bookings, so the FK is coming in Bloque B.

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

## Architecture decisions (ADR)

### ADR-001 — Booking ↔ plan/session FK (status: PROPOSED, 2026-09-23)

- **Context.** The owner requires that *every plan generates its bookings* and
  that, for the same patient, in-plan vs out-of-plan bookings are
  distinguishable. Today the three plan entry points (`createProgram`,
  `assignDiagnosisAndCreateProgram`, `applyPlanTemplate`) create `Session`s at
  midnight with no `Booking`. The only bridge was a ±2h heuristic in
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
  `Booking.copagoCents` with `pricedByPlan`. Pending the owner's approval (D25).

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

## Cache & cookies (what is implemented — updated 30-sep-2026)

**Data cache** — `unstable_cache` in 9 loaders, **every key carries the
`tenantId`** (no cross-tenant leakage by key), tags from `lib/cache-tags.ts`:
catalog/facets/diagnosis 1 h · services, insurers, practitioners 5 min ·
dashboard counts and month booking-days 60 s. React `cache()` only for
`getActor` and the visibility helpers (it does NOT dedupe inside Server
Actions). Invalidation: ~120 `revalidatePath`, tag helpers (e.g.
`invalidateBookingDerivedCaches`) and ~60 client `router.refresh()`.
Agenda, patients, clinical history and sessions are **not** cached (correct).

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
(agenda toggles).

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
