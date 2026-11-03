import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-AG2] Cableado de la agenda, 2.ª parte (plan §29 D-CF2-2, D-CF2-3, D-CF2-7; brief CF2 A.1, A.4, A.5):
 * - título de alcance en el toolbar («Tu agenda · …», «Agenda de …», «Todos los profesionales (N)», «Por sala · …») y
 *   los chips en `layout="heading"`;
 * - vista Mes: segmento «Mes» (solo con `agenda.viewAll`; sin ella `?view=month` cae al Día), ±1 mes en el toolbar,
 *   `MonthView` con las props del handoff A-MV, y las guardas: en Mes no corren la disponibilidad de la semana ni el
 *   refetch en vivo de la semana (el Mes trae su resumen y se suscribe solo);
 * - Recepción: `collect` por rol (handoff A-RC).
 * Render estático (sin jsdom): los effects no corren. Las vistas y el toolbar se envuelven en un mock que GUARDA las
 * props que la agenda les arma y dibuja el componente real; los clics se prueban invocando el callback real.
 */

const { dynamicLoads, router, seen, monthAction, pageMocks } = vi.hoisted(() => ({
  dynamicLoads: [] as Promise<unknown>[],
  router: { push: [] as string[] },
  seen: {
    toolbar: null as null | Record<string, unknown>,
    chips: null as null | Record<string, unknown>,
    month: null as null | Record<string, unknown>,
    reception: null as null | Record<string, unknown>,
  },
  monthAction: { calls: [] as unknown[] },
  pageMocks: { actor: null as unknown, loaded: [] as unknown[], calls: [] as unknown[] },
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => router.push.push(href), refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false } }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: () => {}, error: () => {}, warning: () => {}, info: () => {}, show: () => {}, dismiss: () => {} }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
// La red: la action del Mes (la vista la llama si el resumen del loader no es de su grilla).
vi.mock("@/lib/agenda-month", () => ({
  getAgendaMonthSummary: async (q: unknown) => {
    monthAction.calls.push(q);
    return { ok: false, error: "sin red en el test" };
  },
}));
// Toolbar, chips, Mes y Recepción: el componente REAL, con sus props guardadas (son la vista; la lógica bajo test es
// lo que la agenda les pasa).
vi.mock("@/components/agenda/agenda-toolbar", async (orig) => {
  const m = await orig<typeof import("@/components/agenda/agenda-toolbar")>();
  return {
    ...m,
    AgendaToolbar: (p: Parameters<typeof m.AgendaToolbar>[0]) => {
      seen.toolbar = p as unknown as Record<string, unknown>;
      return <m.AgendaToolbar {...p} />;
    },
  };
});
vi.mock("@/components/agenda/practitioner-chips", async (orig) => {
  const m = await orig<typeof import("@/components/agenda/practitioner-chips")>();
  return {
    ...m,
    PractitionerChips: (p: Parameters<typeof m.PractitionerChips>[0]) => {
      seen.chips = p as unknown as Record<string, unknown>;
      return <m.PractitionerChips {...p} />;
    },
  };
});
vi.mock("@/components/agenda/views/month-view", async (orig) => {
  const m = await orig<typeof import("@/components/agenda/views/month-view")>();
  return {
    ...m,
    MonthView: (p: Parameters<typeof m.MonthView>[0]) => {
      seen.month = p as unknown as Record<string, unknown>;
      return <m.MonthView {...p} />;
    },
  };
});
vi.mock("@/components/agenda/reception/reception-view", async (orig) => {
  const m = await orig<typeof import("@/components/agenda/reception/reception-view")>();
  return {
    ...m,
    ReceptionView: (p: Parameters<typeof m.ReceptionView>[0]) => {
      seen.reception = p as unknown as Record<string, unknown>;
      return <m.ReceptionView {...p} />;
    },
  };
});
vi.mock("@/components/agenda/booking-drawer", () => ({ BookingDrawer: () => null }));
vi.mock("@/lib/booking-share-actions", () => ({ getPatientShareContact: async () => ({ status: "hidden" }) }));
vi.mock("@/lib/preferences", () => proxy());
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
// page.tsx: la sesión (cookie) y el loader (DB) son el borde; `AgendaFromWire` se reemplaza para leer sus props.
vi.mock("@/lib/session", () => ({ getActor: async () => pageMocks.actor }));
vi.mock("@/lib/agenda-page-loader", () => ({
  loadAgendaPage: async (_actor: unknown, args: unknown) => {
    pageMocks.calls.push(args);
    return pageMocks.loaded.shift();
  },
}));
vi.mock("@/app/(app)/agenda/agenda-from-wire", () => ({ AgendaFromWire: () => null }));

import { AgendaClient, agendaWeekDataOn, type Props } from "@/components/agenda/agenda-client";
import AgendaPage from "@/app/(app)/agenda/page";
import { AGENDA_VIEW_CHUNKS } from "@/components/agenda/views/view-chunks";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { DEFAULT_AGENDA_VIEW_PREFS } from "@/lib/preferences-constants";
import { AGENDA_VIEWS, monthGridRange } from "@/lib/agenda-client-state";
import { dayKeyRange } from "@/lib/availability/day";
import type { AgendaMonthSummary } from "@/lib/agenda-month-types";

const DAY = "2026-11-10"; // martes
const MON = "2026-11-09";
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
    updatedAt: ar(DAY, "08:00"),
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
const R = monthGridRange(DAY);
const monthSummary: AgendaMonthSummary = {
  from: R.from,
  to: R.to,
  locationId: null,
  days: dayKeyRange(R.from, R.to).map((k) => (k === DAY ? { k, c: { p1: [3, 1], p2: [2, 0] } } : { k })),
};
const base: Props = {
  view: "timeline",
  dayKey: DAY,
  weekStartKey: MON,
  bookings: [bk("p1", "09:00", { arrivedAt: ar(DAY, "08:55") }), bk("p2", "10:00", { arrivedAt: ar(DAY, "09:55") })],
  services: [{ id: "svc-kine", name: "Kinesio", durationMin: 45, priceCents: 1000, color: "#3b82f6" }],
  practitioners: pracs,
  patients: [],
  insurers: [],
  businessHours: { start: 8, end: 19, slotMinutes: 30 },
  viewer: { userId: "u1", practitionerId: "p1" },
  capabilities: ["agenda.viewAll", "agenda.reception", "agenda.manageBlocks"],
  locations: [{ id: "L1", name: "Principal", isPrimary: true }],
  agendaPrefs: { ...DEFAULT_AGENDA_VIEW_PREFS },
  initialAvailability: null,
};
const render = (p: Partial<Props> = {}) => renderToStaticMarkup(<AgendaClient {...base} {...p} />);
const h1Of = (html: string) => html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? null;
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

beforeAll(async () => {
  await Promise.all(dynamicLoads);
});
afterEach(() => {
  router.push.length = 0;
  monthAction.calls.length = 0;
  seen.toolbar = seen.chips = seen.month = seen.reception = null;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-1] título de alcance (D-CF2-2) y chips debajo", () => {
  it("[CF2-AG2-1a] propia: «Tu agenda · Ana Pérez»; la fecha baja a subtítulo", () => {
    const html = render({ initialSelectedIds: ["p1"] });
    expect(h1Of(html)).toBe("Tu agenda · Ana Pérez");
    expect(html).toContain("martes, 10 de noviembre");
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
  });
  it("[CF2-AG2-1b] otro profesional, dos, tres y todos", () => {
    expect(h1Of(render({ initialSelectedIds: ["p2"] }))).toBe("Agenda de Bruno Díaz");
    expect(h1Of(render({ initialSelectedIds: ["p2", "p3"] }))).toBe("Agenda de Bruno Díaz y Carla Gómez");
    expect(h1Of(render({ initialSelectedIds: [] }))).toBe("Todos los profesionales (3)");
    // Los tres elegidos = «Todos» (misma regla que `parseSelectedPractitioners`).
    expect(h1Of(render({ initialSelectedIds: ["p1", "p2", "p3"] }))).toBe("Todos los profesionales (3)");
    const four = [...pracs, { id: "p4", name: "Diego Ruiz" }];
    expect(h1Of(render({ practitioners: four, initialSelectedIds: ["p1", "p2", "p3"] }))).toBe(
      "3 profesionales: Ana P., Bruno D., Carla G."
    );
  });
  it("[CF2-AG2-1c] «Por sala» ignora la selección (sin pisarla): «Por sala · todos los profesionales»", () => {
    const rooms = [
      { id: "r1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO" as const, capacity: 1 },
      { id: "r2", locationId: "L1", name: "Gimnasio", kind: "GIMNASIO" as const, capacity: 3 },
    ];
    const html = render({ view: "room", rooms, initialSelectedIds: ["p2"] });
    expect(h1Of(html)).toBe("Por sala · todos los profesionales");
    // Sin chips en «Por sala» (SRZ M2), como antes.
    expect(seen.chips).toBeNull();
  });
  it("[CF2-AG2-1d] un solo profesional: sin título de alcance, el h1 es la fecha (markup de siempre)", () => {
    const html = render({ practitioners: [pracs[0]], bookings: [] });
    expect(seen.toolbar?.scopeHeading).toBeNull();
    expect(h1Of(html)).toBe("martes, 10 de noviembre");
  });
  it("[CF2-AG2-1e] los chips van con `layout=\"heading\"` debajo del título", () => {
    const html = render({ initialSelectedIds: ["p1"] });
    expect(seen.chips?.layout).toBe("heading");
    expect(html).toContain("Profesionales</span>");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="Profesionales a mostrar"'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-2] segmento «Mes» y fallback sin `agenda.viewAll` (A-K)", () => {
  it("[CF2-AG2-2a] con `agenda.viewAll`: Día / Semana / Mes / Lista / Recepción", () => {
    const html = render();
    expect(seen.toolbar?.segments).toEqual(["day", "week", "month", "list", "reception"]);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*><span[^>]*>Mes<\/span><\/button>/);
  });
  it("[CF2-AG2-2b] sin `agenda.viewAll`: sin «Mes»; `view=month` que llega igual cae al Día", () => {
    const caps = ["agenda.reception"];
    render({ capabilities: caps });
    expect(seen.toolbar?.segments).toEqual(["day", "week", "list", "reception"]);
    const html = render({ capabilities: caps, view: "month", initialMonth: monthSummary });
    expect(seen.month).toBeNull();
    expect(html).not.toContain("data-month-view");
    expect(seen.toolbar?.segment).toBe("day");
  });
  it("[CF2-AG2-2c] «Mes» lleva a `?view=month` con el mismo día y la selección", () => {
    render({ initialSelectedIds: ["p2"] });
    (seen.toolbar?.onSegmentChange as (s: string) => void)("month");
    expect(router.push).toEqual([`/agenda?view=month&date=${DAY}&pros=p2`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-3] vista Mes", () => {
  const month = (p: Partial<Props> = {}) => render({ view: "month", bookings: [], initialMonth: monthSummary, ...p });

  it("[CF2-AG2-3a] monta `MonthView` con las props del handoff A-MV", () => {
    const html = month({ initialSelectedIds: ["p2"] });
    expect(html).toContain("data-month-view");
    expect(html).toContain("data-month-grid");
    const p = seen.month!;
    expect(p.initial).toBe(monthSummary);
    expect(p.anchorDayKey).toBe(DAY);
    expect(p.selectedPractitionerIds).toEqual(["p2"]);
    expect(p.practitioners).toEqual([
      { id: "p1", name: "Ana Pérez", initials: "AP" },
      { id: "p2", name: "Bruno Díaz", initials: "BD" },
      { id: "p3", name: "Carla Gómez", initials: "CG" },
    ]);
    expect(p.locationId).toBeNull();
    // Visibilidad por defecto: ausentes visibles → no se restan.
    expect(p.hideNoShow).toBe(false);
    // Sáb/dom de las prefs (mock de tweaks: sábado sí, domingo no).
    expect(p.showSaturday).toBe(true);
    expect(p.showSunday).toBe(false);
    expect(typeof p.onCounts).toBe("function");
    expect(typeof p.todayKey).toBe("string");
    // El resumen del loader es de esta grilla: no se pide nada.
    expect(monthAction.calls).toEqual([]);
  });
  it("[CF2-AG2-3b] clic en un día → ese día en el Día del modo guardado", () => {
    month({ initialSelectedIds: ["p2"] });
    (seen.month!.onPickDay as (k: string) => void)("2026-11-19");
    expect(router.push).toEqual(["/agenda?view=timeline&date=2026-11-19&pros=p2"]);
    router.push.length = 0;
    month({ agendaPrefs: { ...DEFAULT_AGENDA_VIEW_PREFS, mode: "practitioner" } });
    (seen.month!.onPickDay as (k: string) => void)("2026-11-19");
    expect(router.push).toEqual(["/agenda?view=practitioner&date=2026-11-19"]);
  });
  it("[CF2-AG2-3c] toolbar ±1 mes con `shiftMonthDay` (31-ene + 1 = 28-feb, sin saltear febrero)", () => {
    month();
    const nav = seen.toolbar!.onNavigateMonths as (d: -1 | 1) => void;
    nav(1);
    nav(-1);
    expect(router.push).toEqual(["/agenda?view=month&date=2026-12-10", "/agenda?view=month&date=2026-10-10"]);
    router.push.length = 0;
    month({ dayKey: "2027-01-31", weekStartKey: "2027-01-25" });
    (seen.toolbar!.onNavigateMonths as (d: -1 | 1) => void)(1);
    expect(router.push).toEqual(["/agenda?view=month&date=2027-02-28"]);
  });
  it("[CF2-AG2-3d] título del mes y botones «Mes anterior» / «Mes siguiente»", () => {
    const html = month({ practitioners: [pracs[0]] });
    expect(h1Of(html)).toBe("noviembre de 2026");
    expect(html).toContain('aria-label="Mes anterior"');
    expect(html).toContain('aria-label="Mes siguiente"');
    expect(seen.toolbar?.segment).toBe("month");
  });
  it("[CF2-AG2-3e] «Ausentes» ocultos → `hideNoShow`", () => {
    // La visibilidad se lee de localStorage en un effect: en el render estático queda el default; se prueba la regla
    // con la fuente (la agenda pasa `!visibility.showNoShow`, literal del handoff A-MV).
    expect(src("components/agenda/agenda-client.tsx")).toMatch(/hideNoShow=\{!visibility\.showNoShow\}/);
  });
  it("[CF2-AG2-3f] en Mes no hay filtros de obra social ni de sala, ni leyenda, ni tira de días de la semana", () => {
    const rooms = [
      { id: "r1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO" as const, capacity: 1 },
      { id: "r2", locationId: "L1", name: "Gimnasio", kind: "GIMNASIO" as const, capacity: 3 },
    ];
    const insurers = [{ id: "os1", name: "OSDE" }];
    const locations = [
      { id: "L1", name: "Principal", isPrimary: true },
      { id: "L2", name: "Centro", isPrimary: false },
    ];
    const day = render({ rooms, insurers, locations });
    expect(day).toContain("Filtrar por sala");
    expect(day).toContain(">Servicios<");
    // Tira picker de la semana: el número del lunes 9 (variante sin columnas).
    const stripNum = /<span class="k-display[^"]*">9<\/span>/;
    expect(day).toMatch(stripNum);
    expect(seen.toolbar?.insurerFilter).not.toBeNull();
    const html = month({ rooms, insurers, locations });
    expect(html).not.toContain("Filtrar por sala");
    expect(html).not.toContain(">Servicios<");
    expect(html).not.toMatch(stripNum);
    expect(seen.toolbar?.insurerFilter).toBeNull();
    // La sede sí (el resumen se pide por sede).
    expect(html).toContain('aria-label="Filtrar por sede"');
  });
  it("[CF2-AG2-3g] el Mes va en su chunk (`view-chunks`), con SSR (la action queda registrada)", () => {
    expect(AGENDA_VIEW_CHUNKS.month).toEqual(["month"]);
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toMatch(/const MonthView = dynamic\(\(\) => import\("\.\/views\/month-view"\)\.then\(\(m\) => m\.MonthView\)\);/);
    expect(code).not.toMatch(/^import[^;]*from "\.\/views\/month-view"/m);
    expect(code).toContain("<MonthViewC\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-4] guardas: en Mes no corren la disponibilidad ni el refetch en vivo de la semana", () => {
  it("[CF2-AG2-4a] `agendaWeekDataOn`: solo Mes la apaga", () => {
    for (const v of AGENDA_VIEWS) expect(agendaWeekDataOn(v)).toBe(v !== "month");
  });
  it("[CF2-AG2-4b] los dos effects salen temprano con esa guarda", () => {
    const code = src("components/agenda/agenda-client.tsx");
    // Disponibilidad de la semana (getAgendaAvailability) y suscripción del refetch de la semana (listAgendaBookings).
    const avail = code.slice(code.indexOf("const want = { from: weekStartKey, locationId };") - 200);
    expect(avail.slice(0, 400)).toMatch(/if \(!weekDataOn\) return;\s*const want = \{ from: weekStartKey, locationId \};/);
    const live = code.slice(code.indexOf("const coalescer = createRefetchCoalescer(refetchLive);") - 300);
    expect(live.slice(0, 500)).toMatch(/if \(!weekDataOn\) return;[\s\S]*const coalescer = createRefetchCoalescer\(refetchLive\);/);
    expect(code).toMatch(/const weekDataOn = agendaWeekDataOn\(view\);/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-5] Recepción: `collect` por rol (handoff A-RC)", () => {
  const rec = (caps: string[], practitionerId: string | null) => {
    render({ view: "reception", capabilities: ["agenda.viewAll", "agenda.reception", ...caps], viewer: { userId: "u1", practitionerId } });
    return seen.reception?.collect;
  };
  it("[CF2-AG2-5a] `billing.collect` (Secretaria): todo", () => {
    expect(rec(["billing.collect"], null)).toEqual({ all: true, practitionerId: null });
  });
  it("[CF2-AG2-5b] `billing.collectOwn` (profesional): lo suyo", () => {
    expect(rec(["billing.collectOwn"], "p1")).toEqual({ all: false, practitionerId: "p1" });
  });
  it("[CF2-AG2-5c] sin cobro: null (markup de antes)", () => {
    expect(rec([], "p1")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[CF2-AG2-6] page.tsx: rango del Mes, `initialMonth` y fallback sin `agenda.viewAll`", () => {
  const loaded = (capabilities: string[], month: AgendaMonthSummary | null) => ({
    bookings: [],
    services: [],
    practitioners: pracs,
    patients: [],
    insurers: [],
    businessHours: { start: 8, end: 19, slotMinutes: 30 },
    locations: [{ id: "L1", name: "Principal", isPrimary: true }],
    rooms: [],
    agendaView: { ...DEFAULT_AGENDA_VIEW_PREFS },
    capabilities,
    availability: null,
    onlineMoney: { enabled: false },
    whatsapp: false,
    month,
  });
  const actor = {
    userId: "u1",
    tenantId: "t1",
    practitionerId: null,
    entitlements: { vertical: "KINESIOLOGIA", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] },
  };
  async function page(searchParams: Record<string, string>, ...results: ReturnType<typeof loaded>[]) {
    pageMocks.actor = actor;
    pageMocks.loaded = [...results];
    pageMocks.calls = [];
    const el = (await AgendaPage({ searchParams })) as React.ReactElement<Record<string, unknown>>;
    return el.props;
  }
  afterEach(() => {
    pageMocks.calls = [];
  });

  it("[CF2-AG2-6a] `?view=month`: pide la grilla del mes (`monthGridRange`) y la pasa como `initialMonth`", async () => {
    const p = await page({ view: "month", date: DAY }, loaded(["agenda.viewAll"], monthSummary));
    expect(pageMocks.calls).toHaveLength(1);
    expect(pageMocks.calls[0]).toMatchObject({ monday: MON, monthRange: monthGridRange(DAY) });
    expect(p.view).toBe("month");
    expect(p.initialMonth).toBe(monthSummary);
  });
  it("[CF2-AG2-6b] otras vistas: sin `monthRange` (la Semana corre como antes) y `initialMonth` null", async () => {
    const p = await page({ view: "week", date: DAY }, loaded(["agenda.viewAll"], null));
    expect(pageMocks.calls).toHaveLength(1);
    expect((pageMocks.calls[0] as { monthRange?: unknown }).monthRange ?? null).toBeNull();
    expect(p.initialMonth).toBeNull();
  });
  it("[CF2-AG2-6c] sin `agenda.viewAll`: `view=month` cae al Día y la semana se vuelve a pedir sin el Mes", async () => {
    const p = await page({ view: "month", date: DAY }, loaded([], null), loaded([], null));
    expect(p.view).toBe("timeline");
    expect(pageMocks.calls).toHaveLength(2);
    expect((pageMocks.calls[1] as { monthRange?: unknown }).monthRange ?? null).toBeNull();
    expect(p.initialMonth).toBeNull();
  });
});
