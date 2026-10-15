import { PageSkeleton, Skel, SkelCard, SkelRows, SkelTabs } from "@/components/ui/skeleton";

/**
 * Esqueleto del perfil del paciente (PF-0c). Propio y no el de la lista: sin este archivo, al entrar a un paciente se
 * veía el esqueleto de `/pacientes` (filas) y después el perfil, con salto. Cabecera con avatar, pestañas y dos
 * columnas de tarjetas.
 */
export default function PacienteLoading() {
  return (
    <PageSkeleton label="Cargando el perfil del paciente">
      <SkelCard pad={20}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Skel w={64} h={64} r={999} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
            <Skel w={240} h={22} style={{ maxWidth: "100%" }} />
            <Skel w={320} h={12} style={{ maxWidth: "100%" }} />
            <div style={{ display: "flex", gap: 6 }}>
              <Skel w={80} h={22} r={999} />
              <Skel w={96} h={22} r={999} />
            </div>
          </div>
          <Skel w={132} h={36} r={999} />
        </div>
      </SkelCard>
      <SkelTabs count={5} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <SkelRows rows={4} toolbar={false} avatar={false} />
        <SkelRows rows={4} toolbar={false} avatar={false} />
      </div>
    </PageSkeleton>
  );
}
