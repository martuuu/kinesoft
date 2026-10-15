import { PageSkeleton, SkelCards, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/**
 * Esqueleto de Plataforma (PF-0c). Cubre el resumen y, como boundary más cercano, toda subruta sin `loading.tsx`
 * propio (catálogo, salud, sistema, auditoría…): mejor una forma genérica que un click sin respuesta.
 */
export default function PlataformaLoading() {
  return (
    <PageSkeleton label="Cargando Plataforma">
      <SkelHeader actions={0} titleW={200} />
      <SkelCards count={4} min={200} h={110} />
      <SkelRows rows={5} toolbar={false} />
    </PageSkeleton>
  );
}
