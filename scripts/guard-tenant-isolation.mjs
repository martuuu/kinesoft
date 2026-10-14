#!/usr/bin/env node
/**
 * Tenant-isolation drift guard (Ola B2).
 *
 * Reconciles the two lists that must never diverge:
 *   1. Prisma models that carry a `tenantId` column (schema.prisma).
 *   2. Tables with RLS ENABLED and at least one policy, parsed from EVERY
 *      `prisma/migrations/<ts>_<name>/migration.sql`, in timestamp order.
 *
 * FAILS (exit 1) if:
 *   • a model has `tenantId` but no RLS (ENABLE + policy) and is NOT on the
 *     documented exclusion allowlist. This is what stops a future tenant
 *     table from silently shipping without isolation;
 *   • a GLOBAL_READONLY catalog table (B-pre M-cat) is missing ENABLE/FORCE,
 *     has no SELECT policy, or has ANY write policy (ALL/INSERT/UPDATE/DELETE):
 *     the app role must only read the global catalog;
 *   • (BO0, M7 platform_backoffice) a SERVICE_ONLY table is missing ENABLE/
 *     FORCE or has ANY policy (the app role must see nothing; only the
 *     BYPASSRLS service channel touches it), or a TENANT_READONLY table is
 *     missing ENABLE/FORCE, has no `FOR SELECT` policy on
 *     app_current_tenant_id(), or has ANY write policy;
 *   • (EV0, M2 tenant_verticals, plan §15.1) any migration or prisma/roles.*.sql
 *     GRANTs anything to the Supabase Data API roles `anon`/`authenticated`, or
 *     the guarded REVOKE block of M2 disappears. The app never uses PostgREST
 *     and 9 public tables have no RLS (UserProfile.isPlatformAdmin among them).
 *
 * B1.0 (M-cat): before this, the guard only read 20260725120000_rls_policies
 * and counted a table as "policied" if its name merely appeared quoted there.
 * Now it parses ENABLE/FORCE/DISABLE, CREATE/DROP POLICY (with its FOR <cmd>)
 * and the `FOREACH t IN ARRAY ARRAY[...]` loop of the B2 migration, across all
 * migrations. `prisma/migrations/policies.sql` is a redirect stub that nothing
 * applies, so it is deliberately NOT read.
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

// GUARD_ISOLATION_ROOT: solo para tests/unit/guard-tenant-isolation.test.ts, que
// corre el guard real contra un repo de juguete (schema + migraciones) para
// probar que falla ante una tabla con tenantId sin policy. Sin la variable, el repo.
const ROOT = process.env.GUARD_ISOLATION_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const MIGRATIONS_DIR = join(ROOT, "prisma", "migrations");

// Models intentionally excluded from tenant-RLS. Keep this list tiny and
// documented — every entry is a deliberate design decision.
const ALLOWLIST = new Set([
  "UserPreferences", // userId-scoped: one row per user, `tenantId` is a mutable "active tenant" pointer, not ownership.
  "Favorite", // userId-scoped: keyed (userId, exerciseId); tenantId is a denormalised filter.
]);

// Global reference catalog (B-pre M-cat, 20260930200000_catalog_global): no
// tenantId, shared by every tenant, written ONLY by the import script and
// Plataforma over `prismaService` (BYPASSRLS). Contract: ENABLE + FORCE, a
// SELECT policy, and NO write policy → RLS default-deny blocks INSERT/UPDATE/
// DELETE for `kinesoft_app` even though its default GRANTs include them.
// (PayerPlan is NOT here: it has tenantId and a split policy like Exercise.)
const GLOBAL_READONLY = new Set([
  "Specialty",
  "Practice",
  "PracticeSpecialty",
  "Payer",
  "CatalogImportRun",
]);
const WRITE_CMDS = new Set(["ALL", "INSERT", "UPDATE", "DELETE"]);

// BO0 (M7 platform_backoffice, plan §19.5): tablas CON tenantId que la app no
// debe ver nunca. Contrato: ENABLE + FORCE y CERO policies → RLS default-deny
// para `kinesoft_app` con cualquier GUC (tiene el GRANT por default privileges,
// pero sin policy no ve ni escribe nada). Solo el canal service (BYPASSRLS) las
// usa: el registro de plataforma (solo inserción, trigger) y los alias de slug
// que lee el turnero. Que tengan tenantId sin policy NO es un olvido: por eso
// están acá y no caen en el "missing" de abajo.
const SERVICE_ONLY = new Set(["PlatformAuditEvent", "TenantSlugAlias"]);

// BO0 (M7): tablas con tenantId que el consultorio LEE pero que solo escribe la
// plataforma por el canal service. Contrato: ENABLE + FORCE, al menos una policy
// `FOR SELECT` filtrada por app_current_tenant_id() y NINGUNA de escritura
// (ALL/INSERT/UPDATE/DELETE). SupportSession: el OWNER ve quién entró como soporte.
const TENANT_READONLY = new Set(["SupportSession"]);

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

// ── 2. Parse ALL migrations: RLS state per table ──────────────────────
// Replayed in timestamp order so a later DROP POLICY / DISABLE wins.
/** @type {Map<string, {enabled: boolean, forced: boolean, policies: Map<string, string>}>} */
const rls = new Map();
const rlsOf = (t) => {
  if (!rls.has(t)) rls.set(t, { enabled: false, forced: false, policies: new Map(), policyText: new Map() });
  return rls.get(t);
};
const migrationDirs = readdirSync(MIGRATIONS_DIR)
  .filter((d) => /^\d{14}_/.test(d) && statSync(join(MIGRATIONS_DIR, d)).isDirectory())
  .sort();
let migrationFiles = 0;
for (const dir of migrationDirs) {
  const file = join(MIGRATIONS_DIR, dir, "migration.sql");
  let sql;
  try {
    sql = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  migrationFiles++;
  // Strip `-- …` comments so prose mentioning a table never counts.
  sql = sql.replace(/--[^\n]*/g, "");

  // a) Loop form (B2): FOREACH t IN ARRAY ARRAY['A','B',…] LOOP … END LOOP,
  //    whose body ENABLEs/FORCEs RLS or EXECUTEs a `CREATE POLICY %I ON %I …`
  //    (the per-table `<t>_tenant_isolation` policy) for each name.
  const loopRe = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi;
  let lm;
  while ((lm = loopRe.exec(sql))) {
    const names = [...lm[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    const body = lm[2];
    for (const n of names) {
      if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) rlsOf(n).enabled = true;
      if (/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) rlsOf(n).forced = true;
      const cp = body.match(/CREATE\s+POLICY\s+%I\s+ON\s+%I([^']*)'/i);
      if (cp) {
        const cmd = (cp[1].match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1] ?? "ALL").toUpperCase();
        rlsOf(n).policies.set(`${n}_tenant_isolation`, cmd);
      }
    }
  }

  // b) Statement form, in file order.
  const stmtRe =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?\s+(ENABLE|FORCE|DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+"?(\w+)"?([^;]*);|DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+"?(\w+)"?/gi;
  let sm;
  while ((sm = stmtRe.exec(sql))) {
    if (sm[1]) {
      const st = rlsOf(sm[1]);
      const op = sm[2].toUpperCase().replace(/\s+/g, " ");
      if (op === "ENABLE") st.enabled = true;
      else if (op === "FORCE") st.forced = true;
      else if (op === "DISABLE") st.enabled = false;
      else if (op === "NO FORCE") st.forced = false;
    } else if (sm[3]) {
      // Postgres default for CREATE POLICY without FOR is ALL.
      const cmd = (sm[5].match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1] ?? "ALL").toUpperCase();
      rlsOf(sm[4]).policies.set(sm[3], cmd);
      rlsOf(sm[4]).policyText.set(sm[3], sm[5]);
    } else if (sm[6]) {
      rlsOf(sm[7]).policies.delete(sm[6]);
      rlsOf(sm[7]).policyText.delete(sm[6]);
    }
  }
}

const policied = new Set();
for (const name of allModels) {
  const st = rls.get(name);
  if (st && st.enabled && st.policies.size > 0) policied.add(name);
}

// ── 3. Reconcile ──────────────────────────────────────────────────────
console.log(`Models with tenantId: ${tenantIdModels.size}`);
console.log(`Migrations parsed: ${migrationFiles}`);
console.log(`Models with RLS enabled + policy: ${policied.size}`);

const missing = [];
for (const name of tenantIdModels) {
  if (policied.has(name)) continue;
  if (ALLOWLIST.has(name)) continue;
  if (SERVICE_ONLY.has(name)) continue; // contrato propio en 3c-bis
  missing.push(name);
}

if (missing.length) {
  fail(
    `These models carry tenantId but have NO RLS policy and are NOT allowlisted:\n    ${missing.join(
      ", "
    )}\n  → ENABLE + FORCE RLS and add a policy in a migration, or (if userId-scoped) add them to the ALLOWLIST in this script.`
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

// ── 3b. GLOBAL_READONLY: read-only global catalog ────────────────────
{
  const bad = [];
  for (const name of GLOBAL_READONLY) {
    if (!allModels.has(name)) {
      bad.push(`${name}: not a model in schema.prisma (stale GLOBAL_READONLY entry?)`);
      continue;
    }
    if (tenantIdModels.has(name)) bad.push(`${name}: carries tenantId — it is not a global catalog table`);
    const st = rls.get(name);
    if (!st || !st.enabled) bad.push(`${name}: RLS not ENABLEd`);
    if (!st || !st.forced) bad.push(`${name}: RLS not FORCEd`);
    const cmds = st ? [...st.policies.entries()] : [];
    if (!cmds.some(([, c]) => c === "SELECT")) bad.push(`${name}: no FOR SELECT policy (the app role could not read it)`);
    for (const [pol, c] of cmds) {
      if (WRITE_CMDS.has(c)) bad.push(`${name}: write policy "${pol}" (FOR ${c}) — the app role must not write the global catalog`);
    }
  }
  if (bad.length) {
    fail(`GLOBAL_READONLY catalog contract broken:\n    ${bad.join("\n    ")}`);
  } else {
    console.log(GREEN(`✓ GLOBAL_READONLY (${GLOBAL_READONLY.size}): ENABLE + FORCE, SELECT-only policies.`));
  }
}

// ── 3b-bis. SERVICE_ONLY / TENANT_READONLY (BO0, M7) ──────────────────
{
  const bad = [];
  for (const name of SERVICE_ONLY) {
    if (!allModels.has(name)) {
      bad.push(`${name}: not a model in schema.prisma (stale SERVICE_ONLY entry?)`);
      continue;
    }
    const st = rls.get(name);
    if (!st || !st.enabled) bad.push(`${name}: RLS not ENABLEd`);
    if (!st || !st.forced) bad.push(`${name}: RLS not FORCEd`);
    for (const [pol, c] of st ? st.policies.entries() : []) {
      bad.push(`${name}: policy "${pol}" (FOR ${c}) — SERVICE_ONLY tables must have ZERO policies (service channel only)`);
    }
  }
  for (const name of TENANT_READONLY) {
    if (!allModels.has(name)) {
      bad.push(`${name}: not a model in schema.prisma (stale TENANT_READONLY entry?)`);
      continue;
    }
    if (!tenantIdModels.has(name)) bad.push(`${name}: has no tenantId — TENANT_READONLY is tenant-scoped`);
    const st = rls.get(name);
    if (!st || !st.enabled) bad.push(`${name}: RLS not ENABLEd`);
    if (!st || !st.forced) bad.push(`${name}: RLS not FORCEd`);
    const entries = st ? [...st.policies.entries()] : [];
    const tenantSelect = entries.some(
      ([pol, c]) => c === "SELECT" && /"?tenantId"?\s*=\s*app_current_tenant_id\(\)/.test(st.policyText.get(pol) ?? "")
    );
    if (!tenantSelect) bad.push(`${name}: no FOR SELECT policy on "tenantId" = app_current_tenant_id()`);
    for (const [pol, c] of entries) {
      if (WRITE_CMDS.has(c)) bad.push(`${name}: write policy "${pol}" (FOR ${c}) — only the service channel writes it`);
    }
  }
  for (const name of [...SERVICE_ONLY, ...TENANT_READONLY]) {
    if (ALLOWLIST.has(name) || GLOBAL_READONLY.has(name)) bad.push(`${name}: listed in more than one RLS category`);
  }
  for (const name of SERVICE_ONLY) if (TENANT_READONLY.has(name)) bad.push(`${name}: both SERVICE_ONLY and TENANT_READONLY`);
  if (bad.length) {
    fail(`SERVICE_ONLY / TENANT_READONLY contract broken:\n    ${bad.join("\n    ")}`);
  } else {
    console.log(
      GREEN(
        `✓ SERVICE_ONLY (${SERVICE_ONLY.size}): ENABLE + FORCE, zero policies. TENANT_READONLY (${TENANT_READONLY.size}): ENABLE + FORCE, tenant SELECT only.`
      )
    );
  }
}

// ── 3c. Data API roles (EV0 · M2 tenant_verticals, plan §15.1) ────────
// Supabase da por default ALL en `public` a `anon` (la anon key es pública) y a
// `authenticated`. M2 se los revoca (tablas, secuencias, rutinas y DEFAULT
// PRIVILEGES) en un bloque guardado. Este chequeo es la mitad estática del
// contrato: (a) ningún SQL nuestro puede volver a dárselos —un GRANT posterior
// reabriría el agujero sin que nadie lo note— y (b) el bloque no puede
// desaparecer de la cadena. La mitad dinámica (que el bloque revoca de verdad
// y no toca kinesoft_app/owner) la prueba tests/integration/tenant-verticals-m2.test.ts.
{
  const DATA_API_ROLE = /\b(anon|authenticated)\b/i;
  const sqlFiles = [
    ...migrationDirs.map((d) => join(MIGRATIONS_DIR, d, "migration.sql")),
    ...readdirSync(join(ROOT, "prisma"))
      .filter((f) => /^roles\..*\.sql$/.test(f))
      .map((f) => join(ROOT, "prisma", f)),
  ];
  const grants = [];
  let revokeBlockFound = false;
  for (const file of sqlFiles) {
    let sql;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    sql = sql.replace(/--[^\n]*/g, "");
    const rel = file.slice(ROOT.length + 1);
    // Por sentencia: `GRANT … TO … anon|authenticated` (incluye el GRANT de un
    // ALTER DEFAULT PRIVILEGES y el `GRANT anon TO x` de membresía).
    for (const stmt of sql.split(";")) {
      const g = stmt.match(/\bGRANT\b([\s\S]*?)\bTO\b([\s\S]*)/i);
      if (g && (DATA_API_ROLE.test(g[2]) || DATA_API_ROLE.test(g[1]))) {
        grants.push(`${rel}: ${stmt.trim().replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    if (
      /ARRAY\s*\[\s*'anon'\s*,\s*'authenticated'\s*\]/i.test(sql) &&
      /REVOKE\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+FROM/i.test(sql) &&
      /REVOKE\s+ALL\s+ON\s+ALL\s+SEQUENCES\s+IN\s+SCHEMA\s+public\s+FROM/i.test(sql) &&
      /REVOKE\s+ALL\s+ON\s+ALL\s+(ROUTINES|FUNCTIONS)\s+IN\s+SCHEMA\s+public\s+FROM/i.test(sql) &&
      /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*?REVOKE\s+ALL/i.test(sql)
    ) {
      revokeBlockFound = true;
    }
  }
  if (grants.length) {
    fail(
      `GRANT to the Supabase Data API roles (anon/authenticated) — the app never uses PostgREST (plan §15.1):\n    ${grants.join(
        "\n    "
      )}`
    );
  } else {
    console.log(GREEN("✓ No GRANT to anon/authenticated in migrations or prisma/roles.*.sql."));
  }
  if (!revokeBlockFound) {
    fail(
      "The guarded REVOKE block for anon/authenticated (M2 20261007120000_tenant_verticals) is missing from the migrations."
    );
  } else {
    console.log(GREEN("✓ Guarded REVOKE of anon/authenticated (tables, sequences, routines, default privileges) present."));
  }
}

// ── 4. SOFT report: unwrapped prisma.<rlsModel> in Actor-facing code ──
// Advisory only. RLS models as lowercase Prisma delegate names.
// GLOBAL_READONLY queda afuera: su policy es `FOR SELECT USING (true)` (igual
// para todos los tenants), así que leer Payer/Practice/Specialty con `prisma`
// pelado y cache global (`lib/catalog.ts`) es intencional, no una fuga
// (handoff de B1.4). PayerPlan NO está en el set: tiene filas por tenant.
const rlsDelegates = new Set(
  [...tenantIdModels, ...policied]
    .filter((n) => !ALLOWLIST.has(n) && !GLOBAL_READONLY.has(n))
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
