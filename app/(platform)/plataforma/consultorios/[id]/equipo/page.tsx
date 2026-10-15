import { notFound } from "next/navigation";
import { getTenantTeamForPlatform } from "@/lib/platform-team-read";
import { loadTenantDetail } from "@/components/plataforma/tenants/load-detail";
import { PlatformTeamPanel } from "@/components/plataforma/team/team-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Equipo · Consultorio · Plataforma · KineSoft" };

/**
 * /plataforma/consultorios/[id]/equipo (BO3-C). Pestaña «Equipo» del detalle: se renderiza dentro del layout con
 * pestañas de `[id]` (BO3-B). Las dos lecturas re-chequean superadmin por su cuenta (`requirePlatformAdmin`) y
 * devuelven null para un id inexistente → 404. El detalle se lee solo por la vertical (etiqueta «Kinesiólogo/a» vs
 * «Profesional», `lib/roles.ts`), que el DTO del equipo no trae; va por `loadTenantDetail` (React `cache`), así reusa
 * la lectura que ya hizo el layout de `[id]` en el mismo request en vez de repetir la query.
 */
export default async function PlataformaConsultorioEquipoPage({ params }: { params: { id: string } }) {
  const [team, detail] = await Promise.all([getTenantTeamForPlatform(params.id), loadTenantDetail(params.id)]);
  if (!team || !detail) notFound();
  return <PlatformTeamPanel team={team} vertical={detail.vertical} />;
}
