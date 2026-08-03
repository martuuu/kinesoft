"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TweaksPanel } from "./tweaks-panel";
import { useTweaks } from "./tweaks-context";
import { CommandPalette } from "@/components/global/command-palette";

/**
 * Authenticated workspace shell. Picks chrome (sidebar vs. topbar) based
 * on the live Tweaks context, applies the active palette via the root
 * effect inside TweaksProvider, and overlays the floating Tweaks panel.
 */
export function AppShell({
  children,
  isPlatformAdmin = false,
}: {
  children: ReactNode;
  isPlatformAdmin?: boolean;
}) {
  const { t } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";

  return (
    <div
      className="k-app"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        display: useSidebar ? "flex" : "block",
      }}
    >
      {useSidebar && <Sidebar collapsed={t.sidebarCollapsed} isPlatformAdmin={isPlatformAdmin} />}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {!useSidebar && <TopBar />}
        <main style={{ flex: 1, padding: useSidebar ? 14 : "0 18px 18px" }}>{children}</main>
      </div>
      <TweaksPanel />
      <CommandPalette />
    </div>
  );
}
