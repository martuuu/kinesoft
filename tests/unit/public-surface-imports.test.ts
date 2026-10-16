/**
 * VX F-d · C-F3 + C-F7: las superficies públicas no cargan framer-motion ni los providers/primitivas de UI.
 *
 * Por qué: `UIProviders` (MotionConfig + Toast + Confirm) vivía en el root y arrastraba framer-motion (~35 kB) a la
 * landing, el login, el turnero y el portal, que no usan ni toast ni modal (baseline de bundle en
 * `scripts/bundle-baseline.json`). F-d lo saca a los layouts que lo usan; este guard impide que vuelva por un import
 * transitivo (p. ej. una pantalla pública que importe un componente que importa `Drawer`).
 *
 * Grafo de imports REAL (no grep plano): se sigue cada `import`/`export … from`/`import()` con specifier `@/…` o
 * relativo, resolviendo extensiones e `index`, desde cada entrada de C-F7. Se ignoran los `import type`/`export type`
 * (TypeScript los borra: no llegan al bundle). Si falla, el mensaje muestra la cadena de imports completa.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const ROOT = process.cwd();
const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

// ── Contrato C-F3.5 (literal): lo que una superficie pública no puede importar, directo ni transitivo. ──
const FORBIDDEN_PACKAGES = ["framer-motion"];
const FORBIDDEN_FILES = [
  "lib/motion.ts",
  "lib/motion-features.ts",
  "components/providers/ui-providers.tsx",
  "components/ui/toast.tsx",
  "components/ui/confirm-dialog.tsx",
  "components/ui/drawer.tsx",
  "components/ui/modal.tsx",
];

// ── C-F3.3: los únicos layouts que montan `UIProviders`. ──
const UI_PROVIDER_MOUNTS = [
  "app/(app)/layout.tsx",
  "app/(platform)/layout.tsx",
  "app/onboarding/layout.tsx",
  "app/cuenta/layout.tsx",
  "app/plataforma-mfa/layout.tsx",
];

// ── C-F3.7: ratchet. Medido el 15-oct después de F-d (20 con `motion`, 26 con framer) y regrabado en PF1-Z (16-oct):
// `motion` = 0 (C-PF1.3, con `LazyMotion strict`) y 21 importadores reales (`m`, `AnimatePresence`, tipos). Si un
// número baja, se baja acá (nunca se sube). ──
/** Archivos que importan el componente `motion` (pesado: trae sus features) de framer-motion. */
const MOTION_COMPONENT_IMPORTERS_MAX = 0;
/** Archivos que importan cualquier cosa de framer-motion (incluye `m`, `LazyMotion`, tipos). */
const FRAMER_IMPORTERS_MAX = 21;

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

/** C-F7 (literal): entradas de las superficies públicas. */
function publicEntries(): string[] {
  const app = join(ROOT, "app");
  const all = walk(app).map(rel);
  const DIR_PREFIXES = [
    "app/(auth)/",
    "app/(booking)/",
    "app/(portal)/",
    "app/invite/",
    "app/sin-acceso/",
    "app/suspendido/",
    "app/cuenta-desactivada/",
    "app/mantenimiento/",
    "app/verificar-acceso/",
    "app/elegir-consultorio/",
  ];
  const SINGLE = ["app/page.tsx", "app/not-found.tsx", "app/global-error.tsx"];
  return all.filter(
    (f) =>
      SINGLE.includes(f) ||
      DIR_PREFIXES.some((d) => f.startsWith(d)) ||
      (f.startsWith("app/auth/") && /\/page\.tsx?$/.test(f))
  );
}

/** Specifiers de VALOR del archivo (sin `import type` / `export type`). */
function valueSpecifiers(src: string): string[] {
  // Comentarios fuera: un `import` dentro de un JSDoc no es un import.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  const staticRe = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(staticRe)) if (!m[2]) specs.push(m[4]);
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile() && EXTS.some((e) => c.endsWith(e))) return c;
  return null; // .css, .json, assets: no cargan JS de UI
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

type Violation = { entry: string; target: string; chain: string[] };

/** BFS desde `entry`; devuelve la primera cadena hacia cada objetivo prohibido. */
function forbiddenReach(entry: string, cache: Map<string, string[]>): Violation[] {
  const start = join(ROOT, entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const found: Violation[] = [];
  const chainTo = (abs: string) => {
    const chain: string[] = [];
    for (let cur: string | null = abs; cur; cur = parent.get(cur) ?? null) chain.unshift(rel(cur));
    return chain;
  };
  while (queue.length) {
    const file = queue.shift()!;
    let specs = cache.get(file);
    if (!specs) {
      specs = valueSpecifiers(readFileSync(file, "utf8"));
      cache.set(file, specs);
    }
    for (const spec of specs) {
      const local = resolveLocal(spec, file);
      if (!local) {
        if (!spec.startsWith(".") && !spec.startsWith("@/") && FORBIDDEN_PACKAGES.includes(packageName(spec))) {
          found.push({ entry, target: spec, chain: chainTo(file) });
        }
        continue;
      }
      if (parent.has(local)) continue;
      parent.set(local, file);
      if (FORBIDDEN_FILES.includes(rel(local))) {
        found.push({ entry, target: rel(local), chain: chainTo(local) });
        continue; // ya es violación; no hace falta seguir adentro
      }
      queue.push(local);
    }
  }
  return found;
}

/**
 * Fugas conocidas, pendientes de un handoff (no son archivos de F-d). Cada una tiene su `it.fails` abajo: cuando el
 * integrador aplica el handoff, el `it.fails` se pone rojo («pasó») → se pasa a `it` y se borra la fila de acá.
 * - F-d/H1: `/verificar-acceso` importa `TotpCodeInput` de `components/plataforma/reauth-modal.tsx`, que importa
 *   `Modal` (y framer-motion) para `PlatformReauthProvider`. No rompe en runtime (no usa toast/confirm), pero mete el
 *   modal y framer en una superficie pública. Fix: mover `TotpCodeInput` a su propio archivo sin `Modal`.
 */
const KNOWN_LEAKS: { entry: string; target: string }[] = [
  // F-d/H1 resuelto en F-Z: TotpCodeInput vive en components/account/totp-code-input.tsx (sin Modal ni framer).
];
const isKnownLeak = (v: Violation) => KNOWN_LEAKS.some((k) => k.entry === v.entry && k.target === v.target);

const fmt = (v: Violation[]) => v.map((x) => `${x.entry} → ${x.target}\n    ${x.chain.join("\n    → ")}`).join("\n");

describe("[VX F-d] superficies públicas sin framer-motion ni providers de UI (C-F3 / C-F7)", () => {
  const cache = new Map<string, string[]>();

  it("las entradas de C-F7 existen (el guard no pasa en vacío)", () => {
    const entries = publicEntries();
    for (const must of ["app/page.tsx", "app/not-found.tsx", "app/global-error.tsx"]) expect(entries).toContain(must);
    expect(entries.some((f) => f.startsWith("app/(auth)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/(booking)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/(portal)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/invite/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/verificar-acceso/"))).toBe(true);
  });

  it("anti-false-green: el grafo SÍ detecta los prohibidos desde una superficie privada", () => {
    const reach = forbiddenReach("app/(app)/layout.tsx", cache).map((v) => v.target);
    expect(reach).toContain("components/providers/ui-providers.tsx");
    // y sigue imports transitivos: desde las providers se llega a toast/confirm
    const viaProviders = forbiddenReach("components/providers/ui-providers.tsx", cache).map((v) => v.target);
    expect(viaProviders).toEqual(expect.arrayContaining(["framer-motion", "components/ui/toast.tsx"]));
  });

  it("ninguna superficie pública importa (directo ni transitivo) framer-motion, lib/motion*, UIProviders, toast, confirm, drawer ni modal", () => {
    const violations = publicEntries()
      .flatMap((e) => forbiddenReach(e, cache))
      .filter((v) => !isKnownLeak(v));
    expect(violations, fmt(violations)).toEqual([]);
  });

  it("[VX F-d → handoff H1] /verificar-acceso no arrastra Modal ni framer vía TotpCodeInput", () => {
    const violations = forbiddenReach("app/verificar-acceso/page.tsx", cache);
    expect(violations, fmt(violations)).toEqual([]);
  });

  it("el root layout (ancestro de todas las públicas) no monta UIProviders ni importa framer (C-F3.1)", () => {
    const violations = forbiddenReach("app/layout.tsx", cache);
    expect(violations, fmt(violations)).toEqual([]);
  });

  it("UIProviders se monta solo en los 5 layouts de C-F3.3", () => {
    const importers = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => rel(f) !== "components/providers/ui-providers.tsx")
      .filter((f) =>
        valueSpecifiers(readFileSync(f, "utf8")).some(
          (s) => resolveLocal(s, f) === join(ROOT, "components/providers/ui-providers.tsx")
        )
      )
      .map(rel)
      .sort();
    expect(importers).toEqual([...UI_PROVIDER_MOUNTS].sort());
  });

  it("UIProviders = LazyMotion (features async de lib/motion-features) → MotionConfig reducedMotion=user, strict desde PF1-Z (C-PF1.3)", () => {
    const src = readFileSync(join(ROOT, "components/providers/ui-providers.tsx"), "utf8");
    expect(src).toMatch(/<LazyMotion features=\{loadMotionFeatures\} strict>/);
    expect(src).toMatch(/import\(\s*"@\/lib\/motion-features"\s*\)/);
    expect(src).toMatch(/<MotionConfig reducedMotion="user">/);
    const order = ["<LazyMotion", "<MotionConfig", "<ToastProvider>", "<ConfirmProvider>"].map((t) => src.indexOf(t));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    const feats = readFileSync(join(ROOT, "lib/motion-features.ts"), "utf8");
    expect(feats).toMatch(/export default domMax;/);
  });

  it("toast, modal, drawer y confirm-dialog usan `m.*`, no `motion.*` (C-F3.4)", () => {
    for (const f of ["toast", "modal", "drawer", "confirm-dialog"]) {
      const src = readFileSync(join(ROOT, `components/ui/${f}.tsx`), "utf8");
      expect(src, f).not.toMatch(/<\/?motion\./);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*"framer-motion"/);
      expect(src, f).toMatch(/<m\./);
      expect(src, f).toMatch(/AnimatePresence/);
    }
  });

  it("ratchet: importadores de framer-motion no suben (C-F3.7)", () => {
    const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
    const framer = files.filter((f) => /from\s*["']framer-motion["']/.test(readFileSync(f, "utf8")));
    const motionComp = framer.filter((f) =>
      /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*["']framer-motion["']/.test(readFileSync(f, "utf8"))
    );
    expect(motionComp.length, motionComp.map(rel).join("\n")).toBeLessThanOrEqual(MOTION_COMPONENT_IMPORTERS_MAX);
    expect(framer.length, framer.map(rel).join("\n")).toBeLessThanOrEqual(FRAMER_IMPORTERS_MAX);
  });
});
