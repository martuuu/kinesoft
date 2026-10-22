/**
 * [TP-K4] Guard del first load de `/agenda` para T5 (brief §25.11): «`/agenda` ≤ cierre de T4 **+0,3 kB** · Badges +
 * ítem del menú; drawer, sección, comprobante y link diferidos».
 *
 * Por qué existe: la card de la agenda (TP-3e) sí suma algo al first load (el mini-badge «Seña» / «Pagado MP»), pero
 * todo lo demás de T5 (la sección de plata del drawer del turno, el comprobante y el `PaymentLinkDrawer` con su zod)
 * tiene que bajar por `import()`. `check-bundle-budget` mide recién con `next build` (y no cuenta los chunks de
 * `next/dynamic`, hallazgo 4 de §24.2), así que un import estático «cómodo» se vería tarde. Este guard lo frena en el
 * unit, con el MISMO grafo real de imports que usan los guards de T4 (`tests/helpers/import-graph.ts`).
 *
 * Dos clausuras desde la página:
 *  - **estática** (first load): `import`/`export … from` de valor; no sigue `import()` ni entra a `"use server"`;
 *  - **completa** (lo que la ruta puede llegar a bajar): también sigue `import()` / `next/dynamic`.
 * «Diferido» = está en la completa y NO en la estática.
 *
 * El +0,3 kB se aproxima sin build: el código de T5 alcanzado estáticamente se arma con esbuild (minificado, con
 * tree-shaking, solo los nombres que de verdad se importan, el resto del repo como externo) y se mide en gzip menos
 * los 20 B fijos de un gzip vacío. Es una cota: en el chunk real de webpack el gzip comparte diccionario y pesa algo
 * menos. El número oficial lo mide TP-3z con `next build` + `perf:bundle --explain` (tabla de §25.11).
 *
 * `it.fails` (se dan vuelta en T5e):
 *  - [TP-3c] el drawer del turno monta la sección de plata por `import()` → sección, comprobante y link quedan
 *    alcanzables desde `/agenda` solo diferidos;
 *  - [TP-3e] los badges entran al first load y lo de T5 estático sigue ≤ 0,3 kB (dado vuelta en TP-3e).
 * Los `it` ya pasan y quedan de ratchet.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { abs, rel, resolveLocal, valueSpecifiers } from "@/tests/helpers/import-graph";

const ENTRY = "app/(app)/agenda/page.tsx";
const BOOKING_DRAWER = "components/agenda/booking-drawer/index.tsx";
const SECTION = "components/payments/booking-money-section.tsx";
const LINK_DRAWER = "components/payments/payment-link-drawer.tsx";
const RECEIPT_VIEW = "components/payments/mp-receipt-view.tsx";
/**
 * [TP-3e] El badge de la card vive en un módulo mínimo propio: `bookingMoneyBadge` de `lib/booking-money-view.ts` medía
 * 315 B (> 300); `cardMoneyBadge` es la versión mínima con la misma regla y el mismo texto (paridad en
 * `booking-money-badge.test.ts`; números de `next build` en la cabecera del módulo).
 */
const BADGES = "lib/booking-money-badge.ts";
/** Techo de §25.11: +0,3 kB gz sobre el cierre de T4. */
const T5_AGENDA_BUDGET_BYTES = 300;

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

/** Clausura desde `entry` (rutas relativas). `withDynamic` también sigue `import()`. No entra a `"use server"`. */
function closure(entry: string, withDynamic: boolean): Set<string> {
  const start = abs(entry);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, "utf8");
    if (file !== start && isUseServer(src)) continue;
    const specs = withDynamic ? valueSpecifiers(src) : staticSpecifiers(src);
    for (const spec of specs) {
      const local = resolveLocal(spec, file);
      if (!local || seen.has(local)) continue;
      seen.add(local);
      queue.push(local);
    }
  }
  return new Set([...seen].map(rel));
}

/** Archivos de T5 (§25.12; mismo criterio que el ratchet de vocabulario `online-payments-copy.test.ts`). */
const T5_PREFIXES = ["components/payments/", "components/cobros/", "lib/mp-connect/"];
const T5_FILES = new Set([
  "lib/online-payments-copy.ts",
  "lib/booking-money-view.ts",
  "lib/booking-money-badge.ts",
  "lib/mp-receipt.ts",
  "lib/online-charge-logic.ts",
  "lib/online-payments-types.ts",
  "lib/mp-connect-types.ts",
  "lib/payment-links-types.ts",
  "lib/booking-payment-policy-types.ts",
  "lib/payment-link-form.ts",
  "lib/cobros-view.ts",
  "components/configuracion/panels/online-payments-panel.tsx",
  "components/configuracion/panels/my-mp-panel.tsx",
  "components/configuracion/panels/clinic-mp-account-card.tsx",
]);
const isT5 = (f: string) => T5_FILES.has(f) || T5_PREFIXES.some((p) => f.startsWith(p));

/** Lo de T5 que NUNCA va estático en `/agenda` (todo menos los badges y su copy). */
const NEVER_STATIC = [
  SECTION,
  LINK_DRAWER,
  RECEIPT_VIEW,
  "components/payments/",
  "lib/mp-receipt.ts",
  "lib/online-charge-logic.ts",
  "lib/payment-links-types.ts",
  "lib/payment-link-form.ts",
  "lib/mp-connect/",
  // [TP-3e] La card usa el badge mínimo; `booking-money-view` (líneas del drawer) baja con la sección de plata.
  "lib/booking-money-view.ts",
];
const hits = (set: Set<string>, paths: string[]) =>
  [...set].filter((f) => paths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));

/**
 * Nombres que los archivos NO de T5 de la clausura importan de módulos de T5 → `export { … } from "<T5>"`. Así el
 * tree-shaking de esbuild deja solo lo que de verdad se usa (como webpack en producción).
 */
function t5EntryFor(statics: Set<string>): string {
  const lines: string[] = [];
  for (const f of statics) {
    if (isT5(f)) continue;
    const code = stripComments(readFileSync(abs(f), "utf8"));
    for (const m of code.matchAll(/^\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
      const target = resolveLocal(m[2], abs(f));
      if (!target || !isT5(rel(target))) continue;
      const clause = m[1];
      const named = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? "";
      const names = named
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0].trim());
      const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause.trim())?.[1];
      if (def) names.push("default");
      if (/\*\s+as\s+/.test(clause)) {
        lines.push(`export * from ${JSON.stringify(target)};`);
        continue;
      }
      if (names.length) lines.push(`export { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(target)};`);
    }
  }
  return [...new Set(lines)].join("\n");
}

/** gzip (−20 B fijos) del código de T5 que alcanza el first load: minificado, tree-shaken, el resto del repo externo. */
async function t5StaticBytes(statics: Set<string>): Promise<number> {
  return measureT5(t5EntryFor(statics));
}

async function measureT5(entry: string): Promise<number> {
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
        name: "solo-t5",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (a.kind === "entry-point") return undefined;
            const local = a.path.startsWith("/") ? a.path : resolveLocal(a.path, a.importer || abs("x.ts"));
            if (local && existsSync(local) && isT5(rel(local))) return { path: local };
            // Lo que no es de T5 ya está (o no) en el first load por su cuenta: no se cuenta acá.
            return { path: a.path, external: true, sideEffects: false };
          });
        },
      },
    ],
  });
  const code = out.outputFiles[0]?.text ?? "";
  return Math.max(0, gzipSync(code).length - gzipSync("").length);
}

const statics = closure(ENTRY, false);
const full = closure(ENTRY, true);

describe("[TP-K4] /agenda: lo de T5 va diferido (§25.11)", () => {
  it("la entrada existe y los grafos se recorren (sanidad: el BFS no quedó vacío)", () => {
    expect(existsSync(abs(ENTRY))).toBe(true);
    expect(statics.has("components/agenda/agenda-client.tsx")).toBe(true);
    // El drawer del turno ya es `next/dynamic` desde la agenda: en la completa sí, en la estática no.
    expect(full.has(BOOKING_DRAWER)).toBe(true);
    expect(statics.has(BOOKING_DRAWER)).toBe(false);
  });

  it("ni la sección, ni el comprobante, ni el link, ni las reglas de cobro entran estáticos al first load", () => {
    const found = hits(statics, NEVER_STATIC);
    expect(found, `T5 estático en ${ENTRY}:\n${found.join("\n")}`).toEqual([]);
  });

  it("la sección de plata no arrastra estáticos el comprobante ni el PaymentLinkDrawer (bajan cuando hacen falta)", () => {
    const fromSection = closure(SECTION, false);
    expect(hits(fromSection, [LINK_DRAWER, RECEIPT_VIEW, "lib/payment-links-types.ts"])).toEqual([]);
    // …pero sí los puede bajar (la sección los usa por `import()`).
    const fromSectionFull = closure(SECTION, true);
    expect(fromSectionFull.has(LINK_DRAWER)).toBe(true);
    expect(fromSectionFull.has(RECEIPT_VIEW)).toBe(true);
  });

  it("el chunk del drawer del turno no lleva estáticos el comprobante ni el PaymentLinkDrawer", () => {
    const fromDrawer = closure(BOOKING_DRAWER, false);
    expect(hits(fromDrawer, [LINK_DRAWER, RECEIPT_VIEW, "lib/mp-receipt.ts", "lib/payment-links-types.ts"])).toEqual([]);
  });

  it("[TP-3c] el drawer del turno monta la sección de plata por import() (alcanzable desde /agenda, solo diferida)", () => {
    expect(full.has(SECTION), `${SECTION} no se alcanza desde ${ENTRY}`).toBe(true);
    expect(statics.has(SECTION)).toBe(false);
    expect(closure(BOOKING_DRAWER, false).has(SECTION), `${BOOKING_DRAWER} la importa estática`).toBe(false);
    expect(closure(BOOKING_DRAWER, true).has(SECTION)).toBe(true);
  });

  it("[TP-3c] comprobante y PaymentLinkDrawer alcanzables desde /agenda solo diferidos", () => {
    for (const f of [LINK_DRAWER, RECEIPT_VIEW]) {
      expect(full.has(f), `${f} no se alcanza desde ${ENTRY}`).toBe(true);
      expect(statics.has(f), `${f} entró al first load`).toBe(false);
    }
  });
});

describe("[TP-K4] /agenda: T5 suma ≤ 0,3 kB al first load (§25.11)", () => {
  it("el medidor ve el código de T5 importado y descarta lo que no se usa (sanidad del tree-shaking)", async () => {
    expect(await measureT5("")).toBe(0);
    const badge = await measureT5(`export { cardMoneyBadge } from ${JSON.stringify(abs(BADGES))};`);
    const wholeCopy = await measureT5(`export * from ${JSON.stringify(abs("lib/online-payments-copy.ts"))};`);
    expect(badge).toBeGreaterThan(0);
    // El badge solo trae su pedazo del copy, no el módulo entero (si no, el techo no mediría nada real).
    expect(badge).toBeLessThan(wholeCopy / 2);
    // Un archivo que no es de T5 que importa de T5 genera la entrada; uno de T5 no (se cuenta desde afuera).
    expect(t5EntryFor(new Set(["components/payments/booking-money-section.tsx"]))).toBe("");
  });

  it("lo de T5 que entra estático a /agenda pesa ≤ 0,3 kB gz (minificado y tree-shaken)", async () => {
    const bytes = await t5StaticBytes(statics);
    expect(bytes, `T5 estático en /agenda: ${bytes} B gz (techo ${T5_AGENDA_BUDGET_BYTES})`).toBeLessThanOrEqual(T5_AGENDA_BUDGET_BYTES);
  });

  it("[TP-3e] los badges «Seña» / «Pagado MP» entran al first load de /agenda y T5 sigue ≤ 0,3 kB gz", async () => {
    expect(statics.has(BADGES), `${BADGES} no está en el first load (la card todavía no muestra el badge)`).toBe(true);
    const bytes = await t5StaticBytes(statics);
    expect(bytes, `T5 estático en /agenda: ${bytes} B gz`).toBeLessThanOrEqual(T5_AGENDA_BUDGET_BYTES);
  });
});
