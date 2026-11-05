/**
 * Martin (05-nov): «seguimos mostrando el ícono viejo de la página y del software: hay que erradicarlo». La marca es el
 * «Sello C» (`components/ui/kine-logo.tsx`, `app/icon.svg`, `app/apple-icon.tsx`, `app/opengraph-image.tsx`); la
 * figura de kinesiología del logo anterior se había vuelto a colar como ícono «Hecho con» en el pie de la sede (venía
 * del prototipo `design_source/sede/`). Este guard falla si el trazo de esa figura vuelve a aparecer en el código que
 * corre o en `public/`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "components", "lib", "public"];
const EXT = /\.(tsx?|jsx?|svg|html|css)$/;
/** Trazos de la figura vieja (cabeza en (7,6) + cuerpo «M6 9.5C6 12…»), en las variantes que existieron. */
const OLD_FIGURE = [/M6 9\.5C6 12 7\.5 13 8 14\.5/, /sede-i-co\b/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

describe("marca: sin el ícono viejo", () => {
  it("ningún archivo de app/, components/, lib/ ni public/ dibuja la figura del logo anterior", () => {
    const files = ROOTS.flatMap((r) => walk(r));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return OLD_FIGURE.some((re) => re.test(src));
    });
    expect(hits).toEqual([]);
  });

  it("el pie de la sede usa el Sello C", () => {
    expect(readFileSync("components/sede/sede-page.tsx", "utf8")).toMatch(/<KineLogo size=\{18\} markOnly \/>/);
  });
});
