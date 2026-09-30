#!/usr/bin/env node
/**
 * Bundle budget report (A1.2) — reads the output of `next build` and prints
 * the first-load JS (gzip) per app route, summing the root chunks + the
 * route's chunks the way the browser downloads them.
 *
 * A1: REPORT ONLY (exit 0). `--write-baseline` records scripts/bundle-baseline.json.
 * C1 (perf fixes) flips it to enforce: fail when a route exceeds its budget
 * (portal/turnero/login ≤ 150 kB, workspace ≤ 180 kB) or grows >10% over the
 * committed baseline.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const NEXT = ".next";
const manifestPath = join(NEXT, "app-build-manifest.json");
const buildManifestPath = join(NEXT, "build-manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[bundle] no hay .next/app-build-manifest.json — corré `npx next build` antes.");
  process.exit(1);
}
const app = JSON.parse(readFileSync(manifestPath, "utf8")).pages;
const rootFiles = existsSync(buildManifestPath) ? JSON.parse(readFileSync(buildManifestPath, "utf8")).rootMainFiles ?? [] : [];

const gzCache = new Map();
function gz(file) {
  if (!file.endsWith(".js")) return 0;
  if (!gzCache.has(file)) {
    const p = join(NEXT, file);
    gzCache.set(file, existsSync(p) ? gzipSync(readFileSync(p)).length : 0);
  }
  return gzCache.get(file);
}

const PUBLIC = [/^\/portal/, /^\/c\/\[slug\]\/booking/, /^\/login/, /^\/signup/, /^\/forgot/, /^\/reset/, /^\/booking/];
const rows = [];
for (const [route, files] of Object.entries(app)) {
  if (!route.endsWith("/page")) continue;
  // Page chunks + every ancestor layout's chunks (root layout carries
  // framer-motion and the providers) + the runtime root files.
  const segs = route.replace(/\/page$/, "").split("/").filter(Boolean);
  const layouts = ["/layout", ...segs.map((_, i) => "/" + segs.slice(0, i + 1).join("/") + "/layout")];
  const all = new Set([...rootFiles, ...files, ...layouts.flatMap((l) => app[l] ?? [])]);
  const kb = [...all].reduce((a, f) => a + gz(f), 0) / 1024;
  const clean = route.replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "") || "/";
  const budget = PUBLIC.some((re) => re.test(clean)) ? 150 : 180;
  rows.push({ route: clean, kb: Math.round(kb * 10) / 10, budget, over: kb > budget });
}
rows.sort((a, b) => b.kb - a.kb);

const baselinePath = "scripts/bundle-baseline.json";
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
console.table(
  rows.map((r) => ({
    ruta: r.route,
    "kB gz": r.kb,
    presupuesto: r.budget,
    estado: r.over ? "EXCEDE" : "ok",
    "vs baseline": baseline?.[r.route] ? `${Math.round(((r.kb - baseline[r.route]) / baseline[r.route]) * 100)}%` : "—",
  })),
);
if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(rows.map((r) => [r.route, r.kb])), null, 2) + "\n");
  console.log(`[bundle] baseline escrito en ${baselinePath}`);
}
// A1: solo reporte. C1 cambia esto a process.exit(1) si hay rutas "EXCEDE" o +10%.
process.exit(0);
