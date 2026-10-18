/**
 * [AS-0z] Guard del first load de /agenda (T3a, plan §23.2 «Bundle /agenda 178,1/180» y §23.11).
 *
 * Por qué existe: lo propio de la página son ~41,7 kB gz, pero webpack arrastra módulos ENTEROS compartidos por un
 * import estático (labels de KPIs de `preferences-constants`, copy del diálogo del candado, `INSTANT_CLASS_LABEL`,
 * copy de roles). La ola T3a los saca a módulos propios (`lib/dashboard-kpi-options`, `lib/day-lock-form`,
 * `lib/slot-picker-state`, `lib/roles-core`…) que solo cargan los chunks diferidos. Este guard evita que un import
 * «cómodo» en la agenda los vuelva a meter al first load.
 *
 * Por nombre de módulo, no por archivo: varios los crean otras sesiones de la misma ola, así que el guard no exige
 * que existan (si no existen, nadie los puede importar y pasa igual). `lib/roles-core` queda permitido a propósito:
 * es la versión liviana que la ola crea para el cliente; lo prohibido es `lib/roles` (copy + capacidades).
 *
 * Además fija los diferidos de la sesión 0z3: el panel del menú «Vista», la leyenda de plan, los chips de profesional
 * y el diagnóstico del indicador «En vivo» bajan por `import()`, no estáticos.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");

/** Archivos vigilados: el cliente de la agenda y todo `agenda-toolbar*` (.ts/.tsx; el CSS no importa JS). */
const WATCHED = [
  "components/agenda/agenda-client.tsx",
  ...readdirSync(resolve(ROOT, "components/agenda"))
    .filter((f) => /^agenda-toolbar.*\.tsx?$/.test(f))
    .map((f) => `components/agenda/${f}`),
];

/** Módulos prohibidos en el first load (regex sobre el especificador, sin extensión). */
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "lib/day-lock-form", re: /(?:^|\/)lib\/day-lock-form$/ },
  { name: "lib/dashboard-kpi-options", re: /(?:^|\/)lib\/dashboard-kpi-options$/ },
  { name: "lib/slot-picker-state", re: /(?:^|\/)lib\/slot-picker-state$/ },
  { name: "lib/agenda-occupancy*", re: /(?:^|\/)lib\/agenda-occupancy[^/]*$/ },
  { name: "lib/roles", re: /(?:^|\/)lib\/roles$/ },
];

/** Especificadores de imports y re-exports de VALOR (los `import type` / `export type` se borran al compilar). */
function staticValueSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) out.push(m[1].replace(/\.(?:ts|tsx|js)$/, ""));
  return out;
}

describe("[AS-0z] /agenda: first load sin módulos pesados compartidos", () => {
  it("los archivos vigilados existen (el guard no pasa en vacío)", () => {
    expect(WATCHED).toContain("components/agenda/agenda-client.tsx");
    expect(WATCHED).toContain("components/agenda/agenda-toolbar.tsx");
    for (const f of WATCHED) expect(existsSync(resolve(ROOT, f)), f).toBe(true);
  });

  it("el detector distingue valor de tipo y el `import()` dinámico", () => {
    const src = [
      'import { a } from "@/lib/roles";',
      'import type { B } from "@/lib/day-lock-form";',
      'export { c } from "@/lib/slot-picker-state";',
      'import "@/lib/agenda-occupancy-core";',
      'const x = () => import("@/lib/dashboard-kpi-options");',
      'import { d } from "@/lib/roles-core";',
    ].join("\n");
    const specs = staticValueSpecifiers(src);
    const hits = FORBIDDEN.filter((f) => specs.some((s) => f.re.test(s))).map((f) => f.name);
    expect(hits).toEqual(["lib/slot-picker-state", "lib/agenda-occupancy*", "lib/roles"]);
  });

  for (const file of WATCHED) {
    it(`${file} no importa estáticamente ${FORBIDDEN.map((f) => f.name).join(", ")}`, () => {
      const specs = staticValueSpecifiers(read(file));
      for (const f of FORBIDDEN) {
        expect(specs.filter((s) => f.re.test(s)), `${file} → ${f.name}`).toEqual([]);
      }
    });
  }
});

describe("[AS-0z] 0z3: UI de la agenda que no se ve al cargar va diferida", () => {
  it("el panel del menú «Vista» baja por `import()` (el botón y el punto quedan en el first load)", () => {
    const specs = staticValueSpecifiers(read("components/agenda/view-options-menu.tsx"));
    expect(specs.some((s) => /view-options-panel$/.test(s))).toBe(false);
    expect(read("components/agenda/view-options-menu.tsx")).toMatch(/import\(\s*["']\.\/view-options-panel["']\s*\)/);
  });

  it("la leyenda de plan y los chips de profesional no son imports estáticos de la agenda", () => {
    const specs = staticValueSpecifiers(read("components/agenda/agenda-client.tsx"));
    expect(specs.some((s) => /\/plan-legend$/.test(s))).toBe(false);
    expect(specs.some((s) => /\/practitioner-chips$/.test(s))).toBe(false);
    expect(specs.some((s) => /\/view-options-panel$/.test(s))).toBe(false);
  });

  it("el copy del diagnóstico «En vivo» no entra con el indicador", () => {
    const specs = staticValueSpecifiers(read("components/realtime/live-indicator.tsx"));
    expect(specs.some((s) => /live-indicator-diag$/.test(s))).toBe(false);
    expect(specs.some((s) => /live-diagnostics$/.test(s))).toBe(false);
    expect(read("components/realtime/live-indicator.tsx")).not.toContain("El servidor rechazó la conexión");
  });
});
