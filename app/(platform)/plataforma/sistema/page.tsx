import { PageHeader } from "@/components/ui/page-header";
import { getPlatformSystemStatus } from "@/lib/platform-system-read";
import { SystemView } from "@/components/plataforma/system/system-view";

// Nunca cacheado: es el estado de ESTE deploy y de la base en este momento.
export const dynamic = "force-dynamic";
export const metadata = { title: "Sistema · Plataforma · KineSoft" };

/** BO3-E · El guard del layout es UX; la barrera real es el `requirePlatformAdmin` de `getPlatformSystemStatus`. */
export default async function PlataformaSistemaPage() {
  const status = await getPlatformSystemStatus();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Sistema"
        description={
          <>
            Qué servicios externos están configurados en este deploy (correo, pagos, errores, tiempo real, cron), las
            migraciones aplicadas y si la base responde. De los secretos se ve solo si están cargados, nunca su valor.
          </>
        }
      />
      <SystemView status={status} />
    </div>
  );
}
