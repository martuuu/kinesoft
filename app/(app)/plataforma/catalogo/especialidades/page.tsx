import { CatalogListPage, type CatalogSearchParams } from "@/components/plataforma/catalog/catalog-list-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Especialidades · Catálogo · Plataforma" };

export default function CatalogoEspecialidadesPage({ searchParams }: { searchParams: CatalogSearchParams }) {
  return <CatalogListPage entity="specialty" searchParams={searchParams} />;
}
