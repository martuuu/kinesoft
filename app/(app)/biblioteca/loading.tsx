import { PageSkeleton, SkelCards, SkelHeader, SkelTabs } from "@/components/ui/skeleton";

/** Esqueleto de la Biblioteca (PF-0c): header, buscador y grilla de ejercicios. */
export default function BibliotecaLoading() {
  return (
    <PageSkeleton label="Cargando la biblioteca">
      <SkelHeader actions={1} titleW={180} />
      <SkelTabs count={4} />
      <SkelCards count={8} min={200} h={180} />
    </PageSkeleton>
  );
}
