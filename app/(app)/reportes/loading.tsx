import { PageSkeleton, Skel, SkelCard, SkelCards, SkelHeader } from "@/components/ui/skeleton";

/** Esqueleto de Reportes (PF-0c): header, indicadores y un gráfico. */
export default function ReportesLoading() {
  return (
    <PageSkeleton label="Cargando los reportes">
      <SkelHeader actions={1} titleW={180} />
      <SkelCards count={4} min={180} h={110} />
      <SkelCard style={{ minHeight: 280 }}>
        <Skel w={200} h={16} />
        <Skel w="100%" h={220} r={12} />
      </SkelCard>
    </PageSkeleton>
  );
}
