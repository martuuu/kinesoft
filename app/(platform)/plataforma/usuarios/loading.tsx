import { PageSkeleton, SkelHeader, SkelRows } from "@/components/ui/skeleton";

/** Esqueleto de la lista de usuarios de Plataforma (PF-0c). */
export default function UsuariosLoading() {
  return (
    <PageSkeleton label="Cargando los usuarios">
      <SkelHeader actions={0} titleW={180} />
      <SkelRows rows={8} />
    </PageSkeleton>
  );
}
