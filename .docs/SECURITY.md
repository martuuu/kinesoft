# KineSoft — Security model

This document captures the authentication + authorisation model. Read it
alongside [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md) and the
open security items in [AUDIT.md](AUDIT.md).

## 0. Recent hardening (post-Sprint 18)

- **Optimistic concurrency on bookings.** `updateBooking` / `deleteBooking` /
  `setBookingStatus` accept `expectedUpdatedAt` (the `Booking.updatedAt` the
  client loaded) and reject the mutation if the row changed since — a stale
  drawer can't edit/delete a turno that moved or was already modified.
- **`updateBooking` is transactional.** Ownership lookup + patient-rebind
  validation + the write run in one `runWithRls` tx (was a TOCTOU gap).
- **Coverage reads are deterministic** (ordered by `id` desc) and public
  booking no longer appends duplicate coverages; free-form insurer names are
  normalised + linked to the catalogue (`resolveInsurerName`).
- **Generic action catches log** (`logger.error(e.message)`) instead of
  swallowing the cause (createBooking/Patient/Service/Insurer).

**Since closed** (post-baseline rondas):

- **Per-booking payment-amount validation** — ✅ closed in **Ronda 2**
  (`c3-payment-amount`): `Payment.expectedAmountCents` is anchored when the MP
  preference is created, and the webhook compares against that anchored amount
  instead of the live `Service.priceCents` (§4).
- **Wholesale RLS adoption** — ✅ closed in **Ronda 4** (§9): every Actor-facing
  module runs under `runWithRls`, the local app role is `kinesoft_app`
  (NOBYPASSRLS) and the isolation test is green. The **prod connection-role
  flip** remains an owner task.

- **Bloque A2/A3 (30-sep-2026)** — ✅ closed in code: basic access = view only
  (§1.1), public booking never touches an existing patient row (§2), webhook
  no-downgrade/no-revive (§4), open redirects + Origin checks, httpOnly cookies
  and session refresh (§11), hardened rate-limit (§8), staff ≠ patient (§9),
  Sentry/CSP reports/HSTS/PII redaction (§12), Next 14.2.35.
- **Bloque A3c (30-sep-2026)** — ✅ H5 closed: the signup uses `auth.signUp` with
  email verification (`lib/auth.ts:49`); `admin.createUser({ email_confirm: true })`
  and tenant creation at signup are gone. The tenant is created only in
  `/onboarding` (step 2, `lib/tenant-bootstrap.ts`) by a verified identity.
  Requires "Confirm email" ON in Supabase (EXTERNAL-CONFIG §0.1).

- **B-pre (01-oct-2026)** — capabilities per role (§13), global catalog
  read-only under RLS (§9, §10), public booking filtered by PUBLIC practices and
  accepted memberships (§2), cupo-1 TOCTOU closed with an advisory lock in the
  agenda and the public booking, availability responses without PHI.

**Still open** (tracked in AUDIT.md): the
Upstash env (§8 — owner); the
prod RLS role flip (§9, its code prerequisite `p2002-target-null-bajo-rls` is
closed); CSP enforce (C1); GDPR export/retention.

## 1. Identity & tenancy

Every authenticated surface flows through `lib/session.ts`:

```
Supabase auth ──┐
                ├─►  Membership lookup  ──►  Actor { tenantId, practitionerId, userId }
kine_tenant ────┘
   cookie (validated)
```

- **`getActor()`** — returns the active `Actor` or **throws
  `UnauthenticatedError`**. Every mutating server action and every
  authenticated API route calls this.
- **`tryGetActor()`** — same, but returns null instead of throwing. Used
  by server components that render a "please sign in" branch (e.g.
  `app/(app)/layout.tsx`).
- The `kine_tenant` cookie chooses *which* tenant to act as. It is only
  honoured when the user is actually a `Membership` of that tenant.
- The `x-tenant-slug` request header is **stripped** by `middleware.ts`
  on every inbound request. The middleware re-sets it for `/c/<slug>/…`
  paths and subdomains so public-tenant surfaces can resolve, but the
  authenticated session lookup never reads it. This closes the
  cross-tenant takeover vector that existed pre-Sprint 11.

### Dev escape hatch

`KINESOFT_ALLOW_DEMO_ACTOR=1` in `.env.local` lets the workspace fall back
to the seeded `movare` tenant + first practitioner when there's no
Supabase session. **Never set this in production** — `lib/session.ts`
also enforces `NODE_ENV !== "production"`.

## 1.1 Access matrix: basic = view only (owner decision, 30-sep-2026)

A PRACTITIONER who is neither the assigned practitioner nor has a
`PatientShare` has **basic** access (`lib/visibility.ts`). OWNER/ADMIN always
have full access; the tenant flag `sharedPatientView` grants full to everyone
**with `clinical.read`** (since ES1, roles without it get the `admin` level, §13).
**The server enforces it; the UI only mirrors it.**

| Action | full | basic |
| --- | --- | --- |
| See the booking (name, time, service) | ✅ | ✅ (notes, `title`, `description` nulled — `lib/bookings.ts:633-635`; in the agenda's `listAgendaBookings` also for any role without `clinical.read`, §13) |
| Edit / reschedule / change status / delete a booking, toggle copago or OS paid | ✅ | ❌ `BASIC_ACCESS_ERROR` (`lib/bookings.ts:64`) |
| Create a booking (single or batch) for that patient | ✅ | ❌ |
| Guest bookings (no patient) | ✅ | ✅ operable |
| Edit patient, coverage, default copago, portal invite | ✅ | ❌ |
| Sessions (detail, close, reschedule, meta, exercises) | ✅ | ❌ (`getSessionDetail` → 404) |
| Files, activity, clinical-history mutations (diagnosis, plans, EVA) | ✅ | ❌ (list → `[]`) |
| Archive / bulk archive (all-or-nothing) | ✅ | ❌ |
| Dashboard recent/upcoming | ✅ | row without diagnosis/progress/actions |
| ICS / CSV export | ✅ | row masked (no notes/title/description/PHI) |

**Exports are route-only.** `exportBookingsIcs` and `exportPatientsCsv` live in
`lib/bookings-export-internal.ts` / `lib/patients-export-internal.ts`
(`server-only`). As `"use server"` exports they were callable as RPC, skipping
the route's rate-limit and the 90-day cap. The CSV neutralises formula cells
(`= + - @`, TAB/CR — `lib/csv.ts`) and writes an `AuditEvent`
`patient.export`.

**Input ids are validated against the tenant** before any write, because FK
checks bypass RLS: `practitionerId` in `createBooking`/batch, `patientId` in the
batch (also in `dryRun`). A client `idempotencyKey` that belongs to another
tenant's row is rejected (the key is globally unique; under BYPASSRLS the upsert
used to overwrite the foreign booking). Known gap (C0): write paths check
practitioner ∈ tenant but not an **accepted** membership.

## 2. The public surface

Public, unauthenticated surfaces (`/c/<slug>/booking`, the booking result
pages, the MP webhook):

- Resolve tenant by slug, not by header.
- Every public server action is rate-limited per IP via `lib/rate-limit.ts`.
- `lib/public-booking.ts#submitPublicBooking` **never modifies an existing
  Patient row** — not even to fill empty fields (H4, closed in A2b,
  30-sep-2026). The match is by normalised DNI only
  (`resolvePublicPatient`, `lib/public-booking-internal.ts:122`); if the typed
  name/email/phone differ from the file, they go to the booking as a snapshot
  (`guestName/guestEmail/guestPhone`) plus the note "Reserva online · datos de
  contacto distintos a la ficha" for the practitioner to review. Before A2 a
  stranger's DNI + the attacker's email took over the patient's portal.
- The wizard sends a per-instance key `pub:<tenantId>:<uuid>`; a reused key with
  different data is rejected and a CANCELLED booking is never revived. The slot
  must belong to the day's grid (`checkPublicSlot`, checked again on submit).
  Since B-pre the grid comes from the availability engine: the
  practitioner's own ranges, exceptions and blocks (blocks are **hard** here),
  lead `minLeadMinutes ?? 60`. The public clinic only exposes practitioners
  with an **accepted** membership and, per practitioner, services whose
  `PractitionerService` is enabled and **PUBLIC** (`lib/public-booking.ts:74-108`);
  a PRIVATE practice is bookable only by staff. The submit takes the capacity
  lock and the shared locations lock inside its tx (`:516,546`), so two
  simultaneous reservations can't both fill a cupo 1. The engine's loader runs
  on `prismaService` here (no Actor) with a hand-written `where: { tenantId }`
  in every query.
- `lib/public-booking.ts#getPublicBookingStatus` returns only initials +
  non-PHI fields. The booking id (25-char CUID) is sufficiently random
  for the polling endpoint, but the payload is minimised regardless.
- `findPatientByEmailForPrefill` is **not** an exported server action. It lives in
  `lib/public-booking-internal.ts` and is only invoked from the page loader
  (`loadPublicBookingPage`) after validating `email_confirmed_at` against
  the Supabase session. **Prefill acotado al consultorio (EV0 V.Z, P2):**
  `tenantId` es obligatorio; criterio ficha con `userId` = el usuario → única
  ficha del consultorio con ese email → nada (dos fichas = ambiguo, sin
  prefill). Antes buscaba por email en todos los consultorios y precargaba DNI,
  nacimiento, cobertura y emergencia de una ficha **ajena** (PD-14: entre
  consultorios no se comparte nada; solo viaja el nombre de la sesión). Con
  los turnos online apagados el loader corta antes de leer la sesión y el
  prefill. Test: `ev0-review-fixes.test.ts` (P2).

## 3. Patient portal

`lib/portal.ts` requires `email_confirmed_at` on the Supabase user before
treating the email as authoritative — Supabase magic-link / unverified
sign-ups can never read PHI on a Patient row that happens to share their
email.

The portal matches the patient's email case-insensitively and treats any
identity with a `Membership` as "no patient files" (staff ≠ patient, §9).

`submitCheckIn` (`lib/portal.ts:196`):

- Rate-limited per IP (4/min).
- Refuses a second check-in for the same session id.
- **Never writes `Patient.notes`** (since A3b, 30-sep-2026). It creates the
  `EvaScore`, notifies the assigned practitioner (or OWNER/ADMIN) and writes an
  `AuditEvent` `portal.checkin` with the text (capped at 500 chars). Before, the
  text was prepended to `Patient.notes` and the field truncated to 4 kB, which
  cut off the practitioner's older notes.
- Known gap (C1, portal v2): `getPortalPlan` returns the practitioner's
  `Session.notes` to the patient.

## 4. Mercado Pago webhook

Pre-Sprint 11, the webhook bypassed signature verification in non-prod
environments. The new model (`lib/mercadopago.ts` +
`app/api/webhooks/mercadopago/route.ts`):

- **Signature is required** when `MP_WEBHOOK_SECRET` is configured. No
  prod-only carve-out. Stale timestamps (>5 min) are rejected to defeat
  replay.
- When the secret is missing, prod **refuses** the request (503) instead
  of falling through.
- `consumeWebhook` is idempotent: a re-fire with the same
  `(externalId, status)` short-circuits without firing notifications.
- The captured MP `transaction_amount` is compared against the amount
  **anchored when the preference was created** (`Payment.expectedAmountCents`,
  Ronda 2) — not the live `Service.priceCents` — before flipping the booking to
  PAID. A mismatch persists `Payment FAILED` instead of losing the trace.
- **No downgrade, no revive** (A2b, 30-sep-2026): `nextPaymentStatus`
  (`lib/mercadopago.ts:184`) only lets a PAID go to REFUNDED; every event is
  kept (redacted, last 20) in `rawPayload.attempts`; the whole update runs in
  one tx with `SELECT … FOR UPDATE` on the booking, and a concurrent P2002 is
  retried as an update. Only PENDING becomes CONFIRMED: a CANCELLED/NO_SHOW/
  COMPLETED booking records the payment and notifies "revisá el reembolso"
  instead of coming back to life. A duplicate payment also notifies.
- Known gap (C): a late payment on an expired public reservation confirms it
  and notifies, without re-checking capacity.
- `rawPayload` is redacted to a known-safe subset before persistence —
  no cardholder name, document, or device fingerprint.

## 5. Auth callback (`/auth/callback`)

`auth/callback/route.ts` only links a Supabase identity to a `Patient`
row when:

1. `user.email_confirmed_at` is set, **and**
2. The Patient row has `userId == null` (or already matches this user).

A Patient already linked to a different identity is never re-bound. This
closes the account-takeover vector via mistyped Patient emails. Since A3b
(30-sep-2026) the callback also never links files to an identity that has a
`Membership` (staff ≠ patient), and its `next` goes through `safeNext` (§11).

## 6. File uploads

`lib/files.ts` (since ES1, Storage goes **only through the service role**,
`lib/storage-internal.ts`, §13; since A2b, 30-sep-2026, every file action requires **full**
access to the patient: basic gets an empty list and upload/delete/download are
rejected; the download `AuditEvent` is written **before** the URL is signed,
and `deletePatientFile` checks the storage `{ error }`).

`lib/files.ts#uploadPatientFile`:

- MIME allow-list (PDF / JPG / PNG / WEBP / GIF / HEIC / MP4 / DOCX /
  XLSX / TXT / MP3 / MOV). Anything else is rejected at the server.
- File extension is sanitised against `/^[a-z0-9]{1,8}$/` — no traversal
  characters in the Supabase Storage path.
- `getDownloadUrl` writes an `AuditEvent` for every signed URL minted.
  PHI exfiltration via repeated download is observable.

## 7. Notification fan-out

`notify()` and `notifyTenantOwners()` accept arbitrary `tenantId` +
`userId` arguments. They live in **`lib/notifications-internal.ts`**, not
`lib/notifications.ts`, so they are not exposed as RPC endpoints. Only
the user-scoped actions (`listNotifications`, `markRead`, …) are
exported from the `"use server"` module.

## 8. Rate limiting (rewritten 30-sep-2026, A3a)

`lib/rate-limit.ts` uses Upstash Redis when `UPSTASH_REDIS_REST_URL` /
`_TOKEN` are set, and an in-memory window otherwise. **In-memory does not
protect anything on Vercel serverless** (one map per isolate, reset on cold
start): the Upstash env is an owner task (EXTERNAL-CONFIG §4).

How the Upstash path behaves since A3a:

- `try/catch` + `AbortSignal.timeout(1500)` + validation of every command's
  result. **Any failure falls back to memory** and logs
  `rate_limit.upstash_fallback` (throttled to 1/min). Before, a network error
  broke login instead of degrading.
- Keys are prefixed `rl:<VERCEL_ENV|dev>:` so preview/staging and production
  never share counters.
- The memory map is swept and capped at 10k keys.
- The client IP comes only from `clientIp(headers)` (`lib/client-ip.ts`; it
  replaced 8 hand-rolled copies). Composite limits go through
  `rateLimitAll([...])`; emails are hashed (`hashKeyPart`, sha256) before being
  used as a key.
- **Uniform 429:** form route handlers redirect 303 to `?error=rate_limited`;
  server actions return "Demasiados intentos. Probá de nuevo en N s."
  (`rateLimitedMessage`).

| Surface | Limit |
| --- | --- |
| `submitPublicBooking` | 5 / 5 min / IP |
| `listPublicSlots` | 60 / min / IP |
| `getPublicBookingStatus` | 120 / min / IP |
| `submitCheckIn` | 4 / min / IP |
| Mercado Pago webhook | 60 / min / IP |
| `/api/auth/sign-in` (login) | 10 / min / IP **+** 10 / 15 min / email hash → 303 `?error=rate_limited` |
| `/api/auth/google` | 10 / min / IP → 303 |
| signup | 3 / 10 min / IP **+** 3 / h / email hash |
| forgot password | 5 / 10 min / IP **+** 3 / h / email hash |
| reset password | 5 / 10 min / IP **+** 5 / 10 min / user (only without `ks_recovery`, when the current password is checked) |
| `createInvitation` / `regenerateInvitationUrl` | 10 / h / actor **+** 1 / 10 min / recipient (shared bucket) |
| `sendPatientPortalInvite` | 10 / h / actor **+** 1 / 10 min / recipient |
| `acceptInvite` | 10 / 10 min / IP |
| `/api/pacientes/export` | 5 / min / user |
| `/api/agenda/export` | 10 / min / user |

Accepted trade-off: the per-email login limit lets someone lock a third party's
account out of password login for up to 15 minutes (Google login and the
recovery flow still work).

## 9. Row-Level Security (RLS) — a real backstop (Ronda 4)

> ⚠️ **One residual, and it is the important one: PROD still connects with a
> BYPASSRLS role.** Everything below is true and verified **locally**. Until the
> owner runs `prisma/roles.supabase.sql` and flips prod's `DATABASE_URL` to
> `kinesoft_app`, `FORCE RLS` does not evaluate in production and the app-layer
> `where: { tenantId }` filter is the only isolation gate *there*. Tracked as a
> bucket-C item in EXTERNAL-CONFIG.md §3.

**Policies.** `prisma/migrations/20260725120000_rls_policies/migration.sql` is
the single source of truth (`prisma/migrations/policies.sql` is now only a
redirect stub, applied by nothing). It does `ENABLE` + `FORCE ROW LEVEL
SECURITY` on **26 tables** (17 original + 7 added in Ola B2 + 2 catalog
tables; later migrations add their own policies — B-pre's
`agenda_foundations` covers Location, PractitionerSchedule, ScheduleException,
TimeBlock, PractitionerService/Payer/Specialty the same way): a generated `tenantId = app_current_tenant_id()` policy for the
direct-`tenantId` ones, `EXISTS`-subquery policies for the tables that reach
tenancy through a parent (`Coverage`/`EmergencyContact` → `Patient`,
`Payment` → `Booking`, `Session` → `TreatmentProgram`, `SessionExercise`,
`EvaScore`), a self-scoped read/update policy on `Tenant` (INSERT/DELETE of
tenants stay off-limits to the app role — they run on the service channel),
and **split policies** on the catalog tables `Condition` / `Exercise`:

```sql
FOR SELECT USING ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id())
FOR ALL    USING ("tenantId" = app_current_tenant_id())
           WITH CHECK ("tenantId" = app_current_tenant_id())
```

— i.e. everyone reads the global catalog, nobody but the owner tenant writes
its own rows, and **no tenant can ever mutate global catalog rows**.
`UserPreferences` and `Favorite` are intentionally left without RLS (they are
userId-scoped, not tenant-owned).

**Global read-only catalog (B-pre).** `Specialty`, `Practice`,
`PracticeSpecialty`, `Payer` and `CatalogImportRun` carry no `tenantId`; they
get `ENABLE` + `FORCE` and **only** `FOR SELECT USING (true)` — no write policy,
so the app role reads and can never insert/update/delete (a GRANT enables the
command, RLS filters the rows). `PayerPlan` is split like `Exercise` (global +
own read, own write: a tenant can propose a plan, never touch a global one).
The guard enforces the `GLOBAL_READONLY` set. Tenant actions that store
`Insurer.payerId`, `Service.practiceId` or `Coverage.payerPlanId` validate the
id (global or own, not archived, plan of that payer) because FKs skip RLS.

**Adoption is wholesale.** `lib/rls.ts#runWithRls(tenantId, fn)` sets the
transaction-local `app.current_tenant_id` GUC (transaction-local is mandatory —
prod pools through Supavisor in transaction mode), and `withTenantDb()` lets a
shared helper either join the caller's transaction or open its own. ~23
Actor-facing `lib/*` modules now read *and* write inside a wrap.
`scripts/guard-tenant-isolation.mjs` (parsing **every** migration since
B-pre) fails the build when a model gains `tenantId` without a matching policy
or a GLOBAL_READONLY table gains a write policy, and prints a soft report of
`prisma.<model>` calls made outside a wrap.

**Verified, not assumed.** Locally the app connects as `kinesoft_app`
(`NOSUPERUSER NOBYPASSRLS`, created by `prisma/roles.local.sql`) while
`DIRECT_URL` stays on the owner role for migrations and the service channel.
`tests/integration/rls-isolation.test.ts` (gated on `RLS_IT=1`, run via
`npm run test:integration`) is green: cross-tenant `INSERT` is rejected by
`WITH CHECK`, and a read that lost its wrap comes back empty — which is exactly
what makes a missed wrap fail loudly instead of leaking.

**Defense in depth stands.** The app-layer `tenantId` filter (`getActor()` +
a hand-written `where: { tenantId }` in every query) is applied everywhere.
(`getTenantPrisma()` is dead code — no call sites.) RLS is the net under it,
not a replacement for it. Note that **FK checks bypass RLS**: an input id from
another tenant is persisted unless the action validates it against the tenant
first. For bookings this is closed since A2a (§1.1); every new action must do
the same.

**Staff ≠ patient rule** (implemented in A3b, 30-sep-2026): an identity with a
`Membership` is never treated as a patient.

- The portal shows "no files" to a staff identity (`lib/portal.ts:61-63`).
- `/auth/callback` never links patient files to staff.
- `createInvitation` rejects the email of a Patient **with a linked portal** —
  **only within the inviting tenant**. Decision taken in A3b, a deliberate
  deviation from the plan's wording ("a Patient in any tenant"): looking at
  other tenants would turn the rejection into a cross-tenant oracle ("this
  email is a patient somewhere").
- `acceptInvite` rejects when `Patient.userId = user.id` or the email belongs to
  a Patient with a linked portal (service channel, any tenant: the invitee
  already proved the email, so it reveals nothing new).

H5 (auto-confirmed signup) is closed since A3c, so identities are verified; this
rule stays as the barrier between staff and patient identities. A portal
patient's email that tries to sign up as staff gets the same response as a
normal signup, with no mail and no tenant (anti-oracle, `lib/auth.ts:98-104`).


## 10. Platform superadmin (cross-tenant privilege tier)

Rondas 7-8 introduced a privilege **above** tenancy: the platform superadmin,
who authors the **global** exercise catalog (the `tenantId IS NULL` rows every
tenant reads) and its tags.

- **The flag.** `UserProfile.isPlatformAdmin` (boolean, default `false`),
  orthogonal to the tenant-scoped `Role` enum. Surfaced on the session as
  `Actor.isPlatformAdmin`.
- **The gate.** `requireSuperAdmin()` (`lib/session.ts`) throws
  `UnauthenticatedError` with no session and
  `ForbiddenError("platform_admin_required")` for a non-admin. It is the first
  line of every admin action in `lib/exercises-admin.ts`, `lib/tags-admin.ts`
  and `lib/exercise-media.ts`, and it guards the route group via
  `app/(app)/plataforma/layout.tsx` (non-admins are redirected to
  `/dashboard`). The sidebar entry only renders for admins — but the layout
  guard, not the hidden link, is the control.
- **Why enforcement is an app-layer chokepoint, not an RLS policy.** Global
  catalog writes go through `prismaService` (`lib/db.ts`), a second Prisma
  client on a **BYPASSRLS** connection. That is not a hole — it is the
  guarantee: under forced RLS the ordinary app role **physically cannot** write
  a `tenantId IS NULL` row (`exercise_write` demands
  `tenantId = app_current_tenant_id()`, and `NULL = <uuid>` is never true), so
  there is exactly one code path into the global catalog and
  `requireSuperAdmin()` sits at the top of it. An RLS policy could not express
  "is a platform admin" anyway — the GUC carries a tenant, not a role.
- **RLS posture of the new catalog tables.** `ExerciseMedia` and
  `ExerciseArticle` carry **no `tenantId`** (they inherit visibility from the
  parent `Exercise`, gated at the app layer in `getExercise`). Migration
  `20260803022653_exercise_media_and_article` gives them `ENABLE` + `FORCE ROW
  LEVEL SECURITY` with `FOR SELECT USING (true)` and **no write policy at
  all** — the app role reads them under `runWithRls` and can never insert,
  update or delete them; only the service channel writes. Verified: a global
  `INSERT` as `kinesoft_app` is denied.
- **Media uploads** (`lib/exercise-media.ts`) reuse the `lib/files.ts` posture:
  private Supabase bucket `exercise-media`, MIME allow-list (`video/mp4`,
  `video/webm`, `video/quicktime`, `image/png`, `image/jpeg`, `image/webp`,
  `image/gif`), 50 MB cap, extension sanitised against `/^[a-z0-9]{1,5}$/`,
  1-hour signed URLs on read. YouTube links are parsed to a video id and
  re-emitted as a privacy-enhanced `youtube-nocookie` embed — the raw
  user-supplied URL is never used as an embed src.
- **Global reference catalog (B-pre).** `plataforma/catalogo/*` over
  `lib/catalog-admin.ts`: same shape — `requireSuperAdmin()` first,
  `prismaService` after (the app role physically can't write the
  GLOBAL_READONLY tables, §9). Edit (marks `curatedAt`), archive, merge
  payers/practices (repoints tenant FKs), promote a tenant-proposed plan,
  import runs, "Refrescar catálogo". The CSV import (`scripts/catalog-import.ts`)
  is an owner-run script: `assertSafeTarget` (`KINESOFT_CONFIRM_PROD=<ref>` for
  a remote DB, also for the dry-run), aborts without BYPASSRLS, dry-run by
  default, one transaction.
- **Granting the flag** is deliberately out-of-band and DB-level:
  `scripts/set-platform-admin.ts` (`<email>` to grant, `--revoke`, `--list`),
  run by the owner against the owner/`DIRECT_URL` connection. There is **no
  in-app path** to promote a user, no invitation flow, and no self-service —
  which keeps the tier out of reach of any tenant-level compromise.

## 11. Session, cookies & redirects (A3b, 30-sep-2026)

- **Session refresh in the middleware.** `middleware.ts` builds a Supabase
  server client with `getAll`/`setAll` and calls `getSession()` (not
  `getUser()`: no authorisation decision is taken there, it only refreshes).
  Refreshed cookies are copied to the request and to the response, and the
  response gets `Cache-Control: private, no-store` when a `Set-Cookie` was
  written. `/_next` and `/api/webhooks` bypass it. The `x-tenant-*` strip and the
  `x-request-id` run on every path (§1, AUDIT §5.3).
- **Cookie flags.** Supabase cookies are `httpOnly`, `secure` in production and
  `sameSite=lax` (`lib/supabase/cookie-options.ts`); the `@supabase/ssr` default
  was `httpOnly: false`. `lax` is required: the OAuth callback and email links
  arrive as top-level cross-site navigations.
- **Open redirects closed.** Every `next=` goes through `safeNext` /
  `safeNextFromUrl` (`lib/safe-next.ts`): own paths only. `next=@evil.com` in
  the callback and sign-out was a real open redirect
  (`https://app@evil.com`).
- **Login/logout CSRF.** The three auth POSTs (sign-in, sign-out, google) check
  `Origin` / `Sec-Fetch-Site` with `isAllowedOrigin`.
- **Login errors** use a closed map of codes (`rate_limited`,
  `invalid_credentials`, `missing_credentials`, `email_not_confirmed`,
  `oauth_failed`, `missing_code`, `link_invalid`); any other `?error=` shows a
  generic message (no reflected text).
- **Google OAuth** no longer asks for `prompt=consent` / `access_type=offline`
  (KineSoft never needs a Google refresh token).
- **`/auth/confirm`** verifies `token_hash` with `verifyOtp` for signup, email,
  invite, recovery and magiclink. On `recovery` it sets `ks_recovery`: httpOnly,
  15 min, value `<userId>.<exp>.<hmac>` signed and checked with
  `timingSafeEqual` (`lib/recovery-cookie.ts`). The reset (A3c,
  `updatePasswordWithRecoverySession`) skips the current password only with a
  valid cookie of the same user, and deletes it after success (single use);
  without it the current password is required.

## 12. Observability & headers (A3b, 30-sep-2026)

- **Next 14.2.35** (from 14.2.18): CVE-2025-29927 (middleware bypass via
  `x-middleware-subrequest`, which would have skipped the header strip),
  plus 56332, 32421, 57822 (SSRF via `Location`), 55183/55184/67779 (RSC).
- **Sentry** (`@sentry/nextjs` 11.1.0) is a **total no-op without
  `SENTRY_DSN`**: `next.config.mjs` is not wrapped and `register()` returns
  early. With a DSN: `sendDefaultPii: false`, and `beforeSend`,
  `beforeSendTransaction` and `beforeBreadcrumb` pass through `redact()`.
  **No client SDK** (bundle budget): client-side errors are not captured until
  C1.
- **PII redaction** (`lib/redact.ts`, used by the logger and by Sentry): by key
  (password, secret, token, authorization, cookie, apikey, dni, documentId,
  cuit, cuil, phone, whatsapp) and by value (emails, JWTs, Bearer/Basic, MP
  tokens, `?token=` / `code=`, formatted DNI). Audit payloads carry field
  names, not values (e.g. `updatePatient`, `session.meta.update`).
- **CSP** is still **Report-Only**; reports go to Sentry (`report-uri` +
  `report-to`, derived from the DSN). Allow-listed: Google Fonts,
  youtube-nocookie, and `form-action` to Supabase + accounts.google.com (the
  portal/wizard POST redirects there). Enforce = C1, after two weeks without
  own violations.
- **HSTS** (`max-age=63072000; includeSubDomains; preload`) only when
  `VERCEL_ENV=production`; server-action `allowedOrigins` drop `localhost` in
  Production. Both are computed at build time, so Vercel must expose System
  Environment Variables to the build.

## 13. Capabilities and the agenda surfaces (B-pre 01-oct, Planes ES1 04-oct-2026)

**Matrix** (`lib/capabilities.ts`, pure; `lib/authz.ts` resolves the role from
the Membership — `Actor` still doesn't carry it):

| Capability | OWNER/ADMIN | PRACTITIONER | ASSISTANT | BILLING |
| --- | --- | --- | --- | --- |
| `agenda.viewAll` | ✅ | ✅ | ✅ | ✅ |
| `agenda.reception` | ✅ | ✅ | ✅ | — |
| `agenda.manageBlocks` (anyone, incl. "everyone") | ✅ | — | ✅ | — |
| `agenda.manageOwnBlocks` | ✅ | ✅ | ✅ | — |
| `clinical.read` | ✅ | ✅ | — | — |
| `schedule.configure` | ✅ | — | — | — |
| `billing.manage` | ✅ | — | — | ✅ |
| `tenant.admin` | ✅ | — | — | — |

- **Fails closed**: unknown role or no membership → empty set. The UI only
  hides; every action calls `requireCapability(...)` / `requireTenantAdmin(...)`
  (`ForbiddenError`). The six copied `role === OWNER|ADMIN` checks are gone.
- **`clinical.read`** gates `title`/`description`/notes in
  `listAgendaBookings` (null + `clinicalHidden`) on top of the per-patient
  basic gate (§1.1): ASSISTANT and BILLING operate the agenda without clinical
  content.
- **`billing.manage`** is not yet required by any charge action; before
  enforcing it the owner decides whether the practitioner charges (ROADMAP).
- Known gap (C0): `buildActor` requires a `Practitioner` row
  (`lib/session.ts:91-97`), so a Secretaria (ASSISTANT) can't log in without one.
**Planes ES1 (04-oct-2026, in code; not deployed until block B closes).** Detail in
[PLANES.md](PLANES.md) §2.6/§8 and AUDIT §Ronda 14.

| Capability | OWNER/ADMIN | PRACTITIONER | ASSISTANT | BILLING |
| --- | --- | --- | --- | --- |
| `agenda.operateAll` | ✅ | — | ✅ | — |
| `plans.manage` | ✅ | ✅ (with full, checked in the action) | — | — |
| `plans.schedule` / `plans.authorize` | ✅ | ✅ (with full) | ✅ | — |

Applied since ES2b by `assertPlan*InTx` (§15).

- **Patient access level `admin`** (`lib/visibility.ts`, PD-13): a role without
  `clinical.read` (ASSISTANT, BILLING) always gets exactly `admin` on every
  patient of the tenant — never `full` (not even with `sharedPatientView`, a
  share or an assignment), never less. `admin` sees name, DNI, contact,
  insurance/coverage, emergency contact, bookings and payment status; never
  diagnosis, notes, EVA, plan titles, files, clinical activity or Seguimiento.
  `seesAll` is false for these roles (own-scope dashboard). **Rule:** every
  check that opens clinical data or clinical writes is `=== "full"` (or
  `canWriteClinical`), never `!== "basic"`.
- **Pure predicates** (`lib/capabilities.ts`): `canOperateBooking = full ||
  agenda.operateAll` (create, batch, update, status, cancel) and
  `canWriteClinical = clinical.read && full`. `bookingFieldAccess`
  (`lib/booking-field-access.ts`): a booking field is written iff it can be
  read; disallowed fields are dropped from the patch **before** the write and
  the audit. Guest bookings: operable with `agenda.operateAll || clinical.read`
  (BILLING can't). Deleting bookings and charge toggles still require full.
- **Secretaria creating patients:** `createPatient(raw, {assignTo})` assigns
  the patient to the booking's practitioner (same tenant, accepted clinical
  membership, validated in the tx); BILLING can't create; clinical fields are
  ignored. Shares and `assignPatientToPractitioner` require a clinical role.
- **Storage only via service role** (`lib/storage-internal.ts`, `server-only`,
  every `{ error }` checked): `lib/files.ts` keeps its gates; exercise media is
  signed by `signExerciseMedia(mediaId)` from the DB row
  (`lib/exercise-media-internal.ts`) — nothing signs a client-supplied key.
  Buckets private, no `storage.objects` policies for anon/authenticated (prod:
  precheck 17, MIGRACIONES-RUNBOOK §2.3). Needs `SUPABASE_SERVICE_ROLE_KEY`.
- **No PHI to the portal or the ICS:** `getPortalPlan` drops `Session.notes`;
  the ICS export decides detail with `bookingFieldAccess` (full **and**
  `clinical.read`); `listBookingsInRange` too, and `patientCondition` only with
  `clinical.read` + full.
- **RPC surface:** `getPatient` (ungated, full clinical history) and
  `saveDiagnosisDraft` were deleted; the P0.Z reviewer swept every export of
  `patients`, `bookings`, `sessions`, `diagnosis`, `portal` and
  `exercise-media` that reads Patient/Booking/Session: each one is gated.
- Known gaps → C0: the `admin` profile is read-only (the Secretaria can't edit
  contact/coverage yet) and the directory still uses the basic projection for
  `admin`. (The ⌘K condition search is tenant-filtered since EV0.)

**Availability reads** (`lib/availability-actions.ts`): `agenda.viewAll`, zod,
every input id (practitioner, service, location, patient, insurer) validated
against the tenant **with an explicit error** (an IDOR doesn't look like "no
availability"), loader with `where: { tenantId }` by hand. Responses carry **no
PHI** (BILLING sees them). No cache.

**Reception** (`markReceptionAction`): administrative action with
`agenda.reception` + optimistic lock (`expectedUpdatedAt`) + audit
`booking.reception.<action>`. Access rule: a role with `agenda.manageBlocks`
(admin, Secretaria) operates any booking; a PRACTITIONER only own bookings or
bookings of patients he has **full** access to (guests ok). Undo returns a guest
or an unpaid public reservation to PENDING, not CONFIRMED, so reception can't
confirm an unpaid public slot by accident.(Access rule `lib/bookings.ts:~1748-1750`;
undo `lib/reception-state.ts:40-49` — both from the B-pre review fixer.)

**Day lock / blocks** (`lib/time-blocks.ts`): own agenda with
`agenda.manageOwnBlocks`; another practitioner or "everyone" (a row with
`practitionerId` null) needs `agenda.manageBlocks`. Cancelling affected
bookings goes through `cancelBookingsInTx`, which **skips** bookings with a
recorded payment (H1); the apply aborts with `changed` if the affected set
moved since the preview.

**Schedule / locations / PS / PP writes**: `schedule.configure`, ids validated
against the tenant, location writes behind the locations advisory lock (shared
to use a location, exclusive to archive or change the primary).

## 14. Verticales, módulos y /plataforma de consultorios (EV0, 07-oct-2026)

Diseño en [ARCHITECTURE.md ADR-005](ARCHITECTURE.md); contratos en [VERTICALES.md §3](VERTICALES.md).

- **Módulos = barrera en la action, no en el nav.** `requireModule` / `assertModule` (`lib/authz.ts`) en cada export
  de un área con módulo: escrituras y lecturas de detalle tiran `ForbiddenError` (`MODULE_DENIED_COPY`), lecturas
  compartidas devuelven `[]`. El `layout.tsx` de segmento (`guardModuleSegment`) y el nav son UX. Por eso la
  revisión cerró `lib/programs.ts` (N1) y `createExercise`/`ensureTag` (N2): un consultorio General los podía invocar
  por RPC aunque no viera el botón.
- **Escritor único de entitlements** (`lib/tenant-entitlements-internal.ts`, server-only): después de
  `bootstrapTenant`, nadie más escribe `vertical`, `plan`, `subscriptionStatus`, `trialEndsAt` ni
  `publicBookingEnabled`. Allowlist por `source` (tira ante una key fuera de la lista):
  - `platform`: todo; exige actor superadmin, cruza tenants por `prismaService`;
  - `tenant-settings`: solo `publicBookingEnabled`; exige `homeTenantId === tenantId`, tx con `runWithRls`;
  - `onboarding`: solo `vertical`, mientras el onboarding siga abierto;
  - `billing`: `plan/subscriptionStatus/trialEndsAt`, para el webhook futuro, que **deriva el `tenantId` del pago
    verificado** contra MP, nunca del body.
  FOR UPDATE + CAS (`expectedUpdatedAt`) y revalidación de `tenantEntitlementTags` solo si hubo cambio. Gate: grep 1
  (excepción: los seeds, que no corren en prod).
- **Audit de plataforma en el tenant afectado.** `auditPlatformInTx` escribe el `AuditEvent` en el consultorio que se
  editó (`action: "platform.*"`, `payload.platform.actorHomeTenantId`), no en el del superadmin: el dueño del tenant ve
  quién le cambió el plan, y el tenant del superadmin no acumula eventos ajenos.
- **Lecturas de /plataforma** (`lib/platform-tenants-read.ts`): `import "server-only"` (no son server actions: no se
  pueden invocar por POST), `requireSuperAdmin()` en **cada** export (grep 2) y **sin PHI**: sobre Patient, Booking,
  Session, etc. solo `count`/`_count` (grep 3); los DTOs de `-types.ts` son el allowlist y el test de integración los
  fija. El superadmin no es equipo clínico de nadie.
- **Data API de Supabase.** M2 revoca a `anon` y `authenticated` todo en `public` (tablas, secuencias, rutinas y
  `DEFAULT PRIVILEGES`), guardado por existencia de los roles. Guard 3c de `npm run guard:isolation`: falla ante un
  `GRANT … TO anon|authenticated` en migraciones o `prisma/roles.*.sql`, o si el bloque REVOKE desaparece. La app
  nunca usa PostgREST. **Pendiente de Martin:** desactivar la Data API en la consola (VERTICALES §1). SV01 tiene que
  respetar el guard (la función de la policy de realtime sin GRANT a `authenticated`).
- **Turnos online apagados** (`publicBookingEnabled = false`, default de un consultorio nuevo): la página muestra
  "Turnos online no disponibles" (`noindex`) **sin leer la sesión ni el prefill**; slots `[]` y el submit se rechaza
  **sin escribir**. El estado de un turno ya reservado sigue consultable. Portal y turnero leen los módulos con
  `getTenantModulesById` (sin Actor; tenant inexistente = set vacío, falla cerrado).

## 15. Planes (ES2b, 07-oct-2026; en código, sin deploy hasta cerrar B)

Contratos en [PLANES.md §2.6 y §4](PLANES.md); orden de locks en [ARCHITECTURE.md ADR-004](ARCHITECTURE.md). En prod la
conexión tiene BYPASSRLS: el `where: { tenantId }` a mano y las FKs compuestas son la barrera, RLS es la segunda capa.

- **FKs compuestas como red bajo BYPASSRLS** (M1, ADR-001): `Booking_plan_tenant_fkey` (`programId, tenantId`),
  `Booking_plan_patient_fkey` (`programId, patientId`) y `Booking_session_program_fkey` (`sessionId, programId`). Aunque
  una action tuviera un bug, la base no deja vincular un turno a un plan de otro consultorio, de otro paciente ni a una
  sesión de otro plan. Lo que **no** es compuesto (`TreatmentProgram.locationId`/`practitionerId`/`serviceId`, FKs
  simples) se valida a mano contra el tenant en `validatePlanRefsInTx` / `validateBookingRefsInTx` antes de escribir.
  Los tests de esa red corren con el rol owner (`skipIf(!BYPASS)` con aviso; TESTING.md).
- **Capabilities de Planes** (matriz en §13) se aplican **solo** con `assertPlanManageInTx` /
  `assertPlanScheduleInTx` / `assertPlanAuthorizeInTx` (`lib/plan-authz-internal.ts`), dentro de la tx. Orden:
  `assertModule('planes')` → capability → `patientAccessFor` → regla:
  - **`plans.manage`** = capability + acceso `full` + `clinical.read`: crear, título/notas, precio, cantidad, estados,
    archivar, re-planificar, vincular, adoptar, sacar del plan, agregar sesión a medida. La Secretaria y BILLING no.
  - **`plans.schedule`** = capability + (`full` **o** `agenda.operateAll`): generar turnos de sesiones pendientes y
    mover "este y los siguientes". La Secretaria sí.
  - **`plans.authorize`** = capability + (`full` o `agenda.operateAll`): renovar la autorización de la OS.
  - Paciente de otro tenant → `none` → Forbidden. Las primitivas del motor (`*InTx`) **no gatean**: gatea el export.
    Quedan tres gates reimplementados en legacy (`rescheduleSession`, `createProgram`, `applyPlanTemplate`) que retira
    S27a (AUDIT `gates-reimplementados-legacy`).
- **PHI del título.** El título de un plan o de una sesión es dato clínico. `planTitleFor(caps, access, title)`
  devuelve el real solo con `clinical.read` **y** acceso `full`; si no, `null`. Lo usan lecturas, dashboard y preview
  del motor. La agenda (C9) lleva disciplina, ordinal y total (`Kine · 3/10`), **nunca** el título para la
  Secretaria/BILLING/básico. `listSchedulablePlanSessions` devuelve una **allowlist** literal `{sessionId, ordinal,
  totalLive, discipline, serviceId, practitionerId, locationId, sinTurno}`: sin título, notas, ejercicios, precios ni
  `programId`.
- **Autorización de la OS** (código, autorizadas, vencimiento): la ve solo quien cumple
  `canSeePlanAuthorization(caps, access)` = `(full && clinical.read) || (plans.authorize con su regla de acceso) ||
  billing.manage`; nunca con `none`. Sale solo en el detalle del plan (`getPlanDetail`, `getPatientPlans`); **nunca** en
  la agenda (C9), el ICS, el CSV, las notificaciones ni el portal. Un PRACTITIONER en básico no la ve aunque tenga la
  capability.
- **Buscador de pacientes de la agenda** (`searchPatientsForBooking`, `lib/patient-search.ts`, P2-FX1): sin gate de
  módulo (la agenda existe en todas las verticales) y sin filtro por nivel, porque nombre + DNI es lo que ya muestran
  las proyecciones `basic` y `admin`. DTO mínimo `{id, firstName, lastName, documentId}`; **no** busca por email (sería
  un oráculo de un dato que `basic` no ve, como H-b1); archivados fuera; `where: { tenantId }` a mano. Operar el turno
  lo sigue decidiendo el server de turnos. El picker del Plan Builder usa otra búsqueda (`searchPatientsForAssignment`,
  módulo `diagnostico`, solo pacientes con acceso `full`, sin archivados).
- **Tags globales filtrados por uso** (`listAllTags`, B-L1): `Tag` no tiene `tenantId` y un consultorio puede crear
  tags de texto libre; devolverlos todos filtraba el texto de otros consultorios. Ahora solo los usados por ejercicios
  o condiciones globales o propias, `[]` sin el módulo `ejercicios`; el superadmin ve todos. `ensureTag` solo crea
  kinds de la allowlist y reserva los slugs de disciplina.
- **Sincronía turno↔sesión sin gate de módulo** (decisión de S12): es consistencia de datos, no una feature; si un
  consultorio baja de vertical, cancelar un turno de plan sigue dejando la sesión coherente.
