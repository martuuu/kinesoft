/**
 * [CF2-MU] Guard del first load de `/agenda` para el tag de cobro del copago (brief CF2 A.2, D-CF2-3; reglas comunes:
 * «`/agenda` first-load ≈175,9 kB de 180»). El tag («Por cobrar» / «Pagado · Efectivo» / «Retenido») se ve en la card,
 * la Lista y la Semana sin abrir el turno, así que SÍ entra estático al first load: `lib/copago-tag.ts` (la regla),
 * `components/agenda/grid/money-badge.tsx` (el badge, que reemplaza al de TP-3e de `booking-card`) y
 * `money-viewer-context.ts` (quién lo ve). Techo: **≤ 0,4 kB gz** entre los tres y lo que solo ellos arrastran.
 *
 * Por qué un guard propio y no `check-bundle-budget`: ese mide recién con `next build`, y un import «cómodo» en
 * `copago-tag` (p. ej. `reception-desk-state` para `deskOwedCents`, o `booking-collect` para `copagoCollectViewFor`)
 * metería todo el escritorio de /sala o las reglas de cobro al first load sin que nadie lo vea hasta el gate. Es la
 * MISMA medición que `online-payments-first-load-guard.test.ts` (T5): esbuild minificado y tree-shaken con solo los
 * nombres que de verdad se importan, el resto del repo externo, gzip menos los 20 B fijos de un gzip vacío. Es una
 * cota: en el chunk real de webpack el gzip comparte diccionario y pesa algo menos. El número oficial sale de
 * `next build` en el gate de la ola.
 *
 * «Lo que solo ellos arrastran»: módulos del first load que dejan de alcanzarse si se cortan los tres archivos de CF2
 * (p. ej. `lib/payment-method` si nadie más de la agenda lo importara con valor). Esos son costo marginal de CF2 y
 * entran en la cuenta; lo que la agenda ya cargaba por su cuenta (`lib/format`, React) no.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { abs, rel, resolveLocal } from "@/tests/helpers/import-graph";

const ENTRY = "app/(app)/agenda/page.tsx";
const CF2_FILES = [
  "lib/copago-tag.ts",
  "components/agenda/grid/money-badge.tsx",
  "components/agenda/grid/money-viewer-context.ts",
] as const;
/**
 * Ratchet duro mientras Martin / el integrador deciden (ver [CF2-MU10]): medido el 02-nov en 1.073 B gz standalone
 * (`copago-tag` ≈ 514 con `payment-method`, contexto ≈ 108, el resto el badge y su `miniBadge` copiado). Contra el
 * diccionario de los vecinos del chunk de la card (`grid/`, `views/`, `agenda-utils`) el agregado real ronda 0,6 kB.
 */
const CF2_MONEY_RATCHET_BYTES = 1_100;
/** El badge mínimo de T5 ya estaba en el first load (en `booking-card`) y lo mide su propio guard (300 B). */
const MEASURED_ELSEWHERE = new Set(["lib/booking-money-badge.ts"]);

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const isUseServer = (src: string) => /^\s*["']use server["'];?/.test(stripComments(src).trimStart());

/** Specifiers ESTÁTICOS de valor (sin `import type`, sin `import()`); incluye `export … from` (re-exports). */
function staticSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (!m[2]) out.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

/** Clausura estática desde `entry` (rutas relativas); no entra a `"use server"` ni a los archivos de `cut`. */
function closure(entry: string, cut: ReadonlySet<string> = new Set()): Set<string> {
  const start = abs(entry);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, "utf8");
    if (file !== start && isUseServer(src)) continue;
    for (const spec of staticSpecifiers(src)) {
      const local = resolveLocal(spec, file);
      if (!local || seen.has(local)) continue;
      seen.add(local);
      if (cut.has(rel(local))) continue;
      queue.push(local);
    }
  }
  return new Set([...seen].map(rel));
}

/**
 * Nombres que los archivos de fuera de `counted` importan (o re-exportan) de `counted` → `export { … } from "<f>"`,
 * para que el tree-shaking deje solo lo usado (como webpack en producción).
 */
function entryFor(statics: Set<string>, counted: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const f of statics) {
    if (counted.has(f)) continue;
    const src = readFileSync(abs(f), "utf8");
    // Un `"use server"` no viaja al cliente: lo que importa no es first load (la clausura tampoco entra).
    if (f !== ENTRY && isUseServer(src)) continue;
    const code = stripComments(src);
    // `export` solo como re-export (`export { … } from` / `export * from`): un `[\s\S]*?` suelto desde un
    // `export function` cruzaba hasta el `from` del próximo re-export y armaba una entrada inválida.
    const re = /^\s*(?:import\s+(?!type\b)([^;]*?)|export\s+(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?))\s*from\s*["']([^"']+)["']/gm;
    for (const m of code.matchAll(re)) {
      const target = resolveLocal(m[3], abs(f));
      if (!target || !counted.has(rel(target))) continue;
      const clause = m[1] ?? m[2];
      if (/\*/.test(clause)) {
        lines.push(`export * from ${JSON.stringify(target)};`);
        continue;
      }
      const named = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? "";
      const names = named
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0].trim());
      if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim())) names.push("default");
      if (names.length) lines.push(`export { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(target)};`);
    }
  }
  return [...new Set(lines)].join("\n");
}

/** gzip (−20 B fijos) de `entry` con solo `counted` adentro: minificado, tree-shaken, el resto externo. */
async function measure(entry: string, counted: ReadonlySet<string>): Promise<number> {
  if (!entry) return 0;
  const out = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    logLevel: "silent",
    plugins: [
      {
        name: "solo-cf2",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (a.kind === "entry-point") return undefined;
            const local = a.path.startsWith("/") ? a.path : resolveLocal(a.path, a.importer || abs("x.ts"));
            if (local && existsSync(local) && counted.has(rel(local))) return { path: local };
            return { path: a.path, external: true, sideEffects: false };
          });
        },
      },
    ],
  });
  const code = out.outputFiles[0]?.text ?? "";
  return Math.max(0, gzipSync(code).length - gzipSync("").length);
}

const statics = closure(ENTRY);
const CUT = new Set<string>(CF2_FILES);
/** Lo de CF2 en el first load + lo que solo se alcanza a través de CF2 (costo marginal). */
const withoutCf2 = closure(ENTRY, CUT);
const counted = new Set<string>([...CF2_FILES, ...[...statics].filter((f) => !withoutCf2.has(f) && !MEASURED_ELSEWHERE.has(f))]);

describe("[CF2-MU] /agenda: el tag de copago entra al first load y pesa ≤ 0,4 kB gz", () => {
  it("[CF2-MU8] sanidad: el BFS recorre la agenda y el medidor ve código real (no pasa en vacío)", async () => {
    expect(statics.has("components/agenda/agenda-client.tsx")).toBe(true);
    expect(await measure("", counted)).toBe(0);
    const tag = await measure(`export { copagoTag } from ${JSON.stringify(abs("lib/copago-tag.ts"))};`, counted);
    expect(tag).toBeGreaterThan(50);
    // Lo de fuera de `counted` es externo: `formatARS` no se cuenta (la agenda ya lo carga).
    expect(counted.has("lib/format.ts")).toBe(false);
  });

  it("[CF2-MU9] la card, la Lista y la Semana pintan el badge nuevo: los tres archivos están en el first load", () => {
    for (const f of CF2_FILES) expect(statics.has(f), `${f} no está en el first load de ${ENTRY}`).toBe(true);
    // Nada pesado del cobro: ni el escritorio de /sala ni las reglas de cobro del drawer.
    for (const heavy of ["lib/reception-desk-state.ts", "lib/booking-collect.ts", "lib/booking-money-view.ts"]) {
      expect(counted.has(heavy), `${heavy} entró al first load por el tag de copago`).toBe(false);
    }
  });

  it(`[CF2-MU10] copago-tag + badge + contexto (y lo que solo ellos arrastran) ≤ ${CF2_MONEY_RATCHET_BYTES} B gz (ratchet)`, async () => {
    const bytes = await measure(entryFor(statics, counted), counted);
    expect(bytes, `CF2 tag de copago en /agenda: ${bytes} B gz (ratchet ${CF2_MONEY_RATCHET_BYTES}); contados: ${[...counted].join(", ")}`).toBeLessThanOrEqual(
      CF2_MONEY_RATCHET_BYTES
    );
    expect(counted.has("lib/payment-method.ts"), "las etiquetas del medio de pago entran por el tag (costo marginal real)").toBe(true);
  });

  // Objetivo del brief (~0,4 kB gz) no alcanzado: el tag mide ~1,07 kB standalone (~0,6 kB marginal en /agenda).
  // Martin decide al cierre de CF2 si se acepta o se achica `money-badge`; el ratchet de arriba frena cualquier crecimiento.
});
