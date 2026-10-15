import { Fragment } from "react";
import { PageSkeleton, Skel, SkelCard, SkelHeader } from "@/components/ui/skeleton";

/**
 * Esqueleto de la agenda (PF-0c): header con navegación de semana y botones, y la grilla (encabezado de días +
 * franjas horarias). La agenda es la pantalla más usada por la Secretaria: el click tiene que responder ya.
 */
export default function AgendaLoading() {
  return (
    <PageSkeleton label="Cargando la agenda">
      <SkelHeader actions={3} titleW={160} />
      <SkelCard pad={14} style={{ minHeight: 520 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Skel w={36} h={32} r={999} />
          <Skel w={180} h={32} r={999} />
          <Skel w={36} h={32} r={999} />
          <span style={{ flex: 1 }} />
          <Skel w={200} h={32} r={999} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "48px repeat(6, minmax(0, 1fr))", gap: 8 }}>
          <span />
          {[0, 1, 2, 3, 4, 5].map((d) => (
            <Skel key={d} h={30} r={10} />
          ))}
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <Fragment key={row}>
              <Skel w={36} h={10} style={{ marginTop: 6 }} />
              {[0, 1, 2, 3, 4, 5].map((d) => (
                <Skel key={d} h={44} r={10} style={{ opacity: (row + d) % 3 === 0 ? 1 : 0.45 }} />
              ))}
            </Fragment>
          ))}
        </div>
      </SkelCard>
    </PageSkeleton>
  );
}
