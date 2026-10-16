"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { Role, TenantVertical } from "@prisma/client";
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
import { PageHeader } from "@/components/ui/page-header";
import { SkelForm } from "@/components/ui/skeleton";
import { TabsBar, initialConfigTab, visibleConfigTabs, type ConfigTabAccess, type Tab } from "./controls";
import type { SupportDraft } from "./panels/support-messages-panel";
import type { PlanChoice } from "./panels/plan-change-drawer";
import type { ExportBlockedTenant } from "./panels/export-panel";

/**
 * [PF1.1-config · C-PF2] Cada pestaña es un chunk aparte (`next/dynamic`). Antes los 12 paneles viajaban en el JS
 * inicial de /configuracion (260,7 kB gz, el más pesado del workspace) aunque se viera uno solo.
 *
 * Con SSR (el default de `dynamic`, a propósito; NO `ssr: false`): la pestaña inicial sale pintada en el HTML del
 * server (sin hueco ni salto, CLS 0, LCP igual que antes) y su chunk no cuenta en el JS inicial de la ruta (no está en
 * `app-build-manifest`, lo que mide `scripts/check-bundle-budget.mjs`). Las otras se bajan al elegirlas; el esqueleto
 * aparece solo si el chunk todavía no llegó, y casi nunca: `preloadConfigTab` lo pide en hover/foco de la pestaña.
 *
 * Cada `import()` va literal dos veces, en `PANEL_LOADERS` (precarga) y en su `dynamic` (render): webpack resuelve las
 * dos al MISMO chunk, y el `import()` literal dentro de `dynamic` deja que Next registre el módulo para precargar el
 * chunk de la pestaña inicial junto con el HTML del server.
 */
const PANEL_LOADERS = {
  general: () => import("./panels/general-panel"),
  sedes: () => import("./panels/locations-panel"),
  profesionales: () => import("./panels/practitioners/practitioner-panel"),
  servicios: () => import("./panels/services-panel"),
  "obras-sociales": () => import("./panels/insurers-panel"),
  diagnosticos: () => import("./panels/diagnosticos-panel"),
  usuarios: () => import("./panels/users-panel"),
  plan: () => import("./panels/plan-tab"),
  facturacion: () => import("./panels/billing-panel"),
  soporte: () => Promise.all([import("./panels/support-messages-panel"), import("./panels/support-access-panel")]),
  exportar: () => import("./panels/export-panel"),
} satisfies Record<Tab, () => Promise<unknown>>;

/** `import()` sin await (C-PF2): deja el chunk de la pestaña en camino antes del click. */
export function preloadConfigTab(t: Tab): void {
  void PANEL_LOADERS[t]().catch(() => {
    /* sin red: el click lo vuelve a intentar y muestra el error de la ruta */
  });
}

/** Mismo alto aproximado que una card de formulario: al cambiar de pestaña la página no colapsa y vuelve a crecer. */
function PanelSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando la pestaña" style={{ minHeight: 420 }}>
      <SkelForm fields={4} />
    </div>
  );
}
// Opciones como literal en cada llamada: el transform de Next pide un objeto literal en el segundo argumento.

const GeneralPanel = dynamic(() => import("./panels/general-panel").then((m) => m.GeneralPanel), { loading: PanelSkeleton });
const LocationsPanel = dynamic(() => import("./panels/locations-panel").then((m) => m.LocationsPanel), { loading: PanelSkeleton });
const PractitionerPanel = dynamic(() => import("./panels/practitioners/practitioner-panel").then((m) => m.PractitionerPanel), { loading: PanelSkeleton });
const ServicesPanel = dynamic(() => import("./panels/services-panel").then((m) => m.ServicesPanel), { loading: PanelSkeleton });
const InsurersPanel = dynamic(() => import("./panels/insurers-panel").then((m) => m.InsurersPanel), { loading: PanelSkeleton });
const DiagnosticosPanel = dynamic(() => import("./panels/diagnosticos-panel").then((m) => m.DiagnosticosPanel), { loading: PanelSkeleton });
const UsersPanel = dynamic(() => import("./panels/users-panel").then((m) => m.UsersPanel), { loading: PanelSkeleton });
const PlanTab = dynamic(() => import("./panels/plan-tab").then((m) => m.PlanTab), { loading: PanelSkeleton });
const BillingPanel = dynamic(() => import("./panels/billing-panel").then((m) => m.BillingPanel), { loading: PanelSkeleton });
const SupportMessagesPanel = dynamic(() => import("./panels/support-messages-panel").then((m) => m.SupportMessagesPanel), { loading: PanelSkeleton });
const SupportAccessPanel = dynamic(() => import("./panels/support-access-panel").then((m) => m.SupportAccessPanel), {
  loading: () => null,
});
const ExportPanel = dynamic(() => import("./panels/export-panel").then((m) => m.ExportPanel), { loading: PanelSkeleton });

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
      <PageHeader eyebrow="Panel del consultorio" title="Configuración" />

      <TabsBar
        tab={tab}
        setTab={(t) => void setTab(t)}
        access={access}
        modules={props.modules}
        onPreload={preloadConfigTab}
      />

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
        // PL-D11: cambiar de plan pide step-up; `PlanTab` monta el provider del modal del código (o el aviso de 2FA).
        <PlanTab
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
