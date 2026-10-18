import { PageSkeleton, Skel, SkelCard, SkelHeader } from "@/components/ui/skeleton";

/**
 * [AS-3h] Esqueleto propio de Ocupación: sin este archivo la ruta heredaba el de /agenda (`../loading.tsx`, la grilla
 * con la navegación de semana), que no se parece a lo que llega. Encabezado, pestañas, filtros y una tabla.
 */
export default function AgendaOccupancyLoading() {
  return (
    <PageSkeleton label="Cargando la ocupación">
      <SkelHeader actions={1} titleW={160} />
      <div style={{ display: "flex", gap: 8 }}>
        <Skel w={120} h={40} r={999} />
        <Skel w={120} h={40} r={999} />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Skel w={180} h={44} r={10} />
        <Skel w={160} h={44} r={10} />
        <Skel w={64} h={44} r={10} />
      </div>
      <SkelCard pad={14} style={{ minHeight: 420 }}>
        <Skel w={320} h={14} />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <div key={row} style={{ display: "grid", gridTemplateColumns: "48px repeat(6, minmax(0, 1fr))", gap: 4 }}>
            <Skel w={36} h={10} style={{ marginTop: 8 }} />
            {[0, 1, 2, 3, 4, 5].map((d) => (
              <Skel key={d} h={28} r={6} style={{ opacity: (row + d) % 3 === 0 ? 1 : 0.45 }} />
            ))}
          </div>
        ))}
      </SkelCard>
    </PageSkeleton>
  );
}
