import { PageHeader } from "@/components/ui/page-header";
import { getPlatformOverview } from "@/lib/platform-tenants-read";
import { PlatformOverviewView } from "@/components/plataforma/tenants/tenant-overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resumen · Plataforma · KineSoft" };

/**
 * /plataforma — Resumen (EV0 · EV-P3, plan §15.4). Antes de EV0 `/plataforma`
 * no tenía página propia (la nav iba directo a Ejercicios); la sub-nav de EV-P2
 * apunta "Resumen" acá.
 *
 * El guard de superadmin vive en `app/(platform)/layout.tsx`, y `getPlatformOverview`
 * lo re-chequea (cruza todos los tenants por el canal service).
 */
export default async function PlataformaResumenPage() {
  const overview = await getPlatformOverview();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Resumen"
        description={
          <>
            Cómo están los consultorios: por tipo y plan, trials que vencen y altas que no terminaron el onboarding.
          </>
        }
      />
      <PlatformOverviewView overview={overview} />
    </div>
  );
}
