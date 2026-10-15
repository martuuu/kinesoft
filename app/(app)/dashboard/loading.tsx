import { PageSkeleton, Skel, SkelCard, SkelCards, SkelHeader } from "@/components/ui/skeleton";

/**
 * Esqueleto del tablero (PF-0c): columna principal (indicadores fijados + gráfico y últimas sesiones) y el aside de
 * 320 px (calendario, próximos turnos). Misma grilla que `DashboardScreen` para que al llegar los datos no salte.
 */
export default function DashboardLoading() {
  return (
    <PageSkeleton label="Cargando el tablero">
      <div style={{ display: "flex", gap: 18, minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <SkelHeader actions={0} titleW={260} />
          <Skel w={160} h={13} />
          <SkelCards count={3} min={180} h={128} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            <SkelCard style={{ minHeight: 260 }}>
              <Skel w={180} h={16} />
              <Skel w="100%" h={190} r={12} />
            </SkelCard>
            <SkelCard style={{ minHeight: 260 }}>
              <Skel w={200} h={16} />
              {[0, 1, 2, 3].map((i) => (
                <Skel key={i} w="100%" h={36} r={10} />
              ))}
            </SkelCard>
          </div>
        </div>
        <div className="k-skel-aside" style={{ width: 320, display: "flex", flexDirection: "column", gap: 14 }}>
          <SkelCard style={{ minHeight: 280 }}>
            <Skel w={140} h={16} />
            <Skel w="100%" h={220} r={12} />
          </SkelCard>
          <SkelCard>
            <Skel w={160} h={16} />
            {[0, 1, 2].map((i) => (
              <Skel key={i} w="100%" h={44} r={12} />
            ))}
          </SkelCard>
        </div>
      </div>
    </PageSkeleton>
  );
}
