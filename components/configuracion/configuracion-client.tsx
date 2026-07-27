"use client";

import { useState } from "react";
import type { Role } from "@prisma/client";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import type { InsurerRow } from "@/lib/insurers-types";
import type { ServiceRow } from "@/lib/services-types";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { TenantSettings } from "@/lib/tenant-settings";
import { TabsBar, type Tab } from "./controls";
import { GeneralPanel } from "./panels/general-panel";
import { ServicesPanel } from "./panels/services-panel";
import { InsurersPanel } from "./panels/insurers-panel";
import { DiagnosticosPanel } from "./panels/diagnosticos-panel";
import { UsersPanel } from "./panels/users-panel";

type Props = {
  role: Role;
  tenant: TenantSettings;
  insurers: InsurerRow[];
  services: ServiceRow[];
  team: TeamMemberRow[];
  pending: InvitationRow[];
  practitioners: { id: string; name: string }[];
  customConditions: import("@/lib/conditions").CustomConditionRow[];
};

export function ConfiguracionClient(props: Props) {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <EyebrowLabel tone="accent">Panel del consultorio</EyebrowLabel>
        <h1 className="k-display" style={{ fontSize: 28, margin: "6px 0 0", letterSpacing: "-0.02em" }}>
          Configuración
        </h1>
      </header>

      <TabsBar tab={tab} setTab={setTab} role={props.role} />

      {tab === "general" && <GeneralPanel tenant={props.tenant} role={props.role} />}
      {tab === "servicios" && (
        <ServicesPanel services={props.services} practitioners={props.practitioners} />
      )}
      {tab === "obras-sociales" && <InsurersPanel insurers={props.insurers} />}
      {tab === "diagnosticos" && <DiagnosticosPanel conditions={props.customConditions} />}
      {tab === "usuarios" && props.role === "OWNER" && (
        <UsersPanel team={props.team} pending={props.pending} />
      )}
    </div>
  );
}
