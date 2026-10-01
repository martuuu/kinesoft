/**
 * Tipos del panel de curado del catálogo global (Plataforma, B1.3). Separados
 * de `lib/catalog-admin.ts` ("use server": solo funciones async).
 */
import type { CatalogSource, PayerKind } from "@prisma/client";

/** Filas por página de las tablas de curado (lo usan la action y el pager). */
export const CATALOG_ADMIN_PAGE_SIZE = 30;

export type CatalogEntityKind = "payer" | "practice" | "specialty";

/**
 * Fila unificada de las tres tablas (prestadoras, prácticas, especialidades):
 * una sola tabla en la UI con columnas que cambian de etiqueta por entidad.
 * `code` = registryCode (RNOS/RNEMP) de la prestadora o código de nomenclador
 * de la práctica; `detail` = tipo de prestadora / nomenclador.
 */
export type CatalogAdminRow = {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  code: string | null;
  detail: string | null;
  province: string | null;
  source: CatalogSource;
  sourceRef: string | null;
  sourceDate: string;
  curatedAt: string | null;
  archived: boolean;
  /** Uso cruzando tenants: insurers + planes (prestadora), servicios + especialidades (práctica), prácticas (especialidad). */
  usage: { label: string; count: number }[];
};

export type CatalogAdminPage = { rows: CatalogAdminRow[]; total: number; page: number; pageCount: number };

export type PayerDetail = {
  kind: "payer";
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  payerKind: PayerKind;
  registryCode: string | null;
  cuit: string | null;
  province: string | null;
  aliases: string[];
  source: CatalogSource;
  sourceRef: string | null;
  curatedAt: string | null;
  archivedAt: string | null;
  plans: { id: string; name: string; slug: string; tenantName: string | null; archived: boolean; coverages: number }[];
  insurerCount: number;
};

export type PracticeDetail = {
  kind: "practice";
  id: string;
  slug: string;
  name: string;
  code: string | null;
  nomenclador: string | null;
  defaultDurationMin: number | null;
  aliases: string[];
  source: CatalogSource;
  sourceRef: string | null;
  curatedAt: string | null;
  archivedAt: string | null;
  specialties: { id: string; name: string }[];
  serviceCount: number;
};

export type SpecialtyDetail = {
  kind: "specialty";
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  source: CatalogSource;
  sourceRef: string | null;
  curatedAt: string | null;
  archivedAt: string | null;
  practiceCount: number;
};

export type CatalogDetail = PayerDetail | PracticeDetail | SpecialtyDetail;

/** Plan propuesto por un consultorio (PayerPlan con tenantId) pendiente de promover. */
export type PayerPlanProposal = {
  id: string;
  name: string;
  slug: string;
  payerId: string;
  payerName: string;
  payerArchived: boolean;
  tenantId: string;
  tenantName: string;
  coverages: number;
  /** Ya hay un plan global con el mismo slug: promover = fusionar en ese. */
  globalMatch: { id: string; name: string } | null;
  createdAt: string;
};

export type CatalogImportRunRow = {
  id: string;
  file: string;
  sha256: string;
  kind: string;
  created: number;
  updated: number;
  skipped: number;
  conflictCount: number;
  ranAt: string;
  ranBy: string | null;
};

export type MergeResult = {
  /** Filas repuntadas por tabla (cruzando todos los tenants). */
  moved: Record<string, number>;
  aliasesAdded: number;
};
