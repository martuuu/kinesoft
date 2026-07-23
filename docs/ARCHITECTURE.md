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
2. **RLS (backstop).** `prisma/migrations/policies.sql` enables FORCE ROW
   LEVEL SECURITY on tenant tables. `runWithRls(tenantId, fn)` (`lib/rls.ts`)
   sets the `app.current_tenant_id` GUC inside a transaction so policies fire.
   **Adoption is opt-in today** — used for high-risk mutations (booking
   create/update/delete). **Note:** the connection role has BYPASSRLS today, so
   RLS is structurally inert — the app-layer `tenantId` filter is the real gate.
   See AUDIT.md §0 + ROADMAP Ola 2.2 for the wholesale-RLS workstream.

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
`seriesId` (groups a multi-turno batch), `idempotencyKey`, `updatedAt`
(optimistic-concurrency token). Bookings have **no FK** to
`Session`/`TreatmentProgram` — they live in parallel.

- **Single turno**: `createBooking` (conflict/sobreturno UX + next-free-slot).
- **Multi-turno**: `createBookingsBatch` (count + weekdays, AR-correct days,
  shared `seriesId`, individual `Booking` rows — **not** a plan).
- **Edit/delete**: `updateBooking` / `deleteBooking` / `setBookingStatus`,
  all under `runWithRls`, all guarded by `expectedUpdatedAt`
  (optimistic concurrency) so a stale drawer can't mutate a changed row.

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
ramped across N `Session`s). The diagnosis guide is deferred to ROADMAP Etapa 3
(`guia-diagnostico-completa`) — gated on a vision session with the owner.

## Build / verify

- `npm run dev` — local Next.js against Docker Postgres (`.env.local`).
- `npm run build` = `prisma generate && next build`.
- Verify: `npx tsc --noEmit` + `npx next build` (clear `.next` on stale
  "Cannot find module for page" cache errors). `scripts/` is excluded from tsc.
- Migrations + env split: see [DEPLOYMENT.md](DEPLOYMENT.md).
