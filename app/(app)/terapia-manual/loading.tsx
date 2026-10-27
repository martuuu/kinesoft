import { PageSkeleton, SkelCards, SkelHeader, SkelTabs } from "@/components/ui/skeleton";

/** Esqueleto de Terapia Manual (HD-8): misma pantalla que /biblioteca (`BibliotecaClient` en modo maniobras). */
export default function TerapiaManualLoading() {
  return (
    <PageSkeleton label="Cargando Terapia Manual">
      <SkelHeader actions={1} titleW={180} />
      <SkelTabs count={4} />
      <SkelCards count={8} min={200} h={180} />
    </PageSkeleton>
  );
}
