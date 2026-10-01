import { CatalogListPage, type CatalogSearchParams } from "@/components/plataforma/catalog/catalog-list-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prestadoras · Catálogo · Plataforma" };

export default function CatalogoPrestadorasPage({ searchParams }: { searchParams: CatalogSearchParams }) {
  return <CatalogListPage entity="payer" searchParams={searchParams} />;
}
