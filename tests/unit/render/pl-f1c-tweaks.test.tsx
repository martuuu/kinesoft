import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-F1c] Panel «Apariencia» (ex Tweaks, §20.18: se mantiene y se arreglan sus opciones rotas).
 * Inventario de opciones y un test por opción de que APLICA (tiene lector real), más: arranca cerrado, cerrado no deja
 * nada flotando, copy en castellano, sin «Timeline / Semana / Lista» ni «Card de paciente», y la paleta va al server.
 * Se mockean la red (server action `updateUserPreferences`) y el router; los componentes son los reales.
 */
const prefs = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/preferences", () => ({
  updateUserPreferences: async (patch: unknown) => {
    prefs.calls.push(patch);
    return { ok: true, data: patch };
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));

import { TweaksProvider, hydrateTweaks, useTweaks, type TweaksState } from "@/components/layout/tweaks-context";
import { TweaksPanel, PALETTE_OPTIONS } from "@/components/layout/tweaks-panel";
import { Sidebar } from "@/components/layout/sidebar";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));

/** Sonda: deja `set` y el estado del contexto real a mano (sin DOM no hay clicks). */
function probe(initialPalette?: Parameters<typeof TweaksProvider>[0]["initialPalette"]) {
  const out: { t?: TweaksState; set?: ReturnType<typeof useTweaks>["set"] } = {};
  function Probe() {
    const ctx = useTweaks();
    out.t = ctx.t;
    out.set = ctx.set;
    return null;
  }
  renderToStaticMarkup(
    <TweaksProvider initialPalette={initialPalette}>
      <Probe />
    </TweaksProvider>
  );
  return out;
}

/**
 * Panel abierto: el estado real arranca cerrado y en SSR no hay clicks ni effects, así que `ForceOpen` pone
 * `minimised: false` en el estado del provider real antes de que el panel lo lea (solo en este render estático).
 */
function openPanel() {
  return renderToStaticMarkup(
    <TweaksProvider>
      <ForceOpen>
        <TweaksPanel />
      </ForceOpen>
    </TweaksProvider>
  );
}
function ForceOpen({ children }: { children: React.ReactNode }) {
  const { t } = useTweaks();
  // Mutación local del objeto de estado SOLO para el render estático del test (no hay effects en SSR).
  (t as { minimised: boolean }).minimised = false;
  return <>{children}</>;
}

beforeEach(() => {
  prefs.calls = [];
});

describe("[PL-F1c] Apariencia: estado inicial", () => {
  it("arranca minimizado y, cerrado, no renderiza nada (ni engranaje flotante que tape el pie de los Drawers)", () => {
    expect(probe().t?.minimised).toBe(true);
    const html = renderToStaticMarkup(
      <TweaksProvider>
        <TweaksPanel />
      </TweaksProvider>
    );
    expect(html).toBe("");
  });

  it("hydrateTweaks: ignora `minimised` guardado y las claves muertas; la paleta del server gana", () => {
    const raw = JSON.stringify({
      palette: "coral",
      dashChrome: "topbar",
      sidebarCollapsed: false,
      minimised: false,
      agendaView: "timeline",
      patientCard: "rich",
    });
    const t = hydrateTweaks(raw, "mint");
    expect(t).toEqual({ palette: "mint", dashChrome: "topbar", sidebarCollapsed: false, minimised: true });
    expect(hydrateTweaks(raw, null).palette).toBe("coral");
    // Basura → defaults (nunca tira).
    expect(hydrateTweaks("{no json", null)).toEqual({
      palette: "sky",
      dashChrome: "sidebar",
      sidebarCollapsed: true,
      minimised: true,
    });
    expect(hydrateTweaks(JSON.stringify({ palette: "neon", dashChrome: "x" }), null).palette).toBe("sky");
  });

  it("el contexto ya no tiene agendaView ni patientCard", () => {
    expect(Object.keys(probe().t ?? {}).sort()).toEqual(["dashChrome", "minimised", "palette", "sidebarCollapsed"]);
  });
});

describe("[PL-F1c] Apariencia: panel abierto", () => {
  it("título y copy en castellano; sin opciones muertas", () => {
    const html = openPanel();
    expect(html).toContain(">Apariencia</h2>");
    expect(html).toContain('aria-label="Cerrar Apariencia"');
    expect(html).toContain(">Barra lateral<");
    expect(html).toContain(">Barra superior<");
    expect(html).toContain("Barra lateral contraída");
    for (const dead of ["Tweaks", "Timeline", "Card de paciente", "Hero con foto", "Sidebar", "Topbar", "collapsed"]) {
      expect(html).not.toContain(dead);
    }
    for (const p of PALETTE_OPTIONS) expect(html).toContain(`aria-label="Paleta ${p.label}"`);
    expect(html).not.toMatch(/aria-label="(sky|mint|coral|violet)"/);
    // Debajo de modales (40), Drawers (45) y toasts (90).
    expect(html).toContain("z-index:35");
  });
});

describe("[PL-F1c] Apariencia: cada opción aplica", () => {
  it("Paleta → se guarda en el server (UserPreferences.palette) y la del server siembra el estado", () => {
    const { set } = probe();
    set?.("palette", "violet");
    expect(prefs.calls).toEqual([{ palette: "violet" }]);
    expect(probe("mint").t?.palette).toBe("mint");
  });

  it("Paleta → `data-palette` cambia los tokens en globals.css (cada opción tiene su bloque)", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    for (const p of PALETTE_OPTIONS.filter((x) => x.value !== "sky")) {
      expect(css).toMatch(new RegExp(`\\[data-palette=["']?${p.value}["']?\\]`));
    }
    // Y el provider lo escribe en <html> (lo aplica el efecto de TweaksProvider).
    const src = readFileSync(join(process.cwd(), "components/layout/tweaks-context.tsx"), "utf8");
    expect(src).toContain('document.documentElement.setAttribute("data-palette", t.palette)');
  });

  it("los otros campos no van al server (localStorage del navegador)", () => {
    const { set } = probe();
    set?.("dashChrome", "topbar");
    set?.("sidebarCollapsed", false);
    set?.("minimised", false);
    expect(prefs.calls).toEqual([]);
  });

  it("Barra lateral contraída → el Sidebar real cambia de ancho (64 vs 232)", () => {
    const render = (collapsed: boolean) =>
      renderToStaticMarkup(
        <TenantModulesProvider modules={KINE}>
          <Sidebar collapsed={collapsed} caps={Array.from(capabilitiesFor("OWNER"))} onOpenAppearance={() => {}} />
        </TenantModulesProvider>
      );
    expect(render(true)).toContain("width:64px");
    expect(render(false)).toContain("width:232px");
  });

  it("el Sidebar abre Apariencia desde su pie (y sin handler no muestra el botón)", () => {
    const caps = Array.from(capabilitiesFor("OWNER"));
    const withBtn = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed={false} caps={caps} onOpenAppearance={() => {}} />
      </TenantModulesProvider>
    );
    expect(withBtn).toContain('aria-label="Apariencia"');
    const without = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed={false} caps={caps} />
      </TenantModulesProvider>
    );
    expect(without).not.toContain("Apariencia");
  });
});
