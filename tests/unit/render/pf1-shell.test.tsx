import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * PF1.0-a · shell del workspace `(app)`: bundle (C-PF1/C-PF2/C-PF3) y mobile clase A (S1), S3, S4.
 *
 * Qué se cuida y por qué:
 *  - Grafo ESTÁTICO del shell (lo que viaja en el first-load de TODAS las rutas de `(app)`): sin zod, sin el
 *    componente `motion` de framer, sin ⌘K / Apariencia / lista del selector / Drawer del menú móvil (van con
 *    `next/dynamic`), sin `lib/preferences-constants` (zod + textos de KPIs del dashboard) ni `profile-menu`. Un solo
 *    import estático de vuelta reinstala kilobytes en cada ruta: este test lo frena antes del `--explain`.
 *  - Las copias locales del shell (defaults de Apariencia y el href de Soporte) siguen iguales a su fuente.
 *  - Render real: barra móvil con «Menú» y buscador; sidebar y topbar marcados para esconderse bajo 768 px; íconos
 *    distintos por sección (S3); ítems del sidebar contraído con nombre accesible y sin `title` (tooltip propio).
 *  - Cada opción viva de Apariencia tiene un lector (§20.18): navegación, días de la semana (sábado, domingo,
 *    encabezado). Paleta y «contraída» ya lo prueban `pl-f1c-tweaks.test.tsx`; la cara de Recepción,
 *    `tweaks-panel.test.tsx`.
 */
const nav = vi.hoisted(() => ({ pathname: "/agenda" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
const tweaks = vi.hoisted(() => ({ chrome: "sidebar" as "sidebar" | "topbar", collapsed: true }));
vi.mock("@/components/layout/tweaks-context", async (orig) => ({
  ...(await orig<typeof import("@/components/layout/tweaks-context")>()),
  useTweaks: () => ({
    t: { palette: "sky", dashChrome: tweaks.chrome, sidebarCollapsed: tweaks.collapsed, minimised: true },
    set: () => {},
    agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false },
    setAgenda: () => {},
  }),
}));
vi.mock("@/components/providers/arrival-alerts", () => ({
  ArrivalAlerts: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/providers/realtime-provider", () => ({
  RealtimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));

import { AppShell } from "@/components/layout/app-shell";
import { Sidebar } from "@/components/layout/sidebar";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import {
  SHELL_DEFAULT_AGENDA,
  SHELL_DEFAULT_RECEPTION_LAYOUT,
  SHELL_RECEPTION_LAYOUTS,
} from "@/components/layout/tweaks-context";
import { SUPPORT_HELP_HREF } from "@/components/layout/shell-links";
import { SUPPORT_HELP_HREF as PROFILE_MENU_SUPPORT_HREF } from "@/components/global/profile-menu";
import { isPaletteToggle } from "@/components/layout/command-palette-launcher";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import { DEFAULT_AGENDA_VIEW_PREFS, DEFAULT_PREFERENCES, RECEPTION_LAYOUTS } from "@/lib/preferences-constants";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { NAV_ITEMS } from "@/lib/nav";

const ROOT = process.cwd();
const rel = (abs: string) => relative(ROOT, abs).split("\\").join("/");
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

// ── Grafo estático del shell ────────────────────────────────────────────────────────────────────────────────────
/** Lo que el layout de `(app)` monta del lado cliente (los `"use client"` que importa `app/(app)/layout.tsx`). */
const SHELL_ENTRIES = [
  "components/layout/app-shell.tsx",
  "components/layout/tweaks-context.tsx",
  "components/providers/ui-providers.tsx",
  "components/layout/access-banner.tsx",
  "components/layout/read-only-write-guard.tsx",
  "components/layout/support-banner.tsx",
];
const EXTS = [".ts", ".tsx"];

/** Specifiers de VALOR estáticos (sin `import type`, sin `import()` dinámico: eso es justamente lo que se difiere). */
function staticValueSpecifiers(code0: string): string[] {
  const code = code0.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    const named = m[3].match(/^\{([\s\S]*)\}$/);
    if (named && named[1].split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

function resolveLocal(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))]) {
    if (existsSync(c) && statSync(c).isFile() && EXTS.some((e) => c.endsWith(e))) return c;
  }
  return null;
}

/** Un `"use server"` importado desde el cliente es una referencia a la action, no su código: el grafo corta ahí. */
const isServerModule = (code: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use server["']/.test(code);

function shellGraph() {
  const files = new Map<string, string | null>();
  const packages = new Map<string, string>();
  const queue = SHELL_ENTRIES.map((e) => join(ROOT, e));
  for (const q of queue) files.set(q, null);
  while (queue.length) {
    const f = queue.shift()!;
    const code = readFileSync(f, "utf8");
    if (isServerModule(code)) continue;
    for (const spec of staticValueSpecifiers(code)) {
      const local = resolveLocal(spec, f);
      if (!local) {
        if (!spec.startsWith(".") && !spec.startsWith("@/")) {
          const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (!packages.has(pkg)) packages.set(pkg, rel(f));
        }
        continue;
      }
      if (files.has(local)) continue;
      files.set(local, f);
      queue.push(local);
    }
  }
  const chain = (abs: string) => {
    const c: string[] = [];
    for (let cur: string | null | undefined = abs; cur; cur = files.get(cur)) c.unshift(rel(cur));
    return c.join(" → ");
  };
  return { files: new Set(Array.from(files.keys(), rel)), packages, chain: (r: string) => chain(join(ROOT, r)) };
}

describe("[PF1.0-a] grafo estático del shell de (app)", () => {
  const g = shellGraph();

  it("sin zod (C-PF3): ni el schema de realtime ni preferences-constants", () => {
    expect(g.packages.has("zod"), `zod entra por ${g.packages.get("zod")}`).toBe(false);
    expect(g.files.has("lib/preferences-constants.ts"), g.chain("lib/preferences-constants.ts")).toBe(false);
    expect(g.files.has("lib/realtime-events-schema.ts")).toBe(false);
  });

  it("lo que arranca cerrado no está en el first-load (C-PF2): ⌘K, Apariencia, lista del selector, menú móvil", () => {
    for (const f of [
      "components/global/command-palette.tsx",
      "components/layout/tweaks-panel.tsx",
      "components/layout/tenant-switcher-panel.tsx",
      "components/layout/mobile-nav-drawer.tsx",
      "components/global/profile-menu.tsx",
      "components/ui/drawer.tsx",
    ]) {
      expect(g.files.has(f), `${f}: ${g.chain(f)}`).toBe(false);
    }
  });

  it("del dashboard solo la campana (la monta el topbar): nada de strings de KPIs (chunk 1370 del brief)", () => {
    const dash = Array.from(g.files).filter((f) => f.startsWith("components/dashboard/") || f.startsWith("components/screens/"));
    expect(dash).toEqual(["components/dashboard/notifications-bell.tsx"]);
  });

  it("ningún archivo del shell usa el componente `motion` de framer (C-PF1): solo `m` dentro de LazyMotion", () => {
    const offenders = Array.from(g.files).filter((f) => {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      return /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*["']framer-motion["']/.test(code) || /<\/?motion\./.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("`pageVariants` se borró de lib/motion.ts (sin uso desde PF-0c)", () => {
    expect(src("lib/motion.ts")).not.toMatch(/export const pageVariants/);
  });
});

describe("[PF1.0-a] copias locales del shell = su fuente", () => {
  it("defaults de Apariencia (semana y cara de Recepción) iguales a lib/preferences-constants", () => {
    expect(SHELL_DEFAULT_AGENDA).toEqual({
      agendaShowWeekHeader: DEFAULT_PREFERENCES.agendaShowWeekHeader,
      agendaShowSaturday: DEFAULT_PREFERENCES.agendaShowSaturday,
      agendaShowSunday: DEFAULT_PREFERENCES.agendaShowSunday,
    });
    expect([...SHELL_RECEPTION_LAYOUTS]).toEqual([...RECEPTION_LAYOUTS]);
    expect(SHELL_DEFAULT_RECEPTION_LAYOUT).toBe(DEFAULT_AGENDA_VIEW_PREFS.receptionLayout);
  });

  it("«Ayuda y soporte» del topbar = el del menú de perfil", () => {
    expect(SUPPORT_HELP_HREF).toBe(PROFILE_MENU_SUPPORT_HREF);
  });

  it("atajo del ⌘K: ⌘K y Ctrl+K (mayúscula también); otras teclas no", () => {
    expect(isPaletteToggle({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPaletteToggle({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPaletteToggle({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPaletteToggle({ key: "j", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

// ── Render ────────────────────────────────────────────────────────────────────────────────────────────────────
const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const OWNER = Array.from(capabilitiesFor("OWNER"));

function shell() {
  return renderToStaticMarkup(
    <AppShell
      modules={KINE}
      caps={OWNER}
      realtime={{ driver: "off", tenantId: "t1" }}
      alertViewer={{ practitionerId: null, canOperateAll: true }}
      initialAlertPrefs={{ arrivalAlert: "off", callAlert: "off" } as never}
      userName="Ana Pérez"
      isPlatformAdmin
    >
      <p>contenido</p>
    </AppShell>
  );
}

describe("[PF1.0-a] mobile clase A (S1) y sidebar (S3, S4)", () => {
  // MB-0c (C-MB1): «Menú» salió de la barra superior; el Drawer lo abre «Más» de la barra inferior (bottom-nav.test.tsx).
  it("la barra móvil está en el HTML con el buscador y el avatar (sin «Menú»); el Drawer no baja hasta abrirlo", () => {
    tweaks.chrome = "sidebar";
    const html = shell();
    const mobile = html.match(/<header[^>]*data-mobile-bar[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(mobile).toMatch(/<button[^>]*aria-label="Abrir búsqueda rápida"/);
    expect(mobile).toContain('aria-label="Menú de cuenta de Ana Pérez"');
    expect(mobile).not.toContain("Abrir menú");
    expect(html).toMatch(/<nav [^>]*data-k-bottom-nav[^>]*>[\s\S]*aria-haspopup="dialog" aria-expanded="false"/);
    // Una sola lista de secciones (la del sidebar): el Drawer móvil no se monta cerrado.
    expect(html.match(/aria-label="Secciones"/g)).toHaveLength(1);
    // ⌘K y Apariencia cerrados: nada en el HTML.
    expect(html).not.toContain("Búsqueda rápida");
    expect(html).not.toContain(">Apariencia</h2>");
  });

  it("sidebar y topbar llevan la clase que los esconde bajo 768 px; el CSS la define con la barra móvil", () => {
    const css = src("components/layout/shell.module.css");
    const media = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(media).toMatch(/\.desktopOnly\s*\{\s*display:\s*none\s*!important;/);
    expect(media).toMatch(/\.mobileBar\s*\{\s*display:\s*flex;/);
    expect(css).toMatch(/\.mobileBar\s*\{\s*display:\s*none;\s*\}/);
    const appShell = src("components/layout/app-shell.tsx");
    expect(appShell).toMatch(/<Sidebar\s+className=\{styles\.desktopOnly\}/);
    expect(appShell).toMatch(/<div className=\{styles\.desktopOnly\}>\s*<TopBar/);
    // Táctil: los botones de la barra móvil miden 44 px como mínimo.
    expect(css).toMatch(/\.mobileButton\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px;/);
  });

  it("S4: sidebar sticky con 100dvh (respaldo 100vh), también en Plataforma", () => {
    const css = src("components/layout/shell.module.css");
    expect(css).toMatch(/\.sidebar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*14px;[^}]*height:\s*calc\(100vh - 28px\);\s*height:\s*calc\(100dvh - 28px\);/);
    expect(src("components/plataforma/platform-shell.tsx")).toContain('height: "calc(100dvh - 28px)"');
  });

  it("S3: cada sección del nav tiene un ícono distinto (también Plataforma en el pie)", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed caps={OWNER} isPlatformAdmin />
      </TenantModulesProvider>
    );
    const items = Array.from(html.matchAll(/<a [^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g), (m) => ({
      label: m[1],
      svg: (m[2].match(/<svg[\s\S]*?<\/svg>/) ?? [""])[0],
    }));
    const labels = items.map((i) => i.label);
    for (const it of NAV_ITEMS) expect(labels).toContain(it.label);
    expect(labels).toContain("Plataforma");
    const svgs = items.map((i) => i.svg);
    expect(new Set(svgs).size, labels.join(", ")).toBe(svgs.length);
  });

  it("sidebar contraído: nombre accesible por aria-label y sin `title` del navegador (el tooltip es propio)", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed caps={OWNER} onOpenAppearance={() => {}} />
      </TenantModulesProvider>
    );
    expect(html).toContain('aria-label="Agenda"');
    expect(html).toContain('aria-label="Apariencia"');
    expect(html).toContain('aria-label="Cerrar sesión"');
    expect(html).not.toMatch(/<a [^>]*title=/);
    expect(html).not.toMatch(/<button [^>]*title="(Apariencia|Cerrar sesión)"/);
    // Expandido: el texto visible ES el nombre; no se duplica con aria-label.
    const open = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed={false} caps={OWNER} />
      </TenantModulesProvider>
    );
    expect(open).not.toMatch(/<a [^>]*aria-label="Agenda"/);
    expect(open).toContain(">Agenda<");
  });

  it("el activo se marca con aria-current y la pastilla va por clase (sin estilos inline que difieran al hidratar, S5)", () => {
    nav.pathname = "/agenda";
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <Sidebar collapsed={false} caps={OWNER} />
      </TenantModulesProvider>
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const current = html.match(/<a [^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/agenda"');
  });
});

describe("[PF1.0-a] Apariencia: cada opción viva tiene un lector (§20.18)", () => {
  it("Navegación → el AppShell monta Sidebar o TopBar según `dashChrome`", () => {
    tweaks.chrome = "sidebar";
    expect(shell()).toContain('aria-label="Navegación principal"');
    tweaks.chrome = "topbar";
    const top = shell();
    // El del sidebar (`<aside>`); la barra inferior (MB-0c) también se llama así y está en los dos chromes.
    expect(top).not.toMatch(/<aside[^>]*aria-label="Navegación principal"/);
    expect(top).toContain('aria-label="Menú de cuenta de Ana Pérez"');
    tweaks.chrome = "sidebar";
  });

  const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  const grid = (p: { showHeader: boolean; showSaturday: boolean; showSunday: boolean }) =>
    renderToStaticMarkup(
      <WeekGridView
        weekDays={week}
        bookings={[]}
        onEdit={() => {}}
        businessHours={{ start: 8, end: 12, slotMinutes: 60 }}
        highlight={null}
        {...p}
      />
    );

  it("Sábado y Domingo → columnas de la grilla semanal", () => {
    expect(grid({ showHeader: true, showSaturday: false, showSunday: false })).toContain("repeat(5, 1fr)");
    expect(grid({ showHeader: true, showSaturday: true, showSunday: false })).toContain("repeat(6, 1fr)");
    expect(grid({ showHeader: true, showSaturday: true, showSunday: true })).toContain("repeat(7, 1fr)");
  });

  it("Encabezado de días → cambia lo que pinta la grilla semanal", () => {
    const on = grid({ showHeader: true, showSaturday: true, showSunday: true });
    const off = grid({ showHeader: false, showSaturday: true, showSunday: true });
    expect(on).not.toBe(off);
  });

  it("la agenda pasa las tres preferencias del contexto a sus vistas (TweaksProvider → agenda-client → vistas)", () => {
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toContain("showHeader={agenda.agendaShowWeekHeader}");
    expect(code).toContain("showSaturday={agenda.agendaShowSaturday}");
    expect(code).toContain("showSunday={agenda.agendaShowSunday}");
  });
});
