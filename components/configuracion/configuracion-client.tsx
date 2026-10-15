"use client";

import { useCallback, useState } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { Role, TenantVertical } from "@prisma/client";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import type { InsurerRow } from "@/lib/insurers-types";
import type { ServiceRow } from "@/lib/services-types";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { TenantSettings } from "@/lib/tenant-settings";
import type { TenantModule } from "@/lib/tenant-modules";
import type { LocationRow } from "@/lib/locations-schemas";
import type { RoomRow } from "@/lib/rooms-types";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";
import type { SupportSessionRow } from "@/lib/support-session-internal";
import type { TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";
import type { BillingOverview } from "@/lib/saas-billing-types";
import { StepUpProvider } from "@/components/account/step-up-modal";
import { TabsBar, initialConfigTab, visibleConfigTabs, type ConfigTabAccess, type Tab } from "./controls";
import { GeneralPanel } from "./panels/general-panel";
import { ServicesPanel } from "./panels/services-panel";
import { InsurersPanel } from "./panels/insurers-panel";
import { DiagnosticosPanel } from "./panels/diagnosticos-panel";
import { UsersPanel } from "./panels/users-panel";
import { LocationsPanel } from "./panels/locations-panel";
import { PractitionerPanel } from "./panels/practitioners/practitioner-panel";
import { PlanUsagePanel } from "./panels/plan-usage-panel";
import { SupportAccessPanel } from "./panels/support-access-panel";
import { SupportMessagesPanel, type SupportDraft } from "./panels/support-messages-panel";
import { BillingPanel } from "./panels/billing-panel";
import type { PlanChoice } from "./panels/plan-change-drawer";
import { ExportPanel, type ExportBlockedTenant } from "./panels/export-panel";

type Props = {
  role: Role;
  /**
   * PL-3a: qué pestañas ve, por CAPACIDAD (C-PL5): `tenantAdmin` = «Configuración», `billing` = «Planes y pagos»,
   * `team` = la página pudo leer el equipo. `canExport` lo calcula este componente (BO5-C / BO-Z B6).
   */
  access: Omit<ConfigTabAccess, "canExport">;
  /** Módulos del consultorio (EV0): esconden pestañas sin módulo (solo UI). */
  modules: TenantModule[];
  /** null si no tiene «Configuración» (solo «Planes y pagos»): no ve General. */
  tenant: TenantSettings | null;
  insurers: InsurerRow[];
  services: ServiceRow[];
  team: TeamMemberRow[];
  pending: InvitationRow[];
  practitioners: { id: string; name: string }[];
  customConditions: import("@/lib/conditions").CustomConditionRow[];
  /** Todas las sedes, archivadas incluidas (B3.4). */
  locations: LocationRow[];
  /** Todas las salas, archivadas incluidas (SR-U1): se muestran dentro de cada sede. */
  rooms: RoomRow[];
  scheduleSummary: PractitionerScheduleSummaryRow[];
  /** Plan y uso (`account.billing`). null = la lectura de cupos no lo dejó pasar (se muestra sin el desglose). */
  planUsage: TenantPlanUsageView | null;
  /** PL-3a: Facturación (`getBillingOverview`); null sin `account.billing`. */
  billingOverview?: BillingOverview | null;
  /** PL-3a: precios y cupos de cada plan (catálogo C-PL2) para el drawer de cambio de plan. */
  planChoices?: PlanChoice[];
  vertical?: TenantVertical;
  /** PL-3a: el consultorio está en modo lectura (modo efectivo): «Plan y uso» lo dice. */
  readOnly?: boolean;
  /**
   * BO3-F: Configuración → Accesos de soporte. PL-F1b: la lee cualquier miembro; null = no se pudo leer (el
   * superadmin «como soporte», o el server la rechazó): sin la tarjeta.
   */
  supportSessions: SupportSessionRow[] | null;
  /**
   * BO3-F: el que mira es un superadmin «como soporte». `role` llega como ADMIN (los límites con que el server lo
   * deja gestionar el equipo, lib/invitations.ts) y esto apaga lo que el server no le deja: la vista compartida de la
   * HC y las preferencias personales (su sesión es de solo lectura fuera de Configuración).
   */
  support?: boolean;
  /** `?tab=` de la URL (el mail de soporte abre «Accesos de soporte»). */
  initialTab?: string;
  /** BO-Z B6: consultorios bloqueados de los que es titular (export desde acá). */
  exportBlocked?: ExportBlockedTenant[];
  /** BO-Z B6: `?tenant=` de la URL (link del mail de pedido de export). */
  exportRequestedTenantId?: string | null;
};

export function ConfiguracionClient(props: Props) {
  const exportBlocked = props.exportBlocked ?? [];
  // BO5-C: solo el titular; soporte (que llega como ADMIN) nunca baja PHI (plan §19.5). BO-Z B6: también quien es
  // titular de un consultorio suspendido aunque en el activo sea ADMIN (ve solo el botón del suspendido).
  const canExport = !props.support && (props.role === "OWNER" || exportBlocked.length > 0);
  const access: ConfigTabAccess = { ...props.access, canExport };
  const visible = visibleConfigTabs(access, props.modules);
  const [tab, setTabRaw] = useState<Tab>(() => initialConfigTab(props.initialTab, visible));
  // B3.4: Servicios/Coberturas de un profesional se editan en línea (no en
  // Drawer); cambiar de pestaña desmonta el editor y perdía lo cargado.
  const [practitionerDirty, setPractitionerDirty] = useState(false);
  // PL-3a: «Consultanos» del plan Libre abre Soporte con un mensaje prellenado.
  const [supportDraft, setSupportDraft] = useState<SupportDraft | null>(null);
  const confirm = useConfirm();
  const setTab = useCallback(
    async (t: Tab) => {
      if (t === tab) return;
      if (practitionerDirty) {
        const ok = await confirm({
          title: "¿Descartar los cambios sin guardar?",
          message: "Tenés cambios sin guardar en Profesionales. Si cambiás de pestaña, se pierden.",
          tone: "danger",
          confirmLabel: "Descartar",
          cancelLabel: "Seguir editando",
        });
        if (!ok) return;
        setPractitionerDirty(false);
      }
      setTabRaw(t);
      // Que la URL siga a la pestaña: un refresh (o el link copiado) vuelve a la misma. `replaceState` y no el router:
      // cambiar de pestaña no tiene que re-renderizar el server ni sumar entradas al historial.
      try {
        const url = new URL(window.location.href);
        if (t === "general") url.searchParams.delete("tab");
        else url.searchParams.set("tab", t);
        window.history.replaceState(window.history.state, "", url);
      } catch {
        /* sin history: la pestaña vale igual */
      }
    },
    [tab, practitionerDirty, confirm]
  );
  const can = (t: Tab) => visible.includes(t);
  // «Accesos de soporte»: PL-F1b (decisión de Martin, 16-oct), cualquier miembro, si la página pudo leerlos. Antes
  // era solo Titular y Administrador/a; ahora el filtro es solo el del server (`listSupportSessionsForTenant`).
  const supportAccessVisible = props.supportSessions !== null;
  const overview = props.billingOverview ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <EyebrowLabel tone="accent">Panel del consultorio</EyebrowLabel>
        <h1 className="k-display" style={{ fontSize: 28, margin: "6px 0 0", letterSpacing: "-0.02em" }}>
          Configuración
        </h1>
      </header>

      <TabsBar tab={tab} setTab={(t) => void setTab(t)} access={access} modules={props.modules} />

      {tab === "general" && can("general") && props.tenant && (
        <GeneralPanel tenant={props.tenant} role={props.role} support={props.support} />
      )}
      {tab === "sedes" && can("sedes") && <LocationsPanel locations={props.locations} rooms={props.rooms} />}
      {tab === "profesionales" && can("profesionales") && (
        <PractitionerPanel
          summary={props.scheduleSummary}
          locations={props.locations}
          rooms={props.rooms}
          onDirtyChange={setPractitionerDirty}
          team={props.team}
        />
      )}
      {tab === "servicios" && can("servicios") && (
        <ServicesPanel services={props.services} practitioners={props.practitioners} />
      )}
      {tab === "obras-sociales" && can("obras-sociales") && <InsurersPanel insurers={props.insurers} />}
      {tab === "diagnosticos" && can("diagnosticos") && <DiagnosticosPanel conditions={props.customConditions} />}
      {tab === "usuarios" && can("usuarios") && (
        <UsersPanel team={props.team} pending={props.pending} viewerRole={props.role} seats={props.planUsage?.seats} />
      )}
      {tab === "plan" && can("plan") && overview && (
        // PL-D11: cambiar de plan pide step-up; el provider monta el modal del código (o el aviso de activar la 2FA).
        <StepUpProvider>
          <PlanUsagePanel
            usage={props.planUsage}
            overview={overview}
            modules={props.modules}
            choices={props.planChoices ?? []}
            vertical={props.vertical}
            readOnly={!!props.readOnly}
            onContactSales={(draft) => {
              setSupportDraft(draft);
              void setTab("soporte");
            }}
            onGoToBilling={() => void setTab("facturacion")}
          />
        </StepUpProvider>
      )}
      {tab === "facturacion" && can("facturacion") && overview && <BillingPanel initial={overview} />}
      {tab === "soporte" && can("soporte") && (
        // PL-2d (C-PL11): la pestaña «Soporte» junta los Mensajes con el equipo de KineSoft y los Accesos de soporte.
        // PL-F1b: Mensajes y Accesos para cualquier miembro (antes PL-D20: `tenant.admin || account.billing`).
        <div style={{ display: "grid", gap: 16 }}>
          <SupportMessagesPanel support={props.support} draft={supportDraft} onDraftUsed={() => setSupportDraft(null)} />
          {supportAccessVisible && <SupportAccessPanel sessions={props.supportSessions ?? []} />}
        </div>
      )}
      {tab === "exportar" && can("exportar") && (
        <ExportPanel
          blocked={exportBlocked}
          requestedTenantId={props.exportRequestedTenantId}
          showActive={props.role === "OWNER"}
        />
      )}
    </div>
  );
}
