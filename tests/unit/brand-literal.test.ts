/**
 * [OPS-1d · BR-1] guard de marca, ESTRICTO desde el cierre del renombre (PV Q5 · BR-Z, 27-oct).
 *
 * Historia: OPS-1d (18-oct) nació como un RATCHET por archivo (242 apariciones de la marca vieja en 113 archivos, cada
 * techo solo podía bajar) para que el barrido del renombre terminara. BR-a..BR-d2 llevaron todo a 0, así que el ratchet
 * se reemplaza por la regla final. `[BR-1]` era el `it.fails` del brief («la marca vieja = 0 en el código que corre»):
 * queda cubierto por este guard en verde.
 *
 * Reglas:
 *  1. La marca vieja («KineSoft» / «Kinesoft», con esa grafía) = 0 en el código que corre o se sirve. Distingue
 *     mayúsculas A PROPÓSITO: los identificadores técnicos que NO se renombran están en minúscula o en mayúscula
 *     sostenida y no cuentan (cookies `kine_*`, claves `kinesoft:*`, roles `kinesoft_app`, prefijo `kinesoft-pref-`,
 *     canal `kinesoft-realtime`, dominios `kinesoft.app`, envs `KINESOFT_*`). Esos los fija `[BR-9]` en
 *     `tests/unit/br-brand.test.ts`: que sigan existiendo con la grafía vieja.
 *  2. El literal de la marca nueva solo vive en `lib/brand.ts` (`BRAND_NAME`): el resto lo importa. Así el próximo
 *     cambio de marca vuelve a ser cambiar una constante y no un barrido.
 *
 * Alcance: `app`, `components`, `lib`, `hooks`, `scripts`, `public` y los `.ts`/`.mjs` de la raíz que corren
 * (`middleware.ts`, `instrumentation.ts`, configs de Next/Sentry). Fuera, a propósito:
 *  - `tests/**`: fixtures y nombres de test que citan la marca como dato (los `EMAIL_FROM` de ejemplo, este archivo);
 *  - `prisma/**`: lo toca solo la sesión MIG y lo que queda son encabezados de comentario de `schema.prisma`,
 *    `roles.*.sql` y `seed.ts` (no se rinden en la app); `prisma/migrations/**` es historia inmutable (checksum);
 *  - `.docs/`, AGENTS.md, `.env.example`, `design_source/`: documentación e historia.
 *
 * Allowlist: vacía. Si un identificador preservado llegara a tener la grafía «KineSoft», se agrega acá con el porqué
 * (nunca copy visible: para eso está `BRAND_NAME`).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BRAND_NAME } from "@/lib/brand";

const ROOT = process.cwd();
const OLD = /KineSoft|Kinesoft/g;
const SCAN_ROOTS = ["app", "components", "lib", "hooks", "scripts", "public"];
const ROOT_FILES = ["middleware.ts", "instrumentation.ts", "next.config.mjs", "sentry.edge.config.ts", "sentry.server.config.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".json", ".webmanifest", ".html", ".svg", ".txt", ".md"];
const SOURCE_OF_TRUTH = "lib/brand.ts";

/** Archivo → por qué puede tener la grafía vieja. Solo identificadores preservados; hoy no hay ninguno. */
const ALLOW_OLD: Record<string, string> = {};

function files(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs);
        continue;
      }
      if (EXTS.some((e) => name.endsWith(e))) out.push(relative(ROOT, abs).split(sep).join("/"));
    }
  };
  for (const r of SCAN_ROOTS) walk(join(ROOT, r));
  for (const f of ROOT_FILES) {
    try {
      if (statSync(join(ROOT, f)).isFile()) out.push(f);
    } catch {
      /* el archivo de raíz no existe en este checkout: nada que escanear */
    }
  }
  return out;
}

function hits(re: RegExp | string): string[] {
  const found: string[] = [];
  for (const rel of files()) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      const hit = typeof re === "string" ? line.includes(re) : new RegExp(re.source).test(line);
      if (hit) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return found;
}

describe("[OPS-1d · BR-1] guard de marca estricto", () => {
  it("[OPS-1d] lib/brand.ts sigue siendo la fuente (BRAND_NAME)", () => {
    expect(readFileSync(join(ROOT, SOURCE_OF_TRUTH), "utf8")).toMatch(/export const BRAND_NAME = "/);
  });

  it("[BR-1] la marca vieja («KineSoft»/«Kinesoft») = 0 en el código que corre", () => {
    const bad = hits(OLD).filter((h) => !(h.split(":")[0] in ALLOW_OLD));
    expect(bad, "Texto visible y comentarios: importá BRAND_NAME de @/lib/brand o reescribilo sin la marca").toEqual([]);
  });

  it("[BR-1] la allowlist no tiene entradas muertas", () => {
    const dead = Object.keys(ALLOW_OLD).filter((f) => !hits(OLD).some((h) => h.startsWith(`${f}:`)));
    expect(dead).toEqual([]);
  });

  it("[BR-1] el literal de la marca nueva solo vive en lib/brand.ts", () => {
    const bad = hits(BRAND_NAME).filter((h) => !h.startsWith(`${SOURCE_OF_TRUTH}:`));
    expect(bad, "Usá BRAND_NAME (o BRAND_SHORT_NAME / BRAND_TAGLINE) de @/lib/brand").toEqual([]);
  });

  it("el escaneo ve el código (anti-false-green: si cambia el layout del repo, el guard no pasa vacío)", () => {
    const all = files();
    expect(all).toContain(SOURCE_OF_TRUTH);
    expect(all).toContain("components/ui/kine-logo.tsx");
    expect(all).toContain("middleware.ts");
    expect(all.length).toBeGreaterThan(500);
    expect(hits(BRAND_NAME).some((h) => h.startsWith(`${SOURCE_OF_TRUTH}:`))).toBe(true);
  });
});
