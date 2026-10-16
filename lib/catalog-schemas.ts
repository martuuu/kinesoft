/**
 * Catálogo global (B-pre M-cat) — zod y tipos compartidos cliente/servidor
 * para la adopción desde el consultorio (B1.4 CAT-tenant).
 *
 * Va separado de `lib/catalog.ts` porque ese archivo es `"use server"` y solo
 * puede exportar funciones async; los pickers de `components/configuracion/
 * catalog/*` importan de acá los tipos de fila.
 *
 * Los ids de catálogo que entran por acá son SOLO forma: que existan, que no
 * estén archivados y (para planes) que sean globales o del tenant lo valida
 * `lib/catalog-validate.ts` dentro de la tx de escritura — las FK saltean RLS.
 */
import { z } from "zod";
import type { PayerKind } from "@prisma/client";

/** Búsqueda libre de los pickers. Vacío = primeras filas por nombre. */
export const CatalogQuery = z.string().trim().max(80).catch("");

/** Id de fila de catálogo (cuid). El tope evita payloads absurdos en el where. */
export const CatalogId = z.string().trim().min(1).max(64);

/** `payerId` editable de un Insurer: id = vincular, null/"" = desvincular. */
export const InsurerPayerLink = z
  .union([CatalogId, z.literal(""), z.null()])
  .transform((v) => (v ? v : null));

export const ProposePayerPlanInput = z.object({
  payerId: CatalogId,
  name: z.string().trim().min(1, "Nombre del plan requerido").max(80),
});

export type PayerOption = {
  id: string;
  name: string;
  kind: PayerKind;
  province: string | null;
};

export type PayerPlanOption = {
  id: string;
  name: string;
  /** null = plan global del catálogo; set = propuesto por este consultorio. */
  tenantId: string | null;
  /** true = lo propuso este consultorio y Plataforma todavía no lo promovió. */
  proposed: boolean;
};

export type PracticeOption = {
  id: string;
  name: string;
  code: string | null;
  nomenclador: string | null;
  defaultDurationMin: number | null;
};

/** Resultado de "Agregar del catálogo" en Obras sociales. */
export type AddFromCatalogResult =
  | { status: "created"; insurerId: string }
  /** Ya hay un Insurer con ese nombre (`@@unique([tenantId,name])`): la UI ofrece vincularlo. */
  | { status: "exists"; insurerId: string; linkedPayerId: string | null };

// VX-Z: vive en `lib/catalog-constants.ts` (sin zod, para bundles de cliente); se re-exporta acá.
export { PAYER_KIND_LABEL } from "@/lib/catalog-constants";
