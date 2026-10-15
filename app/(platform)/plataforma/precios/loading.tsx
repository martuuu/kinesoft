import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de /plataforma → Precios (molde de Mensajes y Usuarios, PF-0c). */
export default function PreciosLoading() {
  return (
    <PageSkeleton label="Cargando los precios">
      <SkelHeader actions={0} titleW={140} />
      <SkelRows rows={4} />
    </PageSkeleton>
  );
}
