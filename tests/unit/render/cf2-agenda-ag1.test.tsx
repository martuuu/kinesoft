import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-AG1] Cableado de la agenda (plan §29 D-CF2-1, D-CF2-3, D-CF2-6; brief CF2 A.1-A.3):
 * - selección inicial por fuente (URL > guardada > rol), resuelta en `page.tsx` con `initialPractitionerSelection`;
 * - la selección se guarda SOLO por clic en los chips, con debounce y en silencio;
 * - `?open=<id>` arranca con el drawer de ese turno abierto;
 * - `MoneyViewerContext`: el tag del copago lo ve quien puede cobrar ese turno (`canCollectCopago`);
 * - Semana con un solo encabezado y la tira picker de Día con el candado de cada día.
 * Render estático (sin jsdom): los effects no corren; los clics se prueban invocando el `onChange` real que la agenda
 * le pasa a los chips (capturado con un mock del componente de chips, que es la vista, no la lógica bajo test).
 */

const { dynamicLoads, chips, drawer, prefsSpy, toastSpy, pageMocks } = vi.hoisted(() => ({
  dynamicLoads: [] as Promise<unknown>[],
  chips: { onChange: null as null | ((ids: string[]) => void), selectedIds: null as null | string[] },
  drawer: { calls: [] as Array<{ booking: { id: string; updatedAt: string } | null }> },
  prefsSpy: { calls: [] as unknown[], result: { ok: true } as unknown },
  toastSpy: { error: [] as unknown[] },
  pageMocks: { actor: null as unknown, loaded: null as unknown },
}));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy({}, { get: (_t: object, k: string | symbol) => (k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} })) }),
}));
vi.mock("@/components/providers/realtime-provider", () => ({
  useRealtime: () => ({ state: "off", subscribe: () => () => {}, onResync: () => () => {}, resync: () => {} }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false } }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({
    success: () => {},
    error: (...a: unknown[]) => toastSpy.error.push(a),
    warning: () => {},
    info: () => {},
    show: () => {},
    dismiss: () => {},
  }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
// La red: la action de preferencias. Se registra cada patch para afirmar QUÉ se guardó y cuándo.
vi.mock("@/lib/preferences", () => ({
  updateAgendaViewPrefs: (patch: unknown) => {
    prefsSpy.calls.push(patch);
    return prefsSpy.result instanceof Error ? Promise.reject(prefsSpy.result) : Promise.resolve(prefsSpy.result);
  },
}));
// La vista de chips (UI, chunk aparte): se captura el `onChange` que le pasa la agenda = el setter real bajo test.
vi.mock("@/components/agenda/practitioner-chips", () => ({
  PractitionerChips: (p: { onChange: (ids: string[]) => void; selectedIds: string[] }) => {
    chips.onChange = p.onChange;
    chips.selectedIds = p.selectedIds;
    return null;
  },
}));
// El drawer (chunk `ssr:false`): se registra qué turno recibe.
vi.mock("@/components/agenda/booking-drawer", () => ({
  BookingDrawer: (p: { booking: { id: string; updatedAt: string } | null }) => {
    drawer.calls.push({ booking: p.booking });
    return null;
  },
}));
vi.mock("@/lib/booking-share-actions", () => ({ getPatientShareContact: async () => ({ status: "hidden" }) }));
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/exercises", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/diagnoses", () => proxy());
vi.mock("@/lib/conditions", () => proxy());
vi.mock("@/lib/clinical-notes", () => proxy());
vi.mock("@/lib/clinical-notes-read", () => proxy());
vi.mock("@/lib/patient-documents", () => proxy());
vi.mock("@/lib/online-charges-read", () => proxy());
vi.mock("@/lib/payment-links", () => proxy());
vi.mock("@/lib/agenda-month", () => proxy());
// page.tsx: la sesión (cookie) y el loader (DB) son el borde; el borde cliente (`AgendaFromWire`) se reemplaza por un
// stub para leer las props que la página le arma.
vi.mock("@/lib/session", () => ({ getActor: async () => pageMocks.actor }));
vi.mock("@/lib/agenda-page-loader", () => ({ loadAgendaPage: async () => pageMocks.loaded }));
vi.mock("@/app/(app)/agenda/agenda-from-wire", () => ({ AgendaFromWire: () => null }));

import {
  AgendaClient,
  createSelectionSaver,
  SELECTION_SAVE_DEBOUNCE_MS,
  withoutOpenParam,
  withProsParam,
  type Props,
} from "@/components/agenda/agenda-client";
import AgendaPage from "@/app/(app)/agenda/page";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { DEFAULT_AGENDA_VIEW_PREFS, type AgendaViewPrefs } from "@/lib/preferences-constants";
import type { AgendaAvailability } from "@/lib/availability-actions-types";

const DAY = "2026-10-05"; // lunes
const ar = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-03:00`).toISOString();
let seq = 0;
function bk(pid: string, hhmm: string, over: Partial<BookingDTO> = {}): BookingDTO {
  seq++;
  return {
    id: `b${seq}`,
    scheduledFor: ar(DAY, hhmm),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "svc-kine",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: pid,
    patientId: `pt${seq}`,
    patientName: `Paciente ${seq}`,
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: ar(DAY, "08:0" + (seq % 10)),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    isOverbooked: false,
    arrivedAt: null,
    attendingAt: null,
    locationId: null,
    locationName: "Principal",
    isTelemedicine: false,
    telemedicineUrl: null,
    clinicalHidden: false,
    ...over,
  };
}
const pracs = [
  { id: "p1", name: "Ana Pérez" },
  { id: "p2", name: "Bruno Díaz" },
  { id: "p3", name: "Carla Gómez" },
];
// Los dos llegaron y deben el copago: «Por cobrar» para quien puede cobrar cada uno.
const bookings = [
  bk("p1", "09:00", { paymentStatus: "UNPAID", arrivedAt: ar(DAY, "08:55") }),
  bk("p2", "10:00", { paymentStatus: "UNPAID", arrivedAt: ar(DAY, "09:55") }),
];
const openLock = { status: "open" as const, reason: null, detail: null, blockIds: [] };
const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10);
  const locked = d === "2026-10-06";
  return {
    dayKey: d,
    clinic: openLock,
    byPractitioner: Object.fromEntries(
      pracs.map((p) => [
        p.id,
        {
          scheduledRanges: [{ startMin: 480, endMin: 1140, locationId: "L1" }],
          workingRanges: locked ? [] : [{ startMin: 480, endMin: 1140, locationId: "L1" }],
          dayLockState: locked
            ? { status: "locked" as const, reason: "bloqueo" as const, detail: "Feriado", blockIds: ["blk1"] }
            : openLock,
        },
      ])
    ),
  };
});
const availability: AgendaAvailability = {
  from: DAY,
  to: "2026-10-11",
  locationId: null,
  primaryLocationId: "L1",
  tenantHours: { startMin: 480, endMin: 1140 },
  practitioners: pracs.map((p) => ({ practitionerId: p.id, isFallback: false })),
  days,
  blocks: [],
  capOf: Object.fromEntries(pracs.map((p) => [p.id, { "svc-kine": null }])),
  enabledServiceIds: Object.fromEntries(pracs.map((p) => [p.id, ["svc-kine"]])),
};
const base: Props = {
  view: "timeline",
  dayKey: DAY,
  weekStartKey: DAY,
  bookings,
  services: [{ id: "svc-kine", name: "Kinesio", durationMin: 45, priceCents: 1000, color: "#3b82f6" }],
  practitioners: pracs,
  patients: [],
  insurers: [],
  businessHours: { start: 8, end: 19, slotMinutes: 30 },
  viewer: { userId: "u1", practitionerId: "p1" },
  capabilities: ["agenda.viewAll", "agenda.manageBlocks"],
  locations: [{ id: "L1", name: "Principal", isPrimary: true }],
  agendaPrefs: { ...DEFAULT_AGENDA_VIEW_PREFS },
  initialAvailability: availability,
};
const render = (p: Partial<Props> = {}) => renderToStaticMarkup(<AgendaClient {...base} {...p} />);
const flushMicrotasks = () => new Promise<void>((res) => queueMicrotask(res)).then(() => Promise.resolve());

beforeAll(async () => {
  await Promise.all(dynamicLoads);
});
afterEach(() => {
  vi.useRealTimers();
  prefsSpy.calls.length = 0;
  prefsSpy.result = { ok: true };
  toastSpy.error.length = 0;
  drawer.calls.length = 0;
  chips.onChange = null;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG1-1] selección inicial por fuente (page.tsx → initialPractitionerSelection)", () => {
  const loaded = (agendaView: AgendaViewPrefs) => ({
    bookings: [],
    services: [],
    practitioners: pracs,
    patients: [],
    insurers: [],
    businessHours: { start: 8, end: 19, slotMinutes: 30 },
    locations: [{ id: "L1", name: "Principal", isPrimary: true }],
    rooms: [],
    agendaView,
    capabilities: ["agenda.viewAll"],
    availability: null,
    onlineMoney: { enabled: false },
    whatsapp: false,
  });
  const actor = (practitionerId: string | null) => ({
    userId: "u1",
    tenantId: "t1",
    practitionerId,
    entitlements: { vertical: "KINESIOLOGIA", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] },
  });
  async function pageProps(searchParams: Record<string, string>, opts: { saved?: string[]; own: string | null }) {
    pageMocks.actor = actor(opts.own);
    pageMocks.loaded = loaded({
      ...DEFAULT_AGENDA_VIEW_PREFS,
      ...(opts.saved !== undefined ? { selectedPractitionerIds: opts.saved } : {}),
    });
    const el = (await AgendaPage({ searchParams })) as React.ReactElement<Record<string, unknown>>;
    return el.props;
  }

  it("[CF2-AG1-1a] `?pros=` válido manda sobre la guardada y el rol (source url)", async () => {
    const p = await pageProps({ pros: "p3" }, { saved: ["p2"], own: "p1" });
    expect(p.initialSelectedIds).toEqual(["p3"]);
    expect(p.initialSelectionSource).toBe("url");
  });
  it("[CF2-AG1-1b] sin URL, la guardada (filtrada a los que existen); `[]` guardado = eligió «Todos»", async () => {
    const p = await pageProps({}, { saved: ["gone", "p2"], own: "p1" });
    expect(p.initialSelectedIds).toEqual(["p2"]);
    expect(p.initialSelectionSource).toBe("saved");
    const all = await pageProps({}, { saved: [], own: "p1" });
    expect(all.initialSelectedIds).toEqual([]);
    expect(all.initialSelectionSource).toBe("saved");
  });
  it("[CF2-AG1-1c] nunca eligió: el profesional ve su agenda; la Secretaria (sin profesional), Todos", async () => {
    const pro = await pageProps({}, { own: "p1" });
    expect(pro.initialSelectedIds).toEqual(["p1"]);
    expect(pro.initialSelectionSource).toBe("default");
    const sec = await pageProps({}, { own: null });
    expect(sec.initialSelectedIds).toEqual([]);
    expect(sec.initialSelectionSource).toBe("default");
  });
  it("[CF2-AG1-1d] `?open=` viaja a la agenda; sin él, null", async () => {
    expect((await pageProps({ open: "b9" }, { own: null })).openBookingId).toBe("b9");
    expect((await pageProps({}, { own: null })).openBookingId).toBeNull();
  });
  it("[CF2-AG1-1e] la selección inicial llega a los chips tal cual", () => {
    render({ initialSelectedIds: ["p2"], initialSelectionSource: "saved" });
    expect(chips.selectedIds).toEqual(["p2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG1-2] la selección se guarda SOLO por clic, con debounce y en silencio", () => {
  it("[CF2-AG1-2a] abrir la agenda (guardada o rol) no escribe nada", async () => {
    vi.useFakeTimers();
    render({ initialSelectedIds: ["p1"], initialSelectionSource: "default" });
    render({ initialSelectedIds: ["p2"], initialSelectionSource: "saved" });
    render({ initialSelectedIds: ["p3"], initialSelectionSource: "url" });
    vi.advanceTimersByTime(10 * SELECTION_SAVE_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(prefsSpy.calls).toEqual([]);
  });
  it("[CF2-AG1-2b] varios clics seguidos = UNA escritura, con la última selección, a los ~800 ms", async () => {
    vi.useFakeTimers();
    render();
    expect(chips.onChange).toBeTypeOf("function");
    chips.onChange!(["p2"]);
    chips.onChange!(["p2", "p3"]);
    vi.advanceTimersByTime(SELECTION_SAVE_DEBOUNCE_MS - 1);
    expect(prefsSpy.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(prefsSpy.calls).toEqual([{ selectedPractitionerIds: ["p2", "p3"] }]);
    // «Todos» también se guarda (`[]` ≠ «nunca eligió»).
    chips.onChange!([]);
    vi.advanceTimersByTime(SELECTION_SAVE_DEBOUNCE_MS);
    expect(prefsSpy.calls).toEqual([{ selectedPractitionerIds: ["p2", "p3"] }, { selectedPractitionerIds: [] }]);
  });
  it("[CF2-AG1-2c] si el guardado falla (rechazo o ok:false): ni toast ni excepción", async () => {
    vi.useFakeTimers();
    render();
    prefsSpy.result = new Error("red");
    chips.onChange!(["p2"]);
    vi.advanceTimersByTime(SELECTION_SAVE_DEBOUNCE_MS);
    await flushMicrotasks();
    prefsSpy.result = { ok: false, error: "Solo lectura" };
    chips.onChange!(["p3"]);
    vi.advanceTimersByTime(SELECTION_SAVE_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(prefsSpy.calls).toHaveLength(2);
    expect(toastSpy.error).toEqual([]);
  });
  it("[CF2-AG1-2d] «Por sala» no ofrece chips: no hay clic que pise la guardada", () => {
    render({
      view: "room",
      rooms: [
        { id: "r1", name: "Consultorio 1", locationId: "L1" },
        { id: "r2", name: "Consultorio 2", locationId: "L1" },
      ] as Props["rooms"],
      initialSelectedIds: ["p2"],
      initialSelectionSource: "saved",
    });
    expect(chips.onChange).toBeNull();
  });
  it("[CF2-AG1-2e] createSelectionSaver: debounce, flush al desmontar y errores sincrónicos tragados", () => {
    vi.useFakeTimers();
    const saved: string[][] = [];
    const s = createSelectionSaver((ids) => void saved.push(ids), 800);
    s.flush(); // nada pendiente: no guarda
    s.schedule(["a"]);
    s.schedule(["a", "b"]);
    s.flush();
    expect(saved).toEqual([["a", "b"]]);
    vi.advanceTimersByTime(2000);
    expect(saved).toHaveLength(1); // el flush canceló el timer
    const boom = createSelectionSaver(() => {
      throw new Error("x");
    }, 10);
    boom.schedule(["a"]);
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });
  it("[CF2-AG1-2f] withProsParam: agrega `pros` una vez y conserva el resto de la URL", () => {
    const href = "https://x.test/agenda?view=timeline&date=2026-10-05&os=particular";
    expect(withProsParam(href, ["p1", "p2"])).toBe(
      "https://x.test/agenda?view=timeline&date=2026-10-05&os=particular&pros=p1%2Cp2"
    );
    expect(withProsParam(href, [])).toBeNull(); // «Todos» = sin `pros`
    expect(withProsParam("https://x.test/agenda?pros=p1", ["p1"])).toBeNull(); // ya está
    expect(withProsParam("https://x.test/agenda?practitioner=zz", ["p1"])).toBe("https://x.test/agenda?pros=p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG1-3] ?open=<id> abre el drawer del turno", () => {
  const lastDrawer = () => drawer.calls[drawer.calls.length - 1]?.booking ?? null;
  it("[CF2-AG1-3a] turno de la semana: el drawer arranca con ese turno (y la versión que se vio)", () => {
    render({ openBookingId: bookings[1].id });
    expect(lastDrawer()).toMatchObject({ id: bookings[1].id, updatedAt: bookings[1].updatedAt });
  });
  it("[CF2-AG1-3b] id que no está en la semana, o sin parámetro: cerrado", () => {
    render({ openBookingId: "otro" });
    expect(lastDrawer()).toBeNull();
    render();
    expect(lastDrawer()).toBeNull();
  });
  it("[CF2-AG1-3c] withoutOpenParam: saca solo `open`", () => {
    expect(withoutOpenParam("https://x.test/agenda?view=timeline&open=b1&pros=p1")).toBe(
      "https://x.test/agenda?view=timeline&pros=p1"
    );
    expect(withoutOpenParam("https://x.test/agenda?view=timeline")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG1-4] MoneyViewerContext: el tag del copago lo ve quien puede cobrar ese turno", () => {
  const owed = (html: string) => (html.match(/data-badge="copago-owed"/g) ?? []).length;
  it("[CF2-AG1-4a] billing.collect (Secretaria): todos; billing.collectOwn (profesional): solo los suyos", () => {
    expect(owed(render({ capabilities: ["agenda.viewAll", "billing.collect"], viewer: { userId: "u", practitionerId: null } }))).toBe(2);
    expect(owed(render({ capabilities: ["agenda.viewAll", "billing.collectOwn"] }))).toBe(1);
    // collectOwn sin profesional propio: nada (no hay «lo suyo»).
    expect(owed(render({ capabilities: ["agenda.viewAll", "billing.collectOwn"], viewer: { userId: "u", practitionerId: null } }))).toBe(0);
  });
  it("[CF2-AG1-4b] quien no cobra no ve el tag", () => {
    expect(owed(render({ capabilities: ["agenda.viewAll"] }))).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG1-5] D-CF2-6: un encabezado en Semana; la tira de Día muestra el candado", () => {
  const PICKER = /class="_strip_[a-z0-9]+"/g;
  it("[CF2-AG1-5a] Semana: solo el encabezado de la grilla (sin la tira picker de afuera), clickeable", () => {
    const html = render({ view: "week" });
    expect((html.match(/data-week-header="true"/g) ?? []).length).toBe(1);
    // La tira picker es `.strip` sola; el encabezado de la grilla, `.strip.stripColumns`. En Semana, solo el segundo.
    expect(html.match(PICKER) ?? []).toHaveLength(0);
    expect((html.match(/data-day-key="/g) ?? []).length).toBe(6);
    expect(html).toMatch(/<button[^>]*data-strip-day="true"/);
  });
  it("[CF2-AG1-5b] Día: la tira picker marca el día bloqueado (no interactivo)", () => {
    const html = render();
    expect(html.match(PICKER) ?? []).toHaveLength(1);
    expect(html).toContain('data-day-status="locked"');
    expect(html).toContain('title="Bloqueado: Feriado"');
    expect(html).not.toContain('data-week-header="true"');
  });
});
