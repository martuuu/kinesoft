import { PageSkeleton, SkelCards, SkelHeader, SkelTabs } from "@/components/ui/skeleton";

/** Esqueleto de Planes (PF-0c): header y grilla de tarjetas. */
export default function PlanesLoading() {
  return (
    <PageSkeleton label="Cargando los planes">
      <SkelHeader actions={1} titleW={160} />
      <SkelTabs count={3} />
      <SkelCards count={6} min={260} h={150} />
    </PageSkeleton>
  );
}
