/**
 * [PF1.1-dashboard] Bundle y pulido del tablero (Inicio).
 *
 * Se monta el `DashboardScreen` REAL con `renderToStaticMarkup`; se mockean solo las server actions (red), el router y
 * Tweaks. Lo que se afirma es el efecto observable: el markup (sin placeholder, sin emoji, un solo h1, sin `<button>`
 * dentro de `<a>`, vacíos con texto), los textos puros (`dashboardKpis`, `chartSummary`, `monthGrid`) y, para el
 * bundle, el código fuente (qué módulos importa cada archivo: es lo que decide el chunk inicial de `/dashboard`).
 */
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/dashboard", () => ({
  getSessionsChart: vi.fn(),
  getMonthBookingDays: vi.fn(),
  getRevenue: vi.fn(),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: vi.fn(), updateDashboardPrefs: vi.fn() }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  dismissReminder: vi.fn(),
  restoreReminder: vi.fn(),
  listNotifications: vi.fn(async () => []),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingStatus: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));
const tweaks = vi.hoisted(() => ({ chrome: "sidebar" as "sidebar" | "topbar" }));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ t: { dashChrome: tweaks.chrome, palette: "sky" }, set: () => {} }),
}));

import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { SessionsChart, chartSummary } from "@/components/dashboard/sessions-chart";
import { PinKpiButton } from "@/components/dashboard/pin-kpi-button";
import { monthGrid } from "@/components/dashboard/mini-calendar";
import { adherenceText, dashboardKpis, weekSlots } from "@/components/dashboard/kpi-view";
import { SettingsModal } from "@/components/global/settings-modal";
import { SUPPORT_HELP_HREF } from "@/components/global/profile-menu";
import { SUPPORT_HELP_HREF as SHELL_SUPPORT_HREF } from "@/components/layout/shell-links";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import type { DashboardData } from "@/lib/dashboard";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const zeroWeek = ["L", "M", "M", "J", "V", "S", "D"].map((d) => ({ d, c: 0, a: 0 }));

const base: DashboardData = {
  greetingName: "Martina",
  todayCount: 0,
  weeklyBars: zeroWeek,
  pinned: {
    activePatients: 0,
    weekSessions: 0,
    activePrograms: 0,
    // Lo que devuelve hoy `getDashboardData` con la semana vacía (`totalSlots ? … : 100`).
    adherencePct: 100,
    newPatientsMonth: 0,
    nearingDischarge: 1,
  },
  pinnedKpis: ["activePatients", "weekSessions", "adherence", "todayCount"],
  recent: [],
  next: [],
  monthRevenue: null,
  revenue: null,
  revenueScope: "none",
  reminderDismissed: false,
  reminderKey: "near-discharge:2026-W42",
  ownPublicBooking: null,
};

function screen(d: DashboardData = base) {
  const tree: ReactNode = (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardScreen data={d} preferences={DEFAULT_PREFERENCES} initialBookingDays={[]} />
      </ConfirmProvider>
    </ToastProvider>
  );
  return renderToStaticMarkup(tree);
}

describe("[PF1.1-dashboard] D4 · sin «100 %» sobre 0", () => {
  it("adherencia: «—» sin turnos con resultado; el % solo con denominador", () => {
    expect(weekSlots(zeroWeek)).toBe(0);
    expect(adherenceText(100, 0)).toBe("—");
    expect(adherenceText(80, 5)).toBe("80%");
  });

  it("KPIs de una semana vacía: ni «100%» ni «100% adherencia»", () => {
    const kpis = dashboardKpis({
      pinned: base.pinned,
      pinnedKpis: base.pinnedKpis,
      weeklyBars: zeroWeek,
      todayCount: 0,
      monthRevenue: null,
      revenueScope: "none",
      hasPlans: true,
      hasSessions: true,
    });
    const adherence = kpis.find((k) => k.key === "adherence")!;
    expect(adherence.n).toBe("—");
    expect(adherence.delta).toBe("Sin turnos esta semana");
    expect(kpis.find((k) => k.key === "weekSessions")!.delta).toBe("Sin turnos esta semana");
    expect(JSON.stringify(kpis)).not.toContain("100%");
  });

  it("con turnos, la tasa de siempre (golden)", () => {
    const bars = zeroWeek.map((b, i) => (i === 0 ? { ...b, c: 9, a: 1 } : b));
    const kpis = dashboardKpis({
      pinned: { ...base.pinned, weekSessions: 9, adherencePct: 90 },
      pinnedKpis: ["weekSessions", "adherence"],
      weeklyBars: bars,
      todayCount: 0,
      monthRevenue: null,
      revenueScope: "none",
      hasPlans: true,
      hasSessions: true,
    });
    expect(kpis.map((k) => [k.n, k.delta])).toEqual([
      ["9", "90% adherencia"],
      ["90%", "9 sesiones"],
    ]);
  });

  it("KPIs repetidas en la preferencia no se dibujan dos veces (key = KPI) y el tope sigue en 6", () => {
    const kpis = dashboardKpis({
      pinned: base.pinned,
      pinnedKpis: ["todayCount", "todayCount", "activePatients", "weekSessions", "adherence", "newPatientsMonth", "nearingDischarge", "activePrograms"],
      weeklyBars: zeroWeek,
      todayCount: 2,
      monthRevenue: null,
      revenueScope: "none",
      hasPlans: true,
      hasSessions: true,
    });
    expect(kpis).toHaveLength(6);
    expect(new Set(kpis.map((k) => k.key)).size).toBe(6);
    expect(kpis[0].delta).toBe("Sin contar cancelados");
  });

  it("gráfico sin turnos: vacío con texto, sin tasa", () => {
    expect(chartSummary([{ label: "L", done: 0, missed: 0 }])).toEqual({
      totalDone: 0,
      totalMissed: 0,
      adherence: null,
      empty: true,
    });
    const html = renderToStaticMarkup(<SessionsChart initialBars={[{ label: "L", done: 0, missed: 0 }]} />);
    expect(html).toContain("Esta semana todavía no hay turnos realizados ni ausentes.");
    expect(html).not.toMatch(/\d+% adherencia/);
    expect(html).not.toContain('role="img"');
  });

  it("gráfico con turnos: barras con su rótulo accesible y la entrada por clase CSS (no framer)", () => {
    const html = renderToStaticMarkup(<SessionsChart initialBars={[{ label: "L", done: 3, missed: 1 }]} />);
    expect(html).toContain('aria-label="L: 3 realizadas"');
    expect(html).toContain('aria-label="L: 1 ausentes"');
    expect(html).toContain("75% adherencia");
    expect(html).toMatch(/class="[^"]*bar[^"]*"/);
    // Sin `transform: scaleY(0)` inline: el estado final se ve sin JS.
    expect(html).not.toContain("scaleY(0)");
  });
});

describe("[PF1.1-dashboard] tablero completo", () => {
  it("D3: sin el placeholder «kine c/paciente»; C-PF5.3: un solo h1 (PageHeader), sin emoji", () => {
    const html = screen();
    expect(html).not.toContain("kine c/paciente");
    expect(html).not.toContain("👋");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(text(html)).toContain("Hola, Lic. Martina");
    expect(text(html)).toMatch(/Hoy tenés 0 sesiones agendadas/);
  });

  it("con barra superior también hay h1 (antes el encabezado solo existía con sidebar) y sin buscador propio", () => {
    tweaks.chrome = "topbar";
    try {
      const html = screen();
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).not.toContain("Abrir búsqueda rápida");
      expect(text(html)).toContain("Ajustes");
    } finally {
      tweaks.chrome = "sidebar";
    }
  });

  it("sin `<button>` dentro de `<a>` (antes «Ver agenda completa» era Link > Button)", () => {
    const html = screen();
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<button\b/s);
    expect(html).toMatch(/<a class="k-btn k-btn-ghost k-btn-block"[^>]*href="\/agenda"/);
  });

  it("vacíos con texto: próximos turnos, recientes e indicadores", () => {
    const t = text(screen({ ...base, pinnedKpis: [] as DashboardData["pinnedKpis"] }));
    expect(t).toContain("No te quedan turnos por hoy.");
    expect(t).toContain("Todavía no se cargaron sesiones recientes.");
    const none = text(
      renderToStaticMarkup(
        <ToastProvider>
          <ConfirmProvider>
            <DashboardScreen
              data={{ ...base, revenueScope: "none", pinnedKpis: ["monthRevenue"] }}
              preferences={DEFAULT_PREFERENCES}
              initialBookingDays={[]}
            />
          </ConfirmProvider>
        </ToastProvider>
      )
    );
    // La única KPI fijada es de ingresos y el rol no los ve (Kine: `effectivePinnedKpis` no cae a una default): antes
    // quedaba una grilla vacía sin explicación; ahora el vacío dice qué hacer.
    expect(none).toContain("No tenés indicadores fijados. Sumalos con «Agregar».");
  });

  it("los modales (Ajustes, + Agregar) y el menú «⋯» no se pintan en el primer render", () => {
    const html = screen({
      ...base,
      recent: [
        {
          id: "p1",
          name: "Ana Pérez",
          cond: "Lumbalgia",
          sessionsDone: 1,
          sessionsTotal: 10,
          nextBookingId: "b1",
          nextBookingAt: null,
          nextBookingUpdatedAt: null,
          access: "full",
        },
      ],
    });
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="menu"');
    expect(html).toContain('aria-label="Acciones rápidas: Ana Pérez"');
  });

  it("S5: un paciente con dos sesiones recientes no repite key (sin aviso de React)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const row = {
        id: "p1",
        name: "Ana Pérez",
        cond: "",
        sessionsDone: 1,
        sessionsTotal: 10,
        nextBookingId: null,
        nextBookingAt: null,
        nextBookingUpdatedAt: null,
        access: "full" as const,
      };
      const html = renderToStaticMarkup(<RecentPatients items={[row, { ...row, sessionsDone: 2 }]} />);
      expect(err.mock.calls.flat().join(" ")).not.toMatch(/same key/);
      // Fila sin diagnóstico: texto explícito, no una línea vacía.
      expect(html).toContain("Sin diagnóstico cargado");
    } finally {
      err.mockRestore();
    }
  });
});

describe("[PF1.1-dashboard] calendario", () => {
  it("monthGrid: aritmética de fecha calendario (independiente del TZ del host) y nombre del mes en AR", () => {
    const oct = monthGrid(2026, 9);
    // 1/10/2026 es jueves → 3 celdas vacías (lunes primero).
    expect(oct.cells.slice(0, 4)).toEqual([null, null, null, 1]);
    expect(oct.cells.filter((c) => c != null)).toHaveLength(31);
    expect(oct.cells.length % 7).toBe(0);
    expect(oct.monthName).toBe("octubre");
    expect(monthGrid(2028, 1).cells.filter((c) => c != null)).toHaveLength(29);
    expect(monthGrid(2026, 0).monthName).toBe("enero");
  });

  it("todo `toLocale*` del calendario pasa la zona AR (AGENTS §4)", () => {
    const code = src("components/dashboard/mini-calendar.tsx");
    const calls = code.match(/toLocale\w+\([^)]*\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain('timeZone: "America/Argentina/Buenos_Aires"');
  });
});

describe("[PF1.1-dashboard] Ajustes y menú de perfil", () => {
  it("SettingsModal usa el Modal del design system (diálogo modal con rótulo y botón de cerrar)", () => {
    const html = renderToStaticMarkup(<SettingsModal preferences={DEFAULT_PREFERENCES} onClose={() => {}} />);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Ajustes"/);
    expect(html).toContain('aria-label="Cerrar"');
    // Paletas y KPIs como toggles accesibles.
    expect(html.match(/aria-pressed="true"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Indicadores fijados en Inicio");
  });

  it("handoff PF1.0-a: SUPPORT_HELP_HREF es el de shell-links y las paletas salen de appearance-options", () => {
    expect(SUPPORT_HELP_HREF).toBe(SHELL_SUPPORT_HREF);
    const menu = src("components/global/profile-menu.tsx");
    expect(menu).toMatch(/export \{ SUPPORT_HELP_HREF \} from "@\/components\/layout\/shell-links"/);
    expect(menu).not.toMatch(/=\s*"\/configuracion\?tab=soporte"/);
    expect(menu).not.toContain("tweaks-panel");
    expect(src("components/global/settings-modal.tsx")).toContain('from "@/components/layout/appearance-options"');
  });

  it("el botón «+ Agregar» no pinta el selector hasta abrirlo", () => {
    const html = renderToStaticMarkup(<PinKpiButton currentPinned={["todayCount"]} />);
    expect(html).toContain("Agregar");
    expect(html).not.toContain("Indicadores fijados");
  });
});

describe("[PF1.1-dashboard] bundle (C-PF1/C-PF2) y layout (D1)", () => {
  const FILES = [
    "components/screens/dashboard-screen.tsx",
    "components/dashboard/mini-calendar.tsx",
    "components/dashboard/pin-kpi-button.tsx",
    "components/dashboard/pin-kpi-modal.tsx",
    "components/dashboard/recent-patients.tsx",
    "components/dashboard/recent-patient-menu.tsx",
    "components/dashboard/revenue-card.tsx",
    "components/dashboard/sessions-chart.tsx",
    "components/global/profile-menu.tsx",
    "components/global/settings-modal.tsx",
  ];

  it("ningún archivo del tablero importa `motion` de framer ni usa `<motion.*>`", () => {
    for (const f of FILES) {
      const code = src(f);
      expect(code, f).not.toMatch(/import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*"framer-motion"/);
      expect(code, f).not.toMatch(/<\/?motion\./);
    }
    // Lo que se ve en el primer render (pantalla, KPIs, recientes) ni siquiera importa framer.
    for (const f of ["components/screens/dashboard-screen.tsx", "components/dashboard/recent-patients.tsx"]) {
      expect(src(f), f).not.toContain("framer-motion");
    }
  });

  it("modales y menú se bajan con next/dynamic (ssr: false) y se precargan en hover/foco", () => {
    const pin = src("components/dashboard/pin-kpi-button.tsx");
    expect(pin).toMatch(/import\("\.\/pin-kpi-modal"\)/);
    expect(pin).not.toMatch(/from "\.\/pin-kpi-modal"/);
    expect(pin).toMatch(/onPointerEnter=\{preload\}/);
    const recent = src("components/dashboard/recent-patients.tsx");
    expect(recent).toMatch(/import\("\.\/recent-patient-menu"\)/);
    expect(recent).not.toContain("setBookingStatus");
    const menu = src("components/global/profile-menu.tsx");
    expect(menu).toMatch(/import\("\.\/settings-modal"\)/);
    expect(menu).not.toContain("updateUserPreferences");
    const screenSrc = src("components/screens/dashboard-screen.tsx");
    expect(screenSrc).not.toMatch(/\bSettingsModal\b(?!Lazy)/);
  });

  it("C-PF4: sin router.refresh() tras actions que ya revalidan /dashboard (solo queda el del rechazo, marcado)", () => {
    for (const f of FILES) {
      const lines = src(f).split("\n");
      lines.forEach((l, i) => {
        if (!/router\.refresh\(\)/.test(l) || /^\s*\/\//.test(l) || l.includes("`router.refresh()`")) return;
        const above = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        expect(above, `${f}:${i + 1}`).toContain("refresh-ok:");
      });
    }
  });

  it("D1: una columna bajo 768 sin duplicar el DOM; el aside cede ancho en tablero angosto", () => {
    const css = src("components/dashboard/dashboard.module.css");
    const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(mobile).toMatch(/\.main,\s*\.aside\s*\{\s*display:\s*contents;/);
    expect(mobile).toMatch(/\.oHero\s*\{\s*order:\s*2;/);
    expect(mobile).toMatch(/\.oKpis\s*\{\s*order:\s*3;/);
    expect(mobile).toMatch(/\.oNext\s*\{\s*order:\s*4;/);
    expect(mobile).toMatch(/\.oCalendar\s*\{\s*order:\s*7;/);
    expect(css).toMatch(/@container dash \(max-width: 899px\)/);
    // Sin el ancho fijo inline que desbordaba a 390.
    expect(src("components/screens/dashboard-screen.tsx")).not.toMatch(/width:\s*320/);
    expect(screen()).not.toMatch(/style="[^"]*width:320px/);
  });

  it("reduce motion: las entradas CSS se apagan (el estado final es el natural)", () => {
    const css = src("components/dashboard/dashboard.module.css");
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toMatch(/\.kpi,\s*\.bar,\s*\.shareBar,\s*\.menuPop\s*\{\s*animation:\s*none;/);
  });

  it("C-PF5.4: sin `outline: none` en los archivos del tablero", () => {
    for (const f of FILES) expect(src(f), f).not.toMatch(/outline:\s*(none|["']none["'])/);
  });
});
