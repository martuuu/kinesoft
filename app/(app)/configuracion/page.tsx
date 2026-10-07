import { redirect } from "next/navigation";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { getCapabilities, getMembershipRole } from "@/lib/authz";
import { getTenantSettings } from "@/lib/tenant-settings";
import { modulesFor } from "@/lib/tenant-modules";
import { listInsurers } from "@/lib/insurers";
import { listServicesWithCounts } from "@/lib/services";
import { listTeamMembers, listPendingInvitations } from "@/lib/invitations";
import { listCustomConditions } from "@/lib/conditions";
import { listLocations } from "@/lib/locations";
import { getPractitionerScheduleSummary } from "@/lib/practitioner-schedule";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuración · KineSoft" };

/**
 * /configuracion — Subscriber control panel.
 *
 * Restricted to OWNER + ADMIN. PRACTITIONER users get a redirect to
 * /dashboard since they can't act on any of these forms anyway (the
 * server actions also enforce role independently).
 */
export default async function ConfiguracionPage() {
  const actor = await getActor();
  // B1.7: rol desde `lib/authz` (cacheado por request) y criterio de
  // `lib/capabilities`: el mismo que exigen las actions (`requireTenantAdmin`).
  const role = await getMembershipRole(actor);
  if (!role || !(await getCapabilities()).has("tenant.admin")) {
    redirect("/dashboard");
  }

  const [
    tenant,
    insurers,
    services,
    team,
    pending,
    practitioners,
    customConditions,
    locations,
    scheduleSummary,
  ] = await Promise.all([
    getTenantSettings(),
    listInsurers(),
    listServicesWithCounts(),
    listTeamMembers(),
    listPendingInvitations(),
    runWithRls(actor.tenantId, (tx) =>
      tx.practitioner.findMany({
        // Solo miembros con la invitación aceptada: un profesional removido
        // (membresía borrada) conserva su fila Practitioner y seguía en los
        // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts).
        where: {
          tenantId: actor.tenantId,
          user: { memberships: { some: { tenantId: actor.tenantId, acceptedAt: { not: null } } } },
        },
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: "asc" },
      })
    ),
    listCustomConditions(),
    // B3.4: pestañas Sedes y Profesionales. Archivadas incluidas: el panel
    // de Sedes las lista aparte para poder restaurarlas.
    listLocations({ includeArchived: true }),
    getPractitionerScheduleSummary(),
  ]);

  // EV0 (EV-K): los módulos salen de `actor.entitlements` (C-EV3, sin query
  // extra) y viajan como array (props serializables). Se pasan por props y no
  // por el contexto de módulos del shell para no depender de que esté montado.
  const modules = [...modulesFor(actor.entitlements)];

  return (
    <ConfiguracionClient
      role={role}
      modules={modules}
      tenant={tenant}
      insurers={insurers}
      services={services}
      team={team}
      pending={pending}
      practitioners={practitioners.map((p) => ({
        id: p.id,
        name: p.user.fullName ?? p.user.email,
      }))}
      customConditions={customConditions}
      locations={locations}
      scheduleSummary={scheduleSummary}
    />
  );
}
