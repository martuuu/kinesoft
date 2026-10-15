import { readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { DUR, EASE_IN_OUT, EASE_OUT } from "@/lib/motion";

/**
 * [VX F-a · C-F1] Contrato de los tokens nuevos de `app/globals.css`.
 *
 * Por qué existe: la Ola F lleva los tokens del prototipo (design_source/vx0/shared.css) a toda la app, y F2 los
 * aplica con un codemod de igualdades exactas contra estos valores. Si un token cambia de valor, una paleta lo
 * pisa (en "mint" el sky es verde: un estado de error no puede cambiar de color por la paleta del tenant) o la
 * duración del CSS se separa de la de framer (`lib/motion.ts`), el codemod y las entradas por CSS dejan de
 * coincidir con lo que se aprobó. Se lee el CSS real que sirve Next (no hay DOM en la capa unit), como en
 * design-tokens.test.ts.
 */

const ROOT = resolve(process.cwd());
const CSS = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const LAYOUT = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
const FONTS = readFileSync(join(ROOT, "lib/fonts.ts"), "utf8");

/** Bloque `:root { … }` principal (el primero), sin las paletas. */
function rootBlock(): string {
  const start = CSS.indexOf(":root {");
  const end = CSS.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, end);
}
const squash = (v: string) => v.replace(/\s+/g, " ").trim();
function tokenValue(name: string, block = rootBlock()): string | null {
  const m = block.match(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`));
  return m ? squash(m[1]) : null;
}

// Copia literal de C-F1 (brief VX §2). Si cambia uno, cambia acá y en el brief, a propósito.
const C_F1: Record<string, string> = {
  "--danger-fg": "#9f1f1f",
  "--danger-solid": "#c62828",
  "--danger-bg": "rgba(228, 70, 70, 0.1)",
  "--danger-bg-strong": "rgba(228, 70, 70, 0.18)",
  "--danger-border": "rgba(176, 32, 32, 0.32)",
  "--danger-dot": "#e44646",
  "--warn-fg": "#7a4a00",
  "--warn-bg": "rgba(255, 176, 32, 0.14)",
  "--warn-bg-strong": "rgba(255, 176, 32, 0.24)",
  "--warn-border": "rgba(154, 91, 0, 0.32)",
  "--success-fg": "#1b704b",
  "--success-bg": "rgba(54, 179, 126, 0.12)",
  "--success-border": "rgba(27, 112, 75, 0.28)",
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "24px",
  "--space-6": "32px",
  "--space-7": "48px",
  "--space-8": "64px",
  "--space-9": "96px",
  "--space-10": "128px",
  "--fs-xs": "12px",
  "--fs-sm": "14px",
  "--fs-base": "16px",
  "--fs-md": "18px",
  "--fs-lg": "20px",
  "--fs-xl": "24px",
  "--fs-2xl": "30px",
  "--fs-3xl": "36px",
  "--fs-display-2": "clamp(30px, 2.4vw + 21px, 48px)",
  "--fs-display-1": "clamp(38px, 3.9vw + 24px, 72px)",
  "--lh-tight": "1.05",
  "--lh-snug": "1.2",
  "--lh-normal": "1.5",
  "--lh-relaxed": "1.65",
  "--dur-fast": "150ms",
  "--dur-base": "220ms",
  "--dur-slow": "300ms",
  "--ease-out": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "--ease-in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
  "--focus-ring": "0 0 0 2px #fff, 0 0 0 4px var(--sky-700)",
  "--container-public": "1200px",
  "--container-narrow": "720px",
  "--gutter": "clamp(16px, 4vw, 40px)",
  // [VX F-Z] Desvío consciente del contrato C-F1 por robustez: fallback dentro del var() para que una --font-onest /
  // --font-jetbrains ausente no invalide todo el font-family (caería a la serif del navegador).
  "--font-sans": 'var(--font-onest, "Onest"), "Onest", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": 'var(--font-jetbrains, "JetBrains Mono"), "JetBrains Mono", ui-monospace, monospace',
  "--bg-public":
    "radial-gradient(60% 50% at 88% 0%, rgba(143, 181, 221, 0.38) 0%, rgba(143, 181, 221, 0) 70%), " +
    "radial-gradient(50% 45% at 0% 100%, rgba(200, 245, 100, 0.22) 0%, rgba(200, 245, 100, 0) 70%), " +
    "linear-gradient(170deg, #dbe8f6 0%, #eef4fb 42%, #f7fafd 100%)",
};

// ── contraste WCAG 2.x (misma cuenta que design-tokens.test.ts) ──────────
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
const color = (t: string) => parseColor(tokenValue(t)!);

describe("[VX F-a · C-F1] tokens en :root", () => {
  for (const [name, value] of Object.entries(C_F1)) {
    it(`${name} existe en :root con el valor literal`, () => {
      expect(tokenValue(name)).toBe(value);
    });
  }

  it("ninguna paleta [data-palette] redefine un token de C-F1", () => {
    const palettes = Array.from(CSS.matchAll(/\[data-palette="[^"]+"\]\s*\{([^}]*)\}/g), (m) => m[1]);
    expect(palettes.length).toBeGreaterThan(0);
    for (const body of palettes) {
      for (const name of Object.keys(C_F1)) {
        expect(body, name).not.toMatch(new RegExp(`${name}\\s*:`));
      }
    }
  });

  it("el CSS no usa más los literales de fuente fuera de los tokens (todo pasa por --font-sans/--font-mono)", () => {
    const outsideTokens = CSS.split("\n").filter((l) => !/^\s*--font-(sans|mono):/.test(l));
    const literals = outsideTokens.filter((l) => /font-family:\s*"(Onest|JetBrains Mono)"/.test(l));
    expect(literals).toEqual([]);
  });
});

describe("[VX F-a · C-F1] contraste AA", () => {
  const pairs: Array<[string, string]> = [
    ["--danger-fg", "--danger-bg"],
    ["--warn-fg", "--warn-bg"],
    ["--success-fg", "--success-bg"],
  ];
  for (const [fg, bg] of pairs) {
    it(`${fg} sobre ${bg} (compuesto sobre blanco) ≥ 4.5`, () => {
      expect(contrast(color(fg).rgb, over(color(bg), WHITE))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("texto blanco sobre --danger-solid ≥ 4.5", () => {
    expect(contrast(WHITE, color("--danger-solid").rgb)).toBeGreaterThanOrEqual(4.5);
  });

  it("--sky-700 (el azul del --focus-ring) sobre blanco ≥ 3 (WCAG 1.4.11)", () => {
    expect(contrast(color("--sky-700").rgb, WHITE)).toBeGreaterThanOrEqual(3);
  });
});

describe("[VX F-a · C-F1] paridad de motion con lib/motion.ts", () => {
  const ms = (v: string | null) => Number(v?.replace(/ms$/, ""));
  const bezier = (p: number[]) => `cubic-bezier(${p.join(", ")})`;

  it("--dur-* = DUR.fast/base/slow × 1000", () => {
    expect(ms(tokenValue("--dur-fast"))).toBe(Math.round(DUR.fast * 1000));
    expect(ms(tokenValue("--dur-base"))).toBe(Math.round(DUR.base * 1000));
    expect(ms(tokenValue("--dur-slow"))).toBe(Math.round(DUR.slow * 1000));
  });

  it("--ease-out / --ease-in-out = EASE_OUT / EASE_IN_OUT", () => {
    expect(tokenValue("--ease-out")).toBe(bezier(EASE_OUT));
    expect(tokenValue("--ease-in-out")).toBe(bezier(EASE_IN_OUT));
  });
});

describe("[VX F-a · C-F1/C-F3.1] root layout", () => {
  it("no carga Google Fonts ni monta UIProviders", () => {
    expect(LAYOUT).not.toContain("fonts.googleapis.com");
    expect(LAYOUT).not.toContain("fonts.gstatic.com");
    expect(LAYOUT).not.toContain("UIProviders");
  });

  it("el <html> lleva las variables de next/font y lang es-AR", () => {
    expect(LAYOUT).toMatch(/className=\{`\$\{onest\.variable\} \$\{jetbrains\.variable\}`\}/);
    expect(LAYOUT).toContain('lang="es-AR"');
  });

  it("lib/fonts.ts: Onest y JetBrains Mono por next/font, JetBrains sin preload", () => {
    expect(FONTS).toMatch(/from "next\/font\/google"/);
    expect(FONTS).toMatch(/variable: "--font-onest"/);
    expect(FONTS).toMatch(/variable: "--font-jetbrains"/);
    expect(FONTS).toMatch(/preload: false/);
  });
});
