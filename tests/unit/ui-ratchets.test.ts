import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import baseline from "./ui-ratchets.baseline.json";

/**
 * [VX F-b2] Ratchets de UI (C-F5): los números solo bajan. Cada conteo se compara con
 * `ui-ratchets.baseline.json`, medido el 15-oct sobre HEAD 9827545 (brief VX §0.5).
 *
 * - Subió → falla: alguien sumó un caso nuevo. Se usa la primitiva (ButtonLink, Field, tokens de estado).
 * - Bajó → pasa e imprime el conteo nuevo para regrabar el baseline (lo regraba el integrador de la ola, no cada sesión,
 *   para que dos sesiones en paralelo no se pisen el JSON).
 *
 * Alcance: `app/**` y `components/**` (.ts/.tsx/.css/.mjs). Se excluye `app/globals.css` (ahí viven las definiciones:
 * los tokens con su hex y el `outline: none` intencional del foco global de C-F1) y, para literales, lo que el codemod
 * F2 excluye: `opengraph-image.*` e `icon.*` (next/og no lee variables CSS).
 *
 * `UI_RATCHET_ROOT` existe solo para medir un árbol exportado con `git archive` (así se tomó el baseline).
 */

const ROOT = process.env.UI_RATCHET_ROOT ?? process.cwd();
const DIRS = ["app", "components"];
const EXT = /\.(tsx?|css|mjs)$/;

type FileText = { rel: string; text: string };

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
}

function loadFiles(): FileText[] {
  const paths: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), paths);
  return paths
    .map((p) => ({ rel: relative(ROOT, p).split(sep).join("/"), text: readFileSync(p, "utf8") }))
    .filter((f) => f.rel !== "app/globals.css");
}

const LINK_OPEN = /<Link(\s|>|$)/;
const BUTTON_OPEN = /<Button(\s|>|$)/;

/** `<Link>` con un `<Button>` en la misma línea o en las 2 siguientes (interactivo anidado; reemplazo: `ButtonLink`). */
export function countLinkWrappingButton(files: FileText[]): number {
  let n = 0;
  for (const f of files) {
    if (!f.rel.endsWith(".tsx")) continue;
    const lines = f.text.split("\n");
    lines.forEach((line, i) => {
      if (LINK_OPEN.test(line) && lines.slice(i, i + 3).some((l) => BUTTON_OPEN.test(l))) n++;
    });
  }
  return n;
}

/** `outline: none` / `outline: "none"`: foco invisible si el componente no pinta otro (PF1 los baja). */
export function countOutlineNone(files: FileText[]): number {
  const re = /outline:\s*(none|["']none["'])/g;
  return files.reduce((n, f) => n + (f.text.match(re)?.length ?? 0), 0);
}

/** Líneas con el ejemplo ficticio «Movare»/«Camila» (placeholders y testimonios inventados; D-VX: copy neutro). */
export function countDemoPlaceholders(files: FileText[]): number {
  return files.reduce((n, f) => n + f.text.split("\n").filter((l) => /movare|camila/i.test(l)).length, 0);
}

/**
 * Literales de estado del mapa del codemod F2, más los dos no exactos (`#4F8A10`, `#9A5B00`) que van a PF1.
 * Normaliza como F2: mayúsculas, espacios dentro de `rgba(…)` y `,.1` = `,0.1`.
 */
export const STATUS_LITERALS = [
  "#9F1F1F",
  "rgba(228,70,70,0.1)",
  "rgba(228,70,70,0.18)",
  "#C62828",
  "#E44646",
  "#7A4A00",
  "rgba(255,176,32,0.14)",
  "rgba(255,176,32,0.24)",
  "#1B704B",
  "rgba(54,179,126,0.12)",
  "#4F8A10",
  "#9A5B00",
] as const;

export function normalizeColors(text: string): string {
  return text
    .toLowerCase()
    .replace(/rgba\(([^)]*)\)/g, (_m, inner: string) => `rgba(${inner.replace(/\s+/g, "").replace(/,\./g, ",0.")})`);
}

export function countStatusLiterals(files: FileText[]): Record<string, number> {
  const scoped = files.filter((f) => !/(^|\/)(opengraph-image|icon)\.[^/]+$/.test(f.rel));
  const texts = scoped.map((f) => normalizeColors(f.text));
  const out: Record<string, number> = {};
  for (const lit of STATUS_LITERALS) {
    const needle = normalizeColors(lit);
    out[lit] = texts.reduce((n, t) => n + t.split(needle).length - 1, 0);
  }
  return out;
}

function ratchet(name: string, now: number, base: number) {
  if (now < base) {
    // Bajó: se avisa para regrabar el baseline (el integrador de la ola lo hace).
    console.log(`[ui-ratchets] ${name}: ${base} → ${now} (bajó; regrabar ui-ratchets.baseline.json)`);
  }
  expect(now, `${name} subió de ${base} a ${now}: usá la primitiva en vez de sumar un caso`).toBeLessThanOrEqual(base);
}

describe("[VX F-b2] ratchets de UI (solo bajan)", () => {
  const files = loadFiles();

  it("el alcance no está vacío (si no, todos los conteos darían 0 en falso verde)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("<Link> que envuelve <Button>", () => {
    ratchet("linkWrappingButton", countLinkWrappingButton(files), baseline.linkWrappingButton);
  });

  it("outline: none", () => {
    ratchet("outlineNone", countOutlineNone(files), baseline.outlineNone);
  });

  it("placeholders Movare/Camila", () => {
    ratchet("demoPlaceholders", countDemoPlaceholders(files), baseline.demoPlaceholders);
  });

  it("literales de estado (por literal)", () => {
    const now = countStatusLiterals(files);
    const base = baseline.statusLiterals as Record<string, number>;
    for (const lit of STATUS_LITERALS) {
      expect(base[lit], `falta ${lit} en el baseline`).toBeTypeOf("number");
      ratchet(`statusLiterals ${lit}`, now[lit], base[lit]);
    }
  });

  it("los contadores detectan lo que dicen (sin falso verde)", () => {
    const fake: FileText[] = [
      { rel: "components/x.tsx", text: '<Link href="/a">\n  <Button>Ir</Button>\n</Link>\n<ButtonLink href="/b">Ir</ButtonLink>' },
      { rel: "components/y.tsx", text: 'style={{ outline: "none" }}\n.a { outline:none }\nplaceholder="camila@movare.com.ar"' },
      { rel: "components/z.tsx", text: "color: '#9f1f1f'; background: rgba(228, 70, 70, .1); x: rgba(228,70,70,0.18)" },
      { rel: "app/icon.tsx", text: "#9F1F1F" },
    ];
    expect(countLinkWrappingButton(fake)).toBe(1);
    expect(countOutlineNone(fake)).toBe(2);
    expect(countDemoPlaceholders(fake)).toBe(1);
    const lits = countStatusLiterals(fake);
    expect(lits["#9F1F1F"]).toBe(1);
    expect(lits["rgba(228,70,70,0.1)"]).toBe(1);
    expect(lits["rgba(228,70,70,0.18)"]).toBe(1);
  });
});
