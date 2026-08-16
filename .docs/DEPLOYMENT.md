# KineSoft — Deployment & Operations Runbook

How the environments fit together, how migrations flow, and the procedures
that bite if you get them wrong.

## The environment split (read this first)

| File | Points at | Used by |
| --- | --- | --- |
| `.env` | **Supabase prod** (pooler `DATABASE_URL` :6543 + direct `DIRECT_URL` :5432 + service key) | Prisma CLI, `npm run build`, prod runtime |
| `.env.local` | **Local Docker** (`postgresql://kinesoft:kinesoft@localhost:5433/kinesoft`) | `next dev`, the `prisma:*` scripts |

**The footgun:** Next.js loads `.env.local` over `.env`, but the **Prisma CLI
loads only `.env`** (= prod). So a bare `prisma migrate dev` from your machine
hits **Supabase prod**. That's why the local scripts are wrapped with
`dotenv -e .env.local`. Never run a bare `prisma migrate …`; use the npm
scripts below.

```bash
npm run prisma:migrate   # dotenv -e .env.local -- prisma migrate dev   → local Docker
npm run prisma:seed      #                                              → local Docker
npm run prisma:studio    #                                              → local Docker
npm run prisma:reset     # prisma migrate reset                          → local Docker (wipes!)
npm run db:deploy        # prisma migrate deploy (ambient .env)          → Supabase PROD
```

## Local dev setup

```bash
# 1) deps
npm ci

# 2) database (Docker Postgres on :5433)
docker compose up -d db
npm run prisma:migrate     # apply migrations to local
npm run prisma:seed        # seed demo tenant (movare) + catalog

# 3) run
npm run dev                # http://localhost:3000
```

`KINESOFT_ALLOW_DEMO_ACTOR=1` in `.env.local` lets you work without a Supabase
session (falls back to the seeded `movare` tenant). **Never in prod** —
`lib/session.ts` also gates it on `NODE_ENV !== "production"`.

## Migrations

Hand-authored SQL under `prisma/migrations/<timestamp>_<name>/migration.sql`
(not generated). After a schema edit:

1. Edit `prisma/schema.prisma`.
2. `npx prisma generate` (refreshes the client + typecheck; no DB needed).
3. Write the migration SQL.
4. `npm run prisma:migrate` → applies to **local** and lets you test it.
5. Commit + push.

### Migrations on deploy (automatic since this pass)

`vercel.json` `buildCommand`:

```
prisma migrate deploy && prisma generate && next build
```

So **every Vercel deploy applies pending migrations to Supabase** before
building (idempotent — applied ones are skipped). If a migration fails, the
deploy fails (fail-fast — don't ship a code/schema mismatch).

> ⚠️ **Vercel env must include `DIRECT_URL`** (not just `DATABASE_URL`) —
> `migrate deploy` uses the direct connection. Without it, the build step
> can't migrate. Confirm in Vercel → Project → Settings → Environment Variables.

**History:** the symptom that prompted this — a deploy threw a server-side
exception because `Booking.seriesId` existed in the Prisma client but not in
Supabase (the migration was only applied locally). The auto-migrate closes
that gap. If you ever need to apply manually: `npm run db:deploy`.

### Migraciones pendientes de aplicar en producción

Rondas 4-9 ran entirely against **local Docker** — prod was deliberately left
untouched. The full history in `prisma/migrations/`, in order:

| # | Migration | Ronda / note |
| --- | --- | --- |
| 1 | `20260518134107_init` | baseline |
| 2 | `20260519013041_sprint5` | baseline |
| 3 | `20260519234538_sprint_9_plans_favorites_templates` | baseline |
| 4 | `20260520170944_sprint_13_insurers_invitations_manual_therapy` | baseline |
| 5 | `20260523234642_sprint_16_perf_indexes` | baseline |
| 6 | `20260524002341_sprint_16_patient_share` | baseline |
| 7 | `20260525000000_sprint_17_business_hours` | baseline |
| 8 | `20260525001000_sprint_17_custom_conditions` | baseline |
| 9 | `20260614120000_sprint_18_audit_fixes` | baseline |
| 10 | `20260615120000_sprint_18_copago_overrides` | baseline |
| 11 | `20260615140000_sprint_18_insurer_paid` | baseline |
| 12 | `20260616120000_booking_series_id` | baseline |
| 13 | `20260723213701_payment_expected_amount_and_delete_restrict` | Ronda 2 — anchored payment amount |
| 14 | `20260725120000_rls_policies` | Ola B2 — **all** RLS policies |
| 15 | `20260730120000_service_max_concurrent` | `Service.maxConcurrent` (overlap capacity) |

**Applied in LOCAL, PENDING in PROD** (verify each against
`_prisma_migrations` before assuming otherwise):

| # | Migration | Ronda | What it does |
| --- | --- | --- | --- |
| 16 | `20260802220514_wave_service_color_booking_title_patient_diagnosis` | 4 | `Service.color`, `Booking.title/description`, `Patient.diagnosisTitle/diagnosisNote` (additive) |
| 17 | `20260802232454_notification_kind_patient_shared` | 5 | `NotificationKind += PATIENT_SHARED` (isolated enum migration) |
| 18 | `20260803002623_booking_patient_slot_active_unique` | 6 | partial unique index `Booking_tenant_patient_slot_active_key` — the race-free anti-duplicate backstop |
| 19 | `20260803022526_platform_admin_flag` | 7 | `UserProfile.isPlatformAdmin` |
| 20 | `20260803022544_tagkind_add_muscle_discipline` | 7 | `TagKind += MUSCLE_GROUP, DISCIPLINE` (isolated enum migration) |
| 21 | `20260803022626_exercise_optional_reps_and_archive` | 7 | `Exercise`: `defaultSets`/`defaultReps` → nullable (drops NOT NULL + defaults), `+durationSeconds`, `+archivedAt` + index |
| 22 | `20260803022653_exercise_media_and_article` | 7 | `ExerciseMediaType` enum, `ExerciseMedia` + `ExerciseArticle` tables, FKs, indexes — **and RLS policies** |
| 23 | `20260803183019_user_prefs_catalog` | 8 | `UserPreferences.catalogPrefs Json?` |
| 24 | `20260816014954_tenant_agenda_slot_minutes` | post-9 (in flight, 2026-08-16) | `Tenant.agendaSlotMinutes INTEGER NOT NULL DEFAULT 60` (configurable agenda slot granularity; additive, safe default) |

> ⚠️ **#22 also creates RLS policies.** It runs `ENABLE`/`FORCE ROW LEVEL
> SECURITY` on `ExerciseMedia` + `ExerciseArticle` with a read-only policy
> (`FOR SELECT USING (true)`) and **no write policy**. Consequence: once prod's
> app role is a non-BYPASSRLS role, the Plataforma panel can only write those
> tables through `DATABASE_URL_SERVICE`. Applying #22 without provisioning
> `kinesoft_service` first means superadmin catalog writes fail.

**Apply them** (owner / `DIRECT_URL` connection — `migrate deploy` is
idempotent and skips what's already applied):

```bash
# Preferred: just deploy — vercel.json's buildCommand runs this for you.
npm run db:deploy                        # = prisma migrate deploy, ambient .env

# Manual / out-of-band, explicit owner connection:
DATABASE_URL="<owner conn>" DIRECT_URL="<owner direct conn>" \
  npx prisma migrate deploy
```

Take a Supabase snapshot first. #21 relaxes NOT NULL and #17/#20 add enum
values — all forward-compatible, but none of them are trivially reversible.
Keep this table updated as new migrations land.

## Required environment variables

From `lib/env.ts` (all optional in the schema, but prod needs the real ones):

| Var | Purpose | Prod status |
| --- | --- | --- |
| `DATABASE_URL` | **App-role** runtime connection (pooler). Must be the role **without** BYPASSRLS so `FORCE ROW LEVEL SECURITY` actually evaluates — locally `kinesoft_app` (`prisma/roles.local.sql`); in prod `kinesoft_app` per `prisma/roles.supabase.sql`. | ✅ required · ⚠️ **still points at a BYPASSRLS role in prod** — see "Prod one-time setup" |
| `DIRECT_URL` | **Owner-role** direct connection (:5432, no pooler). Used by `prisma migrate deploy` and as the local fallback for the service channel. | ✅ required (for auto-migrate) |
| `DATABASE_URL_SERVICE` | **Service-role** connection — the dedicated **BYPASSRLS** role `kinesoft_service`. Used by `prismaService` (`lib/db.ts`) for Actor-less surfaces (MP webhook, public booking, job audit writes) **and by every superadmin write to the global exercise catalog**. Resolution order is `DATABASE_URL_SERVICE` → `DIRECT_URL` → `DATABASE_URL`, so **local needs nothing** (falls back to the Docker owner). | ⚠️ **required in prod** — without it the service channel falls back to `DIRECT_URL`; once prod's app role is flipped, missing/incorrect and the Plataforma panel can't write the catalog |
| `KINESOFT_ALLOW_DEMO_ACTOR` | Local-dev escape hatch (`=1` → seeded `movare` tenant with no Supabase session). | 🚫 **must NEVER be set in prod** (`lib/session.ts` also gates on `NODE_ENV !== "production"`, but do not rely on that alone) |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Supabase Auth client | ✅ required |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin ops (invites, storage — incl. the `exercise-media` bucket) | ✅ required |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | Mercado Pago checkout | ✅ required for payments |
| `MP_WEBHOOK_SECRET` | Webhook signature verification | ✅ required (prod refuses 503 without it) |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs (emails, redirects) | ✅ set to the prod domain |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Distributed rate limiting | ⚠️ **NOT set — see EXTERNAL-CONFIG.md (Upstash) / AUDIT.md `c1-ratelimit-inmemory`** |
| `SENTRY_DSN` | Error reporting | ⚠️ not wired yet |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | optional (default `info`) |

## Prod one-time setup (owner)

Steps that are **done locally but not in prod**. Each is a manual, one-time
owner action; see EXTERNAL-CONFIG.md for the ownership/gate framing.

### 1. Provision the DB roles (unblocks real RLS)

Paste `prisma/roles.supabase.sql` into the Supabase SQL editor (it runs as
`postgres`, which has CREATEROLE) **after** `prisma migrate deploy`. It creates
two roles, idempotently, with placeholder passwords you must replace:

- `kinesoft_app` — `NOSUPERUSER NOBYPASSRLS` → goes in **`DATABASE_URL`**.
  This flip is what makes RLS stop being inert in prod.
- `kinesoft_service` — `BYPASSRLS` → goes in **`DATABASE_URL_SERVICE`**.

Then set both in Vercel and redeploy. Verify with
`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kinesoft%';`.

> `GRANT … ON ALL TABLES` is a point-in-time snapshot. The
> `ALTER DEFAULT PRIVILEGES` blocks in that file cover future tables **only if
> `postgres` creates them**. After any migration that adds tables, re-run the
> two GRANT blocks if unsure.

### 2. Create the `exercise-media` Storage bucket

Exercise uploads (`lib/exercise-media.ts`) write to a Supabase Storage bucket
literally named **`exercise-media`**. It does **not** exist in prod yet and is
not created by code — the owner must create it in the Supabase dashboard,
**private** (access is by 1-hour signed URL only, same posture as
`patient-files`). Without it, every video/image/GIF upload in
`/plataforma/ejercicios` fails; YouTube-type media still works (it stores a
link, not a file).

### 3. Grant platform-superadmin

`UserProfile.isPlatformAdmin` has no in-app grant path — it is set at the DB
level with `scripts/set-platform-admin.ts`, run with the **owner** connection
(the script defaults to the local Docker URL if `DATABASE_URL` is unset, so
always pass it explicitly for prod):

```bash
# grant (the user must already exist as a UserProfile — i.e. have signed in once)
DATABASE_URL="<owner conn>" npx tsx scripts/set-platform-admin.ts you@example.com

# revoke
DATABASE_URL="<owner conn>" npx tsx scripts/set-platform-admin.ts someone@x.com --revoke

# list current admins
DATABASE_URL="<owner conn>" npx tsx scripts/set-platform-admin.ts --list
```

The email is lower-cased and must match an existing `UserProfile.email`; the
script exits non-zero if there's no such user. Grant it to the owner (and the
client, if they author the catalog) after the migrations land.

## DB reset (start clean)

On the table once the product is validated for selling. **Destructive.**

- **Local:** `npm run prisma:reset` (drops + re-migrates + re-seeds the Docker DB).
- **Prod (Supabase):** do NOT use `migrate reset` against prod casually.
  Procedure when intentional:
  1. Announce downtime; take a Supabase backup/snapshot first.
  2. In the Supabase SQL editor, drop the schema or truncate domain tables
     (keep `_prisma_migrations` or re-baseline).
  3. Re-apply: `npm run db:deploy` (recreates schema from migrations).
  4. Re-seed the tenant(s) as needed.
  5. Re-create the Particular insurer + base catalog per tenant.

## Deploy flow (summary)

```
local Docker (.env.local)  →  test  →  git push  →  Vercel:
    prisma migrate deploy (Supabase)  →  prisma generate  →  next build  →  live
```

One Supabase DB backs prod. Preview deploys share it — keep migrations
additive/backward-compatible so a preview build doesn't break prod data.
