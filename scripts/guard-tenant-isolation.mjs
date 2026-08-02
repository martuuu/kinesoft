#!/usr/bin/env node
/**
 * Tenant-isolation drift guard (Ola B2).
 *
 * Reconciles the two lists that must never diverge:
 *   1. Prisma models that carry a `tenantId` column (schema.prisma).
 *   2. Tables covered by the RLS policies migration.
 *
 * FAILS (exit 1) if a model has `tenantId` but no RLS policy and is NOT on
 * the documented exclusion allowlist. This is what stops a future tenant
 * table from silently shipping without isolation.
 *
 * Also prints a SOFT report of Actor-facing modules that still call
 * `prisma.<rlsModel>.<op>` outside a runWithRls wrap (potential wrap-miss).
 * The soft report never fails the build — it is advisory.
 *
 * Usage: node scripts/guard-tenant-isolation.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const MIGRATION = join(
  ROOT,
  "prisma",
  "migrations",
  "20260725120000_rls_policies",
  "migration.sql"
);

// Models intentionally excluded from tenant-RLS. Keep this list tiny and
// documented — every entry is a deliberate design decision.
const ALLOWLIST = new Set([
  "UserPreferences", // userId-scoped: one row per user, `tenantId` is a mutable "active tenant" pointer, not ownership.
  "Favorite", // userId-scoped: keyed (userId, exerciseId); tenantId is a denormalised filter.
]);

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

function fail(msg) {
  console.error(RED(`✗ ${msg}`));
  process.exitCode = 1;
}

// ── 1. Parse schema: all models, and which carry `tenantId` ───────────
const schema = readFileSync(SCHEMA, "utf8");
const allModels = new Set();
const tenantIdModels = new Set();
{
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(schema))) {
    const [, name, body] = m;
    allModels.add(name);
    if (/^\s*tenantId\s+/m.test(body)) tenantIdModels.add(name);
  }
}

// ── 2. Parse migration: which model tables get a policy ───────────────
const migration = readFileSync(MIGRATION, "utf8");
const policied = new Set();
for (const name of allModels) {
  // Model appears quoted in the migration (in the ENABLE array or a
  // CREATE POLICY ... ON "Name"), as 'Name' or "Name".
  const re = new RegExp(`['"]${name}['"]`);
  if (re.test(migration)) policied.add(name);
}

// ── 3. Reconcile ──────────────────────────────────────────────────────
console.log(`Models with tenantId: ${tenantIdModels.size}`);
console.log(`Models with RLS policy in migration: ${policied.size}`);

const missing = [];
for (const name of tenantIdModels) {
  if (policied.has(name)) continue;
  if (ALLOWLIST.has(name)) continue;
  missing.push(name);
}

if (missing.length) {
  fail(
    `These models carry tenantId but have NO RLS policy and are NOT allowlisted:\n    ${missing.join(
      ", "
    )}\n  → add them to the policies migration, or (if userId-scoped) to the ALLOWLIST in this script.`
  );
} else {
  console.log(GREEN("✓ Every tenantId model is policied or explicitly allowlisted."));
}

// Warn if an allowlisted model somehow gained a policy (contradiction).
for (const name of ALLOWLIST) {
  if (policied.has(name)) {
    console.log(
      YELLOW(
        `⚠ ${name} is on the RLS exclusion allowlist but ALSO has a policy in the migration — resolve the contradiction.`
      )
    );
  }
}

// ── 4. SOFT report: unwrapped prisma.<rlsModel> in Actor-facing code ──
// Advisory only. RLS models as lowercase Prisma delegate names.
const rlsDelegates = new Set(
  [...tenantIdModels, ...policied]
    .filter((n) => !ALLOWLIST.has(n))
    .map((n) => n[0].toLowerCase() + n.slice(1))
);
// Files that legitimately use the BYPASSRLS channel — skip them.
const SERVICE_FILES = new Set([
  "lib/public-booking.ts",
  "lib/public-booking-internal.ts",
  "lib/mercadopago.ts",
  "lib/audit.ts",
  "lib/audit-extension.ts",
  "lib/portal.ts",
  "lib/auth.ts",
  "lib/session.ts",
  "app/api/booking/checkout/route.ts",
  "app/auth/callback/route.ts",
  "app/invite/[token]/accept-action.ts",
  "app/invite/[token]/page.tsx",
]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !full.includes("/migrations/")) acc.push(full);
  }
  return acc;
}

const suspects = [];
for (const file of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]) {
  const rel = file.slice(ROOT.length + 1);
  if (SERVICE_FILES.has(rel)) continue;
  const src = readFileSync(file, "utf8");
  // Only consider files using the Actor-facing `prisma` (not prismaService only).
  if (!/import\s*\{[^}]*\bprisma\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(src)) continue;
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    // Skip type-level references (`typeof prisma.x.findMany`) — not runtime.
    if (/typeof\s+prisma\./.test(line)) return;
    const mm = line.match(/(?<!prismaService)\bprisma\.(\w+)\./);
    if (mm && rlsDelegates.has(mm[1])) {
      suspects.push(`${rel}:${i + 1}  prisma.${mm[1]}`);
    }
  });
}

if (suspects.length) {
  console.log(
    YELLOW(
      `\n⚠ Advisory — ${suspects.length} unwrapped prisma.<rlsModel> call(s) in Actor-facing modules (verify each is intentional / wrapped elsewhere):`
    )
  );
  for (const s of suspects.slice(0, 50)) console.log(`    ${s}`);
  if (suspects.length > 50) console.log(`    …and ${suspects.length - 50} more`);
} else {
  console.log(GREEN("✓ No unwrapped prisma.<rlsModel> calls in Actor-facing modules."));
}

process.exit(process.exitCode ?? 0);
