/**
 * [CF2-SD] Escritorio de Recepción de /sala (Lista y Flujo) en CF2 (plan §29 D-CF2-3/4/5, brief CF2 A.2):
 * - el tag de cobro («Pagado · medio» / «Por cobrar» / «Retenido», `MoneyBadge` + `copagoTag`) junto al estado en
 *   TODA fila pagada o que debe, solo para quien puede cobrar esa fila (`canCollectRow`); antes solo los atendidos;
 * - KPI «Llamados» en el header; sede y «¿Otro día?» antes de «Pantallas»;
 * - `applyCopagoPaid` = `withCopagoPaid` (la misma fila que arma Recepción de la agenda).
 * Render SSR de los componentes REALES; se mockean la red (server actions), el router, el toast y `next/dynamic`
 * (resuelto en `beforeAll`). Horas AR explícitas y `now` fijo (10:42 AR): corre igual con TZ=UTC y AR.
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

vi.mock("@/components/sala/displays/displays-drawer", () => ({ DisplaysDrawer: () => null }));
vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn(), listAgendaBookings: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/payment-links", () => ({ createPaymentLink: vi.fn(), getPaymentLinkSuggestions: vi.fn(), getPaymentLinkShare: vi.fn(), sendPaymentLinkEmail: vi.fn() }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sala",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { createRef } from "react";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { DeskActionsProvider, type DeskActionsApi } from "@/components/sala/desk/desk-actions";
import { DeskList, deskRowSig } from "@/components/sala/desk/desk-list";
import { DeskFlow, flowRowSig } from "@/components/sala/desk/desk-flow";
import { DeskHeader } from "@/components/sala/desk/desk-header";
import { applyCopagoPaid } from "@/components/sala/desk/desk-pay-modal";
import { SalaLocationContext } from "@/components/sala/sala-location";
import { withCopagoPaid } from "@/lib/booking-collect";
import { deskEntries, deskKpis, deskMenuItems, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";

const DAY = "2026-10-15";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date("2026-10-15T13:42:00Z"); // 10:42 AR

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"), notes: null,
    title: null, description: null, patientAccess: "full", isOverbooked: false, arrivedAt: null, attendingAt: null,
    calledAt: null, roomId: null, canOperate: true, paymentStatus: "UNPAID", ...over,
  };
}

const ROWS: BookingDTO[] = [
  // Llegó y debe (todavía no atendido): antes de CF2 no decía nada hasta terminar.
  dto("saladebe", "10:30", { arrivedAt: at("10:25"), copagoCents: 400_000 }),
  // Pagó por adelantado y todavía no llegó (de p2).
  dto("prepago", "11:30", { practitionerId: "p2", copagoCents: 300_000, paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER" }),
  // Atendido ya cobrado (de p2).
  dto("atpagado", "08:00", { practitionerId: "p2", status: "COMPLETED", copagoCents: 500_000, paymentStatus: "PAID", copagoPaymentMethod: "CASH" }),
  // Atendido que debe.
  dto("atdebe", "09:00", { status: "COMPLETED", copagoCents: 600_000 }),
  // Llamado (KPI «Llamados»).
  dto("llamado", "10:20", { arrivedAt: at("10:10"), calledAt: at("10:40") }),
  // Por llegar sin plata: ningún tag.
  dto("nada", "12:00"),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];

const NO_COBRA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const COBRA_SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.collect"]);
const PROFESIONAL_P2 = deskViewer("p2", ["agenda.viewAll", "agenda.reception", "clinical.read", "billing.collectOwn"]);

function makeLive(viewer: DeskViewer, rows: BookingDTO[] = ROWS): SalaLive {
  return {
    dayKey: DAY, clock: NOW, loading: false, rows, entries: deskEntries(rows, NOW, viewer),
    pendingIds: new Set(), act: vi.fn(async () => {}), replaceRow: vi.fn(), call: null, dismissCall: vi.fn(),
    pulseIds: new Set(), announce: "", practitioners: PRACTITIONERS, rooms: [], roomById: {}, viewer,
  };
}
function api(viewer: DeskViewer): DeskActionsApi {
  return {
    viewer, dayKey: DAY, now: NOW, pendingIds: new Set(),
    practitionerName: (id) => PRACTITIONERS.find((p) => p.id === id)?.name ?? "Profesional", run: vi.fn(), collect: vi.fn(),
  };
}
function list(viewer: DeskViewer): string {
  const live = makeLive(viewer);
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(viewer)}>
      <DeskList live={live} query="" proFilter={null} onProFilter={() => {}} />
    </DeskActionsProvider>
  );
}
function flow(viewer: DeskViewer): string {
  const live = makeLive(viewer);
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(viewer)}>
      <DeskFlow live={live} query="" proFilter={null} onProFilter={() => {}} />
    </DeskActionsProvider>
  );
}
/** La fila de la tabla de la Lista (de su `<tr>` al cierre). */
function tableRow(html: string, id: string): string {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const start = body.indexOf(`data-row="${id}"`);
  return start === -1 ? "" : body.slice(start, body.indexOf("</tr>", start));
}
/** La fila de la línea de tiempo del Flujo. */
function tlRow(html: string, id: string): string {
  const start = html.indexOf(`class="desk-tl-row" data-row="${id}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</li>", start));
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("[CF2-SD] tag de cobro en la Lista", () => {
  it("[CF2-SD1] quien cobra ve «Por cobrar» en el que llegó y debe (antes de atender) y «Pagado · medio» en el prepago", () => {
    const html = list(COBRA_SECRETARIA);
    expect(tableRow(html, "saladebe")).toContain('data-badge="copago-owed"');
    expect(tableRow(html, "saladebe")).toContain("Por cobrar: $");
    expect(tableRow(html, "prepago")).toContain('data-badge="copago-paid"');
    expect(tableRow(html, "prepago")).toContain("Pagado · Transferencia");
    expect(tableRow(html, "nada")).not.toContain("data-badge");
  });

  it("[CF2-SD2] atendido pagado: «Pagado · Efectivo» UNA vez y junto al estado; el que debe: tag y «Cobrar»", () => {
    const html = list(COBRA_SECRETARIA);
    const paid = tableRow(html, "atpagado");
    // Un solo tag (su texto + su aria-label) y ya no el «Pagado» de la primaria.
    expect(count(paid, 'data-badge="copago-')).toBe(1);
    expect(paid).not.toContain("desk-paid");
    const state = paid.slice(paid.indexOf('class="c-state"'), paid.indexOf('class="c-wait"'));
    expect(state).toContain('data-badge="copago-paid"');
    const owed = tableRow(html, "atdebe");
    expect(owed).toContain('data-badge="copago-owed"');
    expect(owed).toContain('data-kind="pay"');
  });

  it("[CF2-SD3] sin cobro: ningún tag de copago; el profesional solo en SUS filas", () => {
    const sin = list(NO_COBRA);
    expect(sin).not.toContain("copago-");
    const pro = list(PROFESIONAL_P2);
    expect(tableRow(pro, "prepago")).toContain('data-badge="copago-paid"');
    expect(tableRow(pro, "atpagado")).toContain('data-badge="copago-paid"');
    expect(tableRow(pro, "saladebe")).not.toContain("copago-");
    expect(tableRow(pro, "atdebe")).not.toContain("copago-");
  });

  it("[CF2-SD4] pagado entero online: «Pagado MP» (nombre «Pagado por Mercado Pago»), nunca «Pagado · Mercado Pago»", () => {
    const rows = [dto("online", "09:30", { status: "COMPLETED", copagoCents: 500_000, paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true })];
    const html = renderToStaticMarkup(
      <DeskActionsProvider value={api(COBRA_SECRETARIA)}>
        <DeskList live={makeLive(COBRA_SECRETARIA, rows)} query="" proFilter={null} onProFilter={() => {}} />
      </DeskActionsProvider>
    );
    expect(tableRow(html, "online")).toContain('aria-label="Pagado por Mercado Pago"');
    expect(html).not.toContain("Pagado · Mercado Pago");
  });

  it("[CF2-SD5] la firma del memo cambia con el medio, la seña y el pago online (si no, el tag quedaba viejo)", () => {
    const v = { pro: PRACTITIONERS[0], room: null, late: false, wait: null, anchor: false, just: false };
    const [e] = deskEntries([ROWS[1]], NOW, COBRA_SECRETARIA);
    const base = deskRowSig(e, v);
    for (const over of [{ copagoPaymentMethod: "CASH" as const }, { onlineDepositCents: 100_000 }, { paidOnline: true }]) {
      const [e2] = deskEntries([{ ...ROWS[1], ...over }], NOW, COBRA_SECRETARIA);
      expect(deskRowSig(e2, v)).not.toBe(base);
    }
    const fv = { pro: PRACTITIONERS[0], room: null, minutes: null, late: false, anchor: false, just: false };
    const [e3] = deskEntries([{ ...ROWS[1], copagoPaymentMethod: "CASH" }], NOW, COBRA_SECRETARIA);
    expect(flowRowSig(e3, fv)).not.toBe(flowRowSig(e, fv));
  });
});

describe("[CF2-SD] tag de cobro en el Flujo", () => {
  it("[CF2-SD6] línea de tiempo: el tag en el que debe, el prepago y el atendido pagado; nada sin cobro", () => {
    const html = flow(COBRA_SECRETARIA);
    expect(tlRow(html, "saladebe")).toContain('data-badge="copago-owed"');
    expect(tlRow(html, "prepago")).toContain("Pagado · Transferencia");
    expect(tlRow(html, "atpagado")).toContain("Pagado · Efectivo");
    expect(tlRow(html, "nada")).not.toContain("data-badge");
    expect(flow(NO_COBRA)).not.toContain("copago-");
  });

  it("[CF2-SD7] ticket de sala de espera: el que llegó y debe lo dice sin abrir nada", () => {
    const html = flow(COBRA_SECRETARIA);
    const start = html.indexOf('class="desk-tk" data-row="saladebe"');
    expect(start).toBeGreaterThan(-1);
    expect(html.slice(start, html.indexOf("</li>", start))).toContain('data-badge="copago-owed"');
  });
});

describe("[CF2-SD] header", () => {
  function header(withLoc: boolean): string {
    const el = (
      <DeskHeader
        dayKey={DAY}
        clock={NOW}
        kpis={deskKpis(deskEntries(ROWS, NOW, NO_COBRA))}
        query=""
        onQuery={() => {}}
        searchRef={createRef<HTMLInputElement>()}
        onNewBooking={() => {}}
        onOpenView={null}
      />
    );
    if (!withLoc) return renderToStaticMarkup(el);
    const value = {
      locations: [
        { id: "a", name: "Centro", isPrimary: true },
        { id: "b", name: "Norte", isPrimary: false },
      ],
      locationId: "b",
      primaryLocationId: "a",
      setLocationId: () => {},
    };
    return renderToStaticMarkup(<SalaLocationContext.Provider value={value}>{el}</SalaLocationContext.Provider>);
  }

  it("[CF2-SD8] KPI «Llamados» (subconjunto de En sala, que no cambia)", () => {
    const html = header(false);
    expect(html).toMatch(/data-kpi="llamados"><dt>Llamados<\/dt><dd class="desk-mono">1<\/dd>/);
    expect(html).toMatch(/data-kpi="en-sala"><dt>En sala<\/dt><dd class="desk-mono">2<\/dd>/);
  });

  it("[CF2-SD9] sede (solo con provider) y «¿Otro día?» a Recepción de la agenda", () => {
    const sin = header(false);
    expect(sin).not.toContain("Todas las sedes");
    expect(sin).toContain('href="/agenda?view=reception"');
    const con = header(true);
    expect(con).toContain("Todas las sedes");
    expect(con).toMatch(/<option value="b" selected="">Norte<\/option>/);
  });
});

describe("[CF2-SD] cobro y link al turno", () => {
  it("[CF2-SD10] applyCopagoPaid = withCopagoPaid (medio null = deshacer → UNPAID)", () => {
    const row = ROWS[3];
    expect(applyCopagoPaid(row, "2026-10-15T13:45:00.000Z", "CASH")).toEqual(withCopagoPaid(row, { updatedAt: "2026-10-15T13:45:00.000Z", method: "CASH" }));
    expect(applyCopagoPaid(row, "2026-10-15T13:45:00.000Z", null).paymentStatus).toBe("UNPAID");
  });

  it("[CF2-SD11] «Ver turno en la agenda» abre ESE turno (open=<id>) en el día y profesional", () => {
    const [e] = deskEntries([ROWS[0]], NOW, COBRA_SECRETARIA);
    const item = deskMenuItems(e, COBRA_SECRETARIA, DAY).find((i) => i.kind === "agenda");
    expect(item && "href" in item ? item.href : "").toBe(`/agenda?date=${DAY}&view=timeline&pros=p1&open=saladebe`);
  });
});
