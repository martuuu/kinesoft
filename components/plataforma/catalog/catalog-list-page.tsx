import { listCatalogForAdmin } from "@/lib/catalog-admin";
import type { CatalogEntityKind } from "@/lib/catalog-admin-types";
import type { CatalogListQueryInput } from "@/lib/catalog-admin-schemas";
import { CatalogAdminClient, type CatalogListState } from "@/components/plataforma/catalog/catalog-admin-client";

/**
 * Página server compartida por prestadoras / prácticas / especialidades: lee el
 * estado de la URL (fuente de verdad, como en Plataforma → Ejercicios), pide la
 * página a `listCatalogForAdmin` y se la pasa a la tabla cliente. Valores
 * inválidos en la URL caen a los defaults (la action valida con zod y la
 * normalización de abajo nunca tira).
 */
type Param = string | string[] | undefined;
export type CatalogSearchParams = { q?: Param; kind?: Param; source?: Param; arch?: Param; page?: Param };

const one = (v: Param): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

const KINDS = ["OBRA_SOCIAL", "PREPAGA", "MUTUAL", "OTRA"];
const SOURCES = ["REFEPS", "NOMENCLADOR_NACIONAL", "PMO", "RNOS", "RNEMP", "PROVINCIAL", "CURATED", "TENANT"];

export async function CatalogListPage({
  entity,
  searchParams,
}: {
  entity: CatalogEntityKind;
  searchParams: CatalogSearchParams;
}) {
  const kind = one(searchParams.kind);
  const source = one(searchParams.source);
  const arch = one(searchParams.arch);
  const state: CatalogListState = {
    q: one(searchParams.q).slice(0, 120),
    kind: entity === "payer" && KINDS.includes(kind) ? kind : "",
    source: SOURCES.includes(source) ? source : "",
    archived: arch === "archived" || arch === "all" ? arch : "active",
  };
  const requested = Math.max(1, Math.min(10_000, Math.trunc(Number(one(searchParams.page))) || 1));

  const data = await listCatalogForAdmin({
    entity,
    q: state.q,
    kind: state.kind as CatalogListQueryInput["kind"],
    source: state.source as CatalogListQueryInput["source"],
    archived: state.archived,
    page: requested,
  });

  return <CatalogAdminClient entity={entity} state={state} data={data} />;
}
