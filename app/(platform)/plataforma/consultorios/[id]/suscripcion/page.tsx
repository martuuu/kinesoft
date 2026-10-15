import { notFound } from "next/navigation";
import { loadTenantDetail } from "@/components/plataforma/tenants/load-detail";
import { TenantSubscriptionView } from "@/components/plataforma/tenants/tenant-subscription";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suscripción · Consultorio · Plataforma · KineSoft" };

/** /plataforma/consultorios/[id]/suscripcion — plan, estado, trial, turnos online y cupo a medida (BO3-B). */
export default async function ConsultorioSuscripcionPage({ params }: { params: { id: string } }) {
  const detail = await loadTenantDetail(params.id);
  if (!detail) notFound();
  return <TenantSubscriptionView detail={detail} />;
}
