"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TweaksPanel } from "./tweaks-panel";
import { useTweaks } from "./tweaks-context";
import { CommandPalette } from "@/components/global/command-palette";
import { TenantModulesProvider } from "./tenant-modules-context";
import type { TenantModule } from "@/lib/tenant-modules";
import type { Capability } from "@/lib/capabilities";

/**
 * Authenticated workspace shell. Picks chrome (sidebar vs. topbar) based
 * on the live Tweaks context, applies the active palette via the root
 * effect inside TweaksProvider, and overlays the floating Tweaks panel.
 *
 * EV0 (EV-S): recibe del layout los módulos del consultorio y las
 * capabilities del rol (arrays: cruzan la frontera Server→Client) y monta
 * `TenantModulesProvider` sobre todo el workspace, así sidebar, topbar y
 * cualquier pantalla cliente leen `useTenantModules()` sin props.
 */
export function AppShell({
  children,
  isPlatformAdmin = false,
  modules,
  caps,
}: {
  children: ReactNode;
  isPlatformAdmin?: boolean;
  modules: readonly TenantModule[];
  caps: readonly Capability[];
}) {
  const { t } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";

  return (
    <TenantModulesProvider modules={modules}>
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
          {!useSidebar && <TopBar caps={caps} isPlatformAdmin={isPlatformAdmin} />}
          <main style={{ flex: 1, padding: useSidebar ? 14 : "0 18px 18px" }}>{children}</main>
        </div>
        <TweaksPanel />
        <CommandPalette />
      </div>
    </TenantModulesProvider>
  );
}
