import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-SB1..6] Tablero de /sala con el cobro a la vista (plan §29 D-CF2-3/4/5, brief CF2 A.2): tag de cobro en la card
 * para quien cobra esa fila, «Por cobrar · N · $ X» en el header con su drawer, sede + «¿Otro día?» antes de
 * «Pantallas» y el link «Ver turno en la agenda» (con `open=`) en el nombre del paciente.
 *
 * Anti-false-green: se renderiza el `SalaClient` REAL (hook, contexto de sede, cara Tablero real); se mockean la red
 * (actions) y `next/dynamic` (resuelto en `beforeAll`, como `sala-board.test.tsx`).
 */
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

vi.mock("@/components/sala/displays/displays-drawer", () => ({ DisplaysDrawer: () => null }));
vi.mock("@/lib/bookings", () => ({ listAgendaBookings: vi.fn(), markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/sala-bookings", () => ({ listSalaBookings: vi.fn() }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { SalaClient } from "@/components/sala/sala-client";
import { SalaCashDrawer } from "@/components/sala/sala-cash-drawer";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { salaCardAgendaHref } from "@/components/sala/sala-card";
import { cashEntries, deskEntries, deskMenuItems, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";
import { salaViewer } from "@/lib/sala-board-state";
import type { SalaLive } from "@/components/sala/sala-live-types";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

const DAY = "2026-10-14";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = at("10:00");

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"), notes: null,
    title: null, description: null, patientAccess: "full", isOverbooked: false, arrivedAt: null,
    attendingAt: null, calledAt: null, roomId: null, canOperate: true, paymentStatus: "UNPAID", ...over,
  };
}

const ROWS = [
  // En sala, debe $ 3.000 (llegó): tag «Por cobrar» en la card.
  dto("debe", "09:50", { arrivedAt: at("09:52"), copagoCents: 300_000 }),
  // En sala, ya pagó en efectivo: «Pagado · Efectivo».
  dto("pago", "09:55", { arrivedAt: at("09:50"), copagoCents: 200_000, paymentStatus: "PAID", copagoPaymentMethod: "CASH" }),
  // Atendidos que deben (no se ven en el tablero: solo en el contador y en «Por cobrar»).
  dto("hecho1", "08:30", { status: "COMPLETED", copagoCents: 500_000 }),
  dto("hecho2", "09:00", { status: "COMPLETED", copagoCents: 400_000, onlineDepositCents: 100_000 }),
  // Atendido de otro profesional que debe.
  dto("ajeno", "08:45", { status: "COMPLETED", copagoCents: 700_000, practitionerId: "p2" }),
  dto("ajeno-sala", "09:58", { arrivedAt: at("09:57"), copagoCents: 100_000, practitionerId: "p2" }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.collect"]);
const SIN_COBRO = salaViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const PRO_P1 = deskViewer("p1", ["agenda.viewAll", "agenda.reception", "billing.collectOwn"]);

function render(over: Partial<Parameters<typeof SalaClient>[0]> = {}) {
  return renderToStaticMarkup(
      <SalaClient
        dayKey={DAY}
        initialNow={NOW}
        initialRows={ROWS}
        practitioners={PRACTITIONERS}
        rooms={[]}
        viewer={SECRETARIA}
        initialGroupBy="practitioner"
        initialLayout="board"
        canManageDisplays
        {...over}
      />
  );
}

/** El HTML de la card del turno `id` (desde su `data-booking-id` hasta la próxima card). */
function card(html: string, id: string): string {
  const i = html.indexOf(`data-booking-id="${id}"`);
  expect(i, id).toBeGreaterThan(-1);
  const j = html.indexOf("data-booking-id=", i + 20);
  return html.slice(i, j === -1 ? undefined : j);
}

describe("[CF2-SB] Tablero de /sala: cobro a la vista", () => {
  it("[CF2-SB1] la Secretaria (cobra todo) ve el tag de cobro en cada card", () => {
    const html = render();
    expect(card(html, "debe")).toContain('data-badge="copago-owed"');
    expect(card(html, "debe")).toContain('aria-label="Por cobrar: $\u00a03.000"');
    expect(card(html, "pago")).toContain('data-badge="copago-paid"');
    expect(card(html, "pago")).toContain("Pagado · Efectivo");
    expect(card(html, "ajeno-sala")).toContain('data-badge="copago-owed"');
  });

  it("[CF2-SB2] sin capability de cobro no hay tag; el profesional (collectOwn) lo ve solo en lo suyo", () => {
    const sin = render({ viewer: SIN_COBRO });
    expect(sin).not.toContain('data-badge="copago-');
    const pro = render({ viewer: PRO_P1 });
    expect(card(pro, "debe")).toContain('data-badge="copago-owed"');
    expect(card(pro, "ajeno-sala")).not.toContain('data-badge="copago-');
  });

  it("[CF2-SB3] header «Por cobrar · N · $ X» para quien cobra (lo que FALTA y solo lo suyo); nada para quien no", () => {
    const html = render();
    // [CF2-ZF1-1] Criterio único (el del tag de la card): atendidos Y los que llegaron. hecho1 5.000 + hecho2
    // (4.000 − seña 1.000) 3.000 + ajeno 7.000 + debe 3.000 (en sala) + ajeno-sala 1.000 = 19.000 en 5 turnos.
    expect(html).toMatch(/<button[^>]*data-sala-cash=""[^>]*aria-haspopup="dialog"[^>]*>/);
    expect(html).toContain("Por cobrar · 5 · $\u00a019.000");
    const pro = render({ viewer: PRO_P1 });
    // hecho1 5.000 + hecho2 3.000 + debe 3.000.
    expect(pro).toContain("Por cobrar · 3 · $\u00a011.000");
    expect(render({ viewer: SIN_COBRO })).not.toContain("data-sala-cash");
  });

  it("[CF2-SB4] sede + «¿Otro día?» antes de «Pantallas» (handoff A-SL)", () => {
    const html = render({
      locations: [
        { id: "l1", name: "Centro", isPrimary: true },
        { id: "l2", name: "Norte", isPrimary: false },
      ],
    });
    const sede = html.indexOf('class="sala-loc"');
    const otro = html.indexOf('class="sala-otherday"');
    const pantallas = html.indexOf("Pantallas");
    expect(sede).toBeGreaterThan(-1);
    expect(otro).toBeGreaterThan(sede);
    expect(pantallas).toBeGreaterThan(otro);
    expect(html).toContain('href="/agenda?view=reception"');
  });

  it("[CF2-SB5] el nombre del paciente lleva a la agenda con `open=` (mismo href que el menú del escritorio)", () => {
    const html = render();
    const entry = deskEntries(ROWS, new Date(NOW), SECRETARIA).find((e) => e.row.id === "debe")!;
    const fromMenu = deskMenuItems(entry, SECRETARIA, DAY).find((i) => i.kind === "agenda");
    const href = salaCardAgendaHref(entry.row, new Date(NOW));
    expect(fromMenu && "href" in fromMenu ? fromMenu.href : null).toBe(href);
    expect(href).toBe("/agenda?date=2026-10-14&view=timeline&pros=p1&open=debe");
    expect(card(html, "debe")).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
    expect(card(html, "debe")).toContain('aria-label="Ver turno en la agenda: Paciente debe, 09:50"');
  });

  it("[CF2-SB5b] el día del link es el AR del reloj, también pasada la medianoche UTC (TZ=UTC)", () => {
    // 22:30 AR = 01:30 UTC del día siguiente: un `toISOString().slice(0,10)` daría el 15.
    const row = dto("noche", "22:30");
    expect(salaCardAgendaHref(row, new Date(`${DAY}T22:40:00-03:00`))).toContain("date=2026-10-14");
  });
});

function liveFor(viewer: DeskViewer): SalaLive {
  const now = new Date(NOW);
  return {
    dayKey: DAY,
    clock: now,
    loading: false,
    rows: ROWS,
    entries: deskEntries(ROWS, now, viewer),
    pendingIds: new Set(),
    act: async () => {},
    replaceRow: () => {},
    call: null,
    dismissCall: () => {},
    pulseIds: new Set(),
    announce: "",
    practitioners: PRACTITIONERS,
    rooms: [],
    roomById: null,
    viewer,
  };
}

describe("[CF2-SB6] drawer «Por cobrar» del Tablero", () => {
  it("lista lo que el viewer cobra (cronológico) con el monto que falta, el profesional y «Cobrar»", () => {
    const live = liveFor(SECRETARIA);
    const html = renderToStaticMarkup(<ConfirmProvider><SalaCashDrawer open onClose={() => {}} live={live} /></ConfirmProvider>);
    const expected = cashEntries(live.entries, SECRETARIA).entries.map((e) => e.row.id);
    // [CF2-ZF1-1] Criterio único (el del tag de la card): también los que llegaron y deben («debe», «ajeno-sala»).
    expect(expected).toEqual(["hecho1", "ajeno", "hecho2", "debe", "ajeno-sala"]);
    const order = ["Paciente hecho1", "Paciente ajeno", "Paciente hecho2", "Paciente debe", "Paciente ajeno-sala"].map((n) => html.indexOf(n));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("$\u00a019.000");
    expect(html).toContain("$\u00a03.000"); // hecho2: 4.000 − seña 1.000
    expect(html).toContain("Bruno Sosa");
    expect(html).toContain('aria-label="Cobrar: Paciente hecho1, 08:30"');
    expect(html).toContain('aria-label="Cobrar: Paciente debe, 09:50"');
    // «5 turnos», no «turnos atendidos»: la lista suma a los que están en la sala.
    expect(html).toContain("5 turnos · falta cobrar");
    expect(html).not.toContain("atendidos");
    // Lo ya pagado no está.
    expect(html).not.toContain("Paciente pago");
  });

  it("profesional: solo lo suyo", () => {
    const html = renderToStaticMarkup(<ConfirmProvider><SalaCashDrawer open onClose={() => {}} live={liveFor(PRO_P1)} /></ConfirmProvider>);
    expect(html).toContain("Paciente hecho1");
    expect(html).toContain("Paciente debe");
    expect(html).not.toContain("Paciente ajeno");
    expect(html).toContain("$\u00a011.000");
  });

  it("sin nada por cobrar: estado vacío", () => {
    const live = { ...liveFor(SECRETARIA), entries: [] };
    const html = renderToStaticMarkup(<ConfirmProvider><SalaCashDrawer open onClose={() => {}} live={live} /></ConfirmProvider>);
    expect(html).toContain("No hay cobros pendientes");
    expect(html).not.toContain("Cobrar:");
  });
});
