import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de Seguimiento (PF-0c): header y la lista de sesiones. */
export default function SeguimientoLoading() {
  return (
    <PageSkeleton label="Cargando el seguimiento">
      <SkelHeader actions={1} titleW={200} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
