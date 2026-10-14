import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconPlans } from "@/components/ui/icons";
import { EyebrowLabel } from "@/components/ui/eyebrow";

/**
 * [P0-S04a] Tokens del design system (`app/globals.css`).
 *
 * Por qué existe: la auditoría encontró `var(--lime-700)` y `var(--navy-400)`
 * usados en ~20 lugares sin estar definidos (`tokens-inexistentes`): sin
 * fallback, el color caía al heredado y el texto quedaba en navy-900 o sin el
 * acento que el diseño pedía. Y Planes necesita tokens de disciplina y de
 * estado que no dependan de la paleta del tenant (`[data-palette]` reasigna
 * todo `--sky-*`: en "mint" el sky-700 es verde y chocaría con "Hecho").
 *
 * Se lee el CSS como texto (no hay DOM en la capa unit): el contrato es el
 * archivo real que sirve Next, no una copia.
 */

const ROOT = resolve(process.cwd());
const CSS = readFileSync(join(ROOT, "app/globals.css"), "utf8");

/** Bloque `:root { … }` principal (el primero), sin las paletas. */
function rootBlock(): string {
  const start = CSS.indexOf(":root {");
  const end = CSS.indexOf("\n}", start);
  return CSS.slice(start, end);
}

function tokenValue(name: string, block = rootBlock()): string | null {
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

// ── contraste WCAG 2.x ────────────────────────────────────────────────
type RGB = [number, number, number];
function parseColor(v: string): { rgb: RGB; a: number } {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB, a: 1 };
  }
  const rgba = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const p = rgba[1].split(",").map((s) => Number(s.trim()));
    return { rgb: [p[0], p[1], p[2]], a: p[3] ?? 1 };
  }
  throw new Error(`color no literal: ${v}`);
}
function over(c: { rgb: RGB; a: number }, base: RGB): RGB {
  return c.rgb.map((v, i) => v * c.a + base[i] * (1 - c.a)) as RGB;
}
function lum([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: RGB, b: RGB): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const WHITE: RGB = [255, 255, 255];
const PANEL = parseColor(tokenValue("--bg-panel")!).rgb;
const AA = 4.5;

describe("[P0-S04a] tokens inexistentes", () => {
  it("--lime-700 y --navy-400 están definidos en :root", () => {
    expect(tokenValue("--lime-700")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokenValue("--navy-400")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokenValue("--font-mono")).not.toBeNull();
  });

  it("todo var(--x) usado en app/components/lib está definido en globals.css", () => {
    const defined = new Set(Array.from(CSS.matchAll(/(--[a-z0-9-]+)\s*:/gi), (m) => m[1]));
    const allow = new Set<string>();
    const used = new Map<string, string>();
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(f)) {
          for (const m of readFileSync(p, "utf8").matchAll(/var\((--[a-z0-9-]+)/gi)) {
            if (!used.has(m[1])) used.set(m[1], p.slice(ROOT.length + 1));
          }
        }
      }
    };
    ["app", "components", "lib"].forEach((d) => walk(join(ROOT, d)));
    const missing = [...used].filter(([t]) => !defined.has(t) && !allow.has(t));
    expect(missing).toEqual([]);
  });
});

describe("[P0-S04a] disciplina: hex literal y AA", () => {
  for (const t of ["--disc-kine", "--disc-osteo"]) {
    it(`${t} es hex literal (no depende de la paleta) con contraste AA`, () => {
      const v = tokenValue(t);
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
      const c = parseColor(v!).rgb;
      expect(contrast(c, WHITE)).toBeGreaterThanOrEqual(AA);
      expect(contrast(c, PANEL)).toBeGreaterThanOrEqual(AA);
    });
  }

  it("ninguna paleta [data-palette] redefine los tokens de disciplina ni de estado", () => {
    const palettes = Array.from(CSS.matchAll(/\[data-palette="[^"]+"\]\s*\{([^}]*)\}/g), (m) => m[1]);
    expect(palettes.length).toBeGreaterThan(0);
    for (const body of palettes) {
      expect(body).not.toMatch(/--disc-|--st-|--lime-700|--navy-400/);
    }
  });

  it("--lime-700 y --navy-400 dan AA sobre blanco y sobre --bg-panel", () => {
    for (const t of ["--lime-700", "--navy-400"]) {
      const c = parseColor(tokenValue(t)!).rgb;
      expect(contrast(c, WHITE), t).toBeGreaterThanOrEqual(AA);
      expect(contrast(c, PANEL), t).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("[P0-S04a] estado de turno --st-*", () => {
  // Una sola paleta para los 5 estados + la reserva online impaga (vigente y
  // vencida). La consume S04b (StatusTag único).
  const KEYS = ["pending", "confirmed", "completed", "noshow", "cancelled", "hold", "hold-expired"];

  for (const k of KEYS) {
    it(`--st-${k}-bg / --st-${k}-fg: literales y texto AA sobre su fondo`, () => {
      const bg = tokenValue(`--st-${k}-bg`);
      const fg = tokenValue(`--st-${k}-fg`);
      expect(bg, `--st-${k}-bg`).not.toBeNull();
      expect(fg, `--st-${k}-fg`).not.toBeNull();
      // El fondo es translúcido: se compone sobre blanco y sobre el panel.
      for (const base of [WHITE, PANEL]) {
        const b = over(parseColor(bg!), base);
        expect(contrast(parseColor(fg!).rgb, b)).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  it("Ausente es ámbar (rojo/verde no; QA de ES1)", () => {
    const fg = parseColor(tokenValue("--st-noshow-fg")!).rgb;
    const [r, g, b] = fg;
    // ámbar: rojo > verde > azul, con azul casi nulo.
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(b).toBeLessThan(40);
  });
});

describe("[P0-S04a] primitivas", () => {
  it("IconPlans renderiza un svg que hereda el color (currentColor)", () => {
    const html = renderToStaticMarkup(createElement(IconPlans, { size: 16 }));
    expect(html).toMatch(/^<svg[^>]*width="16"/);
    expect(html).toContain('stroke="currentColor"');
  });

  it("EyebrowLabel tone=lime usa --lime-700, que ahora existe", () => {
    const html = renderToStaticMarkup(createElement(EyebrowLabel, { tone: "lime", children: "Osteo" }));
    expect(html).toContain("var(--lime-700)");
    expect(tokenValue("--lime-700")).not.toBeNull();
  });
});

describe("[SV03u] estado de Recepción/Sala --rc-* (C-SV10)", () => {
  // Reemplazan los literales de reception-row.tsx (STATE_STYLE: demorado, en
  // sala, en atención) y suman «Llamado» (SV-D5). Literales como --st-*: el
  // fondo = estado no puede cambiar con la paleta del tenant.
  const KEYS = ["insala", "called", "attending", "late"];

  for (const k of KEYS) {
    it(`--rc-${k}-bg / --rc-${k}-fg: literales y texto AA sobre su fondo`, () => {
      const bg = tokenValue(`--rc-${k}-bg`);
      const fg = tokenValue(`--rc-${k}-fg`);
      expect(bg, `--rc-${k}-bg`).not.toBeNull();
      expect(fg, `--rc-${k}-fg`).not.toBeNull();
      for (const base of [WHITE, PANEL]) {
        const b = over(parseColor(bg!), base);
        expect(contrast(parseColor(fg!).rgb, b), `--rc-${k}`).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  it("--rc-late-border es literal (el demorado conserva su borde)", () => {
    expect(() => parseColor(tokenValue("--rc-late-border")!)).not.toThrow();
  });

  it("«Llamado» se distingue de En sala, En atención y Por llegar (fondo y texto)", () => {
    const called = over(parseColor(tokenValue("--rc-called-bg")!), WHITE);
    const others = ["--rc-insala-bg", "--rc-attending-bg", "--st-confirmed-bg"].map((t) =>
      over(parseColor(tokenValue(t)!), WHITE),
    );
    // Distancia euclídea RGB > 60: a simple vista son tonos distintos, no
    // dos intensidades del mismo color.
    for (const o of others) {
      const d = Math.hypot(called[0] - o[0], called[1] - o[1], called[2] - o[2]);
      expect(d).toBeGreaterThan(60);
    }
  });

  it("ninguna paleta [data-palette] redefine --rc-*", () => {
    const palettes = Array.from(CSS.matchAll(/\[data-palette="[^"]+"\]\s*\{([^}]*)\}/g), (m) => m[1]);
    for (const body of palettes) expect(body).not.toMatch(/--rc-/);
  });
});

describe("[SV03u] clases de motion en CSS (C-SV10)", () => {
  it("define .k-live-badge, .k-live-dot, .k-flash, .k-toast-progress y sus @keyframes", () => {
    for (const sel of [".k-live-badge", ".k-live-dot", ".k-flash", ".k-toast-progress", ".k-arrival-ring"]) {
      expect(CSS, sel).toContain(`${sel} {`);
    }
    for (const kf of ["k-live-dot", "k-flash", "k-toast-progress"]) {
      expect(CSS, kf).toMatch(new RegExp(`@keyframes ${kf}\\s*\\{`));
    }
  });

  it("la barra del toast se pausa en hover y focus-within", () => {
    expect(CSS).toMatch(/:hover \.k-toast-progress[\s\S]*?animation-play-state:\s*paused/);
    expect(CSS).toMatch(/:focus-within \.k-toast-progress/);
  });

  it("prefers-reduced-motion deja estático todo lo que anima", () => {
    const m = CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    for (const sel of [".k-live-dot", ".k-flash", ".k-toast-progress", ".k-arrival-ring"]) {
      expect(m![1], sel).toContain(sel);
    }
    expect(m![1]).toMatch(/animation:\s*none/);
  });
});
