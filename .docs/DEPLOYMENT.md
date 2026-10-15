# KineSoft — Deployment & Operations Runbook

How the environments fit together, how migrations flow, and the procedures
that bite if you get them wrong.

## The environment split (read this first)

| File | Points at | Used by |
| --- | --- | --- |
| `.env` | Historically a **hand-toggled DEV/PROD** file. **Target (A0b, 2026-09-29): DEV only** — delete the commented PROD block | Prisma CLI and `@prisma/client` (both auto-load it) |
| `.env.local` | **Local Docker** (`localhost:5433`, app role `kinesoft_app`) | `next dev`, the `prisma:*` scripts, tests |
| `.env.prod.local` | **Supabase prod** (owner `DIRECT_URL` + `DATABASE_URL`) — gitignored, created by the owner | only the `db:prod:*` scripts |

**The footgun:** Next.js loads `.env.local` over `.env`, but the **Prisma CLI
and `@prisma/client` load `.env`**. Whatever `.env` points to is what a bare
`prisma …` or a script hits. That's why: local scripts are wrapped with
`dotenv -e .env.local`; prod operations go ONLY through `db:prod:*`
(`.env.prod.local`); and every seed/script calls `assertSafeTarget`
(`scripts/lib/assert-safe-target.ts`), which prints the real target, refuses a
remote DB for local-only seeds, and requires `KINESOFT_CONFIRM_PROD=<project
ref>` for the few scripts allowed against prod.

```bash
npm run prisma:migrate   # dotenv -e .env.local -- prisma migrate dev   → local Docker
npm run prisma:seed      #                                              → local Docker
npm run prisma:studio    #                                              → local Docker
npm run prisma:reset     # prisma migrate reset                          → local Docker (wipes!)
npm run db:prod:status   # prisma migrate status  (.env.prod.local)     → Supabase PROD (read)
npm run db:prod:backup   # pg_dump -Fc → ~/kinesoft-backups/            → Supabase PROD (read)
npm run db:prod:deploy   # prisma migrate deploy  (.env.prod.local)     → Supabase PROD (owner only)
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
4. `npx dotenv -e .env.local -- npx prisma migrate deploy` → applies to **local**; verify object by object and
   run the integration suite. **Not** `npm run prisma:migrate` (= `migrate dev`): it detects drift, proposes a
   reset and can drop the hand-written partial indexes (Booking, Location, ScheduleException, PayerPlan…).
5. Commit (the owner; agents never commit or push).

### Migrations on deploy (Production only, since A0b)

`vercel.json` → `node scripts/vercel-build.mjs`:

```
VERCEL_ENV=production → prisma migrate deploy && prisma generate && next build
anything else         →                          prisma generate && next build
```

So **only Production deploys apply pending migrations** (idempotent — applied
ones are skipped; a failing migration fails the deploy). Until A0b every
Preview build migrated too, and Previews shared the prod DB: any pushed branch
with a migration hit prod before review (AUDIT H6). Previews must point at
**staging** (EXTERNAL-CONFIG §Staging).

**Order for a block with migrations** (the agent writes the exact list):
1. read-only prechecks against prod (queries in MIGRACIONES-RUNBOOK);
2. `npm run db:prod:backup`;
3. apply + QA on **staging**;
4. merge to `main` → the Production build applies them (or `npm run
   db:prod:deploy` beforehand, then deploy).

> ⚠️ **Vercel env must include `DIRECT_URL`** (not just `DATABASE_URL`) —
> `migrate deploy` uses the direct connection. Without it, the build step
> can't migrate. Confirm in Vercel → Project → Settings → Environment Variables.

**History:** the symptom that prompted this — a deploy threw a server-side
exception because `Booking.seriesId` existed in the Prisma client but not in
Supabase (the migration was only applied locally). The auto-migrate closes
that gap. If you ever need to apply manually: `npm run db:prod:deploy`.

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
| 25 | `20260930120000_tenant_onboarding` | Bloque A3c (30-sep-2026) | `Tenant.onboardingCompletedAt/phone/whatsapp/publicEmail` (nullable) + backfill `onboardingCompletedAt = createdAt`. **Exact order, prechecks and post-check in [MIGRACIONES-RUNBOOK.md §2.1](MIGRACIONES-RUNBOOK.md)** (A3 needs the owner's SMTP first; A3b never ships without A3c) |
| 26 | `20260930200000_catalog_global` | B-pre (30-sep-2026) | Global catalog (Specialty, Practice, PracticeSpecialty, Payer, PayerPlan, CatalogImportRun) + nullable `Insurer.payerId`, `Coverage.payerPlanId`, `Service.practiceId` + **global read-only RLS** (SELECT-only policies) and split PayerPlan. No backfill |
| 27 | `20261001090000_agenda_foundations` | B-pre (01-oct-2026) | Location, PractitionerSchedule, ScheduleException, TimeBlock, PractitionerService/Payer/Specialty, Booking expand (`locationId`, `isOverbooked`, reception, telemedicine), `UserPreferences.agendaPrefs`, RLS + **idempotent backfill** that needs a BYPASSRLS migrating role. **Order, prechecks, expected counts and post-deploy in [MIGRACIONES-RUNBOOK.md §2.2](MIGRACIONES-RUNBOOK.md)** |

> ⚠️ **B-pre ships TWO new migrations (#26, #27).** Both are additive: apply
> them **before or together with** the code, never after. #27 runs its
> backfill with `SET LOCAL row_security = off` — `DIRECT_URL` must be the owner
> (`rolsuper` or `rolbypassrls`) or the migration fails on purpose. After the
> code is live: the `isOverbooked` UPDATE for the deploy gap, re-run the
> backfill if tenants/practitioners were created in between, then the catalog
> import (owner) + "Refrescar catálogo". B-pre can ship alone or in the same
> deploy as the (already committed) Bloque A; **A3 still needs the owner's SMTP**.

> ⚠️ **#22 also creates RLS policies.** It runs `ENABLE`/`FORCE ROW LEVEL
> SECURITY` on `ExerciseMedia` + `ExerciseArticle` with a read-only policy
> (`FOR SELECT USING (true)`) and **no write policy**. Consequence: once prod's
> app role is a non-BYPASSRLS role, the Plataforma panel can only write those
> tables through `DATABASE_URL_SERVICE`. Applying #22 without provisioning
> `kinesoft_service` first means superadmin catalog writes fail.

**Apply them** (owner / `DIRECT_URL` connection — `migrate deploy` is
idempotent and skips what's already applied):

```bash
# Preferred: just deploy — the Production build runs this for you.
npm run db:prod:status && npm run db:prod:backup && npm run db:prod:deploy

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
| `SUPABASE_SERVICE_ROLE_KEY` | Admin ops (invites, storage — incl. the `exercise-media` bucket). Desde SV también el POST de Broadcast del publisher realtime (`lib/realtime-publisher-internal.ts`, server-only) | ✅ required |
| `REALTIME_DRIVER` | Sala de Espera en vivo (SV): `off` (default; app idéntica a SR, `/sala` con polling de 60 s) · `local` (bus en memoria + SSE, **solo dev**) · `supabase` (Broadcast privado). Production: `local` hace fallar el build; `supabase` exige `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` y `_ANON_KEY` (`lib/env.ts`). Se lee al cargar el módulo: cambiarla pide **redeploy** | 🆕 arrancar en `off`; `supabase` después de V1-V7 en staging ([EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md), RUNBOOK «Deploy de SV») |
| `SUPABASE_JWT_SECRET` | Secreto HS256 con el que el server firma el token corto (10 min) del canal realtime (`lib/realtime-token-internal.ts`). **Server-only**, nunca `NEXT_PUBLIC_` (guard (d)): con él se firma un token `authenticated` del proyecto | 🆕 required con `REALTIME_DRIVER=supabase` |
| `SUPABASE_JWT_KID` | `kid` del header del token, solo si la clave HS256 es del sistema nuevo de JWT Signing Keys (con el secreto legacy, vacío; `""` = ausente) | 🆕 opcional (R4) |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | Mercado Pago checkout | ✅ required for payments |
| `MP_WEBHOOK_SECRET` | Webhook signature verification | ✅ required (prod refuses 503 without it) |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs (emails, redirects) | ✅ set to the prod domain |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Distributed rate limiting (sa-east-1; separate DB for staging). Since A3a a failing Upstash falls back to memory with a log | ⚠️ **NOT set — see EXTERNAL-CONFIG.md §0.1/§4** |
| `SENTRY_DSN` | Error reporting + CSP reports (build **and** runtime). No-op when absent. Optional: `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` (sourcemaps), `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG` | ⚠️ code ready since A3b (30-sep-2026); DSN not set |
| System Environment Variables (`VERCEL_ENV`) | CSP/HSTS/`allowedOrigins` are computed at build time from `VERCEL_ENV` | ⚠️ "Automatically expose System Environment Variables" must be ON |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | optional (default `info`) |
| `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_REPLY_TO` | Mails propios (IAM, ADR-007). Production sin key o sin from → los mails van a `log` (warning al arrancar); Preview nunca manda. `EMAIL_REPLY_TO` opcional | ⚠️ owner — [EXTERNAL-CONFIG §0.4](EXTERNAL-CONFIG.md) |
| `TENANT_ACCESS_ENFORCEMENT` | BO1: `off` \| `banner` (default) \| `enforce`. Qué pasa con un consultorio en prueba vencida o impago (`banner` avisa; suspendido/baja se respetan igual) | 🆕 dejar vacía (= `banner`); `enforce` cuando Martin decida |
| `PLATFORM_MFA_ENFORCEMENT` | BO4: `off` (default) \| `enforce`. TOTP obligatorio para superadmins + re-verificación en acciones de riesgo | 🆕 `off` al deployar → enrolar → `enforce` + redeploy |
| `MAINTENANCE_MODE` / `MAINTENANCE_MESSAGE` | BO5-B: `on` cierra la app con 503 (`/mantenimiento`); webhooks MP, `/api/health` y crons pasan. El mensaje es público (máx. 280) | 🆕 vacías (= `off`); se leen en el edge: cambiar pide **redeploy** |
| `CRON_SECRET` | BO5-A: `Authorization: Bearer` que Vercel manda a `/api/cron/*`. Sin él: 503 en Production y los crons no corren | 🆕 required (`openssl rand -hex 32`, Production) |

## Prod one-time setup (owner)

Steps that are **done locally but not in prod**. Each is a manual, one-time
owner action; see EXTERNAL-CONFIG.md for the ownership/gate framing.

### 1. Provision the DB roles (unblocks real RLS)

Run `prisma/roles.supabase.sql` with **psql** and the owner connection
(`postgres` has CREATEROLE), **after** `prisma migrate deploy`, passing the
passwords as psql variables — they are never written in the file, and
re-running it **rotates** them (A0b):

```bash
psql "$OWNER_URL" -v app_password="$(openssl rand -base64 32)" \
  -v service_password="$(openssl rand -base64 32)" -f prisma/roles.supabase.sql
```

It creates two roles, idempotently:

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
(`DATABASE_URL` is required — no localhost fallback since A0b — and prod also
needs `KINESOFT_CONFIRM_PROD=<project ref>`; the script prints its target):

```bash
# grant (the user must already exist as a UserProfile — i.e. have signed in once)
DATABASE_URL="<owner conn>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts you@example.com

# revoke
DATABASE_URL="<owner conn>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts someone@x.com --revoke

# list current admins
DATABASE_URL="<owner conn>" KINESOFT_CONFIRM_PROD=<ref> npx tsx scripts/set-platform-admin.ts --list
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
  3. Re-apply: `npm run db:prod:deploy` (recreates schema from migrations).
  4. Re-seed the tenant(s) as needed — **never with `prisma/seed.ts`** (demo
     data; it is local-only and aborts against a remote DB).
  5. Re-create the Particular insurer + base catalog per tenant.

## Deploy de B-pre (agenda y catálogo, 01-oct-2026)

Exact runbook: [MIGRACIONES-RUNBOOK.md §2.2](MIGRACIONES-RUNBOOK.md). Summary:

1. Read-only prechecks (migrating role has BYPASSRLS; new tables absent; tenants/practitioners/insurers/
   `[SOBRETURNO]` counts; bookings of a service owned by another practitioner).
2. `npm run db:prod:backup`.
3. **Staging**: `migrate deploy` (#26, #27) → compare expected counts → QA ([QA.md §B-pre](QA.md), `TZ=UTC`) →
   catalog import in staging.
4. Merge to `main` (the Production build migrates) — or `npm run db:prod:deploy` beforehand.
5. Post-deploy: `UPDATE "Booking" SET "isOverbooked"=true WHERE notes LIKE '[SOBRETURNO]%' AND NOT "isOverbooked";`,
   expected counts (Location = #tenants; PractitionerSchedule = 6 × accepted practitioners;
   `Booking.locationId IS NULL` = 0), re-run the backfill block if needed (idempotent, GUC
   `kinesoft.backfill_tenants`).
6. Catalog import (owner): backup → dry-run → `--apply` → dry-run = 0 changes → Plataforma → Catálogo →
   Importaciones → **"Refrescar catálogo"**. Local: `npm run catalog:import`.

No new environment variables. No new console tasks besides the import.

## Deploy del bloque BO (back-office, 14-oct-2026)

Orden exacto, prechecks y vuelta atrás en [MIGRACIONES-RUNBOOK «M7 en prod» y «Deploy de BO»](MIGRACIONES-RUNBOOK.md).
Resumen: **M7** (aditiva, puede ir antes) → variables con los flags en default (`TENANT_ACCESS_ENFORCEMENT` = `banner`,
`PLATFORM_MFA_ENFORCEMENT` = `off`, `MAINTENANCE_MODE` = `off`) + `CRON_SECRET` → deploy → enrolar el TOTP en
`/plataforma-mfa/configurar` → `PLATFORM_MFA_ENFORCEMENT=enforce` + redeploy → recién ahí usar soporte.

`vercel.json` desde BO5:
- `functions`: `app/api/consultorio/export/route.ts` 60 s (clave propia **antes** de `app/**/*` 30 s; con Vercel Pro se
  puede subir a 300 s: un consultorio grande puede cortarse en 60 s y el archivo queda como JSON inválido).
- `crons`: `/api/cron/invitations-expire` 06:00 UTC, `/api/cron/health-digest` 11:00 UTC, `/api/cron/trial-reminders`
  12:00 UTC (09:00 AR). Hobby: una vez por día y hora inexacta; Pro: hora exacta. Solo corren en Production.

## Deploy flow (summary)

```
local Docker (.env.local)  →  test  →  commit (owner)  →  staging (Preview)  →  QA
  →  prod precheck + backup  →  merge to main  →  Vercel Production:
     prisma migrate deploy  →  prisma generate  →  next build  →  live
```

Preview deploys must use **staging**, not the prod DB (A0d, owner). Keep
migrations additive/backward-compatible (expand/contract) anyway.
