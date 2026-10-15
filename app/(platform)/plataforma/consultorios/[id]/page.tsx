import { notFound } from "next/navigation";
import { getPlatformTenantDetail } from "@/lib/platform-tenants-read";
import { TenantDetailView } from "@/components/plataforma/tenants/tenant-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consultorio · Plataforma · KineSoft" };

/**
 * /plataforma/consultorios/[id] — detalle + Drawer "Editar suscripción" (EV0 ·
 * EV-P3, plan §15.4). `getPlatformTenantDetail` re-chequea superadmin y devuelve
 * null para un id inexistente o mal formado → 404.
 */
export default async function PlataformaConsultorioPage({ params }: { params: { id: string } }) {
  const detail = await getPlatformTenantDetail(params.id);
  if (!detail) notFound();
  return <TenantDetailView detail={detail} />;
}
