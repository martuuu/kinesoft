import { notFound } from "next/navigation";
import { loadTenantDetail } from "@/components/plataforma/tenants/load-detail";
import { TenantDetailHeader } from "@/components/plataforma/tenants/tenant-header";

export const dynamic = "force-dynamic";

/**
 * /plataforma/consultorios/[id] — layout del detalle (BO3-B, contrato B ↔ C del brief BO3): header con estado,
 * «Entrar como soporte» y las pestañas Resumen · Suscripción · Equipo (BO3-C) · Ciclo de vida · Actividad; cada
 * pestaña es su `page.tsx`.
 *
 * `getPlatformTenantDetail` re-chequea superadmin (el guard del layout de `(platform)` es UX) y devuelve null para
 * un id inexistente o mal formado → 404 para TODAS las pestañas, también la de Equipo.
 */
export default async function ConsultorioDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { id: string };
}) {
  const detail = await loadTenantDetail(params.id);
  if (!detail) notFound();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <TenantDetailHeader detail={detail} />
      {children}
    </div>
  );
}
