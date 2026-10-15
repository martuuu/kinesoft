import { redirect } from "next/navigation";
import { runWithRls } from "@/lib/rls";
import { getAccessSnapshot, getActor } from "@/lib/session";
import { getCapabilities, getMembershipRole } from "@/lib/authz";
import { getTenantSettings } from "@/lib/tenant-settings";
import { modulesFor } from "@/lib/tenant-modules";
import { listInsurers } from "@/lib/insurers";
import { listServicesWithCounts } from "@/lib/services";
import { listTeamMembers, listPendingInvitations } from "@/lib/invitations";
import { listCustomConditions } from "@/lib/conditions";
import { listLocations } from "@/lib/locations";
import { listRooms } from "@/lib/rooms";
import { getPractitionerScheduleSummary } from "@/lib/practitioner-schedule";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { listSupportSessionsForTenant } from "@/lib/platform-support";
import { getTenantPlanUsage } from "@/lib/tenant-plan-usage";
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
export default async function ConfiguracionPage({
  searchParams,
}: {
  searchParams?: { tab?: string | string[]; tenant?: string | string[] };
}) {
  const actor = await getActor();
  // B1.7: rol desde `lib/authz` (cacheado por request) y criterio de
  // `lib/capabilities`: el mismo que exigen las actions (`requireTenantAdmin`).
  const role = await getMembershipRole(actor);
  const caps = await getCapabilities();
  if (!role || !caps.has("tenant.admin")) {
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
    rooms,
    planUsage,
    supportSessions,
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
        // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts):
        // IAM-2e, solo roles clínicos sin suspender (la Secretaria no atiende).
        where: bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: "asc" },
      })
    ),
    listCustomConditions(),
    // B3.4: pestañas Sedes y Profesionales. Archivadas incluidas: el panel
    // de Sedes las lista aparte para poder restaurarlas.
    listLocations({ includeArchived: true }),
    getPractitionerScheduleSummary(),
    // SR-U1: salas de todas las sedes, archivadas incluidas (el panel de Sedes
    // las muestra por sede y las archivadas aparte). `includeArchived` exige
    // `schedule.configure`; hoy `tenant.admin` lo implica (OWNER/ADMIN), pero
    // si la matriz cambia, mejor una lista vacía que un 500 de la página.
    caps.has("schedule.configure") ? listRooms({ includeArchived: true }) : Promise.resolve([]),
    // BO3-F: «Plan y uso» y «Accesos de soporte». Las dos exigen `tenant.admin`, que el `redirect` de arriba ya
    // garantizó (también el soporte, con SUPPORT_CAPS).
    getTenantPlanUsage(),
    listSupportSessionsForTenant(),
  ]);

  // BO3-F: el soporte entra con `getMembershipRole` = ASSISTANT (su nivel de lectura clínica), que en la UI le
  // apagaba horarios, turnero y la pestaña Usuarios aunque el server se los deja (allowlist `withSupportWritable`,
  // C-BO4; en el equipo, con los límites del ADMIN: lib/invitations.ts `requireTeamManager`). Para la pantalla
  // se lo trata como ADMIN; lo que el server le niega igual (vista compartida de la HC) lo apaga `support`.
  const uiRole = actor.support ? "ADMIN" : role;

  // EV0 (EV-K): los módulos salen de `actor.entitlements` (C-EV3, sin query
  // extra) y viajan como array (props serializables). Se pasan por props y no
  // por el contexto de módulos del shell para no depender de que esté montado.
  const modules = [...modulesFor(actor.entitlements)];

  // [BO-Z B6] Consultorios suspendidos/dados de baja de los que es titular (misma foto del request que usó el gate:
  // sin query extra). El soporte no baja PHI: lista vacía. `?tenant=` viene del mail de Plataforma.
  const snapshot = actor.support ? null : await getAccessSnapshot();
  const exportBlocked = (snapshot?.tenantBlocks ?? [])
    .filter((b) => b.role === "OWNER")
    .map((b) => ({ tenantId: b.tenantId, tenantName: b.tenantName, kind: b.kind }));
  const rawTenant = Array.isArray(searchParams?.tenant) ? searchParams?.tenant[0] : searchParams?.tenant;

  return (
    <ConfiguracionClient
      role={uiRole}
      support={!!actor.support}
      initialTab={Array.isArray(searchParams?.tab) ? searchParams?.tab[0] : searchParams?.tab}
      planUsage={planUsage}
      exportBlocked={exportBlocked}
      exportRequestedTenantId={rawTenant?.trim().slice(0, 64) || null}
      supportSessions={supportSessions}
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
      rooms={rooms}
      scheduleSummary={scheduleSummary}
    />
  );
}
