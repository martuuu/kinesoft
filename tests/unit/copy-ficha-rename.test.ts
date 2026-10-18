/**
 * [FC-3h] copy-ficha-rename · ratchet del rename de copy «evolución» → «ficha» (T4 §24.7, tabla literal del Anexo B).
 *
 * Por qué: desde FC el documento de la HC se llama «ficha» y la pestaña «Historia clínica». Quedaban ~60 strings con
 * «evolución(es)» en ~24 archivos (EV2). Sin un ratchet, cada sesión nueva vuelve a escribir «Cargar evolución» o
 * «las evoluciones» a mano y el paciente/profesional ve las dos palabras para lo mismo.
 *
 * Qué cuenta: cada aparición de «evolución»/«evoluciones» (cualquier mayúscula, con o sin tilde) en el CÓDIGO de
 * `app`, `components`, `lib` y `hooks` (comentarios afuera: ahí la palabra explica la historia de EV2 y no se rinde).
 * La allow-list es EXACTA (archivo → lista de líneas recortadas): no puede aparecer una nueva ni sobrar una vieja; si
 * se barre una, se borra su entrada (así no vuelve).
 *
 * Qué NO cuenta, a propósito:
 *  - identificadores: la clave de módulo/pestaña `evoluciones` (`?tab=evoluciones`, `has("evoluciones")`,
 *    `evoluciones: …`), el ancla `#sin-evolucion` y los camelCase (`EvolucionesView`, `sinEvolucion`,
 *    `evolucionesOn`, `cargarEvolucionHc`): renombrarlos rompe deep links, permisos y la base (Anexo B, «No se tocan»);
 *  - `tests/**`, `.docs/`, `prisma/` (historia y datos).
 *
 * Lo que queda en la allow-list y por qué (Anexo B, «No se tocan»):
 *  - `CLINICAL_NOTE_KIND_LABEL.EVOLUTION` = «Evolución»: es el TIPO de ficha (Primera consulta / Evolución / …);
 *  - la EVA (`evol`, `evolucion-view.tsx`, «Dolor (EVA) · evolución», «evolución de tu dolor» del portal): es la
 *    curva de dolor, otra cosa;
 *  - el refinamiento de diagnóstico (`refinement-panel.tsx`), `session-detail.tsx` y `dashboard-screen.tsx`, que
 *    hablan de la evolución clínica del paciente, no del documento.
 *
 * Baseline (FC-3h2, 19-oct, después de FC-3h1 `5d07636`): 7 apariciones en 5 archivos, todas de la lista de arriba.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const EXTS = [".ts", ".tsx"];

const WORD = /evoluci[oó]n(?:es)?/gi;

/**
 * Allow-list EXACTA: archivo → líneas (recortadas) con una aparición de copy que se conserva a propósito (Anexo B,
 * «No se tocan»). Una línea con dos apariciones va dos veces. Solo se BORRAN entradas.
 */
const ALLOW: Record<string, string[]> = {
  // El TIPO de ficha (Primera consulta / Evolución / Alta): CLINICAL_NOTE_KIND_LABEL.EVOLUTION.
  "lib/clinical-notes-types.ts": ['EVOLUTION: "Evolución",'],
  // EVA: la curva de dolor del plan, no el documento de la HC.
  "components/seguimiento/session-detail.tsx": [
    "Cuando cierres sesiones con EVA pre/post, vas a ver acá la evolución del dolor.",
    "Dolor (EVA) · evolución",
  ],
  // La evolución clínica del paciente (alta o continuidad), no el documento.
  "components/screens/dashboard-screen.tsx": [
    "<p className={styles.heroText}>Revisá su evolución y dejá programada el alta o la continuidad.</p>",
  ],
  // Refinamiento de diagnóstico: grupo de preguntas sobre cómo evolucionó el cuadro.
  "components/diagnostico/refinement-panel.tsx": ['<Group label="Evolución">'],
  "components/screens/diagnostico-wizard.tsx": [
    '<div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 700 }}>EVOLUCIÓN</div>',
  ],
};

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
}

/**
 * Reemplaza los comentarios (`//` y `/* *\/`, también los de JSX `{/* *\/}`) por espacios, conservando los saltos de
 * línea para que los números de línea sigan valiendo. Respeta strings y template literals (un `//` dentro de
 * "https://…" no es comentario). Es un tokenizer chico, no un parser: alcanza para el copy del repo.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        // Un salto de línea corta un string simple sin cerrar (p. ej. un apóstrofo suelto en texto JSX).
        if (src[i] === "\n" && c !== "`") break;
        out += src[i];
        i++;
      }
      if (i < n && src[i] === c) {
        out += c;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** ¿La aparición es un identificador (clave de módulo/pestaña, ancla o camelCase) y no copy? */
function isIdentifier(line: string, start: number, end: number, match: string): boolean {
  const prev = line[start - 1] ?? "";
  const next = line[end] ?? "";
  if (/[A-Za-z0-9_$]/.test(prev) || /[A-Za-z0-9_$]/.test(next)) return true; // sinEvolucion, EvolucionesView, evolucionesOn
  if (match !== match.toLowerCase() || /ó/.test(match)) return false; // con mayúscula o tilde = copy
  if (/[=#\-/.]/.test(prev) || /[:?\-&]/.test(next)) return true; // ?tab=evoluciones, sin-evolucion, evoluciones:, evoluciones?: number
  if (/["'`]/.test(prev) && /["'`]/.test(next)) return true; // "evoluciones" (la clave sola entre comillas)
  return false;
}

function scan(): Map<string, string[]> {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(ROOT, r), files);
  const hits = new Map<string, string[]>();
  for (const full of files) {
    const rel = relative(ROOT, full).split(sep).join("/");
    const code = stripComments(readFileSync(full, "utf8"));
    if (!WORD.test(code)) continue;
    WORD.lastIndex = 0;
    const lines = code.split("\n");
    for (const line of lines) {
      for (const m of line.matchAll(WORD)) {
        const start = m.index ?? 0;
        if (isIdentifier(line, start, start + m[0].length, m[0])) continue;
        const list = hits.get(rel) ?? [];
        list.push(line.trim());
        hits.set(rel, list);
      }
    }
  }
  return hits;
}

describe("[FC-3h] copy-ficha-rename", () => {
  const hits = scan();

  it("ningún archivo fuera de la allow-list dice «evolución» en el copy (se dice «ficha» / «historia clínica»)", () => {
    const offenders: string[] = [];
    for (const [file, lines] of hits) {
      if (file in ALLOW) continue;
      for (const l of lines) offenders.push(`${file}: ${l}`);
    }
    expect(offenders).toEqual([]);
  });

  it("la allow-list es exacta: cada entrada sigue y no aparece ninguna nueva en esos archivos", () => {
    for (const [file, allowed] of Object.entries(ALLOW)) {
      expect({ file, lines: [...(hits.get(file) ?? [])].sort() }).toEqual({ file, lines: [...allowed].sort() });
    }
  });

  it("el tokenizer saca comentarios y deja strings (incluido un `//` de URL)", () => {
    const src = 'const a = "https://x/evolución"; // evolución\n/* evoluciones */ const b = 1;';
    const out = stripComments(src);
    expect(out).toContain('"https://x/evolución"');
    expect(out.split("\n")).toHaveLength(2);
    expect(out.match(WORD)).toHaveLength(1);
  });

  it("los identificadores no cuentan; el copy sí", () => {
    const id = (l: string) => {
      const m = [...l.matchAll(WORD)][0];
      return isIdentifier(l, m.index ?? 0, (m.index ?? 0) + m[0].length, m[0]);
    };
    for (const l of ['has("evoluciones")', "?tab=evoluciones", 'id="sin-evolucion"', "  evoluciones: null,", "evoluciones?: number", "sinEvolucion", "EvolucionesView"]) {
      expect(id(l)).toBe(true);
    }
    for (const l of ['"Cargar evolución"', "las evoluciones habilitadas", '"Evoluciones"', "Evolución"]) {
      expect(id(l)).toBe(false);
    }
  });
});
