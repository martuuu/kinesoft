/**
 * [MB-1c] /sala en el celular (C-MB3 Sala/Recepción) y en escritorio chico (C-MB4): secciones colapsables con conteo,
 * «Esperando» primero, targets de 44 px bajo 768 y la densidad del Tablero a 625/695 de alto. Render SSR de los
 * componentes REALES (`renderToStaticMarkup`); las medidas en px las verifica el revisor visual (Playwright), acá se
 * fija el contrato del markup y del CSS que las produce. Horas AR explícitas: corre igual con TZ=UTC y AR.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<import("react").ComponentType<Record<string, unknown>>>) => {
    let Loaded: import("react").ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  let seen = -1;
  while (seen !== dynamicLoads.length) {
    seen = dynamicLoads.length;
    await Promise.all(dynamicLoads);
  }
});
vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn(), listAgendaBookings: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("@/lib/sala-bookings", () => ({ listSalaBookings: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sala",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { SalaClient } from "@/components/sala/sala-client";
import { SALA_CSS } from "@/components/sala/sala-css";
import { DESK_CSS } from "@/components/sala/desk/desk-css";
import { DeskList, DESK_LIST_CSS } from "@/components/sala/desk/desk-list";
import { DeskFlow, DESK_FLOW_CSS } from "@/components/sala/desk/desk-flow";
import { DeskActionsProvider, type DeskActionsApi } from "@/components/sala/desk/desk-actions";
import { foldLabel } from "@/components/sala/sala-fold";
import { deskEntries, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";

const DAY = "2026-10-14";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(at("10:45"));

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: "COND-SECRETA", obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"),
    notes: "NOTA-SECRETA", title: "DX-SECRETO", description: "DESC-SECRETA", patientAccess: "full",
    isOverbooked: false, arrivedAt: null, attendingAt: null, calledAt: null, roomId: null, canOperate: true,
    paymentStatus: "UNPAID", ...over,
  };
}

const ROWS: BookingDTO[] = [
  dto("box", "10:00", { arrivedAt: at("09:55"), attendingAt: at("10:05") }),
  dto("sala", "10:40", { arrivedAt: at("10:35") }),
  dto("prox", "11:00", { practitionerId: "p2" }),
  dto("hecho", "09:00", { status: "COMPLETED", practitionerId: "p2" }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);

function makeLive(viewer: DeskViewer): SalaLive {
  return {
    dayKey: DAY, clock: NOW, loading: false, rows: ROWS, entries: deskEntries(ROWS, NOW, viewer),
    pendingIds: new Set(), act: vi.fn(async () => {}), replaceRow: vi.fn(), call: null, dismissCall: vi.fn(),
    pulseIds: new Set(), announce: "", practitioners: PRACTITIONERS, rooms: [], roomById: null, viewer,
  };
}
const api = (viewer: DeskViewer): DeskActionsApi => ({
  viewer, dayKey: DAY, now: NOW, pendingIds: new Set(), practitionerName: () => "Ana Pérez", run: vi.fn(), collect: vi.fn(),
});
const face = (el: JSX.Element) => renderToStaticMarkup(<DeskActionsProvider value={api(SECRETARIA)}>{el}</DeskActionsProvider>);

/** Todos los botones de pliegue del HTML: [aria-expanded, aria-controls, aria-label]. */
function folds(html: string): Array<{ expanded: string; controls: string; label: string }> {
  return Array.from(html.matchAll(/<button[^>]*class="[^"]*\b(?:desk-fold|sala-col-fold)\b[^"]*"[^>]*>/g), (m) => {
    const tag = m[0];
    const attr = (n: string) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? "";
    return { expanded: attr("aria-expanded"), controls: attr("aria-controls"), label: attr("aria-label") };
  });
}

describe("[MB-1c] pliegue de secciones (C-MB3)", () => {
  it("foldLabel dice qué hace el botón y el conteo", () => {
    expect(foldLabel("Sala de espera", 3, true)).toBe("Ocultar Sala de espera (3)");
    expect(foldLabel("Sala de espera", 3, false)).toBe("Mostrar Sala de espera (3)");
  });

  it("Lista y panel: cada card (sala, próximos, en atención, turnos de hoy) se pliega, abierta al cargar, con su lista como control", () => {
    const html = face(<DeskList live={makeLive(SECRETARIA)} query="" proFilter={null} onProFilter={() => {}} />);
    const f = folds(html);
    expect(f.map((x) => x.label)).toEqual([
      "Ocultar Turnos de hoy (4)",
      "Ocultar Sala de espera (1)",
      "Ocultar Próximos 30 min (1)",
      "Ocultar En atención (1)",
    ]);
    for (const x of f) {
      expect(x.expanded).toBe("true");
      expect(html).toContain(`id="${x.controls}"`);
    }
    // PD-13 sigue intacto con el markup nuevo.
    expect(html).not.toMatch(/SECRET|COND-/);
  });

  it("Flujo: los carriles y «Hoy» se pliegan; cada carril dice cuál es (la sala va primero en el celular)", () => {
    const html = face(<DeskFlow live={makeLive(SECRETARIA)} query="" proFilter={null} onProFilter={() => {}} />);
    expect(folds(html).map((x) => x.label)).toEqual([
      "Ocultar Hoy (4)",
      "Ocultar Llegan pronto (1)",
      "Ocultar Sala de espera (1)",
      "Ocultar En atención (1)",
    ]);
    expect(html).toContain('data-lane="wait"');
    expect(html).toContain('data-lane="soon"');
    expect(html).not.toMatch(/SECRET|COND-/);
  });

  it("Tablero: cada columna se pliega con su total y marca si tiene gente esperando", () => {
    const html = renderToStaticMarkup(
      <SalaClient
        dayKey={DAY}
        initialNow={NOW.toISOString()}
        initialRows={ROWS}
        practitioners={PRACTITIONERS}
        rooms={[]}
        viewer={SECRETARIA}
        initialGroupBy="practitioner"
        initialLayout="board"
      />
    );
    const f = folds(html);
    expect(f.length).toBe(2);
    expect(f[0].label).toMatch(/^Ocultar Ana Pérez \(\d+\)$/);
    expect(f.every((x) => x.expanded === "true")).toBe(true);
    for (const x of f) expect(html).toContain(`id="${x.controls}"`);
    // Ana tiene a «sala» esperando: su columna va primera en el celular (CSS `order`).
    expect(html).toMatch(/<section class="sala-col"[^>]*data-waiting="true"/);
    expect(html).not.toMatch(/SECRET|COND-/);
  });
});

describe("[MB-1c] CSS: celular y escritorio chico", () => {
  it("el Tablero apila en una columna bajo 768 (no 640) y lleva los toques a 44 px", () => {
    const mobile = SALA_CSS.slice(SALA_CSS.indexOf("@media (max-width: 767px)"));
    expect(SALA_CSS).not.toContain("@media (max-width: 640px)");
    expect(mobile).toContain(".sala-board { flex-direction: column;");
    expect(mobile).toMatch(/\.sala-btn \{[^}]*min-height: 44px/);
    expect(mobile).toMatch(/\.sala-col\[data-waiting=true\] \{ order: -1; \}/);
    expect(mobile).toMatch(/\.sala-col\[data-collapsed=true\] \.sala-col-body/);
    // El pliegue no existe en escritorio.
    expect(SALA_CSS).toMatch(/^\.sala-col-fold \{ display: none;/m);
  });

  it("el Tablero se compacta solo en escritorio de poco alto (C-MB4), sin tocar el escritorio alto", () => {
    expect(SALA_CSS).toContain("@media (min-width: 768px) and (max-height: 800px)");
    const short = SALA_CSS.slice(SALA_CSS.indexOf("@media (min-width: 768px) and (max-height: 800px)"));
    expect(short).toMatch(/\.sala \{[^}]*height: calc\(100dvh - 28px\)/);
    expect(short).toMatch(/\.sala-col \{[^}]*max-height: 100%/);
  });

  it("el header del escritorio de Recepción mide 56 px (franja ≤ 56, C-MB4)", () => {
    expect(DESK_CSS).toMatch(/\.desk-head \{[^}]*min-height: 54px;[^}]*padding: 7px 12px 7px 20px/);
  });

  it("en una columna los carriles y cards se pliegan, la sala va primero y el ⋯ del ticket mide 44", () => {
    expect(DESK_FLOW_CSS).toMatch(/\.desk-flow-lane\[data-lane=wait\] \{ order: -1; \}/);
    expect(DESK_FLOW_CSS).toMatch(/\.desk-tk-a \.desk-act\[data-kind=more\] \{ flex: 0 0 44px; \}/);
    expect(DESK_FLOW_CSS).toContain("60dvh");
    expect(DESK_FLOW_CSS).toMatch(/\.desk-flow-card\[data-collapsed=true\] \.desk-flow-scroll \{ display: none; \}/);
    expect(DESK_LIST_CSS).toMatch(/\.dl-card\[data-collapsed=true\] \.dl-scroll/);
    expect(DESK_CSS).toMatch(/\.desk-fold \{ display: none;/);
  });

  it("los <style> siguen sin caracteres que React escapa en el HTML del server", () => {
    for (const css of [SALA_CSS, DESK_CSS, DESK_LIST_CSS, DESK_FLOW_CSS]) expect(css).not.toMatch(/[<>"'&]/);
  });
});
