import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de la lista de pacientes (PF-0c): header, buscador y filas con avatar. */
export default function PacientesLoading() {
  return (
    <PageSkeleton label="Cargando los pacientes">
      <SkelHeader actions={1} titleW={180} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
