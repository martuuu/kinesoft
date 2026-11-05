/**
 * CF3b (BR-H) · colores e imagen de fondo de la imagen para compartir la sede (`app/(sede)/[slug]/opengraph-image.tsx`).
 *
 * `next/og` (satori) no lee variables CSS ni entiende `color-mix`: los colores van como hex, COPIA de los tokens de
 * `app/globals.css` (--sky-800/700/600/200 y --lime-300 de `:root` = paleta `sky`, y de cada `[data-palette]`).
 * `tests/unit/render/br-h-sede-hero.test.tsx` compara cada valor con globals.css y exige una entrada por paleta de
 * `SITE_PALETTES`: si se agrega una paleta y no se copia acá, el test lo dice (mientras tanto la imagen cae a `sky`).
 *
 * Sin React ni `next/*`: lo testea el unit y lo usa la ruta de la imagen.
 */
import type { SitePalette } from "@/lib/clinic-site-types";

export type SedeOgColors = { s800: string; s700: string; s600: string; s200: string; lime300: string };

export const SEDE_OG_PALETTES: Partial<Record<SitePalette, SedeOgColors>> & { sky: SedeOgColors } = {
  sky: { s800: "#0f3781", s700: "#1f4fbe", s600: "#3d74b5", s200: "#d2e2f4", lime300: "#c8f564" },
  mint: { s800: "#0e4a30", s700: "#166e48", s600: "#1f8a5b", s200: "#b7e7d2", lime300: "#dbfd8c" },
  coral: { s800: "#4f2210", s700: "#7c3618", s600: "#a24a20", s200: "#f4c9ac", lime300: "#ffd66a" },
  violet: { s800: "#1b0f4d", s700: "#2e1a7c", s600: "#4327a5", s200: "#cbc1f6", lime300: "#b6f3d8" },
  // CF3b (BR-P): la paleta del consultorio TMP (azul marino y turquesa del logo), `[data-palette="tmp"]`.
  tmp: { s800: "#1a436c", s700: "#1f5a80", s600: "#2a7480", s200: "#c6e3e7", lime300: "#a6eedd" },
};

export function sedeOgColors(palette: SitePalette | null | undefined): SedeOgColors {
  return (palette && SEDE_OG_PALETTES[palette]) || SEDE_OG_PALETTES.sky;
}

/** `#1f4fbe` + 0.5 → `rgba(31, 79, 190, 0.5)` (satori sí entiende rgba en un degradé). */
export function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * El mismo velo que el encabezado de la página (`.heroScrim`): --sky-800 casi opaco donde va el texto (≥ 0,88: AA del
 * blanco sobre una foto casi blanca, el test lo mide) y la foto a la vista a la derecha, teñida con la paleta.
 */
export function sedeOgScrim(c: SedeOgColors): string {
  return `linear-gradient(90deg, ${hexAlpha(c.s800, 0.94)} 0%, ${hexAlpha(c.s800, 0.88)} 52%, ${hexAlpha(c.s700, 0.5)} 72%, ${hexAlpha(c.s600, 0.24)} 100%)`;
}
