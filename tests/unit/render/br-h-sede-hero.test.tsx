import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClinicSite, ClinicSiteLookup } from "@/lib/clinic-site-types";

/**
 * CF3b (BR-H, 05-nov) · encabezado de la sede `/<slug>` con foto, velo en el color del consultorio y animación CSS.
 *
 * Pedido de Martin: «el hero quedó muy básico con un gradiente» → foto de medicina + algo animado encima, y que la
 * sede de TMP se adapte a su marca SIN hex de TMP en el código (la paleta `tmp` la agrega BR-P en globals.css; la sede
 * tiene que quedar en azul/turquesa solo por `data-palette`).
 *
 * Qué se fija acá (render real de la página con `renderToStaticMarkup`, sin jsdom; se mockea solo la red:
 * `getClinicSite`):
 *   - la foto: `<picture>` con webp 960/1600/2400 + jpg, `sizes`, `fetchpriority=high`, sin lazy, decorativa, con
 *     dimensiones y los archivos en `public/sede/` con pesos razonables para el LCP;
 *   - el logo protagonista y el CTA;
 *   - reduced-motion: todo quieto y el estado quieto = el final; los keyframes solo tocan transform/opacity;
 *   - sin hex de TMP ni colores de marca fijos en la sede (solo tokens);
 *   - AA del texto sobre el velo con CADA paleta de globals.css (la de TMP incluida cuando exista);
 *   - los hex de la imagen OG = los tokens de globals.css (next/og no lee variables CSS).
 */
const state = vi.hoisted(() => ({ lookup: null as ClinicSiteLookup }));
vi.mock("@/lib/clinic-site-internal", () => ({ getClinicSite: async () => state.lookup }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import SedeDigitalPage from "@/app/(sede)/[slug]/page";
import { SEDE_HERO_PHOTO } from "@/components/sede/sede-hero";
import { SEDE_OG_PALETTES, sedeOgColors, sedeOgScrim } from "@/components/sede/sede-og";
import { SITE_PALETTES } from "@/lib/clinic-site-types";
import { RESERVED_SLUGS, isValidSlug, slugify } from "@/lib/onboarding-logic";

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "components/sede/sede.module.css"), "utf8");
const GLOBALS = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");

function site(over: Partial<ClinicSite> = {}): ClinicSite {
  return {
    slug: "tmp",
    name: "TMP",
    palette: "sky",
    tagline: "Terapia Manual Práctica",
    description: "Kinesiología y osteopatía.",
    logoUrl: null,
    contact: { phone: "011 4832-5517", whatsapp: null },
    locations: [{ name: "Palermo", address: "Av. Santa Fe 3450", city: "Palermo", province: null, mapsUrl: null }],
    openingSummary: "Lun a vie 8 a 20",
    coverages: [],
    bookingUrl: "/c/tmp/booking",
    practitioners: [],
    online: { bookingOpen: true },
    ...over,
  };
}
async function render(): Promise<string> {
  return renderToStaticMarkup(await SedeDigitalPage({ params: { slug: "tmp" } }));
}
/** El `<section>` del encabezado (hasta el primer `</section>`: adentro no hay otra sección). */
function heroOf(html: string): string {
  const start = html.indexOf('aria-labelledby="sede-h1"');
  expect(start, "no hay encabezado").toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</section>", start));
}
/** Cuerpo de la primera regla `selector {…}` del CSS (sin comentarios). */
function rule(css: string, selector: string): string {
  const src = noComments(css);
  const i = src.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf("}", i));
}

beforeEach(() => {
  state.lookup = site();
});

describe("[BR-H] foto del encabezado", () => {
  it("[BR-H-1] <picture> con webp 960/1600/2400 + jpg, sizes, fetchpriority=high, sin lazy, decorativa y con dimensiones", async () => {
    const hero = heroOf(await render());
    expect(hero).toMatch(/<div[^>]*aria-hidden="true"[^>]*><picture>/);
    const source = hero.match(/<source[^>]*>/)![0];
    expect(source).toContain('type="image/webp"');
    for (const w of [960, 1600, 2400]) expect(source).toContain(`/sede/hero-consultorio-${w}.webp ${w}w`);
    expect(source).toContain('sizes="100vw"');
    const img = hero.match(/<img[^>]*src="\/sede\/[^"]*"[^>]*>/)![0];
    expect(img).toContain('src="/sede/hero-consultorio-1600.jpg"');
    expect(img).toContain('alt=""');
    expect(img).toContain('width="1600"');
    expect(img).toContain('height="1060"');
    // React 18.3 del test lo escribe `fetchPriority`; el de Next (canary) `fetchpriority`. HTML no distingue.
    expect(img).toMatch(/fetchpriority="high"/i);
    expect(img).toContain('decoding="async"');
    expect(img).not.toMatch(/loading=/);
    // La foto va fuera del flujo (absolute): su carga no mueve nada (CLS 0).
    expect(rule(CSS, ".heroImg")).toMatch(/position:\s*absolute/);
    expect(rule(CSS, ".heroMedia")).toMatch(/position:\s*absolute/);
  });

  it("[BR-H-1b] los archivos existen con el tamaño declarado y pesos razonables para el LCP", () => {
    const dir = join(ROOT, "public/sede");
    const kb = (f: string) => statSync(join(dir, f)).size / 1024;
    for (const w of [960, 1600, 2400]) expect(existsSync(join(dir, `hero-consultorio-${w}.webp`)), `${w}`).toBe(true);
    expect(kb("hero-consultorio-960.webp")).toBeLessThan(40);
    expect(kb("hero-consultorio-1600.webp")).toBeLessThan(80);
    expect(kb("hero-consultorio-2400.webp")).toBeLessThan(120);
    expect(kb("hero-consultorio-1600.jpg")).toBeLessThan(130);
    // Las dimensiones del <img> = las del jpg real (si no, el navegador reserva otra proporción).
    expect(jpegSize(join(dir, "hero-consultorio-1600.jpg"))).toEqual({ width: SEDE_HERO_PHOTO.width, height: SEDE_HERO_PHOTO.height });
    // La de la imagen OG: 1200×630 exacta (satori la pinta sin recorte).
    expect(jpegSize(join(dir, "hero-consultorio-og.jpg"))).toEqual({ width: 1200, height: 630 });
  });

  it("[BR-H-2] logo protagonista en el encabezado con alt; sin logo, monograma; CTA lima «Sacar turno» y el h1", async () => {
    state.lookup = site({ logoUrl: "/tmp/logo?v=123" });
    let hero = heroOf(await render());
    expect(hero).toMatch(/<img[^>]+src="\/tmp\/logo\?v=123"[^>]+alt="Logo de TMP"[^>]*class="[^"]*logoXl/);
    expect(hero).toMatch(/<h1[^>]*id="sede-h1"[^>]*>TMP<small>Terapia Manual Práctica<\/small><\/h1>/);
    expect(hero).toMatch(/<a[^>]+class="k-btn k-btn-lime k-btn-lg"[^>]+href="\/c\/tmp\/booking"[\s\S]*?Sacar turno/);
    // Orden de lectura: logo → nombre → CTA.
    expect(hero.indexOf("logo?v=")).toBeLessThan(hero.indexOf("<h1"));
    expect(hero.indexOf("<h1")).toBeLessThan(hero.indexOf("Sacar turno"));
    state.lookup = site();
    hero = heroOf(await render());
    expect(hero).not.toMatch(/\/logo\?v=/);
    expect(hero).toMatch(/class="[^"]*monoXl[^"]*" aria-hidden="true">TMP<\/span>/);
    // El logo XL: alto fijo y ancho libre (un logo horizontal se ve entero; uno cuadrado, cuadrado).
    expect(rule(CSS, ".logoXl")).toMatch(/width:\s*auto/);
  });

  it("[BR-H-3] «vértebras» decorativas (aria-hidden), una por punto del CSS", async () => {
    const hero = heroOf(await render());
    const dots = hero.match(/<span class="[^"]*dots[^"]*" aria-hidden="true">((?:<span class="[^"]*dot[^"]*"><\/span>)+)<\/span>/);
    expect(dots).not.toBeNull();
    const n = dots![1].match(/<span/g)!.length;
    expect(n).toBe(9);
    for (let i = 1; i <= n; i++) expect(CSS, `.dot:nth-child(${i})`).toContain(`.dot:nth-child(${i}) {`);
  });
});

describe("[BR-H] movimiento", () => {
  it("[BR-H-4] reduced-motion apaga TODA animación y transición de la página; el estado quieto es el final", () => {
    const m = noComments(CSS).match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/\.page \*, \.page \*::before, \.page \*::after \{ animation: none !important; transition: none !important; \}/);
    // Quieto: la foto a escala 1 (el `from` del zoom), el barrido fuera de cuadro e invisible, los puntos sin transform.
    expect(noComments(CSS)).toMatch(/@keyframes sedeKenBurns \{\s*from \{ transform: scale\(1\); \}/);
    expect(rule(CSS, ".heroSweep")).toMatch(/opacity:\s*0;/);
    expect(rule(CSS, ".dot")).not.toMatch(/transform:/);
    // El barrido pasa una sola vez (no en loop) y la foto y los puntos sí van en loop, despacio.
    expect(rule(CSS, ".heroSweep")).toMatch(/animation: sedeSweep [\d.]+s [^;]* 1 both/);
    expect(rule(CSS, ".heroImg")).toMatch(/animation: sedeKenBurns (2\d|3\d)s/);
  });

  it("[BR-H-5] los keyframes de la sede solo animan transform/opacity (compositor) y no hay framer ni JS", () => {
    const frames = [...noComments(CSS).matchAll(/@keyframes (\w+)\s*\{([\s\S]*?\})\s*\}/g)];
    expect(frames.map((f) => f[1]).sort()).toEqual(["sedeDotIn", "sedeFloat", "sedeKenBurns", "sedeSweep"]);
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      expect(props.length, name).toBeGreaterThan(0);
      for (const p of props) expect(["transform", "opacity"], `${name}: ${p}`).toContain(p);
    }
    for (const f of ["sede-hero.tsx", "sede-page.tsx"]) {
      const src = readFileSync(join(ROOT, "components/sede", f), "utf8");
      expect(src, f).not.toMatch(/"use client"|framer-motion|useEffect|useState/);
    }
  });
});

describe("[BR-H] marca por tokens (sin hex de TMP)", () => {
  it("[BR-H-6] ni #1A436C ni #53A0AA (ni ningún color de marca fijo) en la sede: solo --sky-* / --lime-*", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(f)) files.push(p);
      }
    };
    walk(join(ROOT, "components/sede"));
    walk(join(ROOT, "app/(sede)"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    // Única excepción: `sede-og.ts` es la COPIA de los tokens para next/og (no lee variables CSS); BR-H-12 la ata a
    // globals.css, así que no es un color «de TMP» elegido en la sede sino el de la paleta `tmp`.
    for (const f of files.filter((p) => !p.endsWith("components/sede/sede-og.ts")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/1a436c|53a0aa/i);
    // En el CSS de la sede, los únicos hex son neutros (blanco y el fondo de página); el resto es token o rgba neutro.
    const hexes = [...new Set(noComments(CSS).match(/#[0-9a-f]{3,8}\b/gi)!.map((h) => h.toLowerCase()))].sort();
    expect(hexes).toEqual(["#f7fafd", "#fff"]);
    expect(rule(CSS, ".heroScrim")).toMatch(/var\(--sky-800\)/);
    expect(rule(CSS, ".band")).toMatch(/var\(--sky-800\)[\s\S]*var\(--sky-700\)/);
  });

  it("[BR-H-7] la página lleva `data-palette` del consultorio (así `tmp` pinta la sede sin tocar código)", async () => {
    state.lookup = site({ palette: "coral" });
    expect(await render()).toMatch(/<div class="[^"]*page[^"]*" data-palette="coral" data-surface="sede">/);
  });
});

// ── AA con cada paleta de globals.css ────────────────────────────────────────────────────────────────────────────
type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const m = h.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`no es hex: ${h}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB;
};
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color` al `alpha` sobre `base`: el velo sobre la foto, que en la zona del texto es casi blanca (peor caso). */
const over = (c: RGB, alpha: number, base: RGB = [255, 255, 255]): RGB => c.map((v, i) => v * alpha + base[i] * (1 - alpha)) as RGB;
const WHITE: RGB = [255, 255, 255];
const TOKENS = ["--sky-50", "--sky-100", "--sky-200", "--sky-700", "--sky-800", "--lime-300", "--navy-900"] as const;

/** `sky` = `:root`; cada `[data-palette="x"]` lo pisa (lo que no redefine, lo hereda del root). */
function palettes(): Record<string, Record<(typeof TOKENS)[number], RGB>> {
  const read = (block: string) => {
    const out: Partial<Record<(typeof TOKENS)[number], RGB>> = {};
    for (const t of TOKENS) {
      const m = block.match(new RegExp(`${t}:\\s*(#[0-9a-f]{6})\\s*;`, "i"));
      if (m) out[t] = hex(m[1]);
    }
    return out;
  };
  const rootStart = GLOBALS.indexOf(":root {");
  const root = read(GLOBALS.slice(rootStart, GLOBALS.indexOf("\n}", rootStart))) as Record<(typeof TOKENS)[number], RGB>;
  const out: Record<string, Record<(typeof TOKENS)[number], RGB>> = { sky: root };
  for (const m of GLOBALS.matchAll(/\[data-palette="([^"]+)"\]\s*\{([^}]*)\}/g)) out[m[1]] = { ...root, ...read(m[2]) };
  return out;
}

/** El alfa mínimo de --sky-800 en los dos primeros cortes del velo de escritorio (los que cubren la columna de texto). */
function scrimTextAlpha(): number {
  const body = rule(CSS, ".heroScrim");
  const stops = [...body.matchAll(/color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, transparent\)/g)];
  expect(stops.slice(0, 2).map((s) => s[1])).toEqual(["sky-800", "sky-800"]);
  return Math.min(...stops.slice(0, 2).map((s) => Number(s[2]) / 100));
}

describe("[BR-H] contraste (AA) con cada paleta", () => {
  const P = palettes();

  it("[BR-H-8] sanidad: lee las 5 paletas base (y `tmp` cuando BR-P la sume) y el chequeo muerde", () => {
    for (const p of ["sky", "mint", "coral", "violet"]) expect(Object.keys(P)).toContain(p);
    for (const p of SITE_PALETTES) expect(Object.keys(P), p).toContain(p);
    for (const [name, t] of Object.entries(P)) for (const k of TOKENS) expect(t[k], `${name} ${k}`).toBeDefined();
    // Anti-false-green: con un velo de 0,6 el blanco NO llegaría a AA con alguna paleta.
    expect(Object.values(P).some((t) => contrast(WHITE, over(t["--sky-800"], 0.6)) < 4.5)).toBe(true);
  });

  it("[BR-H-9] escritorio: nombre (blanco), frase (--sky-200) y bajada (--sky-100) sobre el velo, foto blanca debajo", () => {
    const a = scrimTextAlpha();
    expect(a).toBeGreaterThanOrEqual(0.88);
    for (const [name, t] of Object.entries(P)) {
      const bg = over(t["--sky-800"], a);
      expect(contrast(WHITE, bg), `${name} blanco`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--sky-200"], bg), `${name} sky-200`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--sky-100"], bg), `${name} sky-100`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("[BR-H-10] mobile y respaldo: el texto va sobre --sky-800 sólido; banda de contacto; eyebrow; CTA lima; avatar", () => {
    expect(rule(CSS, ".hero")).toMatch(/background:\s*var\(--sky-800\)/);
    expect(rule(CSS, ".heroScrim")).toMatch(/background:\s*var\(--sky-800\);\s*background:\s*linear-gradient/);
    for (const [name, t] of Object.entries(P)) {
      for (const fg of ["--sky-100", "--sky-200"] as const) expect(contrast(t[fg], t["--sky-800"]), `${name} ${fg}/800`).toBeGreaterThanOrEqual(4.5);
      // Banda de contacto y avatar: --sky-800 → --sky-700; el tramo más claro es --sky-700.
      expect(contrast(WHITE, t["--sky-700"]), `${name} blanco/700`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--sky-100"], t["--sky-700"]), `${name} sky-100/700`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--sky-700"], t["--sky-50"]), `${name} eyebrow`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--navy-900"], t["--lime-300"]), `${name} CTA lima`).toBeGreaterThanOrEqual(4.5);
    }
    // PH-U2 (05-nov): el avatar de las tarjetas pasó a `PractitionerPhoto` (marco blanco; iniciales --sky-700 sobre
    // --sky-50, el mismo par que el «eyebrow» de arriba). El disco con degradé ya no existe: lo fija ph-u2-practitioner-photo.
    expect(noComments(CSS)).not.toMatch(/\.avatar\s*\{/);
  });

  it("[BR-H-11] alto del encabezado: ≤ 64vh y ≤ 600 px en escritorio (a 1366×768 no pasa del ~70 %)", () => {
    const m = rule(CSS, ".heroIn").match(/min-height:\s*clamp\((\d+)px,\s*(\d+)vh,\s*(\d+)px\)/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeLessThanOrEqual(64);
    expect(Number(m![3])).toBeLessThanOrEqual(600);
  });
});

describe("[BR-H] imagen OG y slug reservado", () => {
  it("[BR-H-12] los hex de la OG = los tokens de globals.css, una entrada por paleta de SITE_PALETTES", () => {
    const P = palettes();
    const toHex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const full = (name: string) => {
      const start = name === "sky" ? GLOBALS.indexOf(":root {") : GLOBALS.indexOf(`[data-palette="${name}"] {`);
      const block = GLOBALS.slice(start, GLOBALS.indexOf("}", start));
      const v = (t: string) => block.match(new RegExp(`${t}:\\s*(#[0-9a-f]{6})`, "i"))?.[1].toLowerCase() ?? null;
      return { s800: v("--sky-800"), s700: v("--sky-700"), s600: v("--sky-600"), s200: v("--sky-200"), lime300: v("--lime-300") ?? toHex(P.sky["--lime-300"]) };
    };
    for (const p of SITE_PALETTES) {
      expect(SEDE_OG_PALETTES[p], `falta ${p} en components/sede/sede-og.ts (copiar de globals.css)`).toBeDefined();
      expect(SEDE_OG_PALETTES[p], p).toEqual(full(p));
    }
    // Una paleta que no está cae a sky (nunca undefined en la imagen).
    expect(sedeOgColors(undefined)).toBe(SEDE_OG_PALETTES.sky);
  });

  it("[BR-H-13] OG: el velo en la zona del texto es ≥ 0,88 y la ruta lee el jpg con la ruta literal (traza del build)", () => {
    for (const p of SITE_PALETTES) {
      const c = sedeOgColors(p);
      const alphas = [...sedeOgScrim(c).matchAll(/rgba\(\d+, \d+, \d+, ([\d.]+)\) (\d+)%/g)].filter((m) => Number(m[2]) <= 52);
      expect(alphas.length, p).toBe(2);
      for (const m of alphas) expect(contrast(WHITE, over(hex(c.s800), Number(m[1]))), p).toBeGreaterThanOrEqual(4.5);
    }
    const src = readFileSync(join(ROOT, "app/(sede)/[slug]/opengraph-image.tsx"), "utf8");
    expect(src).toContain('readFile(join(process.cwd(), "public/sede/hero-consultorio-og.jpg"))');
  });

  it("[BR-H-14] `public/sede/` crea el segmento /sede: el slug `sede` queda reservado y slugify no cae en él", () => {
    expect(RESERVED_SLUGS.has("sede")).toBe(true);
    expect(isValidSlug("sede")).toBe(false);
    expect(slugify("Sede")).not.toBe("sede");
    expect(isValidSlug(slugify("Sede"))).toBe(true);
    // La reserva es exacta: «sede-palermo» sigue libre.
    expect(isValidSlug("sede-palermo")).toBe(true);
  });
});

/** Ancho y alto de un JPEG leyendo el marcador SOF (sin dependencias). */
function jpegSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error("JPEG inválido");
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("sin SOF");
}
