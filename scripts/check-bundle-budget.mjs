#!/usr/bin/env node
/**
 * Presupuesto de bundle (A1.2 → VX F-e, contrato C-F6). Lee la salida de `next build` y calcula el JS inicial (gzip)
 * de cada ruta del App Router: root main files + chunks de cada layout ancestro + los de la page, como los baja el
 * browser en la primera carga.
 *
 * Presupuesto por GRUPO de ruta (`scripts/bundle-groups.mjs`): públicas ≤ 120 kB, turnero ≤ 135, portal ≤ 125 son
 * bloqueantes; onboarding / Plataforma / workspace solo informan. Sale 1 si una ruta de grupo bloqueante excede su
 * presupuesto o crece > 10 % sobre `scripts/bundle-baseline.json` (el 10 % atrapa una regresión que todavía entra en
 * el número absoluto, p. ej. alguien que vuelve a meter framer-motion en el root).
 *
 * Flags:
 *   --json              array `{route, group, kb, budget, blocking, over, vsBaseline}` por stdout (sin tabla).
 *   --explain <ruta>    chunks de esa ruta por kB gz, marcando los que traen framer-motion / zod / @supabase / react-dom
 *                       (por firma de texto en el chunk minificado: los nombres de módulo no sobreviven al build).
 *   --write-baseline    regraba scripts/bundle-baseline.json con los números actuales (y no falla: es para regrabar).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { groupFor } from "./bundle-groups.mjs";

const NEXT = ".next";
const GROWTH_LIMIT = 0.1;
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const writeBaseline = args.includes("--write-baseline");
const explainIdx = args.indexOf("--explain");
const explainRoute = explainIdx >= 0 ? args[explainIdx + 1] : null;
if (explainIdx >= 0 && !explainRoute) {
  console.error("[bundle] uso: --explain <ruta>  (p. ej. --explain /login)");
  process.exit(2);
}

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
const round1 = (n) => Math.round(n * 10) / 10;

/** Archivos de la primera carga de una entrada `…/page` del manifest. */
function filesFor(entry) {
  // Page + cada layout ancestro (el root layout es el que cargaba framer-motion y los providers) + runtime.
  const segs = entry.replace(/\/page$/, "").split("/").filter(Boolean);
  const layouts = ["/layout", ...segs.map((_, i) => "/" + segs.slice(0, i + 1).join("/") + "/layout")];
  return [...new Set([...rootFiles, ...(app[entry] ?? []), ...layouts.flatMap((l) => app[l] ?? [])])].filter((f) =>
    f.endsWith(".js"),
  );
}
const cleanRoute = (entry) => entry.replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "") || "/";

const baselinePath = "scripts/bundle-baseline.json";
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};

const rows = [];
const entryOf = new Map();
for (const entry of Object.keys(app)) {
  if (!entry.endsWith("/page")) continue;
  const route = cleanRoute(entry);
  entryOf.set(route, entry);
  const kb = round1(filesFor(entry).reduce((a, f) => a + gz(f), 0) / 1024);
  const g = groupFor(route);
  const base = baseline[route];
  const vsBaseline = typeof base === "number" && base > 0 ? round1(((kb - base) / base) * 100) : null;
  const over = kb > g.budget;
  const grew = vsBaseline !== null && vsBaseline > GROWTH_LIMIT * 100;
  rows.push({ route, group: g.id, kb, budget: g.budget, blocking: g.blocking, over, vsBaseline, fail: g.blocking && (over || grew) });
}
rows.sort((a, b) => a.group.localeCompare(b.group) || b.kb - a.kb);

if (explainRoute) {
  const entry = entryOf.get(explainRoute);
  if (!entry) {
    console.error(`[bundle] la ruta ${explainRoute} no está en el build. Rutas: ${[...entryOf.keys()].join(", ")}`);
    process.exit(2);
  }
  // Firmas que sobreviven a la minificación (strings, no identificadores). Son heurísticas: alcanzan para decir en
  // qué chunk vive cada librería pesada, que es la pregunta de `--explain`.
  const SIGNATURES = {
    "framer-motion": /framerAppearId|data-framer-appear-id|MotionConfigContext|motionValue/,
    zod: /ZodError|invalid_type_error|too_small/,
    "@supabase": /supabase-js|x-client-info|GoTrueClient|sb-[a-z]*-auth-token/,
    "react-dom": /__reactFiber\$|__reactContainer\$|react-dom/,
  };
  const chunks = filesFor(entry)
    .map((f) => {
      const p = join(NEXT, f);
      const src = existsSync(p) ? readFileSync(p, "utf8") : "";
      const libs = Object.entries(SIGNATURES)
        .filter(([, re]) => re.test(src))
        .map(([name]) => name);
      return { chunk: f, kb: round1(gz(f) / 1024), libs };
    })
    .sort((a, b) => b.kb - a.kb);
  if (asJson) console.log(JSON.stringify(chunks, null, 2));
  else {
    const r = rows.find((x) => x.route === explainRoute);
    console.log(`[bundle] ${explainRoute} (${r.group}): ${r.kb} kB gz / presupuesto ${r.budget}`);
    console.table(chunks.map((c) => ({ chunk: c.chunk, "kB gz": c.kb, contiene: c.libs.join(", ") || "—" })));
  }
  process.exit(0);
}

const failing = rows.filter((r) => r.fail);
if (asJson) {
  console.log(JSON.stringify(rows.map(({ fail: _fail, ...r }) => r), null, 2));
} else {
  console.table(
    rows.map((r) => ({
      ruta: r.route,
      grupo: r.group,
      "kB gz": r.kb,
      presupuesto: r.budget,
      bloquea: r.blocking ? "sí" : "no",
      estado: r.over ? "EXCEDE" : "ok",
      "vs baseline": r.vsBaseline === null ? "—" : `${r.vsBaseline > 0 ? "+" : ""}${r.vsBaseline}%`,
    })),
  );
}

if (writeBaseline) {
  const sorted = [...rows].sort((a, b) => b.kb - a.kb);
  writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(sorted.map((r) => [r.route, r.kb])), null, 2) + "\n");
  console.error(`[bundle] baseline escrito en ${baselinePath}`);
  process.exit(0);
}

if (failing.length) {
  // stderr: con --json el stdout tiene que seguir siendo JSON parseable.
  console.error(
    `[bundle] ${failing.length} ruta(s) bloqueante(s) fuera de presupuesto o con > ${GROWTH_LIMIT * 100} % sobre baseline: ` +
      failing.map((r) => `${r.route} ${r.kb}/${r.budget} kB${r.vsBaseline !== null ? ` (${r.vsBaseline}%)` : ""}`).join(", ") +
      ". Mirá `node scripts/check-bundle-budget.mjs --explain <ruta>`.",
  );
  process.exit(1);
}
process.exit(0);
