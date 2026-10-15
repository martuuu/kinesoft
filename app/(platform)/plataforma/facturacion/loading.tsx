import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de /plataforma → Facturación (molde de Mensajes y Usuarios, PF-0c). */
export default function FacturacionLoading() {
  return (
    <PageSkeleton label="Cargando la facturación">
      <SkelHeader actions={0} titleW={180} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
