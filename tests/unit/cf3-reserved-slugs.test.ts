/**
 * [CF3-SDR] Slugs reservados = rutas de primer nivel REALES de la app (§30, D-CF3-10; Anexo R «Sede digital»).
 *
 * Por qué: la sede digital vive en `/<slug>` (`app/(sede)/[slug]/`). Next resuelve primero los segmentos estáticos, así
 * que un consultorio con slug `caja` tendría su sede tapada por `/caja` (la caja del día) sin que nadie lo note. Hasta
 * CF3 la lista `RESERVED_SLUGS` se mantenía a mano y le faltaban 21 (caja, cobros, pagar, consultorios, contacto, los
 * archivos de metadata…). Este test la deriva del árbol `app/` (carpetas, entrando a los route groups `(x)`, más los
 * archivos de metadata y los de `public/`) y exige que cada segmento sea un slug inválido: reservado, o que no pase
 * `SLUG_RE` (p. ej. `tv`, `sw`: menos de 3 letras).
 *
 * Excepciones (no son segmentos que puedan chocar):
 *   - `[slug]` y cualquier `[x]` / `[...x]`: dinámicos, son justamente la sede.
 *   - `_*`: carpetas privadas de Next (no generan ruta).
 *   - `@x` (slots paralelos) y `(x)` (route groups): no son segmento de URL; a los grupos se entra.
 *   - Archivos especiales de Next (layout, page, error, not-found, template, loading, default, route, global-error) y
 *     `globals.css`: no generan una ruta propia.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_SLUGS, SLUG_RE, isValidSlug, slugify } from "@/lib/onboarding-logic";

const ROOT = process.cwd();
const APP = join(ROOT, "app");
const PUBLIC = join(ROOT, "public");

/** Archivos de `app/` que NO generan una URL propia (convenciones de Next). */
const NEXT_SPECIAL_FILES = new Set([
  "layout",
  "page",
  "error",
  "global-error",
  "not-found",
  "template",
  "loading",
  "default",
  "route",
  "globals",
  "middleware",
  "instrumentation",
]);

const isDir = (p: string) => statSync(p).isDirectory();
const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

/** Segmentos de primer nivel bajo `dir`, entrando a los route groups `(x)`. `dynamic` junta los `[x]` (excluidos a propósito). */
function topLevelSegments(dir: string): { segments: Set<string>; dynamic: string[] } {
  const segments = new Set<string>();
  const dynamic: string[] = [];
  if (!existsSync(dir)) return { segments, dynamic };
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (isDir(p)) {
      if (/^\(.+\)$/.test(name)) {
        const inner = topLevelSegments(p);
        inner.segments.forEach((s) => segments.add(s));
        dynamic.push(...inner.dynamic);
      } else if (name.startsWith("[")) dynamic.push(name);
      else if (name.startsWith("_") || name.startsWith("@")) continue;
      else segments.add(name);
    } else {
      // Metadata routes (`robots.ts` → /robots.txt, `icon.svg` → /icon.svg, `favicon.ico`…): la URL lleva el nombre.
      const base = stripExt(name);
      if (!NEXT_SPECIAL_FILES.has(base)) segments.add(base);
    }
  }
  return { segments, dynamic };
}

/** `public/offline.html` → `offline`; `public/icons/` → `icons`. */
function publicSegments(): Set<string> {
  if (!existsSync(PUBLIC)) return new Set();
  return new Set(readdirSync(PUBLIC).filter((n) => !n.startsWith(".")).map((n) => (isDir(join(PUBLIC, n)) ? n : stripExt(n))));
}

describe("[CF3-SDR] RESERVED_SLUGS cubre las rutas de primer nivel de app/ y public/", () => {
  const { segments } = topLevelSegments(APP);
  const all = [...new Set([...segments, ...publicSegments()])].sort();

  it("sanidad: la derivación encuentra rutas reales, entra a los grupos y ve la metadata (no pasa en vacío)", () => {
    // Directas, dentro de un grupo y metadata: si alguna desaparece, la derivación dejó de mirar ese caso.
    for (const s of ["onboarding", "agenda", "caja", "login", "pagar", "terminos", "tv", "robots", "sitemap", "favicon", "icon"])
      expect(all, s).toContain(s);
    expect(all).toContain("offline"); // public/offline.html
    expect(all.length).toBeGreaterThan(40);
    // Ni grupos, ni archivos especiales, ni dinámicos se cuelan como segmento.
    for (const s of ["(app)", "layout", "page", "not-found", "globals", "[slug]"]) expect(all).not.toContain(s);
  });

  it("sanidad: no baja a segundo nivel (`app/icons/[name]` no es segmento) y sí ve `c` dentro de `(booking)`", () => {
    expect(all).toContain("c");
    expect(all).not.toContain("[name]");
  });

  it("todo segmento de primer nivel es un slug inválido (reservado o fuera de SLUG_RE)", () => {
    const free = all.filter((s) => isValidSlug(s));
    expect(free, `segmentos que un consultorio podría tomar como slug: ${free.join(", ")}`).toEqual([]);
  });

  it("los 21 de CF3 (Anexo R) están reservados y slugify no cae en ellos", () => {
    const CF3 = [
      "caja", "cobros", "planes", "sala", "pagar", "profesionales", "consultorios", "privacidad", "terminos", "contacto",
      "mantenimiento", "plataforma-mfa", "icons", "apple-icon", "opengraph-image", "icon", "favicon", "manifest",
      "robots", "sitemap", "offline",
    ];
    for (const s of CF3) {
      expect(RESERVED_SLUGS.has(s), s).toBe(true);
      expect(isValidSlug(slugify(s)), `slugify(${s})`).toBe(true);
    }
  });

  it("slugs de sede que se parecen a una ruta siguen siendo válidos (la reserva es exacta, no por prefijo)", () => {
    for (const s of ["tvsalud", "salamanca-kine", "cajal-kine", "planeta-salud", "contactokine", "iconica"]) {
      expect(SLUG_RE.test(s), s).toBe(true);
      expect(isValidSlug(s), s).toBe(true);
    }
  });
});
