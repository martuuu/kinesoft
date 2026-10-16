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
  Requires "Confirm email" ON in Supabase (EXTERNAL-CONFIG §0.1). **Since IAM
  (14-oct)** `auth.signUp` is gone too: `admin.generateLink(signup)` + the app's
  own mail (§18).
- **IAM (14-oct-2026)** — exact email match (ILIKE finding), app-sent mails with
  scanner-proof `/auth/confirm`, own invitation tokens, multi-tenant users,
  membership suspension, actor without practitioner (§18).

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
- The `kine_tenant` cookie (value = tenantId) chooses *which* tenant to act
  as. It is only honoured when it points to a *usable* `Membership` (accepted,
  not suspended), and it is cleared on every login (§18).
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

**Desde ES4 (15/16-oct-2026) el portal autoriza por el VÍNCULO, nunca por email.** `lib/portal-identity-internal.ts`
(`getPortalUser`, `requirePortalPatient(slug)`, `listPortalPatients(userId)`) resuelve por `(tenantId, userId)` con
`archivedAt: null`, por el canal service (cada query lleva `tenantId` y `userId` explícitos). Una ficha que solo comparte
el email con la cuenta no muestra nada. Siguen valiendo: email verificado (`email_confirmed_at`) para cualquier acción y
staff (con `Membership`) ≠ paciente.

- **Vínculo** (`lib/portal-link-internal.ts`, AUDIT §5.8): auto-vínculo al entrar solo si hay **exactamente una** ficha
  no archivada con el email exacto en ese consultorio y está libre; 0 → nada, >1 → `ambiguous` (decide la invitación).
  La única escritura es el CAS `linkPatientCas` (count 1; P2002 → `conflict`, nunca 500). «Buscar mis fichas» corre la
  misma regla (5/h por cuenta). Archivar una ficha desvincula la cuenta (audit `patient.portal.unlink` en la tx).
- **Invitación** (`lib/portal-invite-token.ts`, `/portal/vincular?t=`): token HMAC de 7 días con `patientId`,
  `tenantId` y el **hash** del email (no el email). El GET nunca escribe (anti-escáner); vincula el POST, con la sesión
  del mismo email y rate-limit 10/h. El token viaja en la URL (riesgo aceptado, AUDIT B6): `referrer: same-origin`,
  nunca en logs ni en el audit.
- **«Mis datos»** nunca escribe la ficha: crea o actualiza un `PatientChangeRequest` PENDING (allowlist estricta, ≤ 4 KB,
  3/h); lo aprueba el consultorio en una tx con CAS y audit sin valores. Un cambio de OS que borra copago propio o cambia
  el copago de turnos impagos pide confirmación.
- **Estado de cuenta y ejercicios:** DTO por allowlist (sin montos de la OS, aranceles ni notas); el plan es el mismo
  `PORTAL_PROGRAM_WHERE` en todas las vistas. Evoluciones nunca (guard `clinical-notes-guard`).
- **Logs del portal:** slug, motivo y nombres de campo; **nunca** email, token, valores del pedido ni `e.message` de un
  error que pueda traerlos (ES4-Z B5).

`submitCheckIn` (`lib/portal.ts:196`):

- Rate-limited per IP (4/min).
- Refuses a second check-in for the same session id.
- **Never writes `Patient.notes`** (since A3b, 30-sep-2026). It creates the
  `EvaScore`, notifies the assigned practitioner (or OWNER/ADMIN) and writes an
  `AuditEvent` `portal.checkin` with the text (capped at 500 chars). Before, the
  text was prepended to `Patient.notes` and the field truncated to 4 kB, which
  cut off the practitioner's older notes.
- ~~Known gap: `getPortalPlan` returns `Session.notes`~~ — cerrado en P0-S02p (el select no las pide).

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
closes the account-takeover vector via mistyped Patient emails (since IAM the
email match is exact, `lib/portal-link-internal.ts`; the link also happens on
magic-link sign-in via `linkPortalPatientsOnSignIn`, driven by `next`). Since A3b
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
| `/api/consultorio/export` (BO5-C) | 3 / h / **tenant** (two owners don't add up) |
| `/api/health` (BO1-D) | 60 / min / IP → 429 |
| `/api/client-errors` (BO1-D) | 20 / min / IP → 429 |
| Plataforma actions (BO) | per superadmin and action key, `PLATFORM_ACTION_POLICY` (`lib/platform-actor.ts:54`), checked before MFA |

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
- **The gate.** `requirePlatformAdmin()` (`lib/platform-actor.ts`, BO1-A; the
  old `requireSuperAdmin()` is a deprecated alias with no callers) throws
  `UnauthenticatedError` with no session and
  `ForbiddenError("platform_admin_required")` for a non-admin or a disabled
  user. It is the first line of every admin action in `lib/exercises-admin.ts`,
  `lib/tags-admin.ts`, `lib/exercise-media.ts`, `lib/catalog-admin.ts` and every
  `lib/platform-*` (static guard, §19), and it guards the route group via
  `app/(platform)/layout.tsx` (BO3-A: `requirePlatformAdmin`, non-admins get
  `notFound()` so the section is not revealed; no session → `/login`). The sidebar entry only renders for admins — but the layout
  guard, not the hidden link, is the control.
- **Why enforcement is an app-layer chokepoint, not an RLS policy.** Global
  catalog writes go through `prismaService` (`lib/db.ts`), a second Prisma
  client on a **BYPASSRLS** connection. That is not a hole — it is the
  guarantee: under forced RLS the ordinary app role **physically cannot** write
  a `tenantId IS NULL` row (`exercise_write` demands
  `tenantId = app_current_tenant_id()`, and `NULL = <uuid>` is never true), so
  there is exactly one code path into the global catalog and
  `requirePlatformAdmin()` sits at the top of it. An RLS policy could not express
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
  `lib/catalog-admin.ts`: same shape — `requirePlatformAdmin()` first,
  `prismaService` after (the app role physically can't write the
  GLOBAL_READONLY tables, §9). Edit (marks `curatedAt`), archive, merge
  payers/practices (repoints tenant FKs), promote a tenant-proposed plan,
  import runs, "Refrescar catálogo". The CSV import (`scripts/catalog-import.ts`)
  is an owner-run script: `assertSafeTarget` (`KINESOFT_CONFIRM_PROD=<ref>` for
  a remote DB, also for the dry-run), aborts without BYPASSRLS, dry-run by
  default, one transaction.
- **Granting the flag**: the first superadmin is bootstrapped out-of-band with
  `scripts/set-platform-admin.ts` (`<email>` to grant, `--revoke`, `--list`),
  run by the owner against the owner/`DIRECT_URL` connection. Since BO2-C an
  existing superadmin can grant/revoke it from `/plataforma/usuarios`
  (`setPlatformSuperadmin`, risk `high`: MFA re-verification with `enforce`,
  5 / 10 min, platform audit log; the last active superadmin can't be removed).
  No tenant-level role can reach it and there is no self-service.

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

### 11.1 Verificación local del access token (PF-0b, 15-oct-2026)

- **Qué cambió.** El actor (`getAccessSnapshot` → `getActor`: toda página, action y /plataforma) ya no llama a
  `auth.getUser()` (HTTP a GoTrue) en cada request. `getSessionUser()` (`lib/session-user.ts`) toma el access token de
  la cookie (`getSession()`, sin red salvo refresh) y lo verifica **local** (`lib/session-jwt.ts`): HS256 con
  `SUPABASE_JWT_SECRET` (`node:crypto`, comparación en tiempo constante) o, con las signing keys asimétricas,
  `getClaims()` de supabase-js (JWKS cacheado 10 min por proceso). Se exige `exp` (±30 s), `iss` =
  `<NEXT_PUBLIC_SUPABASE_URL>/auth/v1`, `aud`/`role` = `authenticated`, `session_id` y un `sub` que no sea el del
  token de realtime (`rt:…`). Memo por request de Next y por token (también dentro de una server action).
- **Fallar cerrado / degradar.** Malformado, vencido o sin `sub` → sin sesión, sin red. Lo que no se puede PROBAR
  localmente (firma con otra clave, `iss` distinto, otro `alg`, sin secreto, claims raros, la API de supabase-js
  cambió) **cae a `getUser()`**: un token falso lo rechaza GoTrue; un error de configuración (secreto rotado, dominio
  propio) deja la app como antes de PF-0b en vez de desloguear a todos. Nunca se acepta un token por descarte. Se
  loguea `session.jwt_local_fallback {reason}` una vez por proceso y motivo (nunca el token): **si aparece en Vercel,
  el camino rápido no está andando** (revisar `SUPABASE_JWT_SECRET` y la URL).
- **Lo que se acepta perder: revocación inmediata.** Un access token vale hasta su `exp` (≤ 1 h en Supabase) aunque
  la sesión se cierre en GoTrue o se borre el usuario. Lo cubren: `UserProfile.disabledAt` (se lee en cada request
  en la misma sentencia de las membresías: deshabilitar corta al instante), las membresías y el estado del
  consultorio (también por request), y `getStrictSessionUser()` (GoTrue) en los puntos sensibles: invitación, alta,
  portal y turnero (piden `email_confirmed_at`, que el JWT no trae), reset/cambio de contraseña, elección de
  consultorio y fin de soporte. **Plataforma** y el 2FA de PL deben sumarlo (handoff de PF-0b a
  `lib/platform-actor.ts`).
- **El secreto.** `SUPABASE_JWT_SECRET` ya existía (realtime). Con él se puede FIRMAR una sesión de cualquier usuario:
  es tan sensible como la service key (server-only, guard (d) de `guard-realtime.mjs`, nunca en logs).

## 12. Observability & headers (A3b, 30-sep-2026)

- **Next 14.2.35** (from 14.2.18): CVE-2025-29927 (middleware bypass via
  `x-middleware-subrequest`, which would have skipped the header strip),
  plus 56332, 32421, 57822 (SSRF via `Location`), 55183/55184/67779 (RSC).
- **Sentry** (`@sentry/nextjs` 11.1.0) is a **total no-op without
  `SENTRY_DSN`**: `next.config.mjs` is not wrapped and `register()` returns
  early. With a DSN: `sendDefaultPii: false`, and `beforeSend`,
  `beforeSendTransaction` and `beforeBreadcrumb` pass through `redact()`.
  **No client SDK** (bundle budget). Since BO1-D the error boundaries send a
  beacon to `/api/client-errors` (own origin, 20/min/IP, redacted before
  `captureException`), so client-side render errors do reach Sentry (§19).
- **PII redaction** (`lib/redact.ts`, used by the logger and by Sentry): by key
  (password, secret, token, authorization, cookie, apikey, dni, documentId,
  cuit, cuil, phone, whatsapp) and by value (emails, JWTs, Bearer/Basic, MP
  tokens, `?token=` / `code=`, formatted DNI). Audit payloads carry field
  names, not values (e.g. `updatePatient`, `session.meta.update`).
- **CSP** is still **Report-Only** outside Plataforma (enforced on
  `/plataforma/**` and `/plataforma-mfa/**` since BO4, §19); reports go to Sentry (`report-uri` +
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
  Since SR it **does** decide who sees the whole clinic's revenue (§16).
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
  - `platform`: todo (desde BO también `status`, `statusReason` (se audita solo la clave) y `seatLimitOverride`, con `statusChangedAt`/`subscriptionStatusChangedAt`
    derivadas); exige actor superadmin, cruza tenants por `prismaService`;
  - `tenant-settings`: solo `publicBookingEnabled`; exige `homeTenantId === tenantId`, tx con `runWithRls`;
  - `onboarding`: solo `vertical`, mientras el onboarding siga abierto;
  - `billing`: `plan/subscriptionStatus/trialEndsAt`, para el webhook futuro, que **deriva el `tenantId` del pago
    verificado** contra MP, nunca del body.
  FOR UPDATE + CAS (`expectedUpdatedAt`) y revalidación de `tenantEntitlementTags` solo si hubo cambio. Gate: grep 1
  (excepción: los seeds, que no corren en prod).
- **Audit de plataforma en el tenant afectado.** `auditPlatformInTx` escribe el `AuditEvent` en el consultorio que se
  editó (`action: "platform.*"`, `payload.platform.actorHomeTenantId`) **y**, desde BO, la fila global de
  `PlatformAuditEvent` (§19), no en el del superadmin: el dueño del tenant ve
  quién le cambió el plan, y el tenant del superadmin no acumula eventos ajenos.
- **Lecturas de /plataforma** (`lib/platform-tenants-read.ts`): `import "server-only"` (no son server actions: no se
  pueden invocar por POST), `requirePlatformAdmin()` en **cada** export (desde BO lo fija el guard
  `tests/unit/platform-admin-guard.test.ts` para todo `lib/platform-*`) y **sin PHI**: sobre Patient, Booking,
  Session, etc. solo `count`/`_count` (grep 3); los DTOs de `-types.ts` son el allowlist y el test de integración los
  fija. El superadmin no es equipo clínico de nadie.
- **Data API de Supabase.** M2 revoca a `anon` y `authenticated` todo en `public` (tablas, secuencias, rutinas y
  `DEFAULT PRIVILEGES`), guardado por existencia de los roles. Guard 3c de `npm run guard:isolation`: falla ante un
  `GRANT … TO anon|authenticated` en migraciones o `prisma/roles.*.sql`, o si el bloque REVOKE desaparece. La app
  nunca usa PostgREST. **Pendiente de Martin:** desactivar la Data API en la consola (VERTICALES §1). M5 (SV) lo respeta:
  la función de la policy de realtime tiene EXECUTE a `PUBLIC`, sin GRANT a `anon`/`authenticated` (§17).
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
    Desde ES3 no quedan gates reimplementados: `createProgram` y `applyPlanTemplate` se retiraron y `rescheduleSession`
    usa `assertPlanScheduleInTx` + full (`lib/sessions.ts:649`; AUDIT `gates-reimplementados-legacy`). Un `templateId`
    exige además el módulo `plantillas` (`lib/plans-engine-internal.ts:199`): la barrera se había perdido en el retiro.
- **PHI del título.** El título de un plan o de una sesión es dato clínico. `planTitleFor(caps, access, title)`
  devuelve el real solo con `clinical.read` **y** acceso `full`; si no, `null`. Lo usan lecturas, dashboard y preview
  del motor. La agenda (C9) lleva disciplina, ordinal y total (`Kine · 3/10`), **nunca** el título para la
  Secretaria/BILLING/básico. `listSchedulablePlanSessions` devuelve una **allowlist** literal `{sessionId, ordinal,
  totalLive, discipline, serviceId, practitionerId, locationId, sinTurno, programId}`: sin título, notas, ejercicios ni
  precios. `programId` entró en ES3 (un id, no PHI): sin él la UI elegía mal el plan con 2 planes de la misma disciplina
  (`lib/plans-read-types.ts:220-233`).
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

## 16. Salas e ingresos por rol (SR, 08-oct-2026; en código, sin deploy hasta cerrar B)

Diseño en [ARCHITECTURE.md §Salas (SR)](ARCHITECTURE.md); orden de locks en ADR-004 (C2 (1b)).

- **Quién lee las salas:** cualquier miembro del consultorio, **solo las activas** de sedes activas
  (`listRoomOptions`, `lib/rooms.ts:156`, bootstrap de la agenda; `listRooms` sin `includeArchived`, `:111`). Son
  nombres de lugares, no PHI. Con `includeArchived` (Configuración) pide `schedule.configure`.
- **Quién las escribe:** `createRoom`/`updateRoom`/`archiveRoom`/`restoreRoom` piden `schedule.configure`
  (OWNER/ADMIN), toman las sedes en exclusivo y auditan con `auditInTx`. La sede se valida `{id, tenantId, active}`.
- **Sala en turnos, franjas, excepciones y bloqueos:** se valida contra el tenant y la sede (`lockActiveRoomInTx`,
  `lib/booking-rooms-internal.ts:63`) y además lo garantizan las FKs compuestas `(roomId, tenantId)` y
  `(roomId, locationId)` de M4: bajo BYPASSRLS (prod) una sala de otro consultorio o de otra sede no entra aunque la
  action tuviera un bug. `Room` tiene RLS ENABLE + FORCE + policy (test en `rls-isolation`, 2 roles). Cambiar la sala de
  un turno sigue `canOperateBooking` (la Secretaria sí, con `agenda.operateAll`).
- **Bloqueo de sala:** `agenda.manageBlocks` (OWNER/ADMIN/Secretaria; `lib/time-blocks.ts:209`), la misma regla que el
  candado de "todos". El PRACTITIONER no ve el alcance "Una sala" y un bloqueo de sala le sale deshabilitado ("Es un
  bloqueo de sala."). `deleteTimeBlock` exige `manageBlocks`.
- **Ingresos del dashboard por rol (SR-D5I, decisión de Martin del 08-oct).** `revenueScopeFor(caps, practitionerId)`
  (`lib/dashboard-revenue.ts:152`) sale de las **capabilities**, no de `seesAll`:

  | Rol | Capability que decide | Scope | Qué ve |
  |---|---|---|---|
  | OWNER / ADMIN / BILLING | `billing.manage` | `tenant` | "Ingresos del mes/semana" de todo el consultorio |
  | PRACTITIONER | `clinical.read` | `own` | "Tus ingresos del mes/semana": turnos donde es el profesional **actual** |
  | ASSISTANT (Secretaria) | ninguna | `none` | nada: widget y KPI ocultos, el picker de KPI no ofrece ingresos, `getRevenue` → error **sin consultar** Payment |

  - La clave de `unstable_cache` lleva el scope explícito (`revenueScopeKey`, `lib/dashboard.ts:679`): sin él, dos
    profesionales del mismo consultorio compartían la entrada durante el TTL. `monthRevenue` salió del cache de counts
    (que se comparte por visibilidad de pacientes). Test de fuga con cache real (`useRealUnstableCache()`, afirma los
    `keyParts`; TESTING.md).
  - Atribución al profesional **actual** del turno: si un turno cobrado se reasigna, la plata se muda con él (no hay
    "cobrado por" congelado). El filtro del OWNER por profesional → C0.
  - Si la Secretaria guarda el picker de KPI, pierde una `monthRevenue` fijada (nunca la vio). `/reportes` es un
    placeholder sin datos; los "próximos turnos" muestran el copago por turno (operativo, no se tocó).
- **Facturación (SR-D4F):** los cancelados/ausentes con cobro se ven siempre y suman en "percibido"
  (`isBillingVisible`, `components/planes/plan-booking-groups.ts:242`). No cambia quién ve la pestaña.

## 17. Realtime (SV, 13/14-oct-2026; en código, sin deploy hasta cerrar B)

Diseño en [ARCHITECTURE.md ADR-006](ARCHITECTURE.md); consola y verificación en [EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md).
Con `REALTIME_DRIVER=off` (default) nada de esto corre: ni publish, ni token, ni socket.

- **El payload no lleva PHI ni se confía.** `RealtimeAgendaMessageSchema` (`lib/realtime-events.ts:33`, zod
  `.strict()`) = `{v, kind, bookingId?, practitionerId, day, roomId?, prev?, at}`: ids y un día AR. El cliente lo usa
  como «tocá acá» y **re-pide con sus propias actions** (que aplican su gate y su proyección); los avisos salen del diff
  del refetch, nunca del mensaje. Un mensaje inválido se descarta sin tirar (`parseIncoming`).
- **Token del canal** (`lib/realtime-token-internal.ts`, `server-only`; action `mintRealtimeToken`, `lib/realtime-token.ts`):
  - JWT HS256 con `node:crypto`, header `kid` opcional (`SUPABASE_JWT_KID`, SV-D15). Claims literales (SV-D6)
    `{iss:"kinesoft-realtime", aud:"authenticated", role:"authenticated", sub:"rt:<uuid>", tenant_id, purpose:
    "kinesoft-realtime", iat, exp: iat+600}`. El `tenant_id` sale del actor de la sesión, nunca del cliente.
  - Gate: `getActor()` → módulo `salaEspera` → `realtimeAllowed` = **`agenda.reception`** (no `agenda.viewAll`:
    BILLING lo tiene y quedaría adentro; `lib/realtime-bootstrap.ts:24`) → driver `supabase` → secreto presente →
    `rateLimit("rt:token:<userId>", 30 cada 10 min)`. Nunca tira (`{ok:false}` → el cliente cae a polling). El token
    y el secreto no se loguean.
  - **Por qué no sirve para otra cosa si se filtra** (10 min): `sub` no es UUID (GoTrue lo rechaza y `auth.uid()` no
    matchea), la Data API está apagada y `anon`/`authenticated` sin grants en `public` (M2 + R3), Storage sin policies
    para `authenticated`. V4 de `scripts/realtime-verify.ts` lo comprueba en staging.
  - No se expone el access token de Supabase de la sesión: vive en una cookie httpOnly (§11) y sacarlo al browser
    rompía esa barrera.
- **Policy y función (M5).** `public.kinesoft_realtime_can_read(topic, claims)`: `LANGUAGE sql IMMUTABLE STRICT`,
  INVOKER, `search_path=''`; exige `purpose`, `role`, `tenant_id` con patrón de id y `topic = 'tenant:'||tenant_id||':agenda'`
  (un `tenant_id` con `:` no escapa al topic de otro: hay test). EXECUTE a `PUBLIC` (la policy corre como el rol del
  token), sin GRANT a los roles de la Data API. Policy `kinesoft_agenda_read` **FOR SELECT TO authenticated** sobre
  `realtime.messages`, solo `extension = 'broadcast'`; **sin policy INSERT**: ningún cliente publica (V3). Tabla de
  verdad en `tests/integration/reception-call-m5.test.ts` con stubs de Supabase en ROLLBACK.
- **Service key solo en el publisher server-only** (`lib/realtime-publisher-internal.ts`, `import "server-only"`): 1
  POST a `/realtime/v1/api/broadcast` con `private:true`, tope 1,5 s y breaker. El log (`realtime.publish_failed`, a lo
  sumo 1/min por motivo) lleva tenantId, cantidad, status y motivo; nunca la key, el token ni el body. El logger
  además borra `sb_secret_…`/`sb_publishable_…` y JWT largos de la línea serializada (`scrubSecrets`, `lib/logger.ts`),
  y `lib/redact.ts` cubre `sb_*` para Sentry.
- **Bootstrap client-safe** (`realtimeBootstrap`): `{driver, url?, anonKey?, tenantId}`; solo valores `NEXT_PUBLIC_*`
  que ya viajan en el bundle. Con config incompleta degrada a `off`.
- **SSE solo en `local` y autenticada** (`app/api/realtime/local/route.ts`): con otro driver **404**; sin sesión
  **401**; sin `realtimeAllowed` **403**; el stream es el del `tenantId` del actor. `local` está **prohibido en
  Production** (`lib/env.ts`, fail-fast del build, SV-D11).
- **CSP** (sigue Report-Only): `connect-src` pasó de `wss:` genérico a `wss://<host de NEXT_PUBLIC_SUPABASE_URL>`
  (`realtimeWsOrigin`, `next.config.mjs:55`).
- **`/sala` y PD-13.** La página y el re-pedido en vivo usan `listSalaBookings` (`lib/sala-bookings.ts`): gate
  `agenda.reception` + `salaEspera`, ventana ≤ 36 h, y la proyección `toSalaWire` se hace **en el server**
  (`SALA_HIDDEN_KEYS` = `title`, `description`, `notes`, `patientCondition`, más el título del plan,
  `lib/sala-board-state.ts:78`). Antes de FX2a el refetch del cliente usaba `listAgendaBookings` y a OWNER/PRACTITIONER
  les volvían a viajar esas claves aunque la card no las pintara. BILLING → `redirect("/agenda")`.
- **Avisos por rol:** la llegada solo a roles con `clinical.read` (OWNER/ADMIN/PRACTITIONER) que son el profesional del
  turno; el llamado a quien tiene `agenda.operateAll` y no es ese profesional (`app/(app)/layout.tsx:88-91`).
- **Guards estáticos** (`scripts/guard-realtime.mjs`, corre en `npm run guard:isolation`):
  (a) exactamente una policy sobre `realtime.messages` tras reproducir todas las migraciones, FOR SELECT TO
  authenticated, con la función y `extension = 'broadcast'`, sin WITH CHECK; ninguna `FOR INSERT|UPDATE|DELETE|ALL`
  ni `ALTER POLICY`; (b) la función definida una vez, `LANGUAGE sql`, IMMUTABLE, `SET search_path`, sin SECURITY
  DEFINER ni GRANT a `anon`/`authenticated`; (c) todo write-path de `Booking` emite (`afterBookingsCommitted` o un
  wrapper `after…`; el webhook de MP incluido); (d) secretos: nada JWT/SECRET/SERVICE_ROLE con `NEXT_PUBLIC_`, ni en
  `components/**`/`app/**/*.tsx`/drivers del cliente, `server-only` en publisher y firmador, sin `console.log` ni
  `logger(…token|secret…)` en `lib/realtime-*`; (e) `@supabase/realtime-js` solo por `import()` dinámico en
  `lib/realtime-client-supabase.ts`. Limitación: (c) mira por archivo, no por función (AUDIT `guard-realtime-por-archivo`).
- **Pendiente de Martin** (EXTERNAL-CONFIG §3.1): R1-R4 (incluye «Allow public access» OFF) y V1-V7 en staging antes de
  `REALTIME_DRIVER=supabase`.

## 18. Identidad y acceso (IAM, 14-oct-2026)

Diseño en [ARCHITECTURE.md §Identidad y acceso + ADR-007/ADR-008](ARCHITECTURE.md); consola en
[EXTERNAL-CONFIG.md §0.4](EXTERNAL-CONFIG.md).

- **Match de email exacto (hallazgo [A] ILIKE, IAM-0a).** Prisma traduce `{ equals, mode: "insensitive" }` a `ILIKE`,
  donde `_` y `%` son comodines: `jpere_@hotmail.com` (verificado) matcheaba la ficha de `jperez@hotmail.com`. Pasaba en
  el portal (fichas ajenas), en el vínculo de `/auth/callback` (`Patient.userId` ajeno = toma de ficha), en la
  precarga del turnero (PHI ajena) y en onboarding. Ahora todo match de email usa `emailEqualsFilter` (escapa `\ % _`)
  **y** `sameEmail` (post-filtro exacto normalizado) de `lib/email-match.ts`; `findUserByEmail` del puerto también
  compara exacto. Guard: `tests/unit/email-match.test.ts` («ningún email con ILIKE pelado» en `lib/` y `app/`).
  Abierto (C, baja): `insurers-internal.ts:26` y `catalog.ts:168` comparan nombre/código con ILIKE sin escapar.
- **Staff ≠ paciente** (AUDIT §5.22): `usedAsPortalPatient` (`lib/invite-activation-internal.ts:139`) en las dos
  puertas de `/invite` (antes de tocar GoTrue en la activación); el portal no le manda link a una identidad con
  membresía; el vínculo de fichas al iniciar sesión tampoco.
- **Tokens de invitación.** En la base solo el hash (sha256); el crudo viaja en el mail. «Reenviar» rota el token y
  el hash anterior va a `priorTokens` (el link del mail anterior sigue valiendo); «Generar link nuevo» vacía
  `priorTokens`; «Anular» = `revokedAt`. Aceptar/activar es CAS `acceptedAt IS NULL AND revokedAt IS NULL`. Suspender a
  un miembro anula sus invitaciones pendientes (aceptar una reactiva la membresía).
- **Activación con `createUser(email_confirm)` solo con token válido** (enmienda AUDIT §5.26, IAM-D1): el email lo fija
  la invitación (el link llegó a ese buzón), no quien activa. Adoptar un zombie (`updateUserById({emailConfirm:true})`)
  solo si `canSafelyDeleteAuthUser` (nunca entró, sin confirmar, sin perfil, membresías ni fichas). Guard:
  `tests/unit/email-confirm-guard.test.ts`.
- **Sin oráculo de cuentas.** Signup, olvidé contraseña, reenviar verificación y el link del portal responden igual
  exista o no la cuenta (o la ficha). Signup sobre una cuenta confirmada → mail «Ya tenés una cuenta» al buzón; sobre una
  sin confirmar → re-manda la verificación **sin pisar la contraseña** (anti pre-account takeover, desvío aceptado de
  IAM-2c). El portal solo pide un magic link si hay ficha con ese email exacto: `generateLink(magiclink)` a un email
  sin cuenta la crea (supuesto S4). Rate limit por IP y por hash del email en todos.
- **`/auth/confirm` resistente a escáneres** (AUDIT §5): el GET valida y redirige a `/auth/confirm/continuar`, **no
  canjea**; el POST (form que se manda solo) exige origen propio (`isConfirmPostAllowed`) y recién ahí `verifyOtp`.
  `next` siempre por `safeNext`. Limpia `kine_tenant` (login nuevo).
- **Reset por admin nunca expone el link.** `sendMemberPasswordReset` (`lib/invitations.ts:869`) manda el mail y
  devuelve solo el estado del envío; ni el resultado, ni el audit, ni el log llevan el link (con verlo, el OWNER o el
  ADMIN tomarían una cuenta que puede ser de otros consultorios). No va al OWNER si lo pide un ADMIN, ni a un
  suspendido, ni si el usuario de Auth no es el de la membresía. 10/h por actor y 1 cada 10 min por destinatario.
- **Suspensión de membresía** (`Membership.disabledAt`): corta el acceso a ese consultorio en `isUsableMembership`
  (no a los demás) y lo saca de lo reservable. Nadie se suspende a sí mismo ni al OWNER; re-invitar a un suspendido se
  rechaza («Usá Reactivar»).
- **Cookie `kine_tenant`** = tenantId, httpOnly; se limpia en cada login y nunca se confía: `chooseActiveTenant` la
  ignora si no es una membresía usable; `switchTenant` responde lo mismo para ajeno, suspendido o basura.
- **Actor sin profesional.** `Actor.practitionerId` es `null` para Secretaria y Facturación; un `where` con ese `null`
  abriría lo «sin asignar» (`IS NULL`). Helpers `ownPatientsWhere` / `isActorPractitioner` y guard estático
  `tests/unit/actor-practitioner-guard.test.ts`. `createBooking` rechaza el id de una Secretaria (IAM-4b).
- **`EmailLog` sin email en claro**: `toHash` (sha256 del email normalizado), `toMasked` (`j***@dominio`) y solo el host
  del link (el link lleva el token). RLS ENABLE + FORCE; escribe `prismaService` (envíos sin Actor). Los logs de
  `issueAccessLink` y `sendEmail` registran el host, nunca el token ni la URL; el rechazo del vínculo del portal ya no
  loguea el email.
- **Puerto único de Auth admin**: `auth.admin.*` solo en `lib/identity/auth-admin.ts` (verificado con grep al cierre de IAM y de BO; todavía sin guard estático, AUDIT `guard-auth-admin-y-getuser`);
  `auth.getUser()` solo en `lib/session-user.ts` (`getStrictSessionUser`, alias `getVerifiedSessionUser`; PF-0b). `lib/invitations.ts` no usa el cliente admin ni
  `inviteUserByEmail` (guard en `tests/integration/invitations-email.test.ts`).

## 19. Back-office de Plataforma (BO, 14-oct-2026)

Diseño en [ARCHITECTURE.md §Back-office de Plataforma + ADR-009..015](ARCHITECTURE.md); consola en
[EXTERNAL-CONFIG.md §0.5](EXTERNAL-CONFIG.md); hallazgos en [AUDIT.md «Hallazgos del bloque BO»](AUDIT.md).

- **Una barrera por export.** Todo `lib/platform-*` corre por `prismaService` (BYPASSRLS) y cruza consultorios: la
  única barrera es `requirePlatformAdmin(action)` al principio de cada export (`lib/platform-actor.ts:197`). Lo fija el
  guard estático `tests/unit/platform-admin-guard.test.ts` (lee el código: cada `export async function` la llama o
  delega en un `*-internal` que la llama; puros exceptuados por lista) y prohíbe `find*` sobre tablas clínicas en esos
  módulos (Plataforma cuenta, nunca lee pacientes, turnos ni HC). Un superadmin deshabilitado (`UserProfile.disabledAt`)
  queda afuera igual que uno sin flag. A quien no es superadmin, `/plataforma` le contesta 404 (`notFound()`).
- **Registro de plataforma** (`PlatformAuditEvent`): solo inserción por trigger (UPDATE/DELETE/TRUNCATE rechazados
  también al owner), SERVICE_ONLY (RLS sin policies), doble escritura con el `AuditEvent` del consultorio afectado.
  Payloads con nombres de campos, no valores (`statusReason` se audita como clave, no como texto).
- **Soporte** (decisión 3 de Martin, ADR-012):
  - cookie `kine_support` firmada con HMAC (clave derivada de `SUPABASE_SERVICE_ROLE_KEY` con etiqueta propia) y ligada
    al `userId`: copiada a otra cuenta no vale; se ignora y borra si la fila está cerrada o el superadmin perdió el flag;
  - **sin vencimiento** por decisión de producto (termina al salir o al cerrar sesión): por eso el MFA y la
    re-verificación de `support.start` (`high`) son la defensa, y **el soporte no se despliega sin MFA en enforce**;
  - capacidades de Secretaria sin `clinical.read` y visibilidad de pacientes de la Secretaria (sin HC);
  - transacciones en solo lectura (`transaction_read_only`) salvo las actions de Configuración de la allowlist estática
    `SUPPORT_WRITABLE_ACTIONS` (`lib/support-writable.ts`, guard `tests/unit/support-writable.test.ts`);
    `setSharedPatientView` queda afuera a propósito;
  - exports (agenda, pacientes, consultorio) → 403 y token realtime rechazado; cada `audit()` lleva `supportSessionId`;
  - el OWNER recibe un mail al empezar (motivo genérico; el texto libre queda en Configuración → «Accesos de soporte»).
- **MFA de superadmin** (BO4, ADR-014): con `PLATFORM_MFA_ENFORCEMENT=enforce`, AAL2 (TOTP de Supabase) para todo
  `requirePlatformAdmin` y re-verificación de 10 min para las acciones `high` (suspender/baja/slug, cortar acceso de un
  miembro, transferir OWNER, deshabilitar usuario, dar superadmin, entrar como soporte, pedir export). La cookie
  `kine_platform_reauth` es `<userId>.<exp>.<hmac>`, httpOnly, `sameSite=strict`, `path=/plataforma`, TTL 10 min, y la
  setean solo las actions de `lib/platform-mfa-actions.ts` después de un `verify` exitoso. `mfaStep` solo vale con
  `mfa.enroll`/`mfa.verify` (`mfa_step_misuse` si no). Si GoTrue no responde, se falla cerrado (`unavailable`).
  **Desde PL-Z**, con `enforce` apagado (el default de PL-2) las acciones `high` no quedan sueltas: piden el step-up de la
  2FA por usuario (§20).
- **CSP enforced en Plataforma** (`next.config.mjs:141`, `/plataforma/:path*` y `/plataforma-mfa/:path*`): sin Mercado
  Pago, sin `unsafe-eval` en prod, `connect-src`/`img-src` sin comodín `https:`, `form-action 'self'`,
  `frame-ancestors 'none'`. Se suma a la Report-Only global (que sigue reportando). Efecto: la toolbar de Vercel no
  carga en Preview dentro de `/plataforma`.
- **Rate limits nuevos:** cada clave de `PLATFORM_ACTION_POLICY` por superadmin (p. ej. `support.start` 10/10 min,
  `user.superadmin.update` 5/10 min, `tenant.export.request` 5/10 min, `mfa.verify` 10/10 min; el cupo corre **antes**
  del MFA para frenar adivinar códigos), `/api/health` 60/min/IP, `/api/client-errors` 20/min/IP,
  `/api/consultorio/export` 3/h **por consultorio** (tabla §8).
- **Export del consultorio** (BO5-C): solo el OWNER aceptado y habilitado (desde PL-Z, además con la 2FA verificada si la
  tiene: §20), también suspendido o dado de baja (BO-D4);
  ADMIN, el resto de los roles y el soporte → 403. Columnas por allowlist (`EXPORT_FIELDS`); **excluye** tokens de
  invitación y `EmailLog`, `Payment.rawPayload` (MP), `PatientFile.storageKey` y binarios, `ip`/`userAgent` de auditoría
  y soporte, ids de Auth (`Practitioner.userId`, `Patient.userId`, `superadminId`), claves de idempotencia, notas internas
  de Plataforma (`statusReason`, `seatLimitOverride`) y `PlatformAuditEvent`. Sale `team.userId` (id opaco, para mapear el
  `actorId` del audit; decisión de Martin). Audit doble `started`/final. `no-store` + `nosniff`. El superadmin solo
  **pide** el export al titular por mail.
- **Cron** (BO5-A): `/api/cron/*` son públicas a nivel red; la única barrera es `Authorization: Bearer CRON_SECRET`,
  comparada en tiempo constante sobre sha256 (`lib/cron-auth.ts`). Sin secreto: 503 en Production (se ve como config
  faltante), 401 fuera; nunca «abierto porque no hay secreto». El log no guarda el header.
- **Mantenimiento** (BO5-B): `MAINTENANCE_MODE=on` cierra todo con 503; el webhook de MP y `/api/health` siguen. El strip
  de `x-tenant-*` y el `x-request-id` corren igual en el 503 (AUDIT §5.3 preservado). `MAINTENANCE_MESSAGE` es público
  (se renderiza como texto, máx. 280). Sin bypass de superadmin.
- **`/plataforma/sistema`** muestra solo **presencia** de la configuración externa (Upstash, Sentry, Resend, MP, realtime,
  cron) y enums re-validados, nunca valores (`lib/platform-system-logic.ts`, test `platform-system.test.ts`).
- **`/api/health`** responde solo `{ ok, db, maintenance, time }`: sin entorno, versión ni mensaje de error.
- **`/api/client-errors`** (beacon de los error boundaries, sin SDK de cliente): origen propio, cuerpo ≤ 16 KB leído como
  texto, `scrubTokenPaths` + `redact()` antes de Sentry, respuestas sin cuerpo.
- **Activación del titular desde Plataforma** (BO2-A): la cuenta se crea **sin confirmar y sin contraseña**
  (`createUser({ emailConfirm: false })`) y el titular recibe un link de recovery a `/reset` para elegir contraseña; el
  link no viaja al navegador si el mail salió (enmienda AUDIT §5.26).

## 20. 2FA por usuario, step-up y escalada a HC (PL-2 / PL-Z, 15-oct-2026)

Hallazgos en [AUDIT.md «Hallazgos de PL-Z»](AUDIT.md); consola en [EXTERNAL-CONFIG.md §0.5-§0.6](EXTERNAL-CONFIG.md).

- **2FA por usuario** (PL-2a, ADR-017): opcional, en `/cuenta/seguridad`. Métodos: TOTP (puerto MFA de BO4), código por
  email (HMAC, 10 min, 5 intentos) y 10 códigos de recuperación. Quien la tiene activa pasa por `/verificar-acceso` antes
  de la app o de Plataforma (`twoFactor.state === "required"` en la foto de acceso).
  - **Una sesión `aal2` de GoTrue cuenta solo si el usuario tiene TOTP en KineSoft** (PL-Z, a2#1,
    `lib/two-factor-logic.ts`). Antes, enrolar un TOTP propio contra la API de GoTrue (con el access token) dejaba la
    sesión en `aal2` y salteaba el código por email.
  - Enrolar un método nuevo con otro ya activo pide step-up (a2#3): con la sesión robada no se suma un segundo factor.
  - Regenerar códigos de recuperación toma el lock del usuario (a2#5); onboarding y aceptar invitación cortan con la 2FA
    pendiente (a2#6).
  - 🟡 **A verificar (a2#7):** si GoTrue rechaza el reuso de un código TOTP dentro de su ventana (anti-replay). Si no, un
    código visto (hombro, captura) sirve ~30 s más.
- **Step-up** (`requireStepUp`, cookie `kine_stepup`, 10 min): re-pide el código antes de las acciones de riesgo del
  consultorio (permisos, «Atiendo pacientes», transferir la titularidad, cambiar de plan). Sin 2FA activa, la UI pide
  activarla.
- **Step-up en Plataforma** (PL-Z, a2#4): con `PLATFORM_MFA_ENFORCEMENT` distinto de `enforce`, `requirePlatformAdmin`
  pide `requireStepUp({ userId })` para toda acción `high` de `PLATFORM_ACTIONS` (`lib/platform-actor.ts`). Con `enforce`
  sigue la re-verificación de BO4 (§19). El superadmin tiene que tener la 2FA activa; un superadmin no resetea la 2FA de
  otro superadmin (a2#8).
- **Export del consultorio** (a2#2): con la 2FA pendiente, `GET /api/consultorio/export` responde 401. El export del
  Titular que no atiende incluye la HC: **excepción de portabilidad** (Ley 25.326), AUDIT §5.50.
- **Guard de escalada a HC** (PL-Z, a3#5, `lib/team-internal.ts`): asignar un rol que atiende (invitar, cambiar de rol,
  reactivar) exige ser Titular o miembro clínico. Sin esto, un ADMIN con «Configuración» (que no ve HC) podía invitar a
  una cuenta propia como Profesional y abrirse la HC. Copy: «Solo el titular o un profesional del consultorio pueden
  sumar a alguien que atiende.»
- **ADMIN nunca atiende** (§20.17, PL-Z): `isClinicalMember` y `clinicalMembershipWhere` devuelven `false` para ADMIN
  aunque la fila diga `clinical = true`; ningún camino de lectura le abre la HC por ese flag.
- **Leads** (a4#1): el tope global diario se consume solo si pasan el de IP y el de email: una IP sola ya no agota el cupo
  del día.

## 21. Evoluciones de HC (EV2, 15/16-oct-2026)

Modelo e invariantes en [ARCHITECTURE.md ADR-020](ARCHITECTURE.md); «preservar» en AUDIT §5.50-55; hallazgos en
[AUDIT.md «Hallazgos de EV2»](AUDIT.md). Un solo gate (`clinicalNoteGateInTx`): módulo `evoluciones` + `clinical.read` +
acceso `full` al paciente para leer; además `practitionerId` para escribir. Los rechazos no distinguen «no existe» de
«no podés» (`forbidden` / `notFound` sin pistas).

| Rol | Ver | Crear / enmendar | Editar (24 h) | Anular | Imprimir | Export del consultorio |
|---|---|---|---|---|---|---|
| Titular clínico (OWNER que atiende) | todos (supervisión → acceso `full`) | sí | solo las propias | **todas** (EV2-D15) | sí (auditado) | sí, con HC (2FA) |
| Titular que no atiende | no | no | no | no | no (404) | **sí, con HC** (§5.50, 2FA) |
| Profesional dueño, con share o con «vista compartida» del consultorio | sí | sí | solo las propias | solo las propias | sí (auditado) | — |
| Profesional sin acceso o con acceso básico | no | no | no | no | no (404) | — |
| ADMIN (nunca atiende, §20.17) | no (aunque la fila diga `clinical = true`) | no | no | no | no | — |
| Secretaria (ASSISTANT) / Facturación (BILLING) | no | no | no | no | no | — |
| Soporte de Plataforma | no (SUPPORT_CAPS sin clínico) | no | no | no | no | — |
| Paciente (portal) | **nunca** (EV2-D5) | — | — | — | — | — |

- **Superficies sin HC** (guard `tests/unit/clinical-notes-guard.test.ts`): portal, ⌘K, turnero público, Plataforma,
  `/sala` y realtime, notificaciones y mails, CSV y exports internos. La sala recibe el toast «Cargar evolución» pero
  ningún texto clínico.
- **Audit** en la misma tx: `clinicalNote.create|edit|amend|void` y `clinicalRecord.print` con `entity: "Patient"` y
  solo ids/kind/revisión — **nunca** el texto ni el motivo de anulación. La impresión audita **antes** de devolver
  datos: si el audit falla, no hay datos.
- **Fuga cerrada en EV2-Z (a2):** el replay de un doble envío (23505) devolvía la nota aunque al actor le hubieran
  sacado el share entre los dos envíos; ahora la tx de recuperación vuelve a pasar por el gate.
- **Inferencia cerrada (a1):** al cambiar el paciente de un turno con evolución, quien no es clínico recibe el error
  genérico, no «tiene una evolución».
- 🔴 **Abierto (a6, C0):** un kine que atiende el turno de un paciente de otro kine sin share no puede cargarle la
  evolución (falla cerrado), aunque la UI le ofrezca el toast.
