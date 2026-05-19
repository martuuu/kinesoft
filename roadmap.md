# KineSoft — Roadmap

> Enterprise SaaS platform for Argentinian physical therapists / kinesiologists.
> Tech: **Next.js 14 (App Router) · TypeScript · Tailwind CSS · Prisma · PostgreSQL · Supabase**.
> Source design system: bundled handoff from Claude Design (`design_source/kinesoft/`).

---

## Getting started (local dev)

The codebase ships with a `docker-compose.yml` for a local Postgres, an
`.env.local` template, and an idempotent seed.

```bash
# 1) one-time setup
npm install
docker compose up -d db                # Postgres on :5432
cp .env.local .env                     # if you prefer .env over .env.local

# 2) database
npx prisma migrate dev --name init     # creates the schema
psql "$DATABASE_URL" -f prisma/migrations/policies.sql   # optional: RLS
npm run prisma:seed                    # ~30 conditions, ~60 exercises, demo tenant

# 3) run
npm run dev
```

Then visit:

| URL                                     | What                                          |
| --------------------------------------- | --------------------------------------------- |
| `/`                                     | Marketing landing                             |
| `/login`                                | Practitioner login                            |
| `/dashboard`                            | KPIs (live data)                              |
| `/agenda`                               | Calendar (Day / Week / List)                  |
| `/pacientes`                            | Patient directory                             |
| `/pacientes/[id]`                       | HC ampliada                                   |
| `/diagnostico`                          | Diagnosis (desktop ≥ 1024px) or wizard (< 1024px) |
| `/seguimiento`                          | Session workflow                              |
| `/biblioteca`                           | Exercise catalog                              |
| `/portal`                               | Patient portal (Google sign-in)               |
| `/c/movare/booking`                     | Public booking turnero                        |

Adminer is up at `http://localhost:8080` (system `PostgreSQL`,
server `db`, user/password `kinesoft`).

---

## 0. Guiding principles

- **Multi-tenant by default.** Every domain table carries a `tenantId`; every query is scoped by the active tenant. Postgres Row-Level Security mirrors the application-layer guard so a misconfigured query cannot leak data.
- **Desktop-first for the practitioner workspace**, mobile-first for everything a patient touches (landing, booking, patient portal).
- **Design fidelity over creative liberty.** The bundled prototypes (`design_source/kinesoft/project/`) are the canonical visual spec. Port them faithfully, then refactor for reusability.
- **Diagnosis module is the IP.** Schema is built manually with strict relations so a future AI override engine has clean ground truth.
- **Enterprise hygiene**: typed end-to-end, server actions validated with Zod, audit logs on PHI tables, secrets via env, no plaintext PII in logs.

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Next.js 14 (App Router)                       │
│                                                                     │
│  app/                                                               │
│   ├─ (marketing)/         public landing, pricing, etc.             │
│   ├─ (booking)/[tenant]/  public turnero for a clinic (subdomain    │
│   │                       or path-based tenant resolution)          │
│   ├─ (auth)/              login, signup, password reset             │
│   ├─ (portal)/            patient portal (Google OAuth + email/OTP) │
│   ├─ (app)/               authenticated practitioner workspace      │
│   │    ├─ dashboard/                                                │
│   │    ├─ agenda/                                                   │
│   │    ├─ pacientes/[id]/  (HC ampliada)                            │
│   │    ├─ diagnostico/                                              │
│   │    ├─ seguimiento/[sessionId]/                                  │
│   │    └─ biblioteca/                                               │
│   ├─ api/                                                           │
│   │    ├─ webhooks/mercadopago/   payment notifications             │
│   │    ├─ webhooks/supabase/      auth events                       │
│   │    └─ trpc/ (or server actions)                                 │
│   └─ middleware.ts        tenant + auth resolution                  │
│                                                                     │
│  prisma/  schema + seeds (anatomy, conditions, exercises)           │
│  lib/     auth, db, tenancy, mercadopago, audit, validation         │
│  components/                                                        │
│    ├─ ui/        primitives (Button, Glass, Card, Avatar, …)        │
│    ├─ layout/    Sidebar, TopBar, TweaksPanel, MobileNav            │
│    ├─ booking/   stepper, calendar, slot grid                       │
│    └─ diagnosis/ BodyMap (SVG), TagPicker, DxRanking, PlanBuilder   │
└─────────────────────────────────────────────────────────────────────┘
```

**Tenant resolution**: the middleware reads either `X-Tenant-Slug`, the first path segment under `/c/<slug>/...`, or the subdomain (`<slug>.kinesoft.app`). It hydrates a `TenantContext` server-only object and forwards `x-tenant-id` to downstream route handlers and server components.

**Data access**: a thin Prisma extension (`prisma.$extends`) injects `where: { tenantId }` on every read/write for tenant-scoped models. Service-role queries (background jobs, webhooks) explicitly opt out.

**Postgres RLS** mirrors the rule at the database layer. The Next.js runtime sets `SET LOCAL app.current_tenant_id = '<uuid>'` at transaction start; policies compare against that GUC.

---

## 2. Phased delivery plan

### Phase 1 — Foundation (this session)
1. Bootstrap Next.js 14 (App Router, TS, Tailwind, ESLint).
2. Install Prisma, Supabase JS, Zod, MercadoPago SDK.
3. Port design tokens (`tokens.css`) into Tailwind config + global CSS.
4. Author the Prisma schema (full kinesiology MVP including diagnosis IP).
5. Build the multi-tenant primitives: middleware, `getTenantContext`, prisma extension stub.
6. Implement the layout shell: `Sidebar` (with collapsed mode), `TopBar`, `TweaksPanel` (with new minimise/collapse toggle).
7. Port the **Login** screen, **Marketing landing** (desktop + mobile), and **public Booking** page (read-only fidelity port).

### Phase 2 — Practitioner workspace screens
- Dashboard (hero, KPIs, weekly chart, upcoming, recent patients).
- Agenda with 3 views (timeline / week-grid / list) and patient panel.
- Historia Clínica ampliada (tabs: Resumen, Sesiones, Plan, Antecedentes, Archivos, Evolución, Facturación).
- Seguimiento por sesión (session rail + assigned exercises + notes).
- Biblioteca de ejercicios (filters + grid).

### Phase 3 — Diagnosis module (core IP)
- Interactive `BodyMap` (front/back SVG, ~32 zones).
- Refinement panel (sub-zone, pain type, when-appears, evolution, intensity).
- Live diagnosis ranking with `% match` (CIE-10).
- Cross-functional exercise mapping (direct vs. indirect via kinematic chain).
- Plan Builder modal — assign confirmed Dx + program to a patient EHR.
- Mobile alternative: step-by-step wizard (no body map, sequential picker).

### Phase 4 — Auth & payments
- Supabase Auth (email/password) for practitioners.
- Google OAuth for the patient portal (Supabase social provider).
- Mercado Pago Checkout Pro integration:
    - Server endpoint creates a `preference` with the booking metadata.
    - Webhook (`/api/webhooks/mercadopago`) validates HMAC, updates `Booking.paymentStatus`, transitions to `CONFIRMED` on `approved`.
    - Client SDK redirect; success/failure/pending routes update UI.
- Idempotency keys on booking creation + payment confirmation.

### Phase 5 — Hardening
- Postgres RLS policies + integration tests.
- Audit log table + Prisma middleware to log PHI access.
- Rate-limit booking creation and login (Upstash/Edge).
- E2E (Playwright) on the golden booking + diagnosis flows.
- Observability: structured logging, Sentry, request IDs.
- A11y pass (keyboard nav for body map, contrast checks).

### Phase 6 — Dashboard, the real cockpit
Today the Dashboard surfaces live KPIs but the **chrome is decorative**: the
search bar, notification bell, mini-calendar chevrons, "Más tarde",
"Agregar fijado" and avatar are inert. Phase 6 makes the cockpit a true
working surface.

**Audit findings**:

| Surface | State | What Phase 6 ships |
| --- | --- | --- |
| Search bar | Decoration | ⌘K / ctrl-K command palette (patients, exercises, sessions, conditions) |
| Notification bell | Static dot | Real `Notification` feed (booking created / payment received / session due) |
| Avatar / settings | Decoration | Profile dropdown → settings, sign-out |
| Hero "Más tarde" | No handler | `DismissedReminder` table; per-user dismissal with week-based key |
| "Agregar" pinned KPIs | No handler | `UserPreferences.pinnedKpis` JSON; pick from a menu |
| MiniCalendar chevrons | No handler | Navigate the month + click-day → `/agenda?date=…` |
| Recent patient row | Read-only | Quick-action menu (open HC, mark no-show, message) |
| Sessions chart | Static | Toggle ranges (this week / this month / 3 months) |
| Revenue widget | Static | Click → drill into `/reportes` filtered by current month |

**Deliverables**: `Notification`, `DismissedReminder`, `UserPreferences`
models; `lib/notifications.ts` + dropdown UI; `lib/preferences.ts`;
`SearchCommand` component (cmd-K, server-side hybrid search across
patients/exercises/conditions/bookings); reminder dismissal flow.

### Phase 7 — Mockup → full flow (workspace polish)
Every surface that's wired but missing **edge cases / power-user actions**.
Phase 7 closes the gap to "production-quality".

**Pacientes (Directory)**:
- Sortable columns (apellido / próx. turno / última visita / sesiones).
- Bulk actions (select N → archive / export CSV).
- "Pacientes archivados" view.
- Advanced filters: cobertura, edad, último diagnóstico, alta.
- Per-row quick actions (open HC, edit, archive, message).

**Patient Profile / EHR**:
- ✅ Archivos tab (Sprint 5) — upload, list, download, delete with size + mime.
- ✅ Facturación tab (Sprint 5) — payments + booking links + status.
- ✅ Edit + delete actions (Sprint 5).
- Send-to-portal action (assigns a Supabase identity to the email).
- Print-friendly HC export (server-rendered PDF).
- Activity feed across all PHI changes for this patient (queries `AuditEvent`).

**Agenda**:
- Practitioner filter (multi-clinic).
- Drag-to-reschedule (HTML5 DnD on the timeline).
- Recurring bookings (weekly N occurrences).
- WhatsApp reminder action (template + server send).
- `.ics` export per booking + per week.
- Conflict resolution UX (suggest next free slot).

**Seguimiento**:
- Substitute exercise on the fly (search + swap, keep series/reps).
- Add ad-hoc exercise to a session.
- Drag-to-reorder exercises within a session.
- Inline RPE / pain timeline visualisation.

**Biblioteca**:
- Practitioner-private custom exercises (tenant-scoped `Exercise`).
- Favourites + "my plans" templates.
- Bulk-assign to an existing program.

**Diagnostico**:
- Save case-without-patient (drafts).
- "Compare top diagnoses" view (side-by-side overlap).
- Practitioner override + custom condition.

**Patient portal**:
- Plan timeline + exercise videos.
- Pre-session check-in (EVA + notes the kine sees before the visit).
- Receipt download.

---

## 3. Prisma schema sketch (delivered in Phase 1)

Models grouped by domain (full DDL in `prisma/schema.prisma`):

- **Tenancy**: `Tenant`, `Membership`, `UserProfile`.
- **People**: `Practitioner`, `Patient`, `Coverage` (insurance), `EmergencyContact`.
- **Catalog (global, non-tenant)**: `BodyRegion → BodySubRegion`, `Tag` (hierarchical `parentId`), `Condition` (CIE-10), `ConditionTag`, `Exercise`, `ExerciseTag`, plus `ConditionExerciseLink` with `relation = DIRECT | INDIRECT | ANTAGONIST` and `weight`.
- **Clinical (per-tenant)**: `ClinicalCase` (patient-agnostic snapshot from the Diagnosis page), `Diagnosis` (case → condition w/ match%), `TreatmentProgram`, `Session` (n of m), `SessionExercise` (order, sets, reps, status, RPE), `SessionNote` (practitioner annotations), `EvaScore` (pain timeline).
- **Scheduling**: `Service`, `Availability`, `Booking` (status enum, patient ref, paymentId), `Payment` (Mercado Pago id, status, amount, raw payload).
- **Audit**: `AuditEvent` (actor, tenant, entity, action, ip, ua).

### 3.1 Tagging and matching engine (excerpt)

```prisma
model Tag {
  id        String   @id @default(cuid())
  slug      String   @unique
  label     String
  kind      TagKind                       // ZONE | SUBZONE | SYMPTOM | TRIGGER | PHASE | EQUIPMENT
  parentId  String?
  parent    Tag?     @relation("TagTree", fields: [parentId], references: [id])
  children  Tag[]    @relation("TagTree")
  conditions ConditionTag[]
  exercises  ExerciseTag[]
}

model Condition {
  id        String   @id @default(cuid())
  cie10     String?
  name      String
  summary   String?
  tags      ConditionTag[]
  exercises ConditionExerciseLink[]
}

model ConditionExerciseLink {
  conditionId String
  exerciseId  String
  relation    ExerciseRelation             // DIRECT | INDIRECT | ANTAGONIST
  weight      Float    @default(1.0)
  rationale   String?                      // why this exercise applies (e.g. "kinematic chain via glute med")
  @@id([conditionId, exerciseId, relation])
}
```

**Match score** (in-app, not DB):

```
score(condition) =
  Σ (tag.weight · symptomIntensity) for tag in condition.tags ∩ caseTags
  / Σ tag.weight for tag in condition.tags
  · phaseBoost(case.evolution)
```

The score is recomputed live as the practitioner refines the case. Exercises are surfaced via `ConditionExerciseLink`, ordered by `relation` then `weight`. **Indirect** exercises appear when a chained tag matches (e.g. ITBS → glute med activation).

---

## 4. Mercado Pago integration contract

| Step | Where | Action |
| --- | --- | --- |
| 1 | Server (Next.js route handler) | Validate slot still free; create `Booking` in `PENDING` state with idempotency key. |
| 2 | Server | POST to `mercadopago.preference.create` with `external_reference = booking.id`, `notification_url`, `back_urls`, items, payer. |
| 3 | Client | Redirect to `init_point` (or open Checkout Bricks). |
| 4 | Webhook `/api/webhooks/mercadopago` | Verify signature, fetch payment, update `Payment` + `Booking.paymentStatus`. Confirm or release the slot. |
| 5 | UI | `back_urls.success` lands on `/c/<slug>/booking/<id>/ok`, which polls `Booking.status` until `CONFIRMED`. |

Secrets: `MP_ACCESS_TOKEN` (server only), `MP_WEBHOOK_SECRET`, `MP_PUBLIC_KEY` (for client SDK if needed).

---

## 5. Google OAuth (patient portal)

- Supabase project provider config: enable Google, set authorized redirect to `https://<app>/auth/callback`.
- `app/(portal)/auth/callback/route.ts` exchanges code → session, attaches `Patient` record if first-time login (match by email, otherwise create).
- Patients are tenant-scoped via `PatientTenantLink` so the same Google identity can be a patient at multiple clinics.

---

## 6. Tweaks panel — refactor scope

- Keep all current controls (palette, dashboard chrome, agenda view, patient card, sidebar collapsed).
- **New**: a header chevron that minimises the panel to a 44×44 floating tab on the right edge. State persists in `localStorage` under `kinesoft:tweaks:minimised`.
- Move from inline-style implementation to a typed React context (`useTweaks`) so any page can read current tweak values.

---

## 7. Responsiveness matrix

| Surface | Strategy |
| --- | --- |
| Landing marketing | Mobile-first, single column under `md`, hero `prose-stack` |
| Public booking | Mobile-first 4-step accordion; on desktop, two-column (calendar + summary) |
| Patient portal | Mobile-first, bottom-nav, lightweight (`<150kB` JS) |
| Login | Centred card, mobile reuses card with stacked brand block |
| Dashboard / Agenda / HC / Seguimiento / Biblioteca | Desktop-first; on mobile, show condensed lists + deep-link to detail |
| Diagnosis | Desktop: full body map. Mobile: 5-step wizard (Zone → Subzone → Symptom → Evolution+Intensity → Suggestions) |

---

## 8. Out of scope for v1

- AI-assisted Dx override (the schema supports it; module ships later).
- Native mobile app.
- HL7/FHIR export.
- Multi-currency (ARS only).

---

## 9. Status (live)

### Shipped this session
- [x] Roadmap drafted
- [x] Project bootstrapped (Next.js 14 App Router, TS strict, Tailwind, Prisma)
- [x] Prisma schema authored — full multi-tenant + diagnosis IP
- [x] Design tokens ported (palette swap via `data-palette`)
- [x] Multi-tenancy primitives — middleware, tenant context, RLS-ready Prisma extension
- [x] Layout shell — `Sidebar` (with collapsed mode), `TopBar`, refactored `TweaksPanel` (typed context + new minimise/collapse toggle)
- [x] Public surfaces — Landing (mobile-ready), Login, Public Booking
- [x] Dashboard ported with full fidelity
- [x] Workspace route stubs (Agenda, Pacientes, Seguimiento, Biblioteca, Reportes)
- [x] **Diagnosis module** — interactive SVG body map, refinement panel, ranked Dx (CIE-10), DIRECT/INDIRECT exercises, Plan-Builder modal with patient picker
- [x] Mobile Diagnosis Wizard (alternative for narrow viewports per the brief)
- [x] Mercado Pago — preference creation, server-to-client redirect, signed webhook
- [x] Google OAuth — server kickoff route + Supabase callback
- [x] Audit log primitive + matching-engine pure functions (`lib/matching.ts`)
- [x] Catalog seed (anatomy tags, conditions, exercises, ITBS DIRECT + INDIRECT links)
- [x] `tsc` passes, `next lint` passes (1 informational warning)

### Sprint 3 — Diagnosis IP fully wired (this session)
- [x] **Schema additions** ([prisma/schema.prisma](prisma/schema.prisma)):
    - `AnatomicalRegion` with SVG geometry (RECT / ELLIPSE / PATH), `view` (FRONT/BACK), `side` (LEFT/RIGHT/CENTER), `parentSlug`, `tagSlug` bridging the matching engine.
    - `ConditionAnatomy` with `role` (PRIMARY / SECONDARY / RELATED) — the latter is what surfaces "indirect" exercises via kinematic chain.
    - `Condition` enriched with `severity`, `recoveryWeeksMin/Max`, `mechanism`, `redFlags`.
    - `Exercise` enriched with `instructions`, `equipment`, `muscleGroups`, `cues`.
    - `ConditionExerciseLink` gains a `phase` (`ACTIVATION` / `STABILITY` / `LOAD` / `PROGRESSION`).
- [x] **Production matching engine** ([lib/diagnosis.ts](lib/diagnosis.ts)) — `rankSelection(...)` blends weighted tag overlap (55%) with anatomy overlap (45%, PRIMARY ×3, SECONDARY ×1.5, RELATED ×0.5), applies an intensity boost (0.7→1.15), a phase boost (chronic +10%, acute +5%) and a specificity penalty for noisy selections. `exercisesFor(...)` orders DIRECT → INDIRECT → ANTAGONIST → PREVENTIVE, then by phase, then by weight.
- [x] **`assignDiagnosisAndCreateProgram`** — single Prisma transaction that re-ranks server-side, writes `ClinicalCase` + top-4 `Diagnosis` (with the practitioner's confirmed one flagged), `TreatmentProgram` and N `Session` rows, with `SessionExercise` distributions phased across the program (activation early → progression late). Idempotency-safe, tenant-scoped, audit-logged.
- [x] **Server-component Diagnostico** ([app/(app)/diagnostico/page.tsx](app/%28app%29/diagnostico/page.tsx)) prefetches the full catalog + initial patients and hands them to a dynamic client. The body map renders from `AnatomicalRegion` records — *no more hardcoded zones*.
- [x] **Plan Builder modal** with real **patient search** (debounced server action), **loading/error/success states**, EVA/sessions/frequency controls (server validates), and a **per-phase preview** that mirrors the persisted distribution.
- [x] **Mobile Wizard** ([components/screens/diagnostico-wizard.tsx](components/screens/diagnostico-wizard.tsx)) — 6 steps (Zona / Síntoma / Cuándo / Intensidad / Diagnóstico / Paciente), same `rankSelection` engine, same `assignDiagnosisAndCreateProgram` action. The route switches between desktop and wizard automatically via a `@media (max-width: 1023px)` rule.
- [x] **Production-grade seed** ([prisma/seed.ts](prisma/seed.ts)):
    - 38 anatomical regions (front 26, back 12) with SVG geometry.
    - 56 tags across 6 kinds (zones, sub-zones, symptoms, triggers, phases, kinematic chains).
    - 28 conditions across knee / hip / ankle / shoulder / elbow / wrist / lumbar / cervical with CIE-10, severity, recovery windows, mechanism and red flags.
    - 60 exercises with instructions, equipment, muscle groups and cues.
    - ~180 `ConditionExerciseLink` rows correctly bucketed DIRECT/INDIRECT/ANTAGONIST × ACTIVATION/STABILITY/LOAD/PROGRESSION — every condition has enough material for a real 8-24 session program.
- [x] `tsc` + `next lint` both clean.

### Sprint 2 — Calendar + Patients + EHR
- [x] **Session/actor resolver** ([lib/session.ts](lib/session.ts)) — single source of truth for the active tenant + practitioner, used by every server action. Falls back to a `kine_tenant` cookie / `movare` demo tenant until Supabase auth is fully wired.
- [x] **Zod validation layer** ([lib/validation.ts](lib/validation.ts)) shared by client forms and server actions.
- [x] **Patient domain** ([lib/patients.ts](lib/patients.ts)) — list/filter/search, getPatient with full clinical relations, create/update/delete, createProgram (auto-schedules sessions), recordEvaScore, completeSession.
- [x] **Booking domain** ([lib/bookings.ts](lib/bookings.ts)) — range query with patient + diagnosis joins, conflict-aware create, update, status transitions, delete.
- [x] **Pacientes (Directory)** ([app/(app)/pacientes/page.tsx](app/(app)/pacientes/page.tsx)) — searchable, filterable list with live counts, empty-state, “Nuevo paciente” modal (server action + redirect to the new profile).
- [x] **Patient Profile / EHR** ([app/(app)/pacientes/[id]/page.tsx](app/(app)/pacientes/[id]/page.tsx)) — hero + 5 tabs (Resumen, Sesiones, Plan, Antecedentes, Evolución), inline EVA recorder with an SVG sparkline, “Cargar sesión” modal that writes back to Prisma, “Crear plan” modal that scaffolds N sessions at the chosen frequency.
- [x] **Agenda (Calendar)** ([app/(app)/agenda/page.tsx](app/(app)/agenda/page.tsx)) — Day timeline / Week grid / List views, week-strip navigation, new-turn modal (validates server-side for time conflicts), edit modal with status transitions (Confirmar / Hecho / Ausente / Cancelar / Eliminar).
- [x] **Dashboard retrofitted** to live data — [lib/dashboard.ts](lib/dashboard.ts) computes KPIs (active patients, weekly sessions, adherence %, programs in course, near-discharge, MoM revenue delta, private vs OS share) directly in Postgres; the existing UI now consumes a typed `DashboardData` prop.
- [x] **Audit trail** records `patient.read|create|update|delete`, `booking.create|update|delete`, `program.create`, `session.complete`.
- [x] **Seed expanded** ([prisma/seed.ts](prisma/seed.ts)) — Owner + Practitioner + Membership, 3 services, 6 patients with coverages, Sofía's full ITBS case + 8-session program (3 completed with EVA data) + Eugenio's post-LCA 24-session program, 18 bookings across the past + current + next week with payments on the realised ones.
- [x] `tsc` passes clean; `next lint` shows only the pre-existing custom-font warning.

### Sprint 4 — Hardening + remaining surfaces (this session)
- [x] **Local dev unblocker** — [docker-compose.yml](docker-compose.yml) brings up Postgres + Adminer; [.env.local](.env.local) seeded with a working local `DATABASE_URL`; new "Getting started" runbook (this file).
- [x] **Structured logger** ([lib/logger.ts](lib/logger.ts)) — JSON in prod, coloured in dev, configurable via `LOG_LEVEL`; `logger.span(name, fn, ctx)` wraps an async call and emits latency + error context.
- [x] **Rate limiter** ([lib/rate-limit.ts](lib/rate-limit.ts)) — in-memory sliding window by default, swaps to Upstash REST when `UPSTASH_REDIS_REST_URL` is set; wired into `/api/booking/checkout` (8/min/IP) and `/api/auth/google` (10/min/IP).
- [x] **Biblioteca de ejercicios** ([app/(app)/biblioteca/page.tsx](app/(app)/biblioteca/page.tsx)) — server component that hydrates from [`lib/exercises.ts`](lib/exercises.ts) with search + difficulty + muscle-group + equipment + condition filters; client grid + detail modal with instructions/cues/equipment/related diagnoses.
- [x] **Seguimiento** ([lib/sessions.ts](lib/sessions.ts), [app/(app)/seguimiento/page.tsx](app/(app)/seguimiento/page.tsx)) — landing splits Today / Upcoming / Recently completed; per-session detail page ([components/seguimiento/session-detail.tsx](components/seguimiento/session-detail.tsx)) shows the plan rail, per-exercise inline editing of sets / reps / notes / status with optimistic toggle, EVA pre/post + RPE recorder, and "Cerrar sesión" that completes any pending exercises and writes an EVA score.
- [x] **Body map A11y** — the SVG is now a `role="application"`, tab-focusable, with **arrow keys** to cycle between zones, **Enter/Space** to toggle, **F/B** to swap views; each zone is a `role="checkbox"` with `aria-checked` and a Spanish `aria-label` describing whether it's marked or kinematic-chain related; a visually-hidden `role="status"` `aria-live="polite"` region announces the top diagnosis whenever the matching engine re-ranks; focus styles via `:focus-visible`.
- [x] **Desktop ↔ wizard switch** wired via CSS media query (`.diag-desktop` / `.diag-mobile` below 1024px) — the practitioner page renders both, the browser picks one.
- [x] **RLS policies** ([prisma/migrations/policies.sql](prisma/migrations/policies.sql)) — enables and forces RLS on every tenant-scoped table, declares isolation policies that read the `app.current_tenant_id` GUC; indirect tables (Coverage, Payment, Session, SessionExercise, EvaScore, Diagnosis) use FK-traversal subqueries so the planner can use existing indexes. [lib/rls.ts](lib/rls.ts) ships `runWithRls(tenantId, fn)` — sets the GUC inside a transaction so raw-SQL / cascade-delete paths are guarded too.
- [x] **Patient portal** ([app/(portal)/portal/](app/%28portal%29/portal/)) — lightweight mobile-first surface: `/portal` is the Google sign-in landing when logged out, otherwise lists every `Patient` row whose email matches the Supabase user (the same human can be a patient at multiple clinics, each with their own plan + next bookings); `/portal/me` is the account view; `/api/auth/sign-out` is the new route handler.
- [x] `tsc` clean; `next lint` shows only the pre-existing custom-font notice.

### Sprint 5 — EHR complete + Phase 6 kick-off (this session)
- [x] **Schema** ([prisma/schema.prisma](prisma/schema.prisma)) — `PatientFile` with `PatientFileCategory` + Supabase Storage hook, `Notification` with `NotificationKind`, `DismissedReminder` (idempotent by `(tenantId,userId,key)`), `UserPreferences` (palette / pinned KPIs / sidebar). `Patient.archivedAt` added for the Phase 7 archive flow.
- [x] **PHI audit middleware** — [lib/request-context.ts](lib/request-context.ts) ships an `AsyncLocalStorage` propagated by `getActor()` (idempotent enter, captures IP + UA from headers). [lib/audit-extension.ts](lib/audit-extension.ts) is a Prisma `$extends` that auto-records reads against `Patient`, `Coverage`, `EmergencyContact`, `ClinicalCase`, `Diagnosis`, `TreatmentProgram`, `Session`, `SessionExercise`, `EvaScore`, `Booking`, `Payment`, `PatientFile`. Fire-and-forget so the audit write never blocks the caller. Opt-in via `getAuditedPrisma()`.
- [x] **HC Archivos tab** — [lib/files.ts](lib/files.ts) handles upload (Supabase Storage when configured, stub-key in local dev), list, signed 10-min download URLs, delete. UI: drag-drop card + categorised list with size + date + per-row download / delete. 25 MB cap.
- [x] **HC Facturación tab** — summary cards (facturados, pagados, pendientes) + booking table with payment + booking status tags.
- [x] **Patient edit + delete** — `EditPatientModal` reuses the Zod `PatientUpdate` schema; `DeletePatientModal` requires the practitioner to type the patient's full name to confirm (defensive against fat-fingered destruction). Both wired through to the existing `updatePatient` / `deletePatient` server actions.
- [x] **Phase 6 kick-off**:
    - [lib/notifications.ts](lib/notifications.ts) — `notify()` enqueue, `listNotifications`, `markNotificationRead`, `markAllNotificationsRead`, plus `dismissReminder` / `isReminderDismissed` for the dashboard reminder card.
    - Dashboard "Más tarde" button is no longer decoration — it writes a `DismissedReminder` keyed by ISO week, so the card hides until the following Monday.
    - [components/dashboard/notifications-bell.tsx](components/dashboard/notifications-bell.tsx) — bell with unread badge, dropdown that lazy-loads on open, optimistic mark-read, "Marcar todas", outside-click + Escape to close. Replaces the decoration that lived in the dashboard chrome.
- [x] `tsc` clean; `next lint` shows only the pre-existing custom-font notice.

### Sprint 6 — Phase 6 cockpit (this session)
- [x] **⌘K command palette** — [lib/search.ts](lib/search.ts) runs 4 parallel Prisma queries (patients / exercises / conditions / next-week bookings) plus a fixed shortcut list; [components/global/command-palette.tsx](components/global/command-palette.tsx) is mounted at the app shell and listens for `(⌘|Ctrl)+K` anywhere in the workspace. 200 ms debounced search, arrow-key + Enter navigation, ESC to close. The decorative dashboard search bar now dispatches the same shortcut event.
- [x] **Profile menu** ([components/global/profile-menu.tsx](components/global/profile-menu.tsx)) — replaces the static avatar. Dropdown → Ajustes + Cerrar sesión. Ajustes opens a modal with the palette picker and the pinned-KPI picker (max 6); persists via `updateUserPreferences` and applies the palette live through `useTweaks` without a refresh.
- [x] **UserPreferences** ([lib/preferences.ts](lib/preferences.ts)) — `getUserPreferences()` returns the row or sensible defaults; `updateUserPreferences()` validates the payload (palette enum + KPI whitelist + 6-max). 8 `KPI_OPTIONS` selectable.
- [x] **PinnedRow filters by preferences** — the dashboard renders only the KPIs the user pinned, in their chosen order. New KPI implementations (`todayCount`, `monthRevenue`, `adherence`, `nearingDischarge`, `newPatientsMonth`) added so all 8 options have data.
- [x] **MiniCalendar nav** ([components/dashboard/mini-calendar.tsx](components/dashboard/mini-calendar.tsx)) — server-fetched booking-day dots, ←/→ month nav with live re-fetch via `getMonthBookingDays`, click-day → `/agenda?date=YYYY-MM-DD`. ARIA-labelled chevrons + day buttons.
- [x] **SessionsChart range toggle** ([components/dashboard/sessions-chart.tsx](components/dashboard/sessions-chart.tsx)) — Semana / Mes / 3 meses. Backend `getSessionsChart(range)` buckets correctly (7 days / weeks of month / last 3 calendar months) and the chart adapts column count + label format. Adherence % computed on the fly.
- [x] **Recent patients quick actions** ([components/dashboard/recent-patients.tsx](components/dashboard/recent-patients.tsx)) — per-row "⋯" menu: abrir HC, marcar próximo turno como realizado / ausente (uses `setBookingStatus`), nuevo turno deep-linked to `/agenda`. Outside-click + Escape close. Optimistic refresh on mutation.
- [x] `tsc` clean; `next lint` shows only the pre-existing custom-font notice.

### Sprint 7 — Phase 6 polish (this session)
- [x] **Agenda deep-link** ([app/(app)/agenda/page.tsx](app/%28app%29/agenda/page.tsx), [components/agenda/agenda-client.tsx](components/agenda/agenda-client.tsx)) — the "Nuevo turno" quick-action on the dashboard now lands on `/agenda?new=1&patient=<id>`, which auto-opens the create-booking modal with that patient pre-selected. The URL is scrubbed via `history.replaceState` after opening so a refresh doesn't re-trigger.
- [x] **Notifications wired into mutations**:
    - `createBooking` → `BOOKING_CREATED` to the active practitioner with the patient name + ISO-date link.
    - `updateBooking` on status transition to `CANCELLED` or `NO_SHOW` → `BOOKING_CANCELLED` (with the original date in the body so it's actionable from the bell).
    - `createPatient` → `PATIENT_NEW`.
    - `completeSessionFromSeguimiento` → `PROGRAM_NEARING_DISCHARGE` when remaining ∈ {0, 1}; also auto-flips `TreatmentProgram.status` to `COMPLETED` when the last session is closed.
    - Mercado Pago webhook (`consumeWebhook`) → `PAYMENT_RECEIVED` via `notifyTenantOwners()` since the webhook has no actor context — recipients are the booking's practitioner + every OWNER/ADMIN of the tenant.
- [x] **"+" pinned-KPI picker** ([components/dashboard/pin-kpi-button.tsx](components/dashboard/pin-kpi-button.tsx)) — replaces the inert "+ Agregar" pill on the dashboard's pinned-KPI row. Modal mirrors the same `KPI_OPTIONS` whitelist as the profile-menu Settings modal but stays scoped to KPIs; selection order is numbered (1..6) so the user can re-order by re-clicking.
- [x] `tsc` clean; `next lint` shows only the pre-existing custom-font notice.

### Next iterations (open)
- [ ] **Phase 7 — workspace mockup → full flow**:
    - Pacientes sortable columns + archive + bulk export + advanced filters.
    - Agenda drag-to-reschedule + practitioner filter + recurring + .ics + send-reminder.
    - Seguimiento substitute-exercise on the fly + drag-reorder + add ad-hoc exercise.
    - Biblioteca tenant-private exercises + favourites + "my plans" templates.
    - Diagnostico draft cases + override + custom condition.
    - Patient portal: plan timeline + check-in + receipts.
- [ ] Practitioner email/password auth (Supabase).
- [ ] Playwright E2E (booking + diagnosis golden paths).
- [ ] Sentry sender (DSN is wired in env).
- [ ] Public booking → Mercado Pago end-to-end test once MP sandbox keys exist.
