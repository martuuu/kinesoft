import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de la bandeja de Tickets de Plataforma (molde de Usuarios, PF-0c). */
export default function MensajesLoading() {
  return (
    <PageSkeleton label="Cargando los tickets">
      <SkelHeader actions={0} titleW={160} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
