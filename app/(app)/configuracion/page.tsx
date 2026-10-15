import { displayMemberName } from "@/lib/display-name";
import { redirect } from "next/navigation";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, getAccessSnapshot, getActor } from "@/lib/session";
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
import { getBillingOverview } from "@/lib/saas-billing";
import { getPublicPlanCatalog } from "@/lib/saas-plans-public";
import { canWrite, effectiveMode } from "@/lib/tenant-access";
import { tenantAccessEnforcement } from "@/lib/env";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import type { PlanChoice } from "@/components/configuracion/panels/plan-change-drawer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuración · KineSoft" };

/**
 * Lecturas que el server puede negar por permiso: `null` en vez de un 500 de la página. Solo `ForbiddenError` (la
 * barrera de cada lectura decide; acá no se adivina): cualquier otro error sigue subiendo.
 */
async function unlessForbidden<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch (err) {
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

/**
 * /configuracion — panel del consultorio.
 *
 * PL-F1b: se abre para CUALQUIER miembro del consultorio (decisión de Martin, 16-oct: «profesionales también, porque
 * pueden necesitar ayuda con algo»). Antes (PL-3a) exigía `tenant.admin` o `account.billing` y redirigía al resto.
 * Las pestañas salen de las capacidades (`ConfigTabAccess`), no del rol: un Profesional sin delegaciones ve solo
 * «Soporte» (Mensajes + Accesos de soporte). Cada lectura se pide solo si la pestaña se puede ver: quien no tiene
 * «Configuración» no baja sedes, servicios ni equipo (y esas lecturas lo rechazarían). Las actions exigen lo suyo igual.
 */
export default async function ConfiguracionPage({
  searchParams,
}: {
  searchParams?: { tab?: string | string[]; tenant?: string | string[] };
}) {
  const actor = await getActor();
  // B1.7: rol desde `lib/authz` (cacheado por request) y criterio de `lib/capabilities`.
  const role = await getMembershipRole(actor);
  const caps = await getCapabilities();
  const tenantAdmin = caps.has("tenant.admin");
  const billing = caps.has("account.billing");
  if (!role) {
    redirect("/dashboard");
  }

  const none = <T,>(v: T) => Promise.resolve(v);
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
    billingOverview,
    catalog,
  ] = await Promise.all([
    tenantAdmin ? getTenantSettings() : none(null),
    tenantAdmin ? listInsurers() : none([]),
    tenantAdmin ? listServicesWithCounts() : none([]),
    // Usuarios: `requireTeamManager` (lib/invitations.ts) exige `tenant.admin` desde PL-3b, la misma capacidad que gatea
    // esta lectura; si igual la rechaza (p. ej. el soporte con otra matriz), sin pestaña y sin 500.
    tenantAdmin ? unlessForbidden(() => listTeamMembers()) : none(null),
    tenantAdmin ? unlessForbidden(() => listPendingInvitations()) : none(null),
    tenantAdmin
      ? runWithRls(actor.tenantId, (tx) =>
          tx.practitioner.findMany({
            // Solo miembros con la invitación aceptada: un profesional removido
            // (membresía borrada) conserva su fila Practitioner y seguía en los
            // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts):
            // IAM-2e, solo roles clínicos sin suspender (la Secretaria no atiende).
            where: bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
            include: { user: { select: { fullName: true, email: true } } },
            orderBy: { createdAt: "asc" },
          })
        )
      : none([]),
    tenantAdmin ? listCustomConditions() : none([]),
    // B3.4: pestañas Sedes y Profesionales. Archivadas incluidas: el panel
    // de Sedes las lista aparte para poder restaurarlas.
    tenantAdmin ? listLocations({ includeArchived: true }) : none([]),
    tenantAdmin ? getPractitionerScheduleSummary() : none([]),
    // SR-U1: salas de todas las sedes, archivadas incluidas (el panel de Sedes
    // las muestra por sede y las archivadas aparte). `includeArchived` exige
    // `schedule.configure`: si la matriz cambia, mejor una lista vacía que un 500 de la página.
    caps.has("schedule.configure") ? listRooms({ includeArchived: true }) : none([]),
    // «Plan y uso»: `getTenantPlanUsage` acepta `account.billing` o `tenant.admin` (PL-3), así que quien tiene solo
    // «Planes y pagos» también ve el desglose de cupos.
    billing ? unlessForbidden(() => getTenantPlanUsage()) : none(null),
    // BO3-F: «Accesos de soporte». PL-F1b: la lee cualquier miembro; el soporte no (la lectura lo rechaza igual).
    !actor.support ? unlessForbidden(() => listSupportSessionsForTenant()) : none(null),
    // PL-3a: Facturación y el drawer de cambio de plan (`requireAccountBilling`).
    billing ? getBillingOverview() : none(null),
    billing ? getPublicPlanCatalog() : none([]),
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

  // PL-3a: el modo EFECTIVO (el mismo de `assertWritable`): con enforcement `banner` no hay modo lectura real.
  const readOnly = !actor.support && !canWrite(effectiveMode(actor.access.mode, tenantAccessEnforcement()));

  // Precios y cupos de cada plan para el drawer (C-PL2; nunca tira: sin base, `[]` y el drawer usa los defaults).
  const planChoices: PlanChoice[] = catalog.map((p) => ({
    plan: p.plan,
    label: p.label,
    priceLabel: p.priceLabel,
    period: p.period,
    limitsLabel: p.limitsLabel,
  }));

  return (
    <ConfiguracionClient
      role={uiRole}
      support={!!actor.support}
      access={{ tenantAdmin, billing, team: team !== null && pending !== null }}
      initialTab={Array.isArray(searchParams?.tab) ? searchParams?.tab[0] : searchParams?.tab}
      planUsage={planUsage}
      billingOverview={billingOverview}
      planChoices={planChoices}
      vertical={actor.entitlements.vertical}
      readOnly={readOnly}
      exportBlocked={exportBlocked}
      exportRequestedTenantId={rawTenant?.trim().slice(0, 64) || null}
      supportSessions={supportSessions}
      modules={modules}
      tenant={tenant}
      insurers={insurers}
      services={services}
      team={team ?? []}
      pending={pending ?? []}
      practitioners={practitioners.map((p) => ({
        id: p.id,
        name: displayMemberName(p.user.fullName),
      }))}
      customConditions={customConditions}
      locations={locations}
      rooms={rooms}
      scheduleSummary={scheduleSummary}
    />
  );
}
