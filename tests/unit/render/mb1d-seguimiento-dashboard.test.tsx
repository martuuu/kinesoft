/**
 * [MB-1d · C-MB3] Seguimiento y Dashboard a 390.
 *
 * - `pf1-seguimiento-ejercicio-390`: la fila de ejercicio de `/seguimiento/[id]` era una grilla inline de 6 columnas
 *   (`28px 1fr 60px 60px auto auto`) y a 390 el nombre quedaba en ~40 px. Ahora la grilla va por clase: escritorio
 *   igual, < 640 en 2 líneas (n.º · nombre · quitar / series · reps · estado). Acciones a 44 px < 768.
 * - Dashboard con la barra inferior: el orden de PF1 se mantiene y los íconos sueltos (campana, flechas del
 *   calendario, «⋯» de recientes, «+ Agregar») llegan a 44 px < 768 por clase (inline no se pisa desde una media query).
 *
 * Vitest en `node`: markup real por SSR + CSS Module real. Se mockean red, router, `next/dynamic` y Tweaks.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/seguimiento/ses3",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/sessions", () => ({
  addSessionExercise: async () => ({ ok: true, data: undefined }),
  completeSessionFromSeguimiento: async () => ({ ok: true, data: {} }),
  loadSessionEvolution: async () => ({ ok: true, data: { loaded: true } }),
  removeSessionExercise: async () => ({ ok: true, data: undefined }),
  reorderSessionExercises: async () => ({ ok: true, data: undefined }),
  updateSessionExercise: async () => ({ ok: true, data: undefined }),
  updateSessionMeta: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/plans-adopt", () => ({
  previewGeneratePlanBookings: async () => ({ ok: false, error: "x" }),
  generatePlanBookings: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/exercises", () => ({ listExercises: async () => [] }));
vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
  voidClinicalNote: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/components/clinical-notes/note-editor-drawer", () => ({ NoteEditorDrawer: () => null }));
vi.mock("@/lib/dashboard", () => ({ getSessionsChart: vi.fn(), getMonthBookingDays: vi.fn(), getRevenue: vi.fn() }));
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
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ t: { dashChrome: "sidebar", palette: "sky" }, set: () => {} }),
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { SessionDetail, type SessionDTO } from "@/components/seguimiento/session-detail";
import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { PinKpiButton } from "@/components/dashboard/pin-kpi-button";
import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import type { DashboardData } from "@/lib/dashboard";

const ROOT = join(__dirname, "..", "..", "..");
const css = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SEG_CSS = css("components/seguimiento/seguimiento.module.css");
const DASH_CSS = css("components/dashboard/dashboard.module.css");

function mediaBlocks(source: string, query: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`@media (${query})`, from);
    if (at < 0) break;
    const open = source.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(open + 1, i - 1));
    from = i;
  }
  return out.join("\n");
}
function rule(source: string, selector: string): string {
  const re = new RegExp(`(^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(source)?.[2] ?? "";
}

const html = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>,
  );

function detail(): SessionDTO {
  return {
    id: "ses3",
    programId: "prog1",
    practitionerId: "pr1",
    index: 7,
    scheduledFor: new Date("2026-10-06T12:00:00.000Z"),
    completedAt: null,
    notes: null,
    rpe: null,
    paInPre: null,
    paInPost: null,
    title: null,
    priceCents: null,
    archivedAt: null,
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ordinal: 3,
    totalLive: 10,
    exercises: [
      {
        id: "sx1",
        exerciseId: "ex1",
        order: 1,
        status: "PENDING",
        sets: 3,
        reps: 12,
        notes: null,
        exercise: { id: "ex1", name: "Puente de glúteos con banda elástica", muscleGroups: "Glúteos, isquios" },
      },
    ],
    program: {
      id: "prog1",
      patientId: "pat1",
      title: "Lumbalgia",
      discipline: "KINESIOLOGY",
      totalSessions: 12,
      patient: { id: "pat1", firstName: "Ana", lastName: "Pérez" },
      case: null,
      sessions: [
        { id: "ses3", index: 7, scheduledFor: new Date("2026-10-06T12:00:00.000Z"), completedAt: null, paInPre: null, paInPost: null },
      ],
    },
  } as unknown as SessionDTO;
}

describe("[MB-1d] pf1-seguimiento-ejercicio-390: fila de ejercicio en 2 líneas < 640", () => {
  const out = html(<SessionDetail session={detail()} scheduledLabel="mar 06/10 09:00" />);

  it("la fila ya no es la grilla inline de 6 columnas: va por clase y cada celda tiene su área", () => {
    expect(out).toContain("Puente de glúteos");
    expect(out).not.toContain("grid-template-columns:28px 1fr 60px 60px auto auto");
    expect(out).toMatch(/class="[^"]*exRow[^"]*"/);
    for (const cell of ["exOrder", "exName", "exSets", "exReps", "exStatus", "exRemove"]) {
      expect(out, cell).toMatch(new RegExp(`class="[^"]*${cell}[^"]*"`));
    }
  });

  it("escritorio: las mismas 6 columnas de antes; < 640: dos líneas con áreas nombradas", () => {
    expect(rule(SEG_CSS, ".exRow")).toMatch(/grid-template-columns:\s*28px 1fr 60px 60px auto auto/);
    const narrow = mediaBlocks(SEG_CSS, "max-width: 639px");
    const r = rule(narrow, ".exRow");
    expect(r).toMatch(/grid-template-areas:\s*"order name name name remove"\s*"\. sets reps status status"/);
    expect(rule(narrow, ".exName")).toMatch(/grid-area:\s*name/);
    expect(rule(narrow, ".exStatus")).toMatch(/grid-area:\s*status/);
  });

  it("< 768: estado y quitar con área táctil de 44 px (por clase, sin tamaño inline que la pise)", () => {
    const mobile = mediaBlocks(SEG_CSS, "max-width: 767px");
    expect(rule(mobile, ".exTap")).toMatch(/min-height:\s*44px/);
    expect(rule(mobile, ".exTap")).toMatch(/min-width:\s*44px/);
    const remove = /<button[^>]*aria-label="Quitar ejercicio"[^>]*>/.exec(out)![0];
    expect(remove).toMatch(/class="[^"]*exTap/);
    expect(out).toMatch(/<button[^>]*class="[^"]*exTap[^"]*"[^>]*>Marcar/);
  });
});

const dashBase: DashboardData = {
  greetingName: "Martina",
  todayCount: 0,
  weeklyBars: ["L", "M", "M", "J", "V", "S", "D"].map((d) => ({ d, c: 0, a: 0 })),
  pinned: {
    activePatients: 0,
    weekSessions: 0,
    activePrograms: 0,
    adherencePct: null,
    newPatientsMonth: 0,
    nearingDischarge: 0,
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
} as unknown as DashboardData;

describe("[MB-1d] Dashboard con la barra inferior", () => {
  it("orden de PF1 < 768 intacto (hero → KPIs → próximos → recientes/gráfico → ingresos → calendario)", () => {
    const mobile = mediaBlocks(DASH_CSS, "max-width: 767px");
    const order = (sel: string) => Number(/order:\s*(-?\d+)/.exec(rule(mobile, sel))?.[1]);
    expect(order(".oHero")).toBeLessThan(order(".oKpis"));
    expect(order(".oKpis")).toBeLessThan(order(".oNext"));
    expect(order(".oNext")).toBeLessThan(order(".oBottom"));
    expect(order(".oBottom")).toBeLessThan(order(".oRevenue"));
    expect(order(".oRevenue")).toBeLessThan(order(".oCalendar"));
  });

  it("< 768: `.tap` lleva los íconos sueltos a 44 px; escritorio no la define (sin cambios)", () => {
    const mobile = mediaBlocks(DASH_CSS, "max-width: 767px");
    expect(rule(mobile, ".tap")).toMatch(/min-width:\s*44px/);
    expect(rule(mobile, ".tap")).toMatch(/min-height:\s*44px/);
    const outside = DASH_CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
    expect(rule(outside, ".tap")).toBe("");
  });

  it("campana, flechas del calendario, «⋯» de recientes y «+ Agregar» llevan `.tap` y sin min-height inline", () => {
    const bell = html(<NotificationsBell />);
    expect(/<button[^>]*aria-label="Notificaciones"[^>]*>/.exec(bell)![0]).toMatch(/class="[^"]*tap/);
    const cal = html(<MiniCalendar initialBookingDays={[]} />);
    const chevs = [...cal.matchAll(/<button[^>]*aria-label="Mes (anterior|siguiente)"[^>]*>/g)].map((m) => m[0]);
    expect(chevs).toHaveLength(2);
    for (const c of chevs) expect(c).toMatch(/class="[^"]*tap/);
    const recent = html(
      <RecentPatients
        items={[
          {
            id: "p1",
            name: "Ana Pérez",
            cond: "Lumbalgia",
            sessionsDone: 2,
            sessionsTotal: 10,
            nextBookingId: null,
            nextBookingAt: null,
            nextBookingUpdatedAt: null,
            access: "full",
          },
        ]}
      />,
    );
    expect(/<button[^>]*aria-label="Acciones rápidas: Ana Pérez"[^>]*>/.exec(recent)![0]).toMatch(/class="[^"]*tap/);
    const pin = html(<PinKpiButton currentPinned={[]} revenueScope="none" />);
    const pinBtn = /<button[^>]*>/.exec(pin)![0];
    expect(pinBtn).toMatch(/class="[^"]*tap/);
    expect(pinBtn).not.toMatch(/min-height/);
  });

  it("el tablero real sigue pintando (smoke con sidebar)", () => {
    const out = html(<DashboardScreen data={dashBase} preferences={DEFAULT_PREFERENCES} initialBookingDays={[]} />);
    expect(out).toContain("Hoy tenés");
  });
});

void React;
