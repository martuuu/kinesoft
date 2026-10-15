import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de la lista de consultorios de Plataforma (PF-0c). */
export default function ConsultoriosLoading() {
  return (
    <PageSkeleton label="Cargando los consultorios">
      <SkelHeader actions={1} titleW={200} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
