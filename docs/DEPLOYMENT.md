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

## Required environment variables

From `lib/env.ts` (all optional in the schema, but prod needs the real ones):

| Var | Purpose | Prod status |
| --- | --- | --- |
| `DATABASE_URL` | Postgres pooler connection | ✅ required |
| `DIRECT_URL` | Postgres direct (migrations) | ✅ required (for auto-migrate) |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Supabase Auth client | ✅ required |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin ops (invites, storage) | ✅ required |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | Mercado Pago checkout | ✅ required for payments |
| `MP_WEBHOOK_SECRET` | Webhook signature verification | ✅ required (prod refuses 503 without it) |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs (emails, redirects) | ✅ set to the prod domain |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Distributed rate limiting | ⚠️ **NOT set — see EXTERNAL-CONFIG.md (Upstash) / AUDIT.md `c1-ratelimit-inmemory`** |
| `SENTRY_DSN` | Error reporting | ⚠️ not wired yet |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | optional (default `info`) |

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
