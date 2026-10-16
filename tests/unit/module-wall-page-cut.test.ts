/**
 * VX-Z (B1): Next renderiza el `layout.tsx` y la `page.tsx` de un segmento EN PARALELO. El muro de módulo vive en el
 * layout (`moduleWall`), pero sin el corte la página igual corría sus queries mientras el usuario veía el muro (y
 * `assertModule` tiraba `ForbiddenError` al log en cada visita; así apareció en /sala). Este test recorre el árbol
 * real de `app/(app)`: todo segmento cuyo layout llama a `moduleWall("<m>")` tiene que cortar en CADA `page.tsx` debajo
 * (incluidas las dinámicas) con el mismo módulo, antes de cualquier otro `await`.
 *
 * Es un test de código fuente a propósito: el comportamiento de `moduleWall` ya lo cubre
 * `module-segment-guard.test.ts`; acá se cuida que nadie agregue una página (o un segmento con muro) sin el corte.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.join(process.cwd(), "app", "(app)");

function walk(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p, name));
    else if (ent.name === name) out.push(p);
  }
  return out;
}

const WALL_RE = /moduleWall\("([A-Za-z]+)"\)/;

const walled = walk(APP, "layout.tsx")
  .map((layout) => ({ dir: path.dirname(layout), m: WALL_RE.exec(fs.readFileSync(layout, "utf8"))?.[1] }))
  .filter((x): x is { dir: string; m: string } => !!x.m);

/** Página que no es async (p. ej. `/reportes`, que solo redirige con `redirect()`): no corre queries, no hace falta. */
function isSyncRedirectOnly(src: string): boolean {
  return !/export default async function/.test(src);
}

describe("muro de módulo: cada page.tsx de un segmento con muro corta al inicio (VX-Z B1)", () => {
  it("encuentra los segmentos con muro (si esto baja, el test dejó de mirar)", () => {
    const names = walled.map((w) => path.basename(w.dir)).sort();
    expect(names).toEqual(
      expect.arrayContaining(["biblioteca", "diagnostico", "planes", "seguimiento", "terapia-manual", "sala"]),
    );
  });

  const pages = walled.flatMap(({ dir, m }) =>
    walk(dir, "page.tsx").map((p) => [path.relative(APP, p), m, p] as const),
  );

  it.each(pages)("%s corta con moduleWall(%j)", (_rel, m, file) => {
    const src = fs.readFileSync(file, "utf8");
    if (isSyncRedirectOnly(src)) return;
    const cut = `if ((await moduleWall("${m}")) !== "ok") return null;`;
    expect(src).toContain(cut);
    const body = src.slice(src.indexOf("export default async function"));
    // Ningún `await` (query) antes del corte: el corte es lo primero que espera la página.
    expect(body.indexOf("await ")).toBe(body.indexOf(cut) + "if ((".length);
  });
});
