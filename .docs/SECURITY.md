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

**Open items** (tracked in AUDIT.md): distributed rate-limiting (Upstash, §8
below), wholesale RLS adoption (§9), per-booking payment-amount validation,
and GDPR export/retention.

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

## 9. Row-Level Security (RLS) — backstop, not gate

> ⚠️ **Structurally inert today (see AUDIT.md §0).** The app connects with a role
> that has BYPASSRLS (dev superuser / Supabase `postgres.<ref>`), so `FORCE RLS`
> never actually evaluates and `runWithRls` sets a GUC no policy gets to read.
> The real isolation gate today is the app-layer `where: { tenantId }` filter.
> Making RLS real is a coupled, all-or-nothing workstream (role without BYPASSRLS
> + GUC in every module + the 9 missing policies) — ROADMAP Ola 2.2.

`prisma/migrations/policies.sql` enables RLS on every tenant-scoped
table. `lib/rls.ts#runWithRls(tenantId, fn)` sets the
`app.current_tenant_id` GUC inside a transaction so the policies fire.

**Current adoption**: opt-in. The primary access control is the
application-layer `tenantId` filter applied in every server action via
`getActor()`. RLS is available as defense-in-depth for raw-SQL paths and
high-risk mutations; wholesale adoption is queued for a future sprint
where every server action is migrated to `runWithRls`.
