/**
 * BR-P (CF3b, pedido de Martin del 05-nov): paletas del consultorio, generales y «de marca».
 *
 * - **Generales** (`sky`, `mint`, `coral`, `violet`): las de siempre. Cualquier usuario las elige en Apariencia y
 *   cualquier consultorio las puede poner en su sitio y su turnero.
 * - **De marca**: los colores de UN consultorio puntual (hoy solo TMP: azul marino `#1A436C` y turquesa `#53A0AA`,
 *   medidos del logo en `design_source/tmp-brand/`). Una paleta de marca existe para un consultorio cuando
 *   `Tenant.palette` es esa key (la asigna Plataforma). Recién ahí se ofrece en Apariencia a sus miembros, y en
 *   Configuración → «Sitio web» queda entre las opciones. A otro consultorio no se le ofrece y, si un usuario la tiene
 *   guardada de otro consultorio (`UserPreferences.palette` es por usuario, no por consultorio), se pinta la de
 *   siempre (`effectivePalette`).
 * - Opcional: no cambia el default de nadie (`DEFAULT_PALETTE` = sky).
 *
 * Puro y sin dependencias: lo importan el shell (cliente), el turnero y la sede (públicas), las actions y los tests.
 * Los colores viven en `app/globals.css` (`[data-palette="<key>"]`); acá solo las keys y los rótulos.
 */

export const GENERAL_PALETTES = ["sky", "mint", "coral", "violet"] as const;
export type GeneralPalette = (typeof GENERAL_PALETTES)[number];

/** Rótulos de las generales (mismos que Apariencia, `components/layout/appearance-options.ts`). */
export const GENERAL_PALETTE_LABELS: Record<GeneralPalette, string> = {
  sky: "Celeste",
  mint: "Verde",
  coral: "Coral",
  violet: "Violeta",
};

/** Paletas de marca: una por consultorio que la pidió. Sumar una = su bloque en globals.css + su swatch. */
export const BRAND_PALETTES = [{ key: "tmp", label: "TMP" }] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
}>;
export type BrandPaletteKey = (typeof BRAND_PALETTES)[number]["key"];
export type BrandPalette = (typeof BRAND_PALETTES)[number];

export type AppPalette = GeneralPalette | BrandPaletteKey;

/**
 * Todas, en orden (generales primero). Tupla literal (no un spread) para `z.enum(...)` de los escritores. El chequeo
 * de abajo no compila si una paleta de marca nueva no se suma acá.
 */
export const ALL_PALETTES = ["sky", "mint", "coral", "violet", "tmp"] as const satisfies ReadonlyArray<AppPalette>;
type MissingFromAll = Exclude<AppPalette, (typeof ALL_PALETTES)[number]>;
const _allCovered: [MissingFromAll] extends [never] ? true : never = true;
void _allCovered;

export const DEFAULT_PALETTE: GeneralPalette = "sky";

export function isAppPalette(v: unknown): v is AppPalette {
  return typeof v === "string" && (ALL_PALETTES as readonly string[]).includes(v);
}

export function isBrandPalette(v: unknown): v is BrandPaletteKey {
  return typeof v === "string" && BRAND_PALETTES.some((b) => b.key === v);
}

/** La paleta de marca del consultorio (por su `Tenant.palette`), o null si tiene una general o ninguna conocida. */
export function brandPaletteFor(tenantPalette: string | null | undefined): BrandPalette | null {
  return BRAND_PALETTES.find((b) => b.key === tenantPalette) ?? null;
}

/** Lo que un miembro del consultorio puede elegir: las generales + la de marca del consultorio, si tiene. */
export function palettesForTenant(tenantPalette: string | null | undefined): AppPalette[] {
  const brand = brandPaletteFor(tenantPalette);
  return brand ? [...GENERAL_PALETTES, brand.key] : [...GENERAL_PALETTES];
}

export function paletteAllowedForTenant(p: unknown, tenantPalette: string | null | undefined): p is AppPalette {
  return isAppPalette(p) && palettesForTenant(tenantPalette).includes(p);
}

/**
 * La que se pinta en el workspace: la del usuario si este consultorio la ofrece; si no (paleta de marca de OTRO
 * consultorio, o un valor viejo/desconocido), la de siempre.
 */
export function effectivePalette(userPalette: unknown, tenantPalette: string | null | undefined): AppPalette {
  return paletteAllowedForTenant(userPalette, tenantPalette) ? userPalette : DEFAULT_PALETTE;
}

/** Rótulo para la UI (Plataforma, «Sitio web»). Un valor desconocido se muestra crudo (no se esconde). */
export function paletteLabel(p: string): string {
  if ((GENERAL_PALETTES as readonly string[]).includes(p)) return GENERAL_PALETTE_LABELS[p as GeneralPalette];
  return brandPaletteFor(p)?.label ?? p;
}

/**
 * Valor de `data-palette` para una superficie pública (turnero, sede): la paleta del consultorio si es conocida;
 * `undefined` para sky o un valor desconocido (`:root` ya es sky, el atributo sobra).
 */
export function paletteAttr(raw: string | null | undefined): AppPalette | undefined {
  return isAppPalette(raw) && raw !== DEFAULT_PALETTE ? raw : undefined;
}
