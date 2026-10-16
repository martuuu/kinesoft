import { PageHeader } from "@/components/ui/page-header";
import { getPlatformHealth } from "@/lib/platform-health-read";
import { HealthBoard } from "@/components/plataforma/health/health-board";
import { healthSummary } from "@/components/plataforma/health/health-logic";
import { formatDateTimeAR } from "@/components/plataforma/users/users-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Salud · Plataforma · KineSoft" };

/**
 * /plataforma/salud — detectores de cuentas y consultorios rotos con su reparación (BO3-D, plan §19.5; absorbe la
 * «4d» de IAM). Se calcula en cada request (`force-dynamic`): es un tablero de diagnóstico, no algo para cachear.
 * El guard de superadmin está en `app/(platform)/layout.tsx` y `getPlatformHealth` vuelve a llamar a
 * `requirePlatformAdmin`.
 */
export default async function PlataformaSaludPage() {
  const report = await getPlatformHealth();
  const { problems, unavailable } = healthSummary(report);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Salud"
        description={
          <>
            Cuentas y consultorios que quedaron en un estado roto y dejan a alguien afuera. Cada caso tiene su arreglo o
            el link a donde se resuelve.
          </>
        }
      />
      <p style={{ fontSize: "var(--fs-sm)", color: "var(--navy-700)", margin: 0 }}>
        {problems === 0 ? "Sin problemas detectados" : problems === 1 ? "1 caso para revisar" : `${problems} casos para revisar`}
        {unavailable > 0 ? ` · ${unavailable === 1 ? "1 detector no disponible" : `${unavailable} detectores no disponibles`}` : ""}
        <span style={{ color: "var(--navy-400)" }}> · actualizado {formatDateTimeAR(report.generatedAt)}</span>
      </p>
      <HealthBoard report={report} />
    </div>
  );
}
