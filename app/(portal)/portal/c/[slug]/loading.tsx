import { PageSkeleton, Skel, SkelCard, SkelTabs } from "@/components/ui/skeleton";

/**
 * ES4-Z (b): esqueleto del consultorio en el portal (inicio, Estado de cuenta y Ejercicios lo heredan). Antes, al
 * tocar una tab la pantalla quedaba congelada hasta que llegaba el server component. Server-safe y sin framer: el
 * portal es superficie pública con presupuesto de bundle (C-F3, D-VX22). Misma forma que la página: volver, encabezado,
 * tabs y dos tarjetas.
 */
export default function PortalTenantLoading() {
  return (
    <PageSkeleton label="Cargando tu consultorio">
      <Skel w={140} h={16} />
      <div style={{ display: "grid", gap: 8 }}>
        <Skel w={120} h={22} r={999} />
        <Skel w="70%" h={28} />
        <Skel w="85%" h={14} />
      </div>
      <SkelTabs count={3} />
      <SkelCard>
        <Skel w="40%" h={12} />
        <Skel w="60%" h={20} style={{ marginTop: 8 }} />
        <Skel h={8} style={{ marginTop: 12 }} />
      </SkelCard>
      <SkelCard>
        <Skel w="50%" h={14} />
        <Skel w="80%" h={14} style={{ marginTop: 10 }} />
        <Skel w="65%" h={14} style={{ marginTop: 10 }} />
      </SkelCard>
    </PageSkeleton>
  );
}
