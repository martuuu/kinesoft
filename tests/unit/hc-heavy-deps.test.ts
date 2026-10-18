/**
 * [FC-1c] Guard de las dependencias pesadas de la historia clínica (§24.9 «Guards», los 8 asserts).
 *
 * Por qué existe: T4 suma cuatro librerías que juntas pesan más que el first load entero del perfil del paciente
 * (Tiptap+ProseMirror ~100-130 kB gz, mammoth ~110-170 kB gz en el cliente; react-pdf+yoga+pdfkit y docx, varios MB,
 * en el server). `/pacientes/[id]` tiene tope 175 kB y `/agenda` +0 (§24.9), y `check-bundle-budget` NO cuenta los
 * chunks de `next/dynamic` (hallazgo 4 de §24.2): un import estático «cómodo» metería 100+ kB al first load y el
 * presupuesto lo vería recién en el build. Este guard lo frena en el unit:
 *   1-2. pins exactos y `serverComponentsExternalPackages` (react-pdf no puede bundlearse en la capa RSC);
 *   3.   las fuentes del PDF viajan a la función (trazado) y son las del README (sha256);
 *   4.   Tiptap/ProseMirror solo en los 4 archivos del editor y en el import de Word;
 *   5.   mammoth solo por `import()` y solo en `word-reader.ts`;
 *   6-7. docx y react-pdf solo en archivos `server-only`;
 *   8.   el grafo de imports ESTÁTICOS desde cada página/layout no llega a ninguno de los cuatro.
 *
 * Grafo real (no grep plano), como `public-surface-imports`: se siguen `import`/`export … from` de valor con
 * specifier `@/…` o relativo; los `import type` se ignoran (TypeScript los borra) y los `import()` NO se siguen (son
 * justamente la forma permitida de cargar estas librerías). El BFS no entra a archivos `"use server"`: desde una
 * página son una referencia RPC, su cuerpo nunca llega al cliente (la action de compartir de C-FC6 arma el PDF ahí).
 *
 * Los archivos del editor y del import todavía no existen en T4a (los crean FC-3a y FC-3f): el guard no exige que
 * existan, fija dónde pueden estar. La entrada del spike del editor (`app/(app)/hc-spike/*`) es temporal: FC-3a borra
 * el archivo y saca su línea de las allow-lists (el spike del render, `app/api/hc-spike/*`, ya lo borró FC-2g).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
// El picomatch que vendoriza Next (sin tipos): el MISMO que usa `collect-build-traces.js` para matchear las claves
// de `outputFileTracingIncludes`, así el assert 3 no puede discrepar del build por versión de matcher.
// @ts-expect-error -- next/dist/compiled/picomatch no publica .d.ts
import picomatchUntyped from "next/dist/compiled/picomatch/index.js";

const picomatch = picomatchUntyped as (glob: string, opts?: { dot?: boolean; contains?: boolean }) => (s: string) => boolean;

const ROOT = process.cwd();
const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");

// ── Contrato §24.10 FC-1c (literal): `npm install --save-exact …` ──
const PINS: Record<string, string> = {
  "@tiptap/react": "3.31.4",
  "@tiptap/pm": "3.31.4",
  "@tiptap/starter-kit": "3.31.4",
  "@tiptap/core": "3.31.4",
  mammoth: "1.13.0",
  docx: "9.8.1",
  "@react-pdf/renderer": "4.9.0",
};

/** Paquete pesado → regex sobre el NOMBRE de paquete del specifier. */
const HEAVY = {
  tiptap: /^(?:@tiptap\/|prosemirror-)/,
  mammoth: /^mammoth$/,
  docx: /^docx$/,
  reactPdf: /^@react-pdf\//,
} as const;

/** Dónde puede vivir Tiptap/ProseMirror: los 4 archivos del editor (FC-3a) y el import de Word (FC-3f, generateJSON). */
const TIPTAP_ALLOWED = [
  "components/hc/editor/hc-editor.tsx",
  "components/hc/editor/hc-extensions.ts",
  "components/hc/editor/hc-toolbar.tsx",
  "components/hc/editor/hc-editor-logic.ts",
  "components/**/word-import-logic.ts",
  "components/**/word-reader.ts",
  // Spike de FC-1c (temporal: lo borra FC-3a con su línea).
  "app/(app)/hc-spike/spike-editor.tsx",
];
/** mammoth: solo `word-reader.ts` (FC-3f) y el spike (temporal, FC-3a). */
const MAMMOTH_ALLOWED = ["components/**/word-reader.ts", "app/(app)/hc-spike/spike-editor.tsx"];

const SOURCE_DIRS = ["app", "components", "lib", "hooks"];
const EXTS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

type Specs = { static: string[]; dynamic: string[] };
/** Specifiers de VALOR: estáticos (`import`/`export … from`/`import "x"`) y dinámicos (`import("x")`). */
function specifiers(src: string): Specs {
  const code = stripComments(src);
  const out: Specs = { static: [], dynamic: [] };
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (!m[2]) out.static.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.static.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.dynamic.push(m[1]);
  return out;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
const isBare = (s: string) => !s.startsWith(".") && !s.startsWith("@/");
const heavyOf = (spec: string) =>
  isBare(spec) ? (Object.keys(HEAVY) as (keyof typeof HEAVY)[]).find((k) => HEAVY[k].test(packageName(spec))) : undefined;

const isServerOnly = (src: string) => /^\s*import\s+["']server-only["'];?\s*$/m.test(stripComments(src));
const isUseServer = (src: string) => /^\s*["']use server["'];?/.test(stripComments(src).trimStart());

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile() && EXTS.some((e) => c.endsWith(e))) return c;
  return null;
}

const ALL_FILES = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
const SRC = new Map(ALL_FILES.map((f) => [f, readFileSync(f, "utf8")]));
const SPECS = new Map(ALL_FILES.map((f) => [f, specifiers(SRC.get(f)!)]));

/** Archivos que importan (estático o dinámico) un paquete pesado de la clase `kind`. */
function importersOf(kind: keyof typeof HEAVY): { file: string; static: boolean; dynamic: boolean }[] {
  const out: { file: string; static: boolean; dynamic: boolean }[] = [];
  for (const [f, s] of SPECS) {
    const st = s.static.some((x) => heavyOf(x) === kind);
    const dy = s.dynamic.some((x) => heavyOf(x) === kind);
    if (st || dy) out.push({ file: rel(f), static: st, dynamic: dy });
  }
  return out;
}

const matchesAny = (file: string, globs: string[]) => globs.some((g) => picomatch(g, { dot: true })(file));

const ENTRY_RE = /\/(page|layout|template|not-found|error|global-error|loading|default)\.tsx?$/;

type Reach = { entry: string; pkg: string; chain: string[] };
/** BFS de imports estáticos desde `entry`; la primera cadena hacia cada paquete pesado. */
function heavyReach(entry: string): Reach[] {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const found: Reach[] = [];
  const chainTo = (abs: string) => {
    const chain: string[] = [];
    for (let cur: string | null = abs; cur; cur = parent.get(cur) ?? null) chain.unshift(rel(cur));
    return chain;
  };
  while (queue.length) {
    const file = queue.shift()!;
    const src = SRC.get(file) ?? readFileSync(file, "utf8");
    if (file !== entry && isUseServer(src)) continue;
    const specs = SPECS.get(file) ?? specifiers(src);
    for (const spec of specs.static) {
      if (heavyOf(spec)) {
        found.push({ entry: rel(entry), pkg: spec, chain: chainTo(file) });
        continue;
      }
      const local = resolveLocal(spec, file);
      if (local && !parent.has(local)) {
        parent.set(local, file);
        queue.push(local);
      }
    }
  }
  return found;
}

describe("[FC-1c] detector del guard (anti-false-green)", () => {
  it("distingue estático, dinámico, tipo, comentario y server-only", () => {
    const src = [
      '"use client";',
      'import { useEditor } from "@tiptap/react";',
      'import type { Editor } from "@tiptap/core";',
      "// import mammoth from 'mammoth';",
      'const m = () => import("mammoth");',
      'export { Packer } from "docx";',
      'import "prosemirror-view/style/prosemirror.css";',
    ].join("\n");
    const s = specifiers(src);
    expect(s.static.map(heavyOf)).toEqual(["tiptap", "docx", "tiptap"]);
    expect(s.dynamic.map(heavyOf)).toEqual(["mammoth"]);
    expect(isServerOnly('import "server-only";\nimport { pdf } from "@react-pdf/renderer";')).toBe(true);
    expect(isServerOnly('// import "server-only";\nimport { pdf } from "@react-pdf/renderer";')).toBe(false);
    expect(isUseServer('"use server";\nexport async function a() {}')).toBe(true);
    expect(matchesAny("components/fichas/word-reader.ts", MAMMOTH_ALLOWED)).toBe(true);
    expect(matchesAny("components/fichas/ficha-form.tsx", MAMMOTH_ALLOWED)).toBe(false);
    // El scan no pasa en vacío: el spike importa los cuatro.
    expect(importersOf("tiptap").length).toBeGreaterThan(0);
    expect(importersOf("reactPdf").length).toBeGreaterThan(0);
  });
});

describe("[FC-1c] dependencias pesadas de la HC (§24.9)", () => {
  it("1 · pins exactos en package.json (sin ^ ni ~, en dependencies)", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(PINS)) expect(pkg.dependencies[name], name).toBe(version);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of Object.entries(PINS)) {
      expect(lock.packages[`node_modules/${name}`]?.version, `lock ${name}`).toBe(version);
    }
  });

  it("2 · `serverComponentsExternalPackages` incluye @react-pdf/renderer y docx", async () => {
    const mod = (await import("../../next.config.mjs")) as unknown as {
      default: { experimental: { serverComponentsExternalPackages?: string[] } };
    };
    const ext = mod.default.experimental.serverComponentsExternalPackages ?? [];
    expect(ext).toEqual(expect.arrayContaining(["@react-pdf/renderer", "docx"]));
  });

  it("3 · las fuentes del PDF (y las de pdfkit) se trazan a las rutas que renderizan y coinciden con SHA256SUMS", async () => {
    const mod = (await import("../../next.config.mjs")) as unknown as {
      default: { experimental: { outputFileTracingIncludes?: Record<string, string[]> } };
    };
    const inc = mod.default.experimental.outputFileTracingIncludes ?? {};
    // Mismo matcher que Next 14 (`collect-build-traces.js`: picomatch con `contains`) sobre la ruta normalizada.
    const fontsFor = (route: string) =>
      Object.entries(inc)
        .filter(([glob]) => picomatch(glob, { dot: true, contains: true })(route))
        .flatMap(([, globs]) => globs);
    for (const route of [
      "/api/pacientes/[id]/fichas/[noteId]/[format]",
      "/api/pacientes/[id]/historia-clinica/[format]",
      "/pacientes/[id]",
    ]) {
      const globs = fontsFor(route).map((g) => picomatch(g.replace(/^\.\//, "")));
      expect(globs.some((m) => m("lib/hc-pdf/fonts/NotoSans-Regular.ttf")), `${route} fuentes`).toBe(true);
      // Hallazgo del spike: pdfkit carga Helvetica por un `imports` (#standard-fonts) que el trazado no sigue.
      expect(globs.some((m) => m("node_modules/pdfkit/js/standard-fonts/Helvetica.cjs")), `${route} pdfkit`).toBe(true);
    }
    const sums = read("lib/hc-pdf/fonts/SHA256SUMS")
      .trim()
      .split("\n")
      .map((l) => l.split(/\s+/) as [string, string]);
    expect(sums.map(([, f]) => f).sort()).toEqual(
      [
        "NotoSans-Bold.ttf",
        "NotoSans-BoldItalic.ttf",
        "NotoSans-Italic.ttf",
        "NotoSans-Regular.ttf",
        "NotoSansMath-Regular.ttf",
        "OFL-NotoSansMath.txt",
        "OFL.txt",
      ].sort(),
    );
    for (const [hash, file] of sums) {
      const actual = createHash("sha256").update(readFileSync(resolve(ROOT, "lib/hc-pdf/fonts", file))).digest("hex");
      expect(actual, file).toBe(hash);
      expect(read("lib/hc-pdf/fonts/README.md"), `README lista ${file}`).toContain(`${hash}  ${file}`);
    }
  });

  it("4 · Tiptap/ProseMirror solo en los 4 archivos del editor y en el import de Word", () => {
    const outside = importersOf("tiptap").filter((x) => !matchesAny(x.file, TIPTAP_ALLOWED));
    expect(outside).toEqual([]);
  });

  it("5 · mammoth solo por `import()` y solo en `word-reader.ts`", () => {
    const hits = importersOf("mammoth");
    expect(hits.filter((x) => !matchesAny(x.file, MAMMOTH_ALLOWED))).toEqual([]);
    expect(hits.filter((x) => x.static)).toEqual([]);
  });

  it("6 · docx solo en archivos `server-only`", () => {
    const bad = importersOf("docx").filter((x) => !isServerOnly(SRC.get(resolve(ROOT, x.file))!));
    expect(bad).toEqual([]);
  });

  it("7 · react-pdf solo en archivos `server-only`", () => {
    const bad = importersOf("reactPdf").filter((x) => !isServerOnly(SRC.get(resolve(ROOT, x.file))!));
    expect(bad).toEqual([]);
  });

  it("8 · el BFS de imports estáticos desde las páginas no alcanza Tiptap, mammoth, docx ni react-pdf", () => {
    const entries = ALL_FILES.filter((f) => rel(f).startsWith("app/") && ENTRY_RE.test(rel(f)));
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.map(rel)).toContain("app/(app)/pacientes/[id]/page.tsx");
    const reach = entries.flatMap(heavyReach);
    expect(reach.map((r) => `${r.entry} → ${r.pkg}: ${r.chain.join(" → ")}`)).toEqual([]);
  });
});
