/**
 * [FC-1e] Grafo de imports REAL para los guards estáticos (extraído de `tests/unit/public-surface-imports.test.ts`, VX F-d).
 *
 * Por qué un helper: el guard de las superficies públicas (framer-motion / providers de UI, C-F3) y el del portal
 * «Documentos» (T4, C-FC8: el portal no puede alcanzar las notas clínicas) necesitan el MISMO recorrido. Antes vivía
 * pegado al test de F-d; copiarlo habría dejado dos BFS que divergen al primer arreglo (p. ej. cuando se sume un
 * alias nuevo o `export * from`).
 *
 * Qué sigue: cada `import`/`export … from`/`import "x"`/`import("x")` con specifier `@/…` o relativo, resolviendo
 * extensiones e `index`. Se ignoran los `import type` / `export type` (TypeScript los borra: no llegan al bundle ni
 * al server en runtime) y los imports dentro de comentarios. Lo que no resuelve a un `.ts/.tsx` local (paquetes,
 * `.css`, `.json`, assets) no se recorre; los paquetes se reportan por nombre para quien los quiera prohibir.
 *
 * Neutral a propósito: este archivo no nombra el modelo de notas (lo importa el guard del portal, que barre texto).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const ROOT = process.cwd();
export const EXTS = [".ts", ".tsx"] as const;

/** Ruta relativa al repo con `/` (estable entre macOS/Linux/Windows). */
export const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");
export const abs = (relPath: string) => join(ROOT, relPath);

/** `.ts/.tsx` (sin `.d.ts`) bajo `dir`, sin `node_modules` ni ocultos. Devuelve rutas absolutas. */
export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Specifiers de VALOR del archivo (sin `import type` / `export type`, sin comentarios). */
export function valueSpecifiers(src: string): string[] {
  // Comentarios fuera: un `import` dentro de un JSDoc no es un import.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  const staticRe = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(staticRe)) if (!m[2]) specs.push(m[4]);
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

/** Archivo local al que resuelve `spec` desde `fromFile` (absoluto), o null si es un paquete / asset. */
export function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile() && EXTS.some((e) => c.endsWith(e))) return c;
  return null; // .css, .json, assets: no cargan JS
}

export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Cache de specifiers por archivo absoluto: los guards recorren cientos de entradas que comparten casi todo. */
export type SpecCache = Map<string, string[]>;

function specsOf(file: string, cache: SpecCache): string[] {
  let specs = cache.get(file);
  if (!specs) {
    specs = valueSpecifiers(readFileSync(file, "utf8"));
    cache.set(file, specs);
  }
  return specs;
}

export type Violation = { entry: string; target: string; chain: string[] };

/**
 * BFS desde `entry` (relativa al repo). Devuelve la primera cadena hacia cada objetivo prohibido:
 *  - `isForbiddenFile(relPath)`: archivo local prohibido (no se sigue adentro: ya es violación);
 *  - `forbiddenPackages`: paquetes npm prohibidos (por nombre de paquete).
 */
export function forbiddenReach(
  entry: string,
  opts: { isForbiddenFile?: (relPath: string) => boolean; forbiddenPackages?: readonly string[] },
  cache: SpecCache
): Violation[] {
  const start = abs(entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const found: Violation[] = [];
  const chainTo = (file: string) => {
    const chain: string[] = [];
    for (let cur: string | null = file; cur; cur = parent.get(cur) ?? null) chain.unshift(rel(cur));
    return chain;
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of specsOf(file, cache)) {
      const local = resolveLocal(spec, file);
      if (!local) {
        if (!spec.startsWith(".") && !spec.startsWith("@/") && opts.forbiddenPackages?.includes(packageName(spec))) {
          found.push({ entry, target: spec, chain: chainTo(file) });
        }
        continue;
      }
      if (parent.has(local)) continue;
      parent.set(local, file);
      if (opts.isForbiddenFile?.(rel(local))) {
        found.push({ entry, target: rel(local), chain: chainTo(local) });
        continue; // ya es violación; no hace falta seguir adentro
      }
      queue.push(local);
    }
  }
  return found;
}

/**
 * Clausura de imports de valor desde `entries`: cada archivo local alcanzado (incluidas las entradas) con la cadena
 * desde su entrada. Sirve para afirmar algo de TODO lo que llega (p. ej. «ningún archivo alcanzado menciona X»).
 */
export function importClosure(entries: readonly string[], cache: SpecCache): Map<string, string[]> {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of entries) {
    const a = abs(e);
    if (!parent.has(a)) {
      parent.set(a, null);
      queue.push(a);
    }
  }
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of specsOf(file, cache)) {
      const local = resolveLocal(spec, file);
      if (!local || parent.has(local)) continue;
      parent.set(local, file);
      queue.push(local);
    }
  }
  const out = new Map<string, string[]>();
  for (const file of parent.keys()) {
    const chain: string[] = [];
    for (let cur: string | null = file; cur; cur = parent.get(cur) ?? null) chain.unshift(rel(cur));
    out.set(rel(file), chain);
  }
  return out;
}

export const fmtViolations = (v: Violation[]) =>
  v.map((x) => `${x.entry} → ${x.target}\n    ${x.chain.join("\n    → ")}`).join("\n");

// ── [FC-1e] Contrato del portal «Documentos» (brief §24.5 «Red», C-FC8) ─────────────────────────────────────────────
//
// El portal deshace EV2-D5 de forma ACOTADA: lee solo lo compartido (`PatientDocument`, una foto HcPrintable v1 ya
// resuelta en texto). Para mostrarla reusa los módulos HC NEUTRALES de esta lista. Vive acá (y no en un test) porque la
// usan dos guards: `clinical-notes-guard` (estos archivos no mencionan el modelo de notas, comentarios incluidos) y
// `portal-documents-guard` (el grafo del portal no alcanza ningún módulo HC fuera de esta lista). Sumar una entrada es
// una decisión de seguridad (PHI): va con planning, no para hacer pasar un test.

/** Módulos HC que el portal PUEDE importar (archivo exacto o prefijo de carpeta terminado en `/`). */
export const PORTAL_HC_ALLOWLIST: readonly string[] = [
  "lib/hc-doc.ts", // C-FC1: formato puro (validar / texto plano)
  "lib/hc-print-types.ts", // C-FC4: tipos de HcPrintable v1 (solo tipos)
  "lib/hc-print-model.ts", // C-FC4: puros (canonicalJson, código de verificación); sin lecturas
  "lib/hc-pdf/", // C-FC5: render del PDF desde el snapshot (stub → render del snapshot)
  "components/hc/", // HcDocView / HcPrintableView: server, sin estado
  "lib/portal-documents-internal.ts", // C-FC8: la lectura del portal (solo PatientDocument)
];

/**
 * Espacios de nombres HC: todo archivo alcanzado desde el portal que caiga acá tiene que estar en la allow-list.
 * `lib/hc-print-internal.ts` (carga la fuente desde las notas) y `lib/hc-docx-internal.ts` caen por `lib/hc-`.
 */
export const HC_NAMESPACES: readonly string[] = [
  "lib/clinical-",
  "components/clinical-",
  "lib/hc-",
  "components/hc/",
  "components/fichas/",
  "lib/patient-documents",
  "lib/portal-documents",
  "lib/diagnoses",
  "lib/diagnosis",
];

/** Los espacios de nombres son prefijos (`lib/hc-` cubre `lib/hc-doc.ts` y `lib/hc-pdf/…`). */
const matchesAny = (relPath: string, list: readonly string[]) => list.some((p) => relPath.startsWith(p));

export const isPortalHcAllowed = (relPath: string) =>
  PORTAL_HC_ALLOWLIST.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : relPath === p));
export const isHcNamespace = (relPath: string) => matchesAny(relPath, HC_NAMESPACES);

/** Archivos existentes de la allow-list (expande las carpetas). Los que todavía no existen se omiten. */
export function portalHcAllowlistFiles(): string[] {
  return PORTAL_HC_ALLOWLIST.flatMap((p) => (p.endsWith("/") ? walk(abs(p)).map(rel) : existsSync(abs(p)) ? [p] : [])).sort();
}

/** Entradas del portal: todo `app/(portal)`, `components/portal` y `lib/portal*.ts` (las superficies del guard EV2-1a). */
export function portalEntries(): string[] {
  const libPortal = readdirSync(abs("lib"))
    .filter((f) => /^portal.*\.tsx?$/.test(f))
    .map((f) => `lib/${f}`);
  return [...walk(abs("app/(portal)")).map(rel), ...walk(abs("components/portal")).map(rel), ...libPortal].sort();
}
