/**
 * Copy y opciones del panel de catálogo (cliente). Los valores de los enums se
 * repiten como strings a propósito: importar los enums de `@prisma/client` en un
 * componente cliente arrastra el runtime de Prisma al bundle. Si el enum cambia
 * en el schema, `satisfies` hace fallar tsc acá.
 */
import type { CatalogSource, PayerKind } from "@prisma/client";
import type { CatalogEntityKind } from "@/lib/catalog-admin-types";

export const PAYER_KIND_OPTIONS = [
  { value: "OBRA_SOCIAL", label: "Obra social" },
  { value: "PREPAGA", label: "Prepaga" },
  { value: "MUTUAL", label: "Mutual" },
  { value: "OTRA", label: "Otra" },
] as const satisfies readonly { value: PayerKind; label: string }[];

export const SOURCE_LABEL = {
  REFEPS: "REFEPS",
  NOMENCLADOR_NACIONAL: "Nomenclador Nacional",
  PMO: "PMO",
  RNOS: "RNOS (SSS)",
  RNEMP: "RNEMP (SSS)",
  PROVINCIAL: "Provincial",
  CURATED: "Curada a mano",
  TENANT: "Propuesta por un consultorio",
} as const satisfies Record<CatalogSource, string>;

export const SOURCE_OPTIONS = (Object.keys(SOURCE_LABEL) as CatalogSource[]).map((value) => ({
  value,
  label: SOURCE_LABEL[value],
}));

export const ENTITY_COPY: Record<
  CatalogEntityKind,
  { singular: string; searchPlaceholder: string; detailHead: string; codeHead: string; empty: string }
> = {
  payer: {
    singular: "prestadora",
    searchPlaceholder: "Buscar por nombre, alias, RNOS/RNEMP o CUIT…",
    detailHead: "Tipo",
    codeHead: "RNOS / CUIT",
    empty: "Todavía no hay prestadoras cargadas.",
  },
  practice: {
    singular: "práctica",
    searchPlaceholder: "Buscar por nombre, alias o código…",
    detailHead: "Nomenclador",
    codeHead: "Código",
    empty: "Todavía no hay prácticas cargadas.",
  },
  specialty: {
    singular: "especialidad",
    searchPlaceholder: "Buscar por nombre o alias…",
    detailHead: "",
    codeHead: "",
    empty: "Todavía no hay especialidades cargadas.",
  },
};

/** dd/mm/aaaa en hora argentina (AGENTS.md §4: todo toLocale* con timeZone). */
export function formatARDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatARDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
