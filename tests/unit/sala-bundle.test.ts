/**
 * [PF1.1-sala] Bundle de /sala (brief-pf §3.1, C-PF1 y C-PF2): se baja solo la cara elegida y nada usa `motion.*`.
 *
 * Es un test de fuente (como el de `diagnostico-door`): lo que importa es qué módulos entran por `import` estático al
 * chunk de la ruta, y eso no se ve en un render. El número real (kB gz) lo mide el integrador con `next build` +
 * `scripts/check-bundle-budget.mjs`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preloadSalaFace, preloadSalaFaces } from "@/components/sala/sala-faces";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Specifiers de los `import … from "x"` de valor (los `import type` no llegan al bundle). */
function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";?$/gms;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(name) ? [rel] : [];
  });
}

describe("[PF1.1-sala] /sala baja solo la cara elegida (C-PF2)", () => {
  it("SalaClient no importa estático ninguna cara: Tablero y escritorio entran por next/dynamic", () => {
    const src = read("components/sala/sala-client.tsx");
    const imports = staticImports(src);
    for (const face of ["sala-board-face", "sala-board", "sala-header", "sala-column", "sala-card", "desk/"]) {
      expect(imports.filter((s) => s.includes(face)), face).toEqual([]);
    }
    expect(imports).toContain("next/dynamic");
    // Con SSR (default): el primer pintado viaja en el HTML; `ssr: false` dejaría un hueco (C-PF2).
    expect(src).not.toMatch(/ssr:\s*false/);
  });

  it("el shell del escritorio no importa estático sus caras ni el modal de cobro", () => {
    const src = read("components/sala/desk/reception-desk.tsx");
    const imports = staticImports(src);
    for (const mod of ["desk-list", "desk-flow", "desk-pay-modal"]) {
      expect(imports.filter((s) => s.includes(mod)), mod).toEqual([]);
    }
    // El único `ssr: false` es el del modal de cobro (no está en el primer pintado).
    expect(src.match(/ssr:\s*false/g)?.length ?? 0).toBe(1);
    expect(src).toMatch(/const DeskPayModal = dynamic\([^\n]*\{ ssr: false \}\)/);
  });

  it("los cargadores apuntan a los módulos de cada cara (tsc fija que exporten lo que se usa)", () => {
    const src = read("components/sala/sala-faces.ts");
    for (const mod of ["./sala-board-face", "./desk/reception-desk", "./desk/desk-list", "./desk/desk-flow", "./desk/desk-pay-modal"]) {
      expect(src).toContain(`import("${mod}")`);
    }
    // El módulo de cargadores no arrastra ninguna cara por import estático.
    expect(staticImports(src).filter((s) => !s.startsWith("@/lib/"))).toEqual([]);
  });

  it("precargar en el server es un no-op (sin window no hay red que adelantar)", () => {
    expect(() => {
      preloadSalaFace("board");
      preloadSalaFace("list");
      preloadSalaFaces();
    }).not.toThrow();
  });

  it("«Vista» precarga las tres caras con hover y foco", () => {
    const src = read("components/sala/desk/desk-header.tsx");
    expect(src).toContain("onPointerEnter={preloadSalaFaces}");
    expect(src).toContain("onFocus={preloadSalaFaces}");
  });
});

describe("[PF1.1-sala] C-PF1: nada de motion.* en /sala", () => {
  const files = [...walk("components/sala"), ...walk("app/(app)/sala")];

  it.each(files)("%s usa `m` (LazyMotion) y no `motion`", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*"framer-motion"/);
    expect(src).not.toMatch(/<\/?motion\./);
  });
});
