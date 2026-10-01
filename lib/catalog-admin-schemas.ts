/**
 * Zod del panel de curado del catálogo global (Plataforma, B1.3 CAT-admin).
 *
 * Vive fuera de `lib/catalog-admin.ts` porque un archivo "use server" solo
 * puede exportar funciones async (AGENTS.md §4). Los enums se toman de
 * `@prisma/client` para que un valor nuevo en el schema rompa acá en tsc y no
 * en runtime.
 */
import { z } from "zod";
import { CatalogSource, PayerKind } from "@prisma/client";

export { CATALOG_ADMIN_PAGE_SIZE } from "@/lib/catalog-admin-types";

export const CatalogEntity = z.enum(["payer", "practice", "specialty"]);

const id = z.string().trim().min(1).max(64);

/** Texto opcional: "" o solo espacios = null (borra el valor). */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Aliases: trim, sin vacíos, sin duplicados exactos (el dedupe fino lo hace la action). */
const aliases = z
  .array(z.string().trim().max(160))
  .max(60)
  .transform((xs) => [...new Set(xs.filter(Boolean))]);

export const CatalogListQuery = z.object({
  entity: CatalogEntity,
  q: z.string().trim().max(120).default(""),
  /** Payer: PayerKind. Ignorado en práctica/especialidad. */
  kind: z.union([z.nativeEnum(PayerKind), z.literal("")]).default(""),
  source: z.union([z.nativeEnum(CatalogSource), z.literal("")]).default(""),
  archived: z.enum(["active", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type CatalogListQueryInput = z.input<typeof CatalogListQuery>;

export const PayerAdminUpdate = z.object({
  id,
  name: z.string().trim().min(2, "Poné un nombre").max(160),
  legalName: optText(240),
  kind: z.nativeEnum(PayerKind),
  registryCode: optText(40),
  cuit: optText(20),
  province: optText(80),
  aliases,
});

export const PracticeAdminUpdate = z.object({
  id,
  name: z.string().trim().min(2, "Poné un nombre").max(200),
  code: optText(40),
  nomenclador: optText(80),
  defaultDurationMin: z.coerce.number().int().min(5).max(480).nullish().transform((v) => v ?? null),
  aliases,
});

export const SpecialtyAdminUpdate = z.object({
  id,
  name: z.string().trim().min(2, "Poné un nombre").max(160),
  aliases,
});

export const CatalogArchive = z.object({ entity: CatalogEntity, id, archived: z.boolean() });

export const CatalogMerge = z
  .object({ fromId: id, intoId: id })
  .refine((v) => v.fromId !== v.intoId, { message: "No se puede fusionar consigo misma" });

export const PayerPlanPromote = z.object({ planId: id });
