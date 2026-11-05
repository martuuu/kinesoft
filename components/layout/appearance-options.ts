/**
 * Paletas de «Apariencia» (PF1.0-a). Vivían en `tweaks-panel.tsx`; el menú de perfil del dashboard
 * (`components/global/profile-menu.tsx`) las importaba de ahí y con eso arrastraba el panel entero a `/dashboard`
 * aunque el panel ahora se baje con `next/dynamic`. Este módulo es solo datos: el panel las re-exporta.
 */
import type { Palette } from "./tweaks-context";
import { brandPaletteFor, type BrandPaletteKey } from "@/lib/brand-palettes";

export type PaletteOption = { value: Palette; label: string; swatch: [string, string, string] };

/** Las generales: las ve todo el mundo. */
export const PALETTE_OPTIONS: PaletteOption[] = [
  { value: "sky", label: "Celeste", swatch: ["#1F4FBE", "#C8F564", "#E6EFFA"] },
  { value: "mint", label: "Verde", swatch: ["#1F8A5B", "#DBFD8C", "#DBF4EA"] },
  { value: "coral", label: "Coral", swatch: ["#C9622E", "#FFD66A", "#FAE5D6"] },
  { value: "violet", label: "Violeta", swatch: ["#5F40C7", "#B6F3D8", "#E5E0FB"] },
];

/**
 * BR-P: las de marca, con el swatch de su logo (TMP: marino #1A436C = `--sky-800`, turquesa #53A0AA = `--sky-500` y
 * el tinte `--sky-100` de su bloque en globals.css). Solo se listan para los miembros del consultorio que la tiene.
 */
export const BRAND_PALETTE_OPTIONS: Record<BrandPaletteKey, PaletteOption> = {
  tmp: { value: "tmp", label: "TMP", swatch: ["#1A436C", "#53A0AA", "#E2F0F2"] },
};

/**
 * BR-P: lo que ofrece Apariencia (y «Ajustes») al consultorio activo: las generales + la de marca si
 * `Tenant.palette` es una (`useTenantBrand().palette`). Cualquier otro valor = solo las generales.
 */
export function paletteOptionsFor(tenantPalette: string | null | undefined): PaletteOption[] {
  const brand = brandPaletteFor(tenantPalette);
  return brand ? [...PALETTE_OPTIONS, BRAND_PALETTE_OPTIONS[brand.key]] : PALETTE_OPTIONS;
}
