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

**Still open** (tracked in AUDIT.md): distributed rate-limiting (Upstash, §8
below — owner/bucket C), the prod RLS role flip (§9), and GDPR
export/retention.

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

## 2. The public surface

Public, unauthenticated surfaces (`/c/<slug>/booking`, the booking result
pages, the MP webhook):

- Resolve tenant by slug, not by header.
- Every public server action is rate-limited per IP via `lib/rate-limit.ts`.
- `lib/public-booking.ts#submitPublicBooking` **never overwrites existing
  PII** on a Patient row — at most it fills `null` fields. This prevents
  an attacker who knows a target's email from rewriting their HC.
- `lib/public-booking.ts#getPublicBookingStatus` returns only initials +
  non-PHI fields. The booking id (25-char CUID) is sufficiently random
  for the polling endpoint, but the payload is minimised regardless.
- `findPatientByEmail` is **not** an exported server action. It lives in
  `lib/public-booking-internal.ts` and is only invoked from server
  components that have already validated `email_confirmed_at` against
  the Supabase session.

## 3. Patient portal

`lib/portal.ts` requires `email_confirmed_at` on the Supabase user before
treating the email as authoritative — Supabase magic-link / unverified
sign-ups can never read PHI on a Patient row that happens to share their
email.

`submitCheckIn`:

- Rate-limited per IP.
- Refuses a second check-in for the same session id.
- Patient input is capped at 500 chars per entry and **prepended**
  (newest-first) to `Patient.notes`, then the whole field is truncated to
  4 kB. Pre-Sprint 11 the append-then-truncate order let a runaway
  patient bury practitioner notes off the bottom of the buffer.

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
- The captured MP `transaction_amount` is compared against the
  configured `Service.priceCents` before flipping the booking to PAID
  (±5 cent tolerance for rounding). Mismatches are logged and rejected.
- `rawPayload` is redacted to a known-safe subset before persistence —
  no cardholder name, document, or device fingerprint.

## 5. Auth callback (`/auth/callback`)

`auth/callback/route.ts` only links a Supabase identity to a `Patient`
row when:

1. `user.email_confirmed_at` is set, **and**
2. The Patient row has `userId == null` (or already matches this user).

A Patient already linked to a different identity is never re-bound. This
closes the account-takeover vector via mistyped Patient emails.

## 6. File uploads

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

## 8. Rate limiting

`lib/rate-limit.ts` falls back to an in-memory sliding window when
`UPSTASH_REDIS_REST_URL` is not configured. **In-memory does not work on
Vercel serverless** — each lambda isolate has its own bucket map and
cold starts reset the counters. Configure Upstash before shipping any
public surface to production.

Rate limits currently in place:

| Surface | Limit |
| --- | --- |
| `submitPublicBooking` | 5 / 5 min / IP |
| `listPublicSlots` | 60 / min / IP |
| `getPublicBookingStatus` | 120 / min / IP |
| `submitCheckIn` | 4 / min / IP |
| Mercado Pago webhook | 60 / min / IP |
| `/api/booking/checkout` | 8 / min / IP |
| `/api/auth/google` | 10 / min / IP |
| `/api/pacientes/export` | 5 / min / user |
| `/api/agenda/export` | 10 / min / user |

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
tables): a generated `tenantId = app_current_tenant_id()` policy for the
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

**Adoption is wholesale.** `lib/rls.ts#runWithRls(tenantId, fn)` sets the
transaction-local `app.current_tenant_id` GUC (transaction-local is mandatory —
prod pools through Supavisor in transaction mode), and `withTenantDb()` lets a
shared helper either join the caller's transaction or open its own. ~23
Actor-facing `lib/*` modules now read *and* write inside a wrap.
`scripts/guard-tenant-isolation.mjs` fails the build when a model gains
`tenantId` without a matching policy, and prints a soft report of `prisma.<model>`
calls made outside a wrap.

**Verified, not assumed.** Locally the app connects as `kinesoft_app`
(`NOSUPERUSER NOBYPASSRLS`, created by `prisma/roles.local.sql`) while
`DIRECT_URL` stays on the owner role for migrations and the service channel.
`tests/integration/rls-isolation.test.ts` (gated on `RLS_IT=1`, run via
`npm run test:integration`) is green: cross-tenant `INSERT` is rejected by
`WITH CHECK`, and a read that lost its wrap comes back empty — which is exactly
what makes a missed wrap fail loudly instead of leaking.

**Defense in depth stands.** The app-layer `tenantId` filter (`getActor()` +
`getTenantPrisma()`'s read injection) is still applied everywhere. RLS is the
net under it, not a replacement for it.

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
- **Granting the flag** is deliberately out-of-band and DB-level:
  `scripts/set-platform-admin.ts` (`<email>` to grant, `--revoke`, `--list`),
  run by the owner against the owner/`DIRECT_URL` connection. There is **no
  in-app path** to promote a user, no invitation flow, and no self-service —
  which keeps the tier out of reach of any tenant-level compromise.
