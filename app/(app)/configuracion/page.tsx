import { redirect } from "next/navigation";
import { getActor } from "@/lib/session";
import { getCapabilities, getMembershipRole } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { canWrite, effectiveMode } from "@/lib/tenant-access";
import { tenantAccessEnforcement } from "@/lib/env";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import type { PlanChoice } from "@/components/configuracion/panels/plan-change-drawer";
import { runWithRls } from "@/lib/rls";
import { isClinicalMember } from "@/lib/roles-core";
import type { Honorific } from "@/lib/directory-constants";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuración · KineSoft" };

/**
 * /configuracion — panel del consultorio.
 *
 * PL-F1b: se abre para CUALQUIER miembro del consultorio (decisión de Martin, 16-oct: «profesionales también, porque
 * pueden necesitar ayuda con algo»). Antes (PL-3a) exigía `tenant.admin` o `account.billing` y redirigía al resto.
 * Las pestañas salen de las capacidades (`ConfigTabAccess`), no del rol: un Profesional sin delegaciones ve solo
 * «Soporte» (Mensajes + Accesos de soporte). Cada lectura se pide solo si la pestaña se puede ver: quien no tiene
 * «Configuración» no baja sedes, servicios ni equipo (y esas lecturas lo rechazarían). Las actions exigen lo suyo igual.
 *
 * PF2-d (C-PF8): las lecturas van por `loadConfiguracionPage` (lib/configuracion-page-loader.ts): una sola tx para
 * todas las pestañas + los lectores de plata de PL en paralelo (13 → 3 tx para el Titular). Mismo criterio por pestaña.
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

  // FC-3i: en paralelo con el loader (misma regla que su `sensitive`: `tenant.sensitive`, lib/configuracion-page-loader.ts).
  const [loaded, practiceAssets] = await Promise.all([
    loadConfiguracionPage(actor, caps),
    loadPracticeAssetsView(actor, caps.has("tenant.sensitive")),
  ]);
  const {
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
    snapshot,
    directory,
    sensitive,
  } = loaded;
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
  // sin query extra; la pide el loader en paralelo). El soporte no baja PHI: lista vacía. `?tenant=` viene del mail
  // de Plataforma.
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
      // T3 (C-AS1): `sensitive` = `tenant.sensitive` (lo delicado de Configuración) para que la UI se lo esconda a la
      // Secretaria con «Configuración» (T3d-1g; el server ya se lo niega).
      access={{ tenantAdmin, billing, team: team !== null && pending !== null, sensitive }}
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
      practitioners={practitioners}
      customConditions={customConditions}
      locations={locations}
      rooms={rooms}
      scheduleSummary={scheduleSummary}
      directory={directory}
      fichas={practiceAssets.fichas}
      logo={practiceAssets.logo}
    />
  );
}

type Actor = Awaited<ReturnType<typeof getActor>>;

/**
 * FC-3i: lo que necesitan «Mis fichas» (honorífico, matrícula, ¿hay firma?) y el logo de General. Solo flags y
 * `updatedAt` (el CAS de C-FC9): las claves de Storage no viajan al cliente; la vista previa se pide aparte con una URL
 * firmada de 60 s. Una tx chica y SOLO si hace falta: quien no es miembro clínico ni tiene `tenant.sensitive` no la
 * abre. `where: { tenantId }` a mano (en prod la conexión tiene BYPASSRLS).
 *
 * Va acá y no dentro de `loadConfiguracionPage` porque ese archivo no es de FC-3i (handoff al integrador: moverlo a la
 * tx de Configuración deja /configuracion en 1 tx menos para el Titular).
 */
async function loadPracticeAssetsView(actor: Actor, sensitive: boolean) {
  // «Mis fichas» = miembro clínico con `Practitioner` (FC-UI-D3). El soporte nunca (no es miembro).
  const practitionerId = actor.practitionerId;
  const clinical = !actor.support && !!practitionerId && !!actor.membership && isClinicalMember(actor.membership);
  if (!clinical && !sensitive) return { fichas: null, logo: null };
  const { tenantRow, me } = await runWithRls(actor.tenantId, async (tx) => ({
    tenantRow: sensitive
      ? await tx.tenant.findFirst({
          where: { id: actor.tenantId },
          select: { logoStorageKey: true, logoUpdatedAt: true },
        })
      : null,
    me:
      clinical && practitionerId
        ? await tx.practitioner.findFirst({
            where: { id: practitionerId, tenantId: actor.tenantId },
            select: { honorific: true, licenseNumber: true, signatureStorageKey: true, signatureUpdatedAt: true },
          })
        : null,
  }));
  return {
    logo: tenantRow
      ? { has: !!tenantRow.logoStorageKey, updatedAt: tenantRow.logoUpdatedAt?.toISOString() ?? null }
      : null,
    fichas: me
      ? {
          me: {
            honorific: (me.honorific as Honorific | null) ?? null,
            licenseNumber: me.licenseNumber,
            signature: { has: !!me.signatureStorageKey, updatedAt: me.signatureUpdatedAt?.toISOString() ?? null },
          },
          backupScope: { tenantId: actor.tenantId, userId: actor.userId },
        }
      : null,
  };
}
