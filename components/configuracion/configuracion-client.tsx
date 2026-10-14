"use client";

import { useCallback, useState } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { Role } from "@prisma/client";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import type { InsurerRow } from "@/lib/insurers-types";
import type { ServiceRow } from "@/lib/services-types";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { TenantSettings } from "@/lib/tenant-settings";
import type { TenantModule } from "@/lib/tenant-modules";
import type { LocationRow } from "@/lib/locations-schemas";
import type { RoomRow } from "@/lib/rooms-types";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";
import { TabsBar, type Tab } from "./controls";
import { GeneralPanel } from "./panels/general-panel";
import { ServicesPanel } from "./panels/services-panel";
import { InsurersPanel } from "./panels/insurers-panel";
import { DiagnosticosPanel } from "./panels/diagnosticos-panel";
import { UsersPanel } from "./panels/users-panel";
import { LocationsPanel } from "./panels/locations-panel";
import { PractitionerPanel } from "./panels/practitioners/practitioner-panel";

type Props = {
  role: Role;
  /** Módulos del consultorio (EV0): esconden pestañas sin módulo (solo UI). */
  modules: TenantModule[];
  tenant: TenantSettings;
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
};

export function ConfiguracionClient(props: Props) {
  const [tab, setTabRaw] = useState<Tab>("general");
  // B3.4: Servicios/Coberturas de un profesional se editan en línea (no en
  // Drawer); cambiar de pestaña desmonta el editor y perdía lo cargado.
  const [practitionerDirty, setPractitionerDirty] = useState(false);
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
    },
    [tab, practitionerDirty, confirm]
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <EyebrowLabel tone="accent">Panel del consultorio</EyebrowLabel>
        <h1 className="k-display" style={{ fontSize: 28, margin: "6px 0 0", letterSpacing: "-0.02em" }}>
          Configuración
        </h1>
      </header>

      <TabsBar tab={tab} setTab={(t) => void setTab(t)} role={props.role} modules={props.modules} />

      {tab === "general" && <GeneralPanel tenant={props.tenant} role={props.role} />}
      {tab === "sedes" && <LocationsPanel locations={props.locations} rooms={props.rooms} />}
      {tab === "profesionales" && (
        <PractitionerPanel
          summary={props.scheduleSummary}
          locations={props.locations}
          rooms={props.rooms}
          onDirtyChange={setPractitionerDirty}
        />
      )}
      {tab === "servicios" && (
        <ServicesPanel services={props.services} practitioners={props.practitioners} />
      )}
      {tab === "obras-sociales" && <InsurersPanel insurers={props.insurers} />}
      {tab === "diagnosticos" && props.modules.includes("diagnostico") && <DiagnosticosPanel conditions={props.customConditions} />}
      {tab === "usuarios" && (props.role === "OWNER" || props.role === "ADMIN") && (
        <UsersPanel team={props.team} pending={props.pending} viewerRole={props.role} />
      )}
    </div>
  );
}
