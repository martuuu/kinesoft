/**
 * Paletas de «Apariencia» (PF1.0-a). Vivían en `tweaks-panel.tsx`; el menú de perfil del dashboard
 * (`components/global/profile-menu.tsx`) las importaba de ahí y con eso arrastraba el panel entero a `/dashboard`
 * aunque el panel ahora se baje con `next/dynamic`. Este módulo es solo datos: el panel las re-exporta.
 */
import type { Palette } from "./tweaks-context";

export const PALETTE_OPTIONS: { value: Palette; label: string; swatch: [string, string, string] }[] = [
  { value: "sky", label: "Celeste", swatch: ["#1F4FBE", "#C8F564", "#E6EFFA"] },
  { value: "mint", label: "Verde", swatch: ["#1F8A5B", "#DBFD8C", "#DBF4EA"] },
  { value: "coral", label: "Coral", swatch: ["#C9622E", "#FFD66A", "#FAE5D6"] },
  { value: "violet", label: "Violeta", swatch: ["#5F40C7", "#B6F3D8", "#E5E0FB"] },
];
