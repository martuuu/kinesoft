import { Card } from "@/components/ui/card";
import { getPlatformOverview } from "@/lib/platform-tenants-read";
import { PlatformOverviewView } from "@/components/plataforma/tenants/tenant-overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resumen · Plataforma · KineSoft" };

/**
 * /plataforma — Resumen (EV0 · EV-P3, plan §15.4). Antes de EV0 `/plataforma`
 * no tenía página propia (la nav iba directo a Ejercicios); la sub-nav de EV-P2
 * apunta "Resumen" acá.
 *
 * El guard de superadmin vive en `plataforma/layout.tsx`, y `getPlatformOverview`
 * lo re-chequea (cruza todos los tenants por el canal service).
 */
export default async function PlataformaResumenPage() {
  const overview = await getPlatformOverview();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Resumen
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Cómo están los consultorios: por tipo y plan, trials que vencen y altas que no terminaron el onboarding.
        </p>
      </Card>
      <PlatformOverviewView overview={overview} />
    </div>
  );
}
