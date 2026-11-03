import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** [CF2-PU2] Esqueleto de /caja: encabezado, la barra de período y las filas por profesional (molde de /cobros). */
export default function CajaLoading() {
  return (
    <PageSkeleton label="Cargando la caja">
      <SkelHeader actions={0} titleW={120} />
      <SkelRows rows={5} avatar={false} />
    </PageSkeleton>
  );
}
