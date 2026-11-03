import { redirect } from "next/navigation";
import { getActor } from "@/lib/session";
import { getCapabilities, getMembershipRole } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { canWrite, effectiveMode } from "@/lib/tenant-access";
import { tenantAccessEnforcement, webPushVapid } from "@/lib/env";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import type { PlanChoice } from "@/components/configuracion/panels/plan-change-drawer";
import { supportDraftFromNuevo } from "@/components/configuracion/panels/support-draft-logic";
import { MP_CONNECT_RETURNS, type MpConnectReturn } from "@/lib/mp-connect-types";

export const dynamic = "force-dynamic";

/**
 * TP-3a: `?mp=` con el que vuelve el callback OAuth de Mercado Pago (`/api/mp/oauth/callback`). Solo los valores del
 * contrato; cualquier otra cosa (un link armado a mano) no muestra aviso.
 */
function parseMpReturn(raw: string | string[] | undefined): MpConnectReturn | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (MP_CONNECT_RETURNS as readonly string[]).includes(v ?? "") ? (v as MpConnectReturn) : null;
}
export const metadata = { title: "Configuración" };

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
  searchParams?: { tab?: string | string[]; tenant?: string | string[]; mp?: string | string[]; nuevo?: string | string[] };
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

  const loaded = await loadConfiguracionPage(actor, caps);
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
    fichas,
    logo,
    onlinePayments,
    myMp,
    previewServicePriceCents,
    whatsapp,
    miAgenda,
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

  // PV (TK-U3): `?nuevo=<motivo>` (banda de acceso, «Consultanos», `/contacto` con sesión) → «Nuevo mensaje» con
  // borrador y origen. Siempre en Soporte aunque falte `tab=soporte` (es lo único que `nuevo` puede querer decir). El
  // superadmin «como soporte» no escribe a Plataforma: sin borrador (el panel tampoco lo abriría).
  const supportDraft = actor.support ? null : supportDraftFromNuevo(searchParams?.nuevo);
  const rawTab = Array.isArray(searchParams?.tab) ? searchParams?.tab[0] : searchParams?.tab;

  return (
    <ConfiguracionClient
      role={uiRole}
      support={!!actor.support}
      // T3 (C-AS1): `sensitive` = `tenant.sensitive` (lo delicado de Configuración) para que la UI se lo esconda a la
      // Secretaria con «Configuración» (T3d-1g; el server ya se lo niega).
      access={{ tenantAdmin, billing, team: team !== null && pending !== null, sensitive }}
      initialTab={supportDraft ? "soporte" : rawTab}
      initialSupportDraft={supportDraft}
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
      // FC-3i: «Mis fichas» y el logo salen de la misma tx del loader (FC-4i).
      fichas={fichas}
      logo={logo}
      // TP-3a: «Cobros online» y «Mi Mercado Pago» salen de la misma tx del loader (§25.11: sin tx nueva).
      onlinePayments={onlinePayments}
      previewServicePriceCents={previewServicePriceCents}
      myMp={myMp}
      mpReturn={parseMpReturn(searchParams?.mp)}
      // WA-U1: pestaña WhatsApp (null = sin `tenant.sensitive` o `WHATSAPP_MODE=off`: la pestaña no aparece).
      whatsapp={whatsapp}
      // CF2 (T.C): «Mi agenda» sale de la misma tx del loader (0 queries nuevas). De VAPID viaja SOLO la clave pública
      // (la que el navegador necesita para `pushManager.subscribe`); la privada y el subject no salen del server.
      miAgenda={miAgenda}
      webPushPublicKey={miAgenda ? webPushVapid()?.publicKey ?? null : null}
    />
  );
}
