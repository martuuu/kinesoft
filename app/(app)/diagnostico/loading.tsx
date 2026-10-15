import { PageSkeleton, SkelForm, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de Diagnóstico (PF-0c): header y las dos columnas (selección y resultado). */
export default function DiagnosticoLoading() {
  return (
    <PageSkeleton label="Cargando el diagnóstico">
      <SkelHeader actions={0} titleW={200} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        <SkelForm fields={4} />
        <SkelRows rows={5} toolbar={false} avatar={false} />
      </div>
    </PageSkeleton>
  );
}
