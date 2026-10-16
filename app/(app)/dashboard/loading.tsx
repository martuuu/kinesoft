import { PageSkeleton, Skel, SkelCard, SkelCards, SkelHeader } from "@/components/ui/skeleton";
import styles from "@/components/dashboard/dashboard.module.css";

/**
 * Esqueleto del tablero (PF-0c): columna principal (indicadores fijados + gráfico y últimas sesiones) y el aside de
 * 320 px (calendario, próximos turnos). Misma grilla que `DashboardScreen` para que al llegar los datos no salte.
 * PF1.1-dashboard: usa las MISMAS clases del CSS Module (aside de 280 en tablero angosto, una columna bajo 768) en vez
 * de la grilla inline + `.k-skel-aside` (que escondía el aside bajo 900 y el tablero real no).
 */
export default function DashboardLoading() {
  return (
    <PageSkeleton label="Cargando el tablero">
      <div className={styles.root}>
        <div className={styles.main}>
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
        <div className={styles.aside}>
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
