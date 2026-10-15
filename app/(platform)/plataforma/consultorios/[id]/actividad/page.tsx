import { notFound } from "next/navigation";
import { getPlatformTenantActivity } from "@/lib/platform-tenants-read";
import { TenantActivityView } from "@/components/plataforma/tenants/tenant-activity";

export const dynamic = "force-dynamic";
export const metadata = { title: "Actividad · Consultorio · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /plataforma/consultorios/[id]/actividad — eventos `platform.*` del consultorio, paginados con `?cursor=` (BO3-B).
 * `getPlatformTenantActivity` re-chequea superadmin y descarta un cursor ajeno o mal formado (arranca de cero).
 */
export default async function ConsultorioActividadPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: SearchParams;
}) {
  const raw = searchParams.cursor;
  const cursor = (Array.isArray(raw) ? raw[0] : raw) ?? null;
  const page = await getPlatformTenantActivity(params.id, cursor);
  if (!page) notFound();
  return <TenantActivityView tenantId={params.id} page={page} fromStart={!cursor} />;
}
