import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-F1c] UI sin funcionalidad (regla de Martin del 16-oct: «todo lo que quede sin funcionalidad, se quita»).
 * Barrido: `wip-20/dead-ui.md`. Componentes reales; se mockean el router, la red (server actions) y, para elegir el
 * chrome del AppShell, el hook de Tweaks y los providers pesados que no son lo que se prueba.
 */
const tweaks = vi.hoisted(() => ({ chrome: "sidebar" as "sidebar" | "topbar" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({
    t: { palette: "sky", dashChrome: tweaks.chrome, sidebarCollapsed: true, minimised: true },
    set: () => {},
    agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false },
    setAgenda: () => {},
  }),
}));
vi.mock("@/components/providers/arrival-alerts", () => ({ ArrivalAlerts: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/providers/realtime-provider", () => ({
  RealtimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/global/command-palette", () => ({ CommandPalette: () => null }));
// PL-F (handoff 8): el menú de cuenta del topbar suma «Ayuda y soporte» (de profile-menu) y el switch del turnero
// propio: sus server actions (red) se mockean; sin esto `lib/session` llama a `cache` de React fuera de Next.
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));

import ReportesPage from "@/app/(app)/reportes/page";
import { TopBar } from "@/components/layout/topbar";
import { TopbarAccountMenu } from "@/components/layout/topbar-account-menu";
import { AppShell } from "@/components/layout/app-shell";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TenantChoiceProvider } from "@/components/layout/tenant-switcher";
import { MODULE_LABEL, visibleModuleChips } from "@/components/plataforma/tenants/labels";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { USER_NO_NAME } from "@/lib/display-name";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const CAPS = Array.from(capabilitiesFor("OWNER"));
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("[PL-F1c] /reportes", () => {
  it("redirige a /dashboard (era una Card placeholder) y ya no tiene esqueleto de carga", () => {
    let digest = "";
    try {
      ReportesPage();
    } catch (e) {
      digest = String((e as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain(";/dashboard;");
    expect(() => src("app/(app)/reportes/loading.tsx")).toThrow();
  });

  it("Plataforma no muestra los chips «Reportes» ni «Evoluciones» (Evoluciones vuelve con EV2)", () => {
    expect(MODULE_LABEL.reportes).toBeNull();
    expect(MODULE_LABEL.evoluciones).toBeNull();
    const chips = visibleModuleChips(["agenda", "evoluciones", "reportes", "planes"]);
    expect(chips.map((c) => c.label)).toEqual(["Agenda", "Planes de tratamiento"]);
  });
});

function topbar(opts: { userName?: string; switchable?: boolean } = {}) {
  const options = opts.switchable
    ? [
        { tenantId: "t1", name: "Uno", role: "OWNER", vertical: "KINESIOLOGY" },
        { tenantId: "t2", name: "Dos", role: "PRACTITIONER", vertical: "GENERAL" },
      ]
    : [];
  return renderToStaticMarkup(
    <TenantChoiceProvider
      // El shape exacto de TenantOption no es lo que se prueba acá.
      options={options as never}
      activeTenantId="t1"
      switchTenant={opts.switchable ? async () => ({ ok: true, data: undefined }) : null}
    >
      <TenantModulesProvider modules={KINE}>
        <TopBar caps={CAPS} userName={opts.userName} onOpenAppearance={() => {}} />
      </TenantModulesProvider>
    </TenantChoiceProvider>
  );
}

describe("[PL-F1c] barra superior (chrome «Barra superior»)", () => {
  it("avatar del usuario real (nunca «Lucía Méndez»), búsqueda que abre ⌘K y campana real", () => {
    const html = topbar({ userName: "Ana Pérez" });
    expect(html).not.toContain("Lucía Méndez");
    expect(html).not.toContain(">LM<");
    expect(html).toContain('aria-label="Menú de cuenta de Ana Pérez"');
    expect(html).toContain(">AP<");
    // Buscador: ahora es un botón (antes un <div> sin handler).
    expect(html).toMatch(/<button[^>]*aria-label="Abrir búsqueda rápida"/);
    // Campana: la de NotificationsBell (botón con dropdown), no un <span> inerte.
    expect(html).toMatch(/<button[^>]*aria-label="Notificaciones/);
    // PF1.0-a: el botón llama a `openCommandPalette`, que despacha el mismo ⌘K que escucha el launcher del shell.
    expect(src("components/layout/topbar.tsx")).toContain("onClick={openCommandPalette}");
    expect(src("components/layout/command-palette-launcher.tsx")).toContain(
      'new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })'
    );
  });

  it("sin nombre cargado dice «Usuario sin nombre» (decisión 19: nunca el email)", () => {
    expect(topbar()).toContain(`Menú de cuenta de ${USER_NO_NAME}`);
  });

  it("menú de cuenta: Apariencia, Seguridad, Cerrar sesión; «Cambiar de consultorio» solo con 2+", () => {
    const render = (switchable: boolean) =>
      renderToStaticMarkup(
        <TenantChoiceProvider
          options={(switchable ? [{ tenantId: "a" }, { tenantId: "b" }] : []) as never}
          activeTenantId="a"
          switchTenant={switchable ? async () => ({ ok: true, data: undefined }) : null}
        >
          <TopbarAccountMenu name="Ana Pérez" onOpenAppearance={() => {}} defaultOpen />
        </TenantChoiceProvider>
      );
    const html = render(false);
    expect(html).toContain('role="menu"');
    expect(html).toContain("Apariencia");
    expect(html).toMatch(/<a href="\/cuenta\/seguridad" role="menuitem"[^>]*>.*Seguridad de la cuenta/);
    expect(html).toMatch(/<form action="\/api\/auth\/sign-out" method="post"><button type="submit" role="menuitem"/);
    expect(html).toContain("Cerrar sesión");
    expect(html).not.toContain("Cambiar de consultorio");
    expect(render(true)).toMatch(/<a href="\/elegir-consultorio" role="menuitem"[^>]*>.*Cambiar de consultorio/);
  });

  it("[PL-F] menú de cuenta: «Ayuda y soporte» para todos y el switch del turnero propio solo si atiende", () => {
    const render = (own: { practitionerId: string; enabled: boolean } | null) =>
      renderToStaticMarkup(
        <TenantModulesProvider modules={KINE}>
          <TenantChoiceProvider options={[]} activeTenantId="a" switchTenant={null}>
            <TopbarAccountMenu name="Ana Pérez" defaultOpen ownPublicBooking={own} />
          </TenantChoiceProvider>
        </TenantModulesProvider>
      );
    const none = render(null);
    expect(none).toMatch(/<a href="\/configuracion\?tab=soporte" role="menuitem"[^>]*>.*Ayuda y soporte/);
    expect(none).not.toContain("data-own-public-booking");
    const own = render({ practitionerId: "p1", enabled: true });
    expect(own).toContain("data-own-public-booking");
    // KINE sin turnero del consultorio: el switch dice quién tiene que prenderlo (no «Primero prendé…»).
    expect(own).toContain("Primero el consultorio tiene que prender el turnero.");
  });
});

describe("[PL-F1c] AppShell: «Barra lateral / Barra superior» de Apariencia aplica", () => {
  const shell = () =>
    renderToStaticMarkup(
      <AppShell
        modules={KINE}
        caps={CAPS}
        realtime={{ driver: "off", tenantId: "t1" }}
        alertViewer={{ practitionerId: null, canOperateAll: true }}
        initialAlertPrefs={{ arrivalAlert: "off", callAlert: "off" } as never}
        userName="Ana Pérez"
      >
        <p>contenido</p>
      </AppShell>
    );

  it("barra lateral: monta el Sidebar (con su «Apariencia» y «Cerrar sesión») y no el topbar", () => {
    tweaks.chrome = "sidebar";
    const html = shell();
    expect(html).toContain("<aside");
    expect(html).toContain('aria-label="Apariencia"');
    // MB-0c (C-MB1): la barra móvil (oculta en escritorio) también lleva el avatar; el chrome de escritorio no.
    expect(html.replace(/<header[^>]*data-mobile-bar[\s\S]*?<\/header>/, "")).not.toContain("Menú de cuenta");
  });

  it("barra superior: monta el TopBar con el usuario real y no el Sidebar", () => {
    tweaks.chrome = "topbar";
    const html = shell();
    expect(html).toContain("<header");
    expect(html).toContain('aria-label="Menú de cuenta de Ana Pérez"');
    expect(html).not.toContain('aria-label="Apariencia"'); // el del sidebar; acá vive en el menú de cuenta
  });

  it("panel minimizado: no queda ningún engranaje flotante", () => {
    tweaks.chrome = "sidebar";
    expect(shell()).not.toContain("Abrir Tweaks");
  });
});
