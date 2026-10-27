/**
 * IN-S (§27, IN): `AppShell` monta `IdleLogout` solo con `idle` (sesión «de navegador»). Render real del shell; se
 * mockean el router, Tweaks y los providers pesados (mismo molde que `pl-f1c-dead-ui.test.tsx`).
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/agenda",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({
    t: { palette: "sky", dashChrome: "sidebar", sidebarCollapsed: true, minimised: true },
    set: () => {},
    agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false },
    setAgenda: () => {},
  }),
}));
vi.mock("@/components/providers/arrival-alerts", () => ({ ArrivalAlerts: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/providers/realtime-provider", () => ({
  RealtimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRealtime: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/components/global/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));

import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "@/components/layout/app-shell";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { idleSignOutAction } from "@/lib/idle-logout";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] }));
const CAPS = Array.from(capabilitiesFor("OWNER"));

const shell = (idle?: { minutes: number; sessionTag: string; serverNowMs: number } | null) =>
  renderToStaticMarkup(
    <AppShell
      modules={KINE}
      caps={CAPS}
      realtime={{ driver: "off", tenantId: "t1" }}
      alertViewer={{ practitionerId: null, canOperateAll: true }}
      initialAlertPrefs={{ arrivalAlert: "off", callAlert: "off" } as never}
      userName="Ana Pérez"
      idle={idle}
    >
      <p>contenido</p>
    </AppShell>
  );

describe("[IN-6] AppShell e IdleLogout", () => {
  it("con idle: form POST oculto al sign-out por inactividad; sin aviso ni tapa en el primer render", () => {
    const html = shell({ minutes: 15, sessionTag: "a1b2c3d4e5f6", serverNowMs: Date.UTC(2026, 9, 27, 15) });
    const form = html.match(/<form[^>]*data-testid="idle-signout-form"[^>]*>/)?.[0] ?? "";
    expect(form).toContain('method="post"');
    expect(form).toContain("hidden");
    expect(form.replace(/&amp;/g, "&")).toContain(`action="${idleSignOutAction()}"`);
    expect(html).not.toContain('data-testid="idle-warning"');
    expect(html).not.toContain('data-testid="idle-closing"');
    expect(html).toContain("<p>contenido</p>");
  });

  it("sin idle (sesión persistente) o null: no se monta nada", () => {
    for (const idle of [undefined, null]) {
      const html = shell(idle);
      expect(html).not.toContain("idle-signout-form");
      expect(html).toContain("<p>contenido</p>");
    }
  });
});
