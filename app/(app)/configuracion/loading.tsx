import { PageSkeleton, SkelForm, SkelHeader, SkelTabs } from "@/components/ui/skeleton";

/** Esqueleto de Configuración (PF-0c): header, pestañas y un formulario. Era la página sin `loading.tsx` más pesada. */
export default function ConfiguracionLoading() {
  return (
    <PageSkeleton label="Cargando la configuración">
      <SkelHeader actions={0} titleW={220} />
      <SkelTabs count={6} />
      <SkelForm fields={5} />
    </PageSkeleton>
  );
}
