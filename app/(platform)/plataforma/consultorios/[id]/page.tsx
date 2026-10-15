import { notFound } from "next/navigation";
import { loadTenantDetail } from "@/components/plataforma/tenants/load-detail";
import { getTenantTeamForPlatform } from "@/lib/platform-team-read";
import { TenantSummaryView } from "@/components/plataforma/tenants/tenant-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consultorio · Plataforma · KineSoft" };

/**
 * /plataforma/consultorios/[id] — pestaña «Resumen» (BO3-B; antes, EV0 · EV-P3, era la página entera). El header y
 * las pestañas los pone `layout.tsx`. El cupo usado sale de `getTenantTeamForPlatform` (BO2-B): solo se toman los
 * `seats`; los miembros los muestra la pestaña Equipo.
 */
export default async function PlataformaConsultorioPage({ params }: { params: { id: string } }) {
  const [detail, team] = await Promise.all([loadTenantDetail(params.id), getTenantTeamForPlatform(params.id)]);
  if (!detail) notFound();
  return <TenantSummaryView detail={detail} seats={team?.seats ?? null} />;
}
