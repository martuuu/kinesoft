#!/usr/bin/env node
/**
 * FC-1c · gz de los chunks diferidos de la historia clínica (§24.9). INFORMATIVO: sale 0 salvo con `--strict`.
 *
 * Por qué existe: `check-bundle-budget` suma solo las entradas del manifest (first load) y NO ve los chunks de
 * `next/dynamic` / `import()` (hallazgo 4 de §24.2). Tiptap+ProseMirror y mammoth viven justamente ahí, así que su
 * peso real no aparecía en ningún número. Este script recorre `.next/static/chunks/**`, reconoce cada librería por
 * FIRMAS DE TEXTO que sobreviven a la minificación (los nombres de módulo no sobreviven), suma su gz y dice si alguno
 * de esos chunks quedó en el first load de alguna ruta (eso sería un import estático que se coló).
 *
 * Esperado (§24.9): Tiptap ~100-130 kB gz y mammoth ~110-170 kB gz, todo diferido; react-pdf y docx, 0 en el cliente
 * (son server-only: `serverComponentsExternalPackages`).
 *
 * Uso: `npx next build && node scripts/measure-hc-chunks.mjs [--json] [--strict]`
 *   --json    salida JSON por stdout.
 *   --strict  sale 1 si un chunk pesado está en un first load o si react-pdf/docx aparecen en el cliente
 *             (lo usa el integrador FC-3i1 como gate).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const NEXT = ".next";
const CHUNKS = join(NEXT, "static", "chunks");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

if (!existsSync(CHUNKS) || !existsSync(join(NEXT, "app-build-manifest.json"))) {
  console.error("[hc-chunks] no hay build: corré `npx next build` antes.");
  process.exit(1);
}

/**
 * Firmas por librería. Medidas sobre el build de FC-1c (18-oct): cada una aparece solo en los chunks de su librería.
 * - tiptap: los mensajes y nombres de clase de ProseMirror (`ProseMirror`, `prosemirror-*`) y los de `@tiptap/*`.
 * - mammoth: `mammoth.styleMapping` / `mammoth/style-map` (strings de su API, no del copy de la app).
 * - react-pdf / docx: no deberían estar NUNCA en el cliente; `yogaNode` (layout de react-pdf), `PDFKit`, y los
 *   atributos del `<w:document>` que escribe docx (`xmlns:wpc`, `"w:compat"`), que mammoth no tiene.
 */
const LIBS = {
  tiptap: { re: /ProseMirror|prosemirror-[a-z]+|@tiptap\//, expected: "100-130", clientAllowed: true },
  mammoth: { re: /mammoth\.styleMapping|mammoth\/style-map/, expected: "110-170", clientAllowed: true },
  "react-pdf": { re: /yogaNode|@react-pdf\/|PDFKit/, expected: "0 (server-only)", clientAllowed: false },
  docx: { re: /xmlns:wpc|"w:compat"/, expected: "0 (server-only)", clientAllowed: false },
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(join(NEXT, "app-build-manifest.json"), "utf8")).pages;
const buildManifestPath = join(NEXT, "build-manifest.json");
const rootFiles = existsSync(buildManifestPath)
  ? JSON.parse(readFileSync(buildManifestPath, "utf8")).rootMainFiles ?? []
  : [];

/** chunk (ruta relativa a .next) → rutas en cuyo first load está (misma cuenta que check-bundle-budget). */
const firstLoadOf = new Map();
for (const entry of Object.keys(manifest)) {
  if (!entry.endsWith("/page")) continue;
  const route = entry.replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "") || "/";
  const segs = entry.replace(/\/page$/, "").split("/").filter(Boolean);
  const layouts = ["/layout", ...segs.map((_, i) => "/" + segs.slice(0, i + 1).join("/") + "/layout")];
  const files = new Set([...rootFiles, ...(manifest[entry] ?? []), ...layouts.flatMap((l) => manifest[l] ?? [])]);
  for (const f of files) {
    if (!firstLoadOf.has(f)) firstLoadOf.set(f, []);
    firstLoadOf.get(f).push(route);
  }
}

const round1 = (n) => Math.round(n * 10) / 10;
const result = {};
for (const lib of Object.keys(LIBS)) result[lib] = { chunks: [], kbGz: 0, expected: LIBS[lib].expected, inFirstLoad: [] };

for (const abs of walk(CHUNKS)) {
  const src = readFileSync(abs, "utf8");
  const relToNext = abs.slice(NEXT.length + 1);
  for (const [lib, { re }] of Object.entries(LIBS)) {
    if (!re.test(src)) continue;
    const kb = round1(gzipSync(src).length / 1024);
    const routes = firstLoadOf.get(relToNext) ?? [];
    result[lib].chunks.push({ chunk: relToNext, kbGz: kb, firstLoadRoutes: routes });
    result[lib].kbGz = round1(result[lib].kbGz + kb);
    if (routes.length) result[lib].inFirstLoad.push(relToNext);
  }
}

const problems = [];
for (const [lib, r] of Object.entries(result)) {
  if (r.inFirstLoad.length) problems.push(`${lib}: en el first load (${r.inFirstLoad.join(", ")})`);
  if (!LIBS[lib].clientAllowed && r.chunks.length) problems.push(`${lib}: aparece en el cliente (${r.chunks.length} chunks)`);
}

if (asJson) {
  console.log(JSON.stringify({ libs: result, problems }, null, 2));
} else {
  console.log("[hc-chunks] chunks diferidos de la HC (gz):");
  console.table(
    Object.entries(result).map(([lib, r]) => ({
      lib,
      chunks: r.chunks.length,
      "kB gz": r.kbGz,
      esperado: r.expected,
      "en first load": r.inFirstLoad.length ? "SÍ" : "no",
    })),
  );
  for (const [lib, r] of Object.entries(result)) {
    for (const c of r.chunks) console.log(`  ${lib.padEnd(9)} ${String(c.kbGz).padStart(6)} kB  ${c.chunk}`);
  }
  if (problems.length) console.log(`[hc-chunks] ${strict ? "FALLA" : "aviso"}:\n  - ${problems.join("\n  - ")}`);
}
process.exit(strict && problems.length ? 1 : 0);
