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
 * (TypeScript los borra: no llegan al bundle). Si falla, el mensaje muestra la cadena de imports completa. El recorrido
 * vive en `tests/helpers/import-graph.ts` desde FC-1e.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// [FC-1e] El BFS vive en el helper (lo comparte el guard del portal «Documentos»); este test afirma lo mismo que antes.
import {
  ROOT,
  rel,
  walk,
  valueSpecifiers,
  resolveLocal,
  forbiddenReach as reachWith,
  fmtViolations as fmt,
  type SpecCache,
  type Violation,
} from "@/tests/helpers/import-graph";

// ── Contrato C-F3.5 (literal): lo que una superficie pública no puede importar, directo ni transitivo. ──
const FORBIDDEN_PACKAGES = ["framer-motion"];
const FORBIDDEN_FILES = [
  "lib/motion.ts",
  "lib/motion-features.ts",
  "components/providers/ui-providers.tsx",
  "components/ui/toast.tsx",
  "components/ui/confirm-dialog.tsx",
  "components/ui/confirm-dialog-panel.tsx",
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
    "app/(directory)/",
    // TV-1c (plan §26.4): pantallas de sala `/tv`. Corren sin Actor en teles de gama baja (grupo de bundle `display`,
    // 125 kB): ni framer, ni toast, ni confirm, ni drawer, ni modal.
    "app/(display)/",
    // LG-P (PV §27): `/terminos` y `/privacidad` (grupo de bundle `public`): server components estáticos, sin JS.
    "app/(legal)/",
    // TK-U2 (PV §27): `/contacto`, la entrada pública única de contacto (grupo de bundle `public`). Lo ven visitantes sin
    // sesión y usuarios bloqueados: forms planos con `useFormState`, sin providers.
    "app/contacto/",
  ];
  const SINGLE = ["app/page.tsx", "app/not-found.tsx", "app/global-error.tsx", "app/error.tsx"];
  return all.filter(
    (f) =>
      SINGLE.includes(f) ||
      DIR_PREFIXES.some((d) => f.startsWith(d)) ||
      (f.startsWith("app/auth/") && /\/page\.tsx?$/.test(f))
  );
}

/** BFS desde `entry`; devuelve la primera cadena hacia cada objetivo prohibido de C-F3.5. */
const forbiddenReach = (entry: string, cache: SpecCache): Violation[] =>
  reachWith(entry, { isForbiddenFile: (f) => FORBIDDEN_FILES.includes(f), forbiddenPackages: FORBIDDEN_PACKAGES }, cache);

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

describe("[VX F-d] superficies públicas sin framer-motion ni providers de UI (C-F3 / C-F7)", () => {
  const cache: SpecCache = new Map();

  it("las entradas de C-F7 existen (el guard no pasa en vacío)", () => {
    const entries = publicEntries();
    for (const must of ["app/page.tsx", "app/not-found.tsx", "app/global-error.tsx"]) expect(entries).toContain(must);
    expect(entries.some((f) => f.startsWith("app/(auth)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/(booking)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/(portal)/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/invite/"))).toBe(true);
    expect(entries.some((f) => f.startsWith("app/verificar-acceso/"))).toBe(true);
  });

  // [TV-1c] El grupo `app/(display)/` lo crea otra sesión de la ola (TV-2*): mientras no exista, el guard no tiene qué
  // recorrer; cuando exista, sus páginas tienen que estar entre las entradas (si no, el guard pasaría en vacío).
  it("[TV-1c] las páginas de app/(display)/ (si existen) son entradas del guard", () => {
    const dir = join(ROOT, "app", "(display)");
    if (!existsSync(dir)) return;
    const pages = walk(dir).map(rel).filter((f) => /\/(page|layout)\.tsx?$/.test(f));
    const entries = publicEntries();
    for (const p of pages) expect(entries, p).toContain(p);
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
    // [CF2-ZF4] el diálogo de confirmación vive en `confirm-dialog-panel` (lo baja el provider con `import()`).
    for (const f of ["toast", "modal", "drawer", "confirm-dialog-panel"]) {
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
