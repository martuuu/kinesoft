import { Card } from "@/components/ui/card";
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
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Sistema
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Qué servicios externos están configurados en este deploy (correo, pagos, errores, tiempo real, cron), las
          migraciones aplicadas y si la base responde. De los secretos se ve solo si están cargados, nunca su valor.
        </p>
      </Card>
      <SystemView status={status} />
    </div>
  );
}
