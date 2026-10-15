import { beforeAll, describe, it, expect, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `agenda-client` carga vistas/modales con `next/dynamic` (bundle de /agenda).
// `renderToStaticMarkup` no espera Suspense: el mock resuelve cada `import()`
// en `beforeAll` y después renderiza el componente real, sincrónico.
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
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
// SV09: `useRealtime` con estado controlable. Fuera del provider el real ya
// devuelve `off`; el mock deja probar `live` sin montar el hub (no hay effects
// en `renderToStaticMarkup`). Lo usan `AgendaClient` y `LiveIndicator`.
const { rt } = vi.hoisted(() => ({ rt: { state: "off" as "off" | "live" | "reconnecting" | "polling" } }));
vi.mock("@/components/providers/realtime-provider", () => ({
  useRealtime: () => ({ state: rt.state, subscribe: () => () => {}, onResync: () => () => {}, resync: () => {} }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/layout/tweaks-context", () => ({
  useTweaks: () => ({ agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false } }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/preferences", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/bookings", () => proxy());
// El drawer importa actions de Planes (S19c/S19d): sin mock, `cache` de React no existe fuera de RSC.
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/exercises", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/conditions", () => proxy());

import { AgendaClient, type Props } from "@/components/agenda/agenda-client";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { AgendaAvailability } from "@/lib/availability-actions-types";

const DAY = "2026-10-05"; // lunes
const MON = DAY;
const ar = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-03:00`).toISOString();
let seq = 0;
function bk(pid: string, hhmm: string, over: Partial<BookingDTO> = {}, d = DAY): BookingDTO {
  seq++;
  return {
    id: `b${seq}`,
    scheduledFor: ar(d, hhmm),
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
    updatedAt: ar(d, "08:00"),
    notes: null,
    title: "Lumbalgia",
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
  { id: "p4", name: "Diego Ruiz" },
  { id: "p5", name: "Elena Martínez" },
  { id: "p6", name: "Federico Sosa" },
];
const openLock = { status: "open" as const, reason: null, detail: null, blockIds: [] };
const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10);
  return {
    dayKey: d,
    clinic: openLock,
    byPractitioner: Object.fromEntries(
      pracs.map((p) => [
        p.id,
        d === "2026-10-06"
          ? {
              scheduledRanges: [{ startMin: 480, endMin: 1140, locationId: "L1" }],
              workingRanges: [],
              dayLockState: { status: "locked" as const, reason: "bloqueo" as const, detail: "Feriado", blockIds: ["blk1"] },
            }
          : {
              scheduledRanges: [{ startMin: 480, endMin: 1140, locationId: "L1" }],
              workingRanges: [{ startMin: 480, endMin: 1140, locationId: "L1" }],
              dayLockState: openLock,
            },
      ])
    ),
  };
});
const availability: AgendaAvailability = {
  from: MON,
  to: "2026-10-11",
  locationId: null,
  primaryLocationId: "L1",
  tenantHours: { startMin: 480, endMin: 1140 },
  practitioners: pracs.map((p) => ({ practitionerId: p.id, isFallback: false })),
  days,
  blocks: [
    { id: "blk1", practitionerId: null, locationId: null, startsAt: ar("2026-10-06", "00:00"), endsAt: ar("2026-10-07", "00:00"), allDay: true, reason: "Feriado", groupId: null },
  ],
  capOf: Object.fromEntries(pracs.map((p) => [p.id, { "svc-kine": null, "svc-osteo": 1 }])),
  enabledServiceIds: Object.fromEntries(pracs.map((p) => [p.id, ["svc-kine", "svc-osteo"]])),
};
const bookings = [
  bk("p1", "09:00"),
  bk("p1", "09:00", { isOverbooked: true }),
  bk("p2", "09:00", { serviceId: "svc-osteo", serviceName: "Osteo", arrivedAt: ar(DAY, "08:50") }),
  bk("p3", "10:30", { isTelemedicine: true, clinicalHidden: true, title: null }),
  bk("p4", "11:00", { status: "CANCELLED" }),
  bk("p5", "12:00", { attendingAt: ar(DAY, "12:05"), arrivedAt: ar(DAY, "11:55") }),
  bk("p6", "15:00", { locationId: "L2" }),
  bk("p1", "10:00", {}, "2026-10-07"),
  bk("p2", "10:00", {}, "2026-10-07"),
];
const base: Props = {
  view: "timeline",
  dayKey: DAY,
  weekStartKey: MON,
  bookings,
  services: [
    { id: "svc-kine", name: "Kinesio", durationMin: 45, priceCents: 1000, color: "#3b82f6" },
    { id: "svc-osteo", name: "Osteo", durationMin: 60, priceCents: 2000, color: "#16a34a" },
  ],
  practitioners: pracs,
  patients: [],
  insurers: [],
  businessHours: { start: 8, end: 19, slotMinutes: 30 },
  viewer: { userId: "u1", practitionerId: "p1" },
  capabilities: ["agenda.viewAll", "agenda.reception", "agenda.manageBlocks", "agenda.manageOwnBlocks"],
  locations: [
    { id: "L1", name: "Principal", isPrimary: true },
    { id: "L2", name: "Centro", isPrimary: false },
  ],
  agendaPrefs: { mode: "day", zoom: 30, density: "comfortable", favoritePractitionerIds: ["p3"], locationId: null, arrivalAlert: "visual", callAlert: "visual", salaGroupBy: "practitioner" },
  initialAvailability: availability,
};
const r = (p: Props, name: string) => {
  const html = renderToStaticMarkup(<AgendaClient {...p} />);
  return html;
};

describe("AgendaClient render (B4.3)", () => {
  beforeAll(async () => {
    await Promise.all(dynamicLoads);
  });
  it("Día multi-profesional: chips, toggle, iniciales, badges, sede", () => {
    const html = r(base, "day");
    expect(html).toContain('aria-label="Profesionales a mostrar"');
    expect(html).toContain('role="radiogroup" aria-label="Modo de la agenda"');
    expect(html).toContain('data-initials="AP"');
    expect(html).toContain('data-badge="sobreturno"');
    expect(html).toContain("En sala");
    expect(html).toContain("En atención");
    expect(html).toContain('aria-label="Telemedicina"');
    expect(html).toContain('aria-label="Filtrar por sede"');
    expect(html).toContain("Recepción");
    expect(html).not.toContain("Todos los profesionales</option>");
  });
  it("Día de un profesional: igual que antes (sin chips/toggle/iniciales/sede)", () => {
    const html = r(
      {
        ...base,
        practitioners: [pracs[0]],
        bookings: bookings.filter((b) => b.practitionerId === "p1"),
        locations: [{ id: "L1", name: "Principal", isPrimary: true }],
        initialAvailability: null,
        capabilities: ["agenda.viewAll", "clinical.read"],
      },
      "single"
    );
    expect(html).not.toContain("Profesionales a mostrar");
    expect(html).not.toContain("Modo de la agenda");
    expect(html).not.toContain("data-initials");
    expect(html).not.toContain("Filtrar por sede");
    expect(html).not.toContain("Recepción");
  });
  it("Día bloqueado (feriado) rayado con motivo", () => {
    const html = r({ ...base, dayKey: "2026-10-06" }, "locked");
    expect(html).toContain('data-blocked="true"');
    expect(html).toContain("Feriado");
  });
  it("Por profesional: 6 columnas", () => {
    const html = r({ ...base, view: "practitioner" }, "prac");
    expect((html.match(/role="columnheader"/g) ?? []).length).toBe(7);
  });
  it("Semana: conteo partido y día bloqueado", () => {
    const html = r({ ...base, view: "week" }, "week");
    expect(html).toContain("AP 2 · BD 1");
    expect(html).toContain('data-blocked="true"');
  });
  it("Lista y Recepción montan", () => {
    expect(r({ ...base, view: "list" }, "list")).toContain("Sobreturno");
    const rec = r({ ...base, view: "reception" }, "reception");
    expect(rec.length).toBeGreaterThan(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S19b (ES3): leyenda "Turnos: De plan · Sueltos" (resaltado, no filtro) y
// "Turnos" del menú Vista. Solo con el módulo `planes` (VERTICALES §5).
// ─────────────────────────────────────────────────────────────────────────────
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { PlanLegend } from "@/components/agenda/plan-legend";
import { ViewOptionsMenu, isViewFiltered } from "@/components/agenda/view-options-menu";
import { DEFAULT_AGENDA_VISIBILITY } from "@/lib/agenda-filters";
import { modulesFor } from "@/lib/tenant-modules";

describe("[P3-S19b] leyenda y filtro de plan", () => {
  beforeAll(async () => {
    await Promise.all(dynamicLoads);
  });
  const withPlan = [...bookings, bk("p1", "16:00", { programId: "pg1", sessionId: "s1", plan: { discipline: "KINESIOLOGY", ordinal: 2, totalLive: 10, title: null } })];

  it("Kine (default): leyenda Turnos con conteo del día sin cancelados, nada resaltado", () => {
    const html = r({ ...base, bookings: withPlan }, "legend");
    expect(html).toContain('aria-label="Resaltar turnos de plan o sueltos"');
    // Día 2026-10-05: 7 turnos + 1 de plan, 1 cancelado → 1 de plan, 6 sueltos.
    // F3a (a11y): el aria-label va en el <button>, con singular/plural.
    expect(html).toMatch(/data-plan-scope="plan" aria-pressed="false" aria-label="De plan, 1 turno"/);
    expect(html).toMatch(/data-plan-scope="loose" aria-pressed="false" aria-label="Sueltos, 6 turnos"/);
    expect(html).not.toMatch(/data-plan-scope="\w+" aria-pressed="true"/);
    // La leyenda de servicios sigue ahí, igual que antes.
    expect(html).toContain("Servicios");
  });

  it("Semana: el conteo es de la semana", () => {
    const html = r({ ...base, view: "week", bookings: withPlan }, "legend-week");
    expect(html).toMatch(/data-plan-scope="loose"[^>]*aria-label="Sueltos, 8 turnos"/);
  });

  it("consultorio General (sin `planes`): sin leyenda de plan", () => {
    const general = Array.from(modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false }));
    expect(general).not.toContain("planes");
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={general}>
        <AgendaClient {...base} bookings={withPlan} />
      </TenantModulesProvider>
    );
    expect(html).not.toContain("data-plan-scope");
    expect(html).not.toContain("Resaltar turnos de plan o sueltos");
    expect(html).toContain("Servicios");
  });

  it("sin servicios con color pero con planes: la fila muestra solo Turnos", () => {
    const html = r({ ...base, services: base.services.map((s) => ({ ...s, color: null })) }, "no-color");
    expect(html).not.toContain(">Servicios<");
    expect(html).toContain('data-plan-scope="plan"');
  });

  it("PlanLegend: el ítem activo queda presionado; no hay título de plan", () => {
    const html = renderToStaticMarkup(
      <PlanLegend highlight={{ kind: "loose" }} onToggle={() => {}} counts={{ plan: 3, loose: 4 }} />
    );
    expect(html).toMatch(/data-plan-scope="loose" aria-pressed="true"/);
    expect(html).toMatch(/data-plan-scope="plan" aria-pressed="false"/);
    expect(html).toContain("Quitar resaltado");
  });

  it("menú Vista: el punto avisa un alcance de plan activo", () => {
    expect(isViewFiltered(DEFAULT_AGENDA_VISIBILITY, "all")).toBe(false);
    expect(isViewFiltered(DEFAULT_AGENDA_VISIBILITY, null)).toBe(false);
    expect(isViewFiltered(DEFAULT_AGENDA_VISIBILITY, "loose")).toBe(true);
    expect(isViewFiltered({ showCancelled: false, showNoShow: true }, "all")).toBe(true);
    const menu = (planScope: "all" | "plan") =>
      renderToStaticMarkup(
        <ViewOptionsMenu
          density="comfortable"
          setDensity={() => {}}
          visibility={DEFAULT_AGENDA_VISIBILITY}
          setVisibility={() => {}}
          planScope={planScope}
          setPlanScope={() => {}}
        />
      );
    expect(menu("plan")).toContain("Hay filtros activos");
    expect(menu("all")).not.toContain("Hay filtros activos");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR-U6 (SR4): salas cableadas en la agenda. Sin salas la agenda queda
// idéntica; con 2+ salas aparecen el filtro, el modo "Por sala" y la sala en
// las tarjetas (solo si `showRoomOnCards`). `RoomDayView` va por `dynamic()`:
// el mock de arriba lo resuelve; acá además se capturan sus props.
// ─────────────────────────────────────────────────────────────────────────────
const { roomViewProps } = vi.hoisted(() => ({ roomViewProps: [] as Record<string, unknown>[] }));
vi.mock("@/components/agenda/views/room-day-view", async () => {
  const actual = await vi.importActual<typeof import("@/components/agenda/views/room-day-view")>(
    "@/components/agenda/views/room-day-view"
  );
  return {
    ...actual,
    RoomDayView: (p: Parameters<typeof actual.RoomDayView>[0]) => {
      roomViewProps.push(p as unknown as Record<string, unknown>);
      return actual.RoomDayView(p);
    },
  };
});

import { dayLockExistingBlocks, roomSlotCreating } from "@/components/agenda/agenda-client";
import { TimelineView } from "@/components/agenda/views/timeline-view";
import type { RoomOption } from "@/lib/rooms-types";

describe("[SR-U6] salas en la agenda", () => {
  beforeAll(async () => {
    await Promise.all(dynamicLoads);
  });
  const rooms: RoomOption[] = [
    { id: "r1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
    { id: "r2", locationId: "L1", name: "Gimnasio", kind: "GIMNASIO", capacity: 3 },
  ];
  // Mismos turnos, dos con sala (el DTO compacto manda `roomId` solo si es string).
  const withRooms = bookings.map((b) =>
    b.practitionerId === "p1" && b.scheduledFor === ar(DAY, "09:00") && !b.isOverbooked
      ? { ...b, roomId: "r1" }
      : b.practitionerId === "p2" && b.scheduledFor === ar(DAY, "09:00")
        ? { ...b, roomId: "r2" }
        : b
  );
  const roomed: Props = { ...base, bookings: withRooms, rooms };

  it("sin salas: el markup es el mismo con `rooms` ausente o vacío, y nada de sala", () => {
    for (const view of ["timeline", "practitioner", "week", "list", "reception"] as const) {
      const none = r({ ...base, view }, view);
      expect(r({ ...base, view, rooms: [] }, view)).toBe(none);
      expect(none).not.toContain("Filtrar por sala");
      expect(none).not.toContain("Por sala");
      expect(none).not.toContain("data-room");
      expect(none).not.toContain(">Sala</th>");
    }
  });

  it("con 2 salas: filtro de sala con conteos del día, toggle con 'Por sala' y la sala en las tarjetas", () => {
    const html = r(roomed, "rooms-day");
    expect(html).toContain('role="radiogroup" aria-label="Filtrar por sala"');
    expect(html).toContain('aria-label="Consultorio 1, 1 turno"');
    expect(html).toContain('aria-label="Gimnasio, 1 turno"');
    expect(html).toContain("Por sala");
    // Tarjeta del Día con la sala (showRoomOnCards: 2 salas, sin filtro).
    // La card lleva `data-room` (React lo serializa "true"); el filtro, `data-room="<id>"`.
    expect(html).toMatch(/data-room="true"[^>]*>.*?Consultorio 1/);
  });

  it("con el filtro de una sala: solo sus turnos y la tarjeta ya no repite la sala", () => {
    const html = r({ ...roomed, agendaPrefs: { ...base.agendaPrefs!, roomId: "r1" } }, "rooms-filter");
    expect(html).not.toContain('data-room="true"');
    expect(html).toContain("Paciente 1"); // r1
    expect(html).not.toContain("Paciente 3"); // r2
    expect(html).toMatch(/aria-checked="true"[^>]*data-room="r1"/);
  });

  it("filtro de sala ajeno (otra sede o archivada): se ignora (= todas)", () => {
    const html = r({ ...roomed, agendaPrefs: { ...base.agendaPrefs!, roomId: "r-vieja" } }, "rooms-stale");
    expect(html).toContain("Paciente 3");
    expect(html).toContain('data-room="true"');
  });

  it("una sola sala: sin filtro ni sala en las tarjetas, pero 'Por sala' disponible", () => {
    const html = r({ ...roomed, rooms: [rooms[0]] }, "one-room");
    expect(html).not.toContain("Filtrar por sala");
    expect(html).not.toContain("data-room");
    expect(html).toContain("Por sala");
  });

  it("Por profesional, Lista y Semana: la sala en la tarjeta", () => {
    expect(r({ ...roomed, view: "practitioner" }, "rooms-prac")).toMatch(/data-room="true"[^>]*>.*?Gimnasio/);
    expect(r({ ...roomed, view: "list" }, "rooms-list")).toContain("Consultorio 1");
    // Semana: la celda es solo conteo; la sala va en el modal de la celda (SR-U5a). Monta igual.
    expect(r({ ...roomed, view: "week" }, "rooms-week")).toContain("AP 2 · BD 1");
  });

  it("vista 'Por sala': monta RoomDayView con sus props y el toggle marca 'Por sala'", () => {
    roomViewProps.length = 0;
    const html = r({ ...roomed, view: "room" }, "room");
    expect(roomViewProps.length).toBeGreaterThan(0);
    const p = roomViewProps.at(-1)!;
    expect(p.dayKey).toBe(DAY);
    expect(p.zoom).toBe(30);
    expect(p.density).toBe("comfortable");
    expect(p.fallbackLocationName).toBe("Principal");
    expect(typeof p.onSlotClick).toBe("function");
    expect(typeof p.onBookingClick).toBe("function");
    const layout = p.layout as { columns: { roomId: string; bookingCount: number }[] };
    // Orden del catálogo y "Sin sala" al final (hay turnos sin sala ese día).
    expect(layout.columns.map((c) => c.roomId)).toEqual(["r1", "r2", "none"]);
    expect(layout.columns[0].bookingCount).toBe(1);
    expect(p.practitionerById).toMatchObject({ p1: { initials: "AP" } });
    expect(html).toContain("por sala");
    expect(html).toMatch(/aria-checked="true"[^>]*data-mode="room"/);
    // En "Por sala" la tarjeta no repite la sala (la columna ya lo dice).
    expect(html).not.toContain('data-room="true"');
  });

  it("vista 'Por sala' filtrada por una sala: solo esa columna", () => {
    roomViewProps.length = 0;
    r({ ...roomed, view: "room", agendaPrefs: { ...base.agendaPrefs!, roomId: "r2" } }, "room-filtered");
    const layout = roomViewProps.at(-1)!.layout as { columns: { roomId: string }[] };
    expect(layout.columns.map((c) => c.roomId)).toEqual(["r2"]);
  });

  it("'Por sala' sin salas: cae al Día de siempre (sin RoomDayView)", () => {
    roomViewProps.length = 0;
    // El server resuelve la vista (`resolveAgendaView` con roomCount 0); acá
    // si igual llega "room" sin catálogo, no se monta la vista de salas.
    const html = r({ ...base, view: "room" }, "room-none");
    expect(roomViewProps.length).toBe(0);
    expect(html).toBe(r(base, "timeline"));
  });

  it("click en una celda de sala: el alta abre con esa sala (o sin sala en 'Sin sala')", () => {
    expect(roomSlotCreating("r1", "2026-10-05T13:00:00.000Z")).toEqual({
      defaultISO: "2026-10-05T13:00:00.000Z",
      defaultRoomId: "r1",
    });
    expect(roomSlotCreating("none", "2026-10-05T13:00:00.000Z")).toEqual({
      defaultISO: "2026-10-05T13:00:00.000Z",
      defaultRoomId: null,
    });
  });

  it("Recepción con columna Sala ('—' sin sala)", () => {
    const html = r({ ...roomed, view: "reception" }, "rooms-reception");
    expect(html).toContain('<th scope="col">Sala</th>');
    expect(html).toContain('data-label="Sala"');
    expect(html).toContain("Consultorio 1");
  });

  it("candado: los bloqueos existentes suman los de sala, rotulables por sala", () => {
    const av: AgendaAvailability = {
      ...availability,
      roomBlocks: [
        { id: "rb1", roomId: "r1", startsAt: ar(DAY, "11:00"), endsAt: ar(DAY, "12:00"), reason: "Mantenimiento" },
        { id: "rb2", roomId: "r2", startsAt: ar("2026-10-08", "11:00"), endsAt: ar("2026-10-08", "12:00"), reason: null },
      ],
    };
    const day = dayLockExistingBlocks(av, "2026-10-06");
    expect(day.map((b) => b.id)).toEqual(["blk1"]);
    const mon = dayLockExistingBlocks(av, DAY);
    expect(mon).toEqual([
      {
        id: "rb1",
        groupId: null,
        practitionerId: null,
        roomId: "r1",
        startsAt: ar(DAY, "11:00"),
        endsAt: ar(DAY, "12:00"),
        allDay: false,
        reason: "Mantenimiento",
      },
    ]);
    // Sin `roomBlocks` (consultorio sin salas): lo de siempre.
    expect(dayLockExistingBlocks(availability, "2026-10-06")).toEqual([
      expect.objectContaining({ id: "blk1", practitionerId: null, allDay: true }),
    ]);
    expect(dayLockExistingBlocks(availability, "2026-10-06")[0]).not.toHaveProperty("roomId");
  });

  it("PD-13: ningún título de plan en la agenda con salas", () => {
    const withPlan = [
      ...withRooms,
      bk("p1", "16:00", {
        roomId: "r1",
        programId: "pg1",
        sessionId: "s1",
        plan: { discipline: "KINESIOLOGY", ordinal: 2, totalLive: 10, title: "Plan rodilla secreto" },
      }),
    ];
    for (const view of ["timeline", "room", "practitioner", "list", "reception"] as const) {
      expect(r({ ...roomed, view, bookings: withPlan }, view)).not.toContain("Plan rodilla secreto");
    }
  });
});

describe("[SR-U6] TimelineView con sala", () => {
  const props = {
    bookings: [bk("p1", "09:00", { roomId: "r1" }), bk("p2", "09:00", { roomId: null })],
    dayKey: DAY,
    onCreate: () => {},
    onEdit: () => {},
    density: "comfortable" as const,
    businessHours: { start: 8, end: 19, slotMinutes: 30 },
    highlight: null,
  };
  it("con `roomById`: la tarjeta con sala la muestra; la sin sala no", () => {
    const html = renderToStaticMarkup(<TimelineView {...props} roomById={{ r1: { name: "Consultorio 1" } }} />);
    expect((html.match(/data-room="true"/g) ?? []).length).toBe(1);
    expect(html).toContain("Consultorio 1");
  });
  it("sin `roomById` (o null): idéntico a no pasarlo", () => {
    const plain = renderToStaticMarkup(<TimelineView {...props} />);
    expect(renderToStaticMarkup(<TimelineView {...props} roomById={null} />)).toBe(plain);
    expect(plain).not.toContain("data-room");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SRZ · FX2a: fixes de la revisión (b) sobre "Por sala", el filtro y Recepción.
// Cada `it` arrancó rojo contra el código de SR-U6.
// ─────────────────────────────────────────────────────────────────────────────
import { withArchivedRooms, ARCHIVED_ROOM_LABEL } from "@/components/agenda/agenda-utils";

describe("[SRZ-FX2a] Por sala, filtro de sala y Recepción", () => {
  beforeAll(async () => {
    await Promise.all(dynamicLoads);
  });
  const rooms: RoomOption[] = [
    { id: "r1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
    { id: "r2", locationId: "L1", name: "Gimnasio", kind: "GIMNASIO", capacity: 3 },
  ];
  // BD (p2) tiene el Consultorio 1 de 9 a 13 y un turno ahí a las 10:00.
  const bdInC1 = bk("p2", "10:00", { roomId: "r1" });
  const withAssign: AgendaAvailability = {
    ...availability,
    days: availability.days.map((d) =>
      d.dayKey === DAY ? { ...d, roomAssignments: { r1: [{ practitionerId: "p2", startMin: 540, endMin: 780 }] } } : d
    ),
  };
  const roomView: Props = {
    ...base,
    view: "room",
    rooms,
    bookings: [...bookings, bdInC1],
    initialAvailability: withAssign,
  };
  const lastLayout = () =>
    roomViewProps.at(-1)!.layout as {
      columns: { roomId: string; slots: { time: string; state: string; bookings: { id: string }[]; continuing: { id: string }[] }[] }[];
    };

  it("M1: con el chip 'AP' puesto, el header dice 'Asignada: BD 9–13' (nunca '?')", () => {
    const html = r({ ...roomView, initialSelectedIds: ["p1"] }, "m1");
    expect(html).toContain("Asignada: BD 9–13");
    expect(html).not.toContain("Asignada: ?");
    // La card de BD en la sala lleva sus iniciales aunque no esté en los chips.
    expect(html).toContain('data-initials="BD"');
  });

  it("M1: consultorio de un solo profesional con salas: iniciales en el header", () => {
    const solo = withAssign.days.map((d) =>
      d.dayKey === DAY ? { ...d, roomAssignments: { r1: [{ practitionerId: "p1", startMin: 540, endMin: 780 }] } } : d
    );
    const html = r(
      {
        ...roomView,
        practitioners: [pracs[0]],
        bookings: bookings.filter((b) => b.practitionerId === "p1"),
        initialAvailability: { ...withAssign, days: solo },
      },
      "m1-solo"
    );
    expect(html).toContain("Asignada: AP 9–13");
    expect(html).not.toContain("Asignada: ?");
  });

  it("M2: con el chip 'AP', la celda del Consultorio 1 donde BD tiene turno no se ve libre; sin chips en 'Por sala'", () => {
    roomViewProps.length = 0;
    const html = r({ ...roomView, initialSelectedIds: ["p1"] }, "m2");
    expect(html).toContain('aria-label="Nuevo turno en Consultorio 1 a las 10:00 (lleno, 1 de 1 profesional)"');
    expect(html).not.toContain('aria-label="Nuevo turno en Consultorio 1 a las 10:00 (libre)"');
    const c1 = lastLayout().columns.find((c) => c.roomId === "r1")!;
    expect(c1.slots.find((s) => s.time === "10:00")!.state).toBe("lleno");
    // Los chips filtran: en "Por sala" no se ofrecen (ni el select de respaldo).
    expect(html).not.toContain("Profesionales a mostrar");
    expect(html).not.toContain("Todos los profesionales</option>");
    // Fuera de "Por sala" los chips siguen igual (y siguen filtrando).
    const day = r({ ...roomView, view: "timeline", initialSelectedIds: ["p1"] }, "m2-day");
    expect(day).toContain("Profesionales a mostrar");
    expect(day).not.toContain(bdInC1.patientName + "<");
  });

  it("M4: con 'Todas las sedes', 'Sin sala' no muestra turnos sin sala de otra sede", () => {
    roomViewProps.length = 0;
    r(roomView, "m4");
    const none = lastLayout().columns.find((c) => c.roomId === "none")!;
    const ids = none.slots.flatMap((s) => [...s.bookings, ...s.continuing].map((b) => b.id));
    const otherSede = bookings.find((b) => b.locationId === "L2")!;
    expect(ids).not.toContain(otherSede.id);
    // Los sin sala de la sede principal siguen ahí.
    expect(ids).toContain(bookings.find((b) => b.practitionerId === "p5")!.id);
  });

  it("B1: 'Todas las salas' cuenta también los turnos de salas fuera del alcance", () => {
    const r3: RoomOption = { id: "r3", locationId: "L2", name: "Box A", kind: "CONSULTORIO", capacity: 1 };
    const html = r(
      {
        ...base,
        rooms: [...rooms, r3],
        bookings: [...bookings.map((b) => (b.id === bookings[0].id ? { ...b, roomId: "r1" } : b)), bk("p6", "16:00", { locationId: "L2", roomId: "r3" })],
      },
      "b1"
    );
    // Día: b1(r1) + 4 sin sala (uno de L2) + p2 09:00 + p6 16:00 en r3 (L2) = 7 no cancelados.
    expect(html).toContain('aria-label="Todas las salas, 7 turnos"');
  });

  it("B3: el vacío de 'Por sala' según quién mira", () => {
    roomViewProps.length = 0;
    r({ ...roomView, capabilities: [...(base.capabilities ?? []), "tenant.admin", "schedule.configure"] }, "b3-owner");
    expect(roomViewProps.at(-1)!.canConfigureRooms).toBe(true);
    r({ ...roomView, capabilities: ["agenda.viewAll", "agenda.reception", "agenda.manageBlocks", "agenda.operateAll"] }, "b3-sec");
    expect(roomViewProps.at(-1)!.canConfigureRooms).toBe(false);
  });

  it("B4: en 'Por sala' con una sede sin salas, el toggle tiene 'Por sala' marcado y la salida a 'Por día'", () => {
    const l2 = { ...base.agendaPrefs!, locationId: "L2" };
    const html = r({ ...roomView, agendaPrefs: l2 }, "b4");
    expect(html).toMatch(/aria-checked="true"[^>]*data-mode="room"/);
    expect(html).toMatch(/data-mode="day"/);
    // Un solo profesional: igual hay toggle (Día / Por sala) para salir.
    const solo = r({ ...roomView, agendaPrefs: l2, practitioners: [pracs[0]] }, "b4-solo");
    expect(solo).toMatch(/aria-checked="true"[^>]*data-mode="room"/);
    expect(solo).toMatch(/data-mode="day"/);
  });

  it("B5: sala archivada en tarjetas, Lista y Recepción (no '—' ni nada)", () => {
    const archived = bookings.map((b) => (b.id === bookings[0].id ? { ...b, roomId: "r-vieja" } : b));
    const p: Props = { ...base, rooms, bookings: archived };
    expect(r(p, "b5-day")).toMatch(/data-room="true"[^>]*>.*?Sala archivada/);
    expect(r({ ...p, view: "list" }, "b5-list")).toContain("Sala archivada");
    expect(r({ ...p, view: "practitioner" }, "b5-prac")).toContain("Sala archivada");
    expect(r({ ...p, view: "reception" }, "b5-rec")).toContain("Sala archivada");
  });

  it("B5: withArchivedRooms suma solo los ids que faltan; sin catálogo, igual que antes", () => {
    const cat = { r1: { name: "Consultorio 1" } };
    const out = withArchivedRooms(cat, [{ roomId: "r1" }, { roomId: "rX" }, { roomId: null }, {}]);
    expect(out).toEqual({ r1: { name: "Consultorio 1" }, rX: { name: ARCHIVED_ROOM_LABEL } });
    // Sin ids desconocidos devuelve el MISMO objeto (no rompe memos).
    expect(withArchivedRooms(cat, [{ roomId: "r1" }])).toBe(cat);
    expect(ARCHIVED_ROOM_LABEL).toBe("Sala archivada");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SV09 · agenda en vivo (plan §18.5): con realtime `off` la agenda es la de SR
// byte a byte (golden tomado ANTES de cablear SV09); con `live`, el indicador.
// ─────────────────────────────────────────────────────────────────────────────
import { BookingCard, BookingFlashContext } from "@/components/agenda/grid/booking-card";

describe("[SV09] agenda en vivo", () => {
  beforeAll(async () => {
    await Promise.all(dynamicLoads);
  });
  // Reloj fijo: "En sala 12′" y la línea de ahora dependen de `new Date()`.
  const FIXED = new Date("2026-10-05T13:30:00.000Z"); // lunes 10:30 AR
  const atFixed = <T,>(fn: () => T): T => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED);
    try {
      return fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it("golden: con realtime off, el markup de cada vista es el de SR", () => {
    rt.state = "off";
    for (const view of ["timeline", "practitioner", "week", "list", "reception"] as const) {
      const html = atFixed(() => r({ ...base, view }, view));
      expect(html).not.toContain("k-live-badge");
      expect(html).not.toContain("k-flash");
      expect(html).toMatchSnapshot(`off-${view}`);
    }
  });

  it("con live: «En vivo» junto al título (completo en desktop, punto en mobile); reconectando también", () => {
    rt.state = "live";
    try {
      const html = atFixed(() => r(base, "live"));
      expect(html).toContain('class="k-live-badge" data-state="live"');
      expect(html).toContain("En vivo");
      // Compacto: solo el punto, con el texto en aria-label.
      expect(html).toContain('data-compact="true"');
      // Va en el header, junto al título (después del h1).
      expect(html.indexOf("k-live-badge")).toBeGreaterThan(html.indexOf("<h1"));
      expect(html.indexOf("k-live-badge")).toBeLessThan(html.indexOf("</header>"));
      rt.state = "reconnecting";
      expect(atFixed(() => r({ ...base, view: "week" }, "rec"))).toContain('data-state="reconnecting"');
    } finally {
      rt.state = "off";
    }
  });

  const card = (b: BookingDTO, flash?: boolean) =>
    renderToStaticMarkup(
      <BookingCard b={b} onEdit={() => {}} highlight={null} compact={false} sizing={{}} now={FIXED} flash={flash} />
    );

  it("BookingCard: flash → data-flash + clase k-flash; sin flash, el markup de siempre", () => {
    const b = bk("p1", "09:00");
    const plain = card(b);
    expect(plain).not.toContain("k-flash");
    expect(plain).not.toContain("data-flash");
    expect(card(b, false)).toBe(plain);
    const lit = card(b, true);
    expect(lit).toContain('data-flash="true"');
    expect(lit).toContain('class="k-flash"');
    // No se agrega una transición de background (la anima el CSS; una transición la pisaría).
    expect(lit).not.toMatch(/transition:[^"]*background/);
  });

  it("BookingCard: el flash también llega por contexto (sin tocar las vistas)", () => {
    const b = bk("p1", "09:00");
    const viaCtx = renderToStaticMarkup(
      <BookingFlashContext.Provider value={new Set([b.id])}>
        <BookingCard b={b} onEdit={() => {}} highlight={null} compact={false} sizing={{}} now={FIXED} />
      </BookingFlashContext.Provider>
    );
    expect(viaCtx).toBe(card(b, true));
    const other = renderToStaticMarkup(
      <BookingFlashContext.Provider value={new Set(["otro"])}>
        <BookingCard b={b} onEdit={() => {}} highlight={null} compact={false} sizing={{}} now={FIXED} />
      </BookingFlashContext.Provider>
    );
    expect(other).toBe(card(b));
  });

  it("BookingCard: «Llamado» con los tokens --rc-called-*", () => {
    const b = bk("p1", "10:00", { arrivedAt: ar(DAY, "10:10"), calledAt: ar(DAY, "10:28") });
    const html = card(b);
    expect(html).toContain('data-badge="llamado"');
    expect(html).toContain("Llamado");
    expect(html).toContain("var(--rc-called-bg)");
    expect(html).toContain("var(--rc-called-fg)");
  });
});
