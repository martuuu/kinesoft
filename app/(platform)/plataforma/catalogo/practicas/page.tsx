import { CatalogListPage, type CatalogSearchParams } from "@/components/plataforma/catalog/catalog-list-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prácticas · Catálogo · Plataforma" };

export default function CatalogoPracticasPage({ searchParams }: { searchParams: CatalogSearchParams }) {
  return <CatalogListPage entity="practice" searchParams={searchParams} />;
}
