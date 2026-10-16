import type { PayerKind } from "@prisma/client";

/**
 * Constantes del catálogo SIN zod (VX-Z, handoff 22 de VX2-e). Vivían en `lib/catalog-schemas.ts`, que define los
 * schemas de las actions: importar de ahí un simple diccionario de etiquetas metía zod entero (~13 kB gz) en el
 * bundle de /onboarding. `lib/catalog-schemas.ts` las re-exporta para los llamadores de siempre.
 */
export const PAYER_KIND_LABEL: Record<PayerKind, string> = {
  OBRA_SOCIAL: "Obra social",
  PREPAGA: "Prepaga",
  MUTUAL: "Mutual",
  OTRA: "Otra",
};
