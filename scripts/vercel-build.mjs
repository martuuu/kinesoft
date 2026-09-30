#!/usr/bin/env node
/**
 * Vercel build entrypoint (vercel.json → buildCommand).
 *
 * Why this exists (AUDIT H6, 2026-09-23): the old buildCommand was
 * `prisma migrate deploy && prisma generate && next build` for EVERY build,
 * and Preview deploys shared the production database (DEPLOYMENT.md). Any
 * pushed branch carrying a migration therefore applied it to prod before
 * review — and a migration fixed during review is never re-applied, because
 * `migrate deploy` skips already-recorded names. Migrations now run ONLY for
 * the Production environment; Preview/Development builds just generate and
 * build (they point at staging, see EXTERNAL-CONFIG).
 *
 * Plain Node, no deps, so it runs before `npm ci`'s devDeps matter.
 */
import { spawnSync } from "node:child_process";

const env = process.env.VERCEL_ENV ?? "local";

function run(cmd, args) {
  console.log(`[vercel-build] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`[vercel-build] "${cmd} ${args.join(" ")}" failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

if (env === "production") {
  run("npx", ["prisma", "migrate", "deploy"]);
} else {
  console.log(`[vercel-build] skip migrate (VERCEL_ENV=${env}) — migrations only run on Production`);
}
run("npx", ["prisma", "generate"]);
run("npx", ["next", "build"]);
