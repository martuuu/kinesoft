"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TweaksPanel } from "./tweaks-panel";
import { useTweaks } from "./tweaks-context";
import { CommandPalette } from "@/components/global/command-palette";
import { TenantModulesProvider } from "./tenant-modules-context";
import type { TenantModule } from "@/lib/tenant-modules";
import type { TenantVertical } from "@prisma/client";
import type { Capability } from "@/lib/capabilities";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import type { RealtimeBootstrap } from "@/lib/realtime-events";
import { ArrivalAlerts } from "@/components/providers/arrival-alerts";
import type { AlertPrefs, AlertViewer } from "@/lib/arrival-alert-state";
import type { TenantOption } from "@/lib/tenant-choice";
import { TenantChoiceProvider, type SwitchTenantAction } from "./tenant-switcher";

/**
 * Authenticated workspace shell. Picks chrome (sidebar vs. topbar) based
 * on the live Tweaks context, applies the active palette via the root
 * effect inside TweaksProvider, and overlays the floating Tweaks panel.
 *
 * EV0 (EV-S): recibe del layout los módulos del consultorio y las
 * capabilities del rol (arrays: cruzan la frontera Server→Client) y monta
 * `TenantModulesProvider` sobre todo el workspace, así sidebar, topbar y
 * cualquier pantalla cliente leen `useTenantModules()` sin props.
 *
 * SV07b: también monta `RealtimeProvider` con el bootstrap del layout, así
 * agenda, Recepción y cualquier vista leen `useRealtime()` sin props. Con
 * `driver:"off"` el provider no carga nada de realtime.
 *
 * SV11b: `ArrivalAlerts` va DENTRO del `RealtimeProvider` (usa `useRealtime`) y
 * envuelve todo el workspace para que la Card de Configuración y el menú de la
 * agenda lean `useAlertPrefs()`. Sin canal (`driver:"off"`) no arranca nada.
 *
 * IAM-3b (decisión 6: un usuario puede trabajar en varios consultorios): `TenantChoiceProvider` publica los
 * consultorios usables de la sesión y el activo, que el layout ya leyó para el gate. Lo leen el selector del
 * sidebar y el «Cambiar de consultorio» del menú de perfil (que vive en el dashboard, dentro de este árbol).
 *
 * BO3-F: `banner` es la banda de soporte (`SupportBanner`, la arma el layout cuando `actor.support`). Va arriba de la
 * columna de contenido y no arriba de todo: el sidebar es sticky y una banda sticky de ancho completo lo pisaba.
 */
export function AppShell({
  children,
  isPlatformAdmin = false,
  modules,
  vertical,
  caps,
  realtime,
  alertViewer,
  initialAlertPrefs,
  tenantOptions = [],
  activeTenantId = null,
  switchTenantAction = null,
  banner = null,
}: {
  children: ReactNode;
  /** BO3-F: banda de soporte (null fuera de soporte). */
  banner?: ReactNode;
  isPlatformAdmin?: boolean;
  modules: readonly TenantModule[];
  /** EV1: vertical del consultorio para el copy (ver `TenantModulesValue.vertical`). */
  vertical?: TenantVertical;
  caps: readonly Capability[];
  realtime: RealtimeBootstrap;
  alertViewer: AlertViewer;
  initialAlertPrefs: AlertPrefs;
  /** Consultorios usables de la sesión (solo los propios). Vacío = sin selector (actor demo). */
  tenantOptions?: readonly TenantOption[];
  activeTenantId?: string | null;
  /** Server action `switchTenant` (la pasa el layout: un módulo cliente no la importa, ver tenant-switcher). */
  switchTenantAction?: SwitchTenantAction | null;
}) {
  const { t } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";

  return (
    <TenantChoiceProvider options={tenantOptions} activeTenantId={activeTenantId} switchTenant={switchTenantAction}>
      <TenantModulesProvider modules={modules} vertical={vertical}>
        <RealtimeProvider bootstrap={realtime}>
          <ArrivalAlerts viewer={alertViewer} initialPrefs={initialAlertPrefs} live={realtime.driver !== "off"}>
            <div
              className="k-app"
              style={{
                minHeight: "100vh",
                background: "var(--bg-app)",
                display: useSidebar ? "flex" : "block",
              }}
            >
              {useSidebar && (
                <Sidebar collapsed={t.sidebarCollapsed} isPlatformAdmin={isPlatformAdmin} caps={caps} />
              )}
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                {banner}
                {!useSidebar && <TopBar caps={caps} isPlatformAdmin={isPlatformAdmin} />}
                <main style={{ flex: 1, padding: useSidebar ? 14 : "0 18px 18px" }}>{children}</main>
              </div>
              <TweaksPanel />
              <CommandPalette />
            </div>
          </ArrivalAlerts>
        </RealtimeProvider>
      </TenantModulesProvider>
    </TenantChoiceProvider>
  );
}
