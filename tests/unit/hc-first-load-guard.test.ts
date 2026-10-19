/**
 * [FC-3k] Guard del first load de `/pacientes/[id]` (brief T4 §24.9 «Bundle y perf», «Guards»):
 * «la HC es estática; Drawer, editor, picker, import, respaldo y Resumen fuera».
 *
 * Por qué existe: §24.7 pone la historia clínica como pestaña PRIMERA e inicial del perfil y el composer siempre
 * visible: tiene que pintarse desde el SSR sin esperar un chunk (si fuera `next/dynamic`, el profesional ve un
 * skeleton y lo que tipea se pierde). A la vez, el tope de 175 kB del perfil no aguanta Tiptap (~100-130 kB gz),
 * mammoth (~110-170 kB gz) ni los paneles grandes; y `check-bundle-budget` no cuenta los chunks de `next/dynamic`
 * (hallazgo 4 de §24.2), así que un import estático «cómodo» se ve recién en el build. Este guard lo frena en el unit.
 *
 * Grafo REAL de imports ESTÁTICOS de valor desde la página (mismo criterio que `hc-heavy-deps`): se siguen
 * `import`/`export … from`/`import "x"` con specifier `@/…` o relativo; se ignoran `import type`; los `import()` NO se
 * siguen (es la forma permitida de diferir: `next/dynamic(() => import(…))` arma un chunk aparte); no se entra a
 * archivos `"use server"` (desde el cliente son una referencia RPC, su cuerpo nunca viaja).
 *
 * Los `it.fails` los da vuelta FC-3d (shell: HC estática y primera, Resumen diferida) y FC-3e1 (inicio de la HC con el
 * composer inline); los `it` ya pasan y quedan de ratchet para FC-3a/3b/3c/3e2/3f/3g. Los archivos que todavía no
 * existen se aceptan (el guard fija dónde NO pueden estar, no exige que existan).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { abs, packageName, rel, resolveLocal } from "@/tests/helpers/import-graph";

const ENTRY = "app/(app)/pacientes/[id]/page.tsx";

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const isUseServer = (src: string) => /^\s*["']use server["'];?/.test(stripComments(src).trimStart());

/** Specifiers ESTÁTICOS de valor (sin `import type`, sin `import()`). */
function staticSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (!m[2]) out.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

type Closure = { files: Map<string, string[]>; packages: Map<string, string[]> };

/** Clausura estática desde `entry`: archivo/paquete alcanzado → cadena desde la entrada (para el mensaje). */
function staticClosure(entry: string): Closure {
  const start = abs(entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const packages = new Map<string, string[]>();
  const queue = [start];
  const chainTo = (file: string) => {
    const chain: string[] = [];
    for (let cur: string | null = file; cur; cur = parent.get(cur) ?? null) chain.unshift(rel(cur));
    return chain;
  };
  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, "utf8");
    if (file !== start && isUseServer(src)) continue;
    for (const spec of staticSpecifiers(src)) {
      const local = resolveLocal(spec, file);
      if (!local) {
        if (!spec.startsWith(".") && !spec.startsWith("@/")) {
          const pkg = packageName(spec);
          if (!packages.has(pkg)) packages.set(pkg, chainTo(file));
        }
        continue;
      }
      if (parent.has(local)) continue;
      parent.set(local, file);
      queue.push(local);
    }
  }
  const files = new Map<string, string[]>();
  for (const f of parent.keys()) files.set(rel(f), chainTo(f));
  return { files, packages };
}

const closure = staticClosure(ENTRY);
const fmt = (hits: [string, string[]][]) => hits.map(([t, chain]) => `${t}\n    ${chain.join("\n    → ")}`).join("\n");

/** Archivos que tienen que estar en el first load (estáticos desde la página). */
const MUST_BE_STATIC = [
  // Inicio de la HC (FC-3e1) y la timeline/tarjeta.
  "components/patients/profile/views/evoluciones-view.tsx",
  // Composer inline (FC-3c) con el campo del editor (textarea SSR, FC-3a) y el de diagnósticos (chips, FC-3b).
  "components/fichas/ficha-form.tsx",
  "components/fichas/hc-editor-field.tsx",
  "components/fichas/diagnosis-field.tsx",
  // Render del doc (FC-1a): las tarjetas se pintan desde el SSR.
  "components/hc/hc-doc-view.tsx",
];

/** Prefijo de carpeta (termina en `/`) o archivo exacto. */
const FORBIDDEN_FILES: { what: string; paths: string[] }[] = [
  { what: "Resumen (segunda pestaña, diferida con SSR)", paths: ["components/patients/profile/views/resumen-view.tsx"] },
  { what: "FichaDrawer (FC-3c)", paths: ["components/fichas/ficha-drawer.tsx"] },
  { what: "editor Tiptap (FC-3a)", paths: ["components/hc/editor/"] },
  { what: "picker de diagnósticos (FC-3b)", paths: ["components/fichas/diagnosis-picker.tsx"] },
  {
    what: "import de Word (FC-3f)",
    paths: ["components/fichas/word-import-drawer.tsx", "components/fichas/word-import-logic.ts", "components/fichas/word-reader.ts"],
  },
  { what: "respaldo (FC-3g)", paths: ["components/fichas/backup-setup.tsx", "lib/hc-backup.ts", "lib/hc-backup-idb.ts"] },
  { what: "compartir (FC-3e2)", paths: ["components/fichas/share-ficha-dialog.tsx"] },
];
const FORBIDDEN_PACKAGES = ["@tiptap/core", "@tiptap/react", "@tiptap/pm", "@tiptap/starter-kit", "mammoth"];

const reached = (paths: string[]) =>
  [...closure.files].filter(([f]) => paths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));

describe("[FC-3k] first load de /pacientes/[id] (§24.9)", () => {
  it("la entrada existe y el grafo se recorre (sanidad: el BFS no quedó vacío)", () => {
    expect(existsSync(abs(ENTRY))).toBe(true);
    expect(closure.files.has("components/patients/patient-profile.tsx")).toBe(true);
  });

  it.fails("[FC-3k] la HC es estática: inicio, composer, editor (textarea), diagnósticos y HcDocView en el first load", () => {
    const missing = MUST_BE_STATIC.filter((f) => !closure.files.has(f));
    expect(missing, `no alcanzados estáticamente desde ${ENTRY}:\n${missing.join("\n")}`).toEqual([]);
  });

  it.fails("[FC-3k] Resumen fuera del first load (va segunda y diferida)", () => {
    const hits = reached(FORBIDDEN_FILES[0].paths);
    expect(hits, fmt(hits)).toEqual([]);
  });

  for (const { what, paths } of FORBIDDEN_FILES.slice(1)) {
    it(`[FC-3k] ${what} fuera del first load`, () => {
      const hits = reached(paths);
      expect(hits, fmt(hits)).toEqual([]);
    });
  }

  it("[FC-3k] ni Tiptap/ProseMirror ni mammoth en el first load", () => {
    const hits = [...closure.packages].filter(([p]) => FORBIDDEN_PACKAGES.includes(p) || p.startsWith("prosemirror-"));
    expect(hits, fmt(hits)).toEqual([]);
  });

  it("[FC-3k] los componentes estáticos de fichas no importan estático los diferidos", () => {
    // Ratchet local (no depende de que el perfil ya los use): FichaForm/HcEditorField/DiagnosisField/useFichaBackup
    // son estáticos; lo pesado entra por `next/dynamic` o `import()` desde ellos.
    const forbidden = FORBIDDEN_FILES.slice(1).flatMap((f) => f.paths);
    const statics = [
      "components/fichas/ficha-form.tsx",
      "components/fichas/hc-editor-field.tsx",
      "components/fichas/diagnosis-field.tsx",
      "components/fichas/use-ficha-backup.ts",
    ].filter((f) => existsSync(abs(f)));
    const hits: [string, string[]][] = [];
    for (const s of statics) {
      const c = staticClosure(s);
      for (const [f, chain] of c.files) if (forbidden.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p))) hits.push([f, chain]);
      for (const [p, chain] of c.packages) if (FORBIDDEN_PACKAGES.includes(p) || p.startsWith("prosemirror-")) hits.push([p, chain]);
    }
    expect(hits, fmt(hits)).toEqual([]);
  });
});
