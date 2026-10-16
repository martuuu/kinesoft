#!/usr/bin/env node
/**
 * [VX F2] Codemod de colores de estado → tokens de C-F1 (brief VX §4 «F2», decisión D-VX23).
 *
 * Uso:
 *   node scripts/codemod-status-colors.mjs --dry     # reporte por archivo, no escribe (default)
 *   node scripts/codemod-status-colors.mjs --write   # aplica; una segunda corrida tiene que dar 0 cambios
 *   node scripts/codemod-status-colors.mjs --dry --json
 *
 * Por qué un codemod y no find/replace a mano: hay ~240 literales en ~110 archivos, escritos con mayúsculas, espacios y
 * `,.1`/`,0.1` distintos; un script con el mapa literal del brief es reproducible, revisable en `--dry` e idempotente.
 *
 * Reglas (D-VX23): solo igualdades EXACTAS contra el valor del token. Un color parecido (`#9a2b2b`, `#4F8A10`, `#9A5B00`,
 * `rgba(225,75,75,0.12)`…) NO se reemplaza: cambiaría el color visible. Esos se listan en el reporte («no exactos») y van
 * como filas de AUDIT para PF1.
 *
 * Exclusiones (brief §4 F2):
 *   - fuera de alcance: todo lo que no esté bajo `app/` o `components/`; `lib/email/**` (los mails van con hex: los
 *     clientes de correo no leen variables CSS), `design_source/**`, `tests/**`;
 *   - `app/globals.css`: ahí viven las definiciones de los tokens (reemplazar sería `--danger-fg: var(--danger-fg)`);
 *   - `opengraph-image.*` e `icon.*` (y `apple-icon.*`): next/og no resuelve variables CSS;
 *   - atributos de presentación SVG `fill=` / `stroke=` / `stopColor=` (y `stop-color`/`floodColor`/`lightingColor`):
 *     `var()` en un atributo de presentación no es confiable entre navegadores (sí lo es en `style`);
 *   - archivos que importan una librería de gráficos (recharts, chart.js, victory, nivo, visx): sus props de color se
 *     pintan en canvas/SVG por atributo. Hoy no hay ninguno; la regla queda para no romper uno futuro.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Mapa literal del brief (§4 F2). Clave = forma normalizada (minúsculas, sin espacios, `0.` explícito). */
export const STATUS_COLOR_MAP = {
  "#9f1f1f": "var(--danger-fg)",
  "rgba(228,70,70,0.1)": "var(--danger-bg)",
  "rgba(228,70,70,0.18)": "var(--danger-bg-strong)",
  "#c62828": "var(--danger-solid)",
  "#e44646": "var(--danger-dot)",
  "#7a4a00": "var(--warn-fg)",
  "rgba(255,176,32,0.14)": "var(--warn-bg)",
  "rgba(255,176,32,0.24)": "var(--warn-bg-strong)",
  "#1b704b": "var(--success-fg)",
  "rgba(54,179,126,0.12)": "var(--success-bg)",
};

/**
 * Colores de la misma familia que NO son iguales al token (D-VX23): se cuentan para AUDIT/PF1, nunca se tocan.
 * Los rgba se agrupan por familia de RGB: cualquier alfa fuera del mapa es «no exacto».
 */
export const NEAR_MISS_HEX = ["#4f8a10", "#9a5b00", "#9a2b2b", "#7a5410", "#1f7a52", "#e59a00", "#b02020", "#e14b4b"];
const STATUS_RGB_FAMILIES = ["228,70,70", "255,176,32", "54,179,126", "225,75,75", "228,176,32", "214,158,46", "159,31,31", "122,74,0", "154,91,0", "176,32,32", "27,112,75"];

const DIRS = ["app", "components"];
const EXT = /\.(tsx?|css|mjs)$/;

/** Normaliza un literal de color como lo hace el ratchet (`tests/unit/ui-ratchets.test.ts` → `normalizeColors`). */
export function normalizeColor(lit) {
  const s = lit.toLowerCase();
  if (!s.startsWith("rgba(")) return s;
  const inner = s.slice(5, -1).replace(/\s+/g, "");
  const parts = inner.split(",");
  if (parts.length === 4) {
    let a = parts[3];
    if (a.startsWith(".")) a = "0" + a;
    parts[3] = a;
  }
  return `rgba(${parts.join(",")})`;
}

/** `#rrggbb` que no sigue con otro dígito hex (así `#9F1F1F80` no matchea) o un `rgba(…)` de cuatro números. */
const COLOR_RE = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:\d*\.\d+|\d+)\s*\)/g;

/** ¿El match cae dentro de un atributo SVG de presentación? Mira la línea hasta el match. */
const SVG_ATTR_RE = /\b(fill|stroke|stopColor|stop-color|floodColor|lightingColor)\s*=\s*(\{[^}]*|["'][^"']*)$/;

const CHART_LIB_RE = /from\s+["'](recharts|chart\.js|react-chartjs-2|victory|@nivo\/[^"']+|@visx\/[^"']+)["']/;

/** Ruta relativa (con `/`) → motivo de exclusión, o null si entra al codemod. */
export function excludedReason(rel) {
  if (!DIRS.some((d) => rel.startsWith(d + "/"))) return "fuera de app/ y components/";
  if (!EXT.test(rel)) return "extensión";
  if (rel === "app/globals.css") return "definiciones de tokens";
  if (/(^|\/)lib\/email\//.test(rel)) return "lib/email (los mails van con hex)";
  if (/(^|\/)(design_source|tests)\//.test(rel)) return "design_source/tests";
  if (/(^|\/)(opengraph-image|twitter-image|icon|apple-icon)\.[^/]+$/.test(rel)) return "next/og no lee variables CSS";
  return null;
}

/**
 * Transforma un archivo. Devuelve el texto nuevo, los reemplazos hechos y los colores de la familia de estado que
 * quedaron sin tocar (no exactos, o exactos pero en un contexto excluido).
 */
export function transformSource(text, rel = "components/x.tsx") {
  const replaced = [];
  const skipped = [];
  const nearMiss = [];
  if (excludedReason(rel)) return { text, replaced, skipped, nearMiss };
  const chartFile = CHART_LIB_RE.test(text);
  const lines = text.split("\n");
  const out = lines.map((line, i) =>
    line.replace(COLOR_RE, (m, offset) => {
      const norm = normalizeColor(m);
      const token = STATUS_COLOR_MAP[norm];
      if (!token) {
        if (isStatusFamily(norm)) nearMiss.push({ literal: norm, line: i + 1 });
        return m;
      }
      const before = line.slice(0, offset);
      if (SVG_ATTR_RE.test(before)) {
        skipped.push({ literal: norm, line: i + 1, reason: "atributo SVG" });
        return m;
      }
      if (chartFile) {
        skipped.push({ literal: norm, line: i + 1, reason: "archivo de gráficos" });
        return m;
      }
      replaced.push({ literal: norm, token, line: i + 1 });
      return token;
    })
  );
  return { text: out.join("\n"), replaced, skipped, nearMiss };
}

function isStatusFamily(norm) {
  if (norm.startsWith("#")) return NEAR_MISS_HEX.includes(norm);
  const rgb = norm.slice(5, -1).split(",").slice(0, 3).join(",");
  return STATUS_RGB_FAMILIES.includes(rgb);
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
}

/** Corre sobre el árbol. `write=false` no toca disco. */
export function runCodemod({ root = process.cwd(), write = false } = {}) {
  const paths = [];
  for (const d of DIRS) walk(join(root, d), paths);
  const files = [];
  const nearMiss = {};
  for (const p of paths.sort()) {
    const rel = relative(root, p).split(sep).join("/");
    if (excludedReason(rel)) continue;
    const src = readFileSync(p, "utf8");
    const r = transformSource(src, rel);
    for (const n of r.nearMiss) (nearMiss[n.literal] ??= []).push(`${rel}:${n.line}`);
    if (r.replaced.length || r.skipped.length) files.push({ file: rel, replaced: r.replaced, skipped: r.skipped });
    if (write && r.text !== src) writeFileSync(p, r.text);
  }
  const byLiteral = {};
  for (const f of files) for (const x of f.replaced) byLiteral[x.literal] = (byLiteral[x.literal] ?? 0) + 1;
  const total = files.reduce((n, f) => n + f.replaced.length, 0);
  return { total, files: files.filter((f) => f.replaced.length || f.skipped.length), byLiteral, nearMiss };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const json = argv.includes("--json");
  const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const r = runCodemod({ root: ROOT, write });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`[codemod-status-colors] ${write ? "--write" : "--dry"}: ${r.total} reemplazos en ${r.files.filter((f) => f.replaced.length).length} archivos`);
    for (const f of r.files) {
      const lits = f.replaced.map((x) => `${x.line}:${x.literal}→${x.token}`).join("  ");
      console.log(`  ${f.file} (${f.replaced.length})  ${lits}`);
      for (const s of f.skipped) console.log(`    salteado ${s.line}:${s.literal} (${s.reason})`);
    }
    console.log("Por literal:", r.byLiteral);
    console.log("No exactos (D-VX23 → AUDIT/PF1):");
    for (const [lit, where] of Object.entries(r.nearMiss).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${lit}: ${where.length}  ${where.slice(0, 6).join(", ")}${where.length > 6 ? ", …" : ""}`);
    }
  }
}
