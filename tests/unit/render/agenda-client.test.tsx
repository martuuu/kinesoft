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
  agendaPrefs: { mode: "day", zoom: 30, density: "comfortable", favoritePractitionerIds: ["p3"], locationId: null },
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
