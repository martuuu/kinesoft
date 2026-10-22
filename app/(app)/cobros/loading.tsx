import { PageSkeleton, SkelCards, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** [TP-3g] Esqueleto de /cobros: encabezado, las dos cifras del resumen y las filas (molde PF-0c de Pacientes). */
export default function CobrosLoading() {
  return (
    <PageSkeleton label="Cargando los cobros">
      <SkelHeader actions={0} titleW={140} />
      <SkelCards count={2} min={220} h={84} />
      <SkelRows rows={8} avatar={false} />
    </PageSkeleton>
  );
}
