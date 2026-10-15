import { notFound } from "next/navigation";
import { loadTenantDetail } from "@/components/plataforma/tenants/load-detail";
import { TenantLifecyclePanel } from "@/components/plataforma/tenants/tenant-lifecycle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ciclo de vida · Consultorio · Plataforma · KineSoft" };

/** /plataforma/consultorios/[id]/ciclo-de-vida — suspender, dar de baja, reactivar, slug y fin del alta (BO3-B). */
export default async function ConsultorioCicloDeVidaPage({ params }: { params: { id: string } }) {
  const detail = await loadTenantDetail(params.id);
  if (!detail) notFound();
  return <TenantLifecyclePanel detail={detail} />;
}
