import { listCatalogImportRuns } from "@/lib/catalog-admin";
import { ImportRunsClient } from "@/components/plataforma/catalog/import-runs-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Importaciones · Catálogo · Plataforma" };

/** Últimas corridas de `scripts/catalog-import.ts --apply` (CatalogImportRun). */
export default async function CatalogoImportacionesPage() {
  const runs = await listCatalogImportRuns(30);
  return <ImportRunsClient runs={runs} />;
}
