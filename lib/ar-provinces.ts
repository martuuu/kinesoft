/**
 * DIR (DIR-D16, M11): las 24 jurisdicciones de Argentina con su código ISO 3166-2:AR sin el prefijo «AR-». Es la
 * lista que acepta el CHECK de `Location.provinceCode` y de `ProfessionalPublicProfile.licenseJurisdiction`
 * (`prisma/migrations/20261019120000_public_directory`): si cambia una, cambia la otra. `province` sigue siendo texto
 * libre («Bs As», «CABA») y no sirve para filtrar; por eso existe el código.
 */
import type { ProvinceCode } from "@/lib/directory-types";

/** Orden de los selects: alfabético por nombre (CABA primero, como la muestran los formularios del país). */
export const AR_PROVINCES: ReadonlyArray<{ code: ProvinceCode; name: string }> = [
  { code: "C", name: "Ciudad Autónoma de Buenos Aires" },
  { code: "B", name: "Buenos Aires" },
  { code: "K", name: "Catamarca" },
  { code: "H", name: "Chaco" },
  { code: "U", name: "Chubut" },
  { code: "X", name: "Córdoba" },
  { code: "W", name: "Corrientes" },
  { code: "E", name: "Entre Ríos" },
  { code: "P", name: "Formosa" },
  { code: "Y", name: "Jujuy" },
  { code: "L", name: "La Pampa" },
  { code: "F", name: "La Rioja" },
  { code: "M", name: "Mendoza" },
  { code: "N", name: "Misiones" },
  { code: "Q", name: "Neuquén" },
  { code: "R", name: "Río Negro" },
  { code: "A", name: "Salta" },
  { code: "J", name: "San Juan" },
  { code: "D", name: "San Luis" },
  { code: "Z", name: "Santa Cruz" },
  { code: "S", name: "Santa Fe" },
  { code: "G", name: "Santiago del Estero" },
  { code: "V", name: "Tierra del Fuego" },
  { code: "T", name: "Tucumán" },
];

/** Alias que usa DIR-2b (`lib/public-profile-logic.ts`): el mismo tipo de C-DIR3. */
export type ArProvinceCode = ProvinceCode;

/** Los 24 códigos, en el orden de `AR_PROVINCES` (para zod/Set). */
export const AR_PROVINCE_CODES: ReadonlyArray<ProvinceCode> = AR_PROVINCES.map((p) => p.code);

const BY_CODE = new Map<string, string>(AR_PROVINCES.map((p) => [p.code, p.name]));

export function isProvinceCode(v: unknown): v is ProvinceCode {
  return typeof v === "string" && BY_CODE.has(v);
}

/** Nombre de la jurisdicción; null si el código no es uno de los 24 (dato viejo o input armado a mano). */
export function provinceName(code: string | null | undefined): string | null {
  return code ? BY_CODE.get(code) ?? null : null;
}
