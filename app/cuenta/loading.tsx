import { AuthShell } from "@/components/auth/auth-shell";
import { PageSkeleton, Skel } from "@/components/ui/skeleton";

/**
 * Esqueleto de /cuenta/* (HD-8): `/cuenta/seguridad` y `/cuenta/perfil-publico` se pintan en `AuthShell centered`
 * (eyebrow + h1 + bajada + bloque de ajustes), así que el esqueleto usa el mismo shell para que no salte el layout al
 * llegar la página. Server component liviano: sin framer ni client (lo mismo que pide `pf0c-loading`).
 */
export default function CuentaLoading() {
  return (
    <AuthShell variant="centered" introAs="p">
      <PageSkeleton label="Cargando tu cuenta">
        <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skel w={90} h={11} />
          <Skel w="70%" h={26} />
          <Skel w="100%" h={12} />
          <Skel w="85%" h={12} />
        </div>
        <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 6 }}>
          <Skel w="100%" h={56} r={12} />
          <Skel w="100%" h={56} r={12} />
          <Skel w={140} h={40} r={999} />
        </div>
      </PageSkeleton>
    </AuthShell>
  );
}
