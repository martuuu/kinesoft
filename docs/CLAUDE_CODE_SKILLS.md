# Claude Code — Top 10 skills/practices for this SaaS

Curated for KineSoft (multi-tenant PHI SaaS, Next.js + Prisma + Supabase +
Vercel, solo/small team). Ranked by ROI. **This doc only documents them** —
nothing here is wired up yet; each entry says how to activate when you want it.
Mix of dev-loop and infra/ops.

> Terminology: "skills" here spans built-in slash commands, settings hooks, MCP
> servers, subagents/workflows, and custom project skills — i.e. everything
> that makes Claude Code more effective on this repo.

---

## Dev loop

### 1. `/code-review` (and `ultra` for big changes) — **highest ROI**
Reviews the current diff for correctness bugs + simplification. Run it before
every merge. For a multi-tenant app, the bugs it catches (a missing `tenantId`
filter, a stale-state mutation, a copago precedence slip) are exactly the
expensive ones. `--fix` applies findings; `--comment` posts inline on a PR;
`/code-review ultra` runs a deep multi-agent cloud review of the branch.
**Activate:** `/code-review` (already available). Make it a habit per feature.

### 2. `/security-review` — non-negotiable for PHI + multitenancy
Security pass over pending changes: authz gaps, tenant-isolation leaks,
injection, secret handling. Run before any release that touches auth, RLS,
billing, public surfaces, or file upload. **Activate:** `/security-review`
(available). Gate releases on it.

### 3. Post-edit hooks: auto typecheck + lint (`settings.json`)
A `PostToolUse` hook that runs `tsc --noEmit` (or `eslint --fix`) after Claude
edits a `.ts/.tsx` file gives instant feedback instead of discovering errors at
build time. The harness runs the hook, not the model — so it's reliable.
**Activate:** add a hook to `.claude/settings.json` (the `update-config` skill
can do this). Keep it scoped/fast (lint the changed file, full `tsc` on demand).

### 4. CI gate via GitHub Actions
A workflow running `npm run typecheck` + `next build` (later `vitest`) on every
PR so red never reaches `main`/Vercel. This is ROADMAP session `ci-gate-minimo`
(Etapa 1, Ola 1.0). Claude Code can
scaffold and maintain `.github/workflows/ci.yml`. **Activate:** ask Claude to
create the workflow; add branch protection requiring it green.

### 5. `/verify` + `/run` — exercise the real app, not just types
`/run` launches the app; `/verify` drives it to confirm a change actually
works (e.g. create a multi-turno and check the days land correctly). Catches
the class of bug that compiles but misbehaves — the multi-turno/timezone family
this project has hit repeatedly. **Activate:** `/run` / `/verify` (available).

### 6. Subagents + Workflows — parallel audits & fan-out
For audits, migrations, and "review every X" sweeps, fan out parallel agents
and adversarially verify findings (this repo's recent 5-finding hardening was
done this way). Massive leverage on breadth-heavy work. **Activate:** the Agent
tool / `Workflow` (available); reach for it on audits, big refactors, repo-wide
changes.

---

## Context & ops

### 7. Persistent memory + plan mode — continuity & safe big changes
The file-based memory (`MEMORY.md` + `project-*.md`) carries the env-split
footgun, the timezone invariant, and the roadmap across sessions so they're not
re-learned every time. Plan mode (plan-then-execute) keeps large changes
reviewable before any edit. **Activate:** already in use — keep memories current
and prefer plan mode for multi-file work.

### 8. Supabase MCP server — DB introspection from the editor
An MCP server for Supabase lets Claude inspect the live schema, run read-only
queries, and check migration status without you shuttling SQL by hand — useful
given the `.env`/`.env.local` footgun and prod-only columns. **Activate:** add
the Supabase MCP server to your MCP config (scope it read-only against prod;
read/write against local Docker).

### 9. Sentry MCP server — prod error triage in the dev loop
Once Sentry is wired (ROADMAP session `sentry-observabilidad`, Etapa 1, Ola 1.4),
the Sentry MCP pulls error groups +
stack traces into the conversation so Claude can triage and fix from the actual
prod signal. **Activate:** wire `SENTRY_DSN`, then add the Sentry MCP server.

### 10. Custom `/deploy` + `/migrate` project skills — encode the runbook
Project skills (in `.claude/skills/`) that wrap the dangerous procedures:
`/migrate` (author + apply to local, never bare-prisma against prod) and
`/deploy` (pre-deploy checks: pending migrations, required env vars, `DIRECT_URL`
present). Turns the [DEPLOYMENT.md](DEPLOYMENT.md) runbook into one safe
command and prevents repeats of the "migration only applied locally" outage.
**Activate:** create skill files under `.claude/skills/`.

---

## Honorable mentions
- **`/simplify`** — quality-only cleanup of changed code (no bug hunt); good
  after a feature lands, especially for the oversized components.
- **`fewer-permission-prompts`** — scans transcripts and allowlists your common
  safe Bash/MCP calls in `.claude/settings.json` to cut interruptions.
- **husky pre-commit** — local `tsc`/lint gate before a commit (belt to CI's
  suspenders).
- **`/loop` + `schedule`** — recurring ops (watch a deploy, nightly audit).

## Suggested adoption order
1–2 (review + security) and 5 (verify) cost nothing — adopt today. Then 3 + 4
(hooks + CI) for an automated safety net. Then 8/10 (Supabase MCP + deploy
skills) to de-risk the DB/deploy footguns. 9 (Sentry MCP) follows once Sentry
is wired.
