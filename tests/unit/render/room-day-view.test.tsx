/**
 * SR-U4 · vista "Por sala" (`components/agenda/views/room-day-view.tsx`) sobre
 * el shell `day-columns-grid` y la celda genérica `grid/slot-cell`. Sin jsdom
 * (`renderToStaticMarkup`), TZ=UTC. La vista por profesional tiene su contrato
 * aparte (`practitioner-day-view.test.tsx`, intacto).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgendaZoom } from "@/lib/agenda-layout";
import { buildRoomColumns, type LayoutRoom } from "@/lib/agenda-layout-rooms";
import {
  RoomDayView,
  roomAssignmentText,
  roomBlockStatus,
  roomSlotStateText,
} from "@/components/agenda/views/room-day-view";
import type { PractitionerDayBooking } from "@/components/agenda/views/practitioner-day-view";
import type { AgendaHighlight } from "@/lib/agenda-highlight";

const DAY = "2026-10-05"; // lunes
const ar = (hhmm: string) => `${DAY}T${hhmm}:00-03:00`;
const iso = (hhmm: string) => new Date(ar(hhmm)).toISOString();
const NOW = new Date(ar("14:32"));

const LOC = "loc-centro";
// Orden del bootstrap (sede + sortOrder): Consultorio 2 va ANTES que Consultorio 1 a propósito.
const ROOMS: LayoutRoom[] = [
  { id: "r-c2", name: "Consultorio 2", kind: "CONSULTORIO", capacity: 1, locationId: LOC },
  { id: "r-c1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, locationId: LOC },
  { id: "r-gym", name: "Gimnasio", kind: "GIMNASIO", capacity: 3, locationId: LOC },
];
const PRACS = {
  p1: { initials: "AP", name: "Ana Pérez" },
  p2: { initials: "BF", name: "Bruno de la Fuente" },
  p3: { initials: "CG", name: "Carla Gómez" },
};
const ASSIGN = {
  "r-c2": [
    { practitionerId: "p1", startMin: 9 * 60, endMin: 13 * 60 },
    { practitionerId: "p2", startMin: 14 * 60, endMin: 18 * 60 },
  ],
  "r-gym": [{ practitionerId: "p3", startMin: 8 * 60, endMin: 19 * 60 + 30 }],
};

type B = PractitionerDayBooking & { roomId?: string | null };
let seq = 0;
function bk(pid: string, hhmm: string, roomId: string | null, over: Partial<B> = {}): B {
  seq += 1;
  return {
    id: `b${seq}`,
    scheduledFor: iso(hhmm),
    durationMin: 30,
    status: "CONFIRMED",
    serviceId: "svc-kine",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: pid,
    patientId: `pt${seq}`,
    patientName: `Paciente ${seq}`,
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 100000,
    updatedAt: iso("07:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    roomId,
    ...over,
  };
}

const BOOKINGS: B[] = [
  bk("p1", "10:00", "r-c2", { patientName: "Lucía Sala" }),
  // Gimnasio: 5 pacientes de Carla a las 10 → "+1 más" en cómodo (límite 4)
  ...Array.from({ length: 5 }, () => bk("p3", "10:00", "r-gym")),
  bk("p2", "15:00", null, { patientName: "Sin Sala Uno" }),
];
const ROOM_BLOCKS = [{ id: "rb-1", roomId: "r-c1", startsAt: ar("11:00"), endsAt: ar("12:00"), reason: "Mantenimiento" }];

function render(
  opts: { zoom?: AgendaZoom; density?: "comfortable" | "compact"; highlight?: AgendaHighlight | null; list?: B[]; fallback?: string | null } = {}
) {
  const zoom = opts.zoom ?? 30;
  const layout = buildRoomColumns(ROOMS, opts.list ?? BOOKINGS, {
    dayKey: DAY,
    zoom,
    now: NOW,
    assignments: ASSIGN,
    roomBlocks: ROOM_BLOCKS,
  });
  const html = renderToStaticMarkup(
    <RoomDayView
      dayKey={DAY}
      layout={layout}
      zoom={zoom}
      density={opts.density ?? "comfortable"}
      now={NOW}
      onSlotClick={() => {}}
      onBookingClick={() => {}}
      highlight={opts.highlight ?? null}
      practitionerById={PRACS}
      fallbackLocationName={opts.fallback ?? null}
    />
  );
  return { layout, html };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("SR-U4 RoomDayView — render", () => {
  it("columnas en el orden del bootstrap (sortOrder) + 'Sin sala' al final", () => {
    const { layout, html } = render();
    expect(layout.columns.map((c) => c.roomId)).toEqual(["r-c2", "r-c1", "r-gym", "none"]);
    const order = ["r-c2", "r-c1", "r-gym", "none"].map((id) => html.indexOf(`role="columnheader" aria-colindex`) >= 0 && html.indexOf(`data-room="${id}"`));
    expect(order.every((i) => typeof i === "number" && i > 0)).toBe(true);
    expect([...order].sort((a, b) => Number(a) - Number(b))).toEqual(order);
    expect(html).toContain("Turnos sin sala asignada");
  });

  it("aria-grid: grid, headers, rowheaders, gridcells, roving tabindex", () => {
    const { layout, html } = render();
    const rows = layout.rows.length;
    const cols = layout.columns.length;
    expect(count(html, 'role="grid"')).toBe(1);
    // Intl es-AR pone la coma después del día de semana (igual que "por profesional").
    expect(html).toMatch(/aria-label="Agenda del lunes,? 5 de octubre por sala"/);
    expect(count(html, 'role="columnheader"')).toBe(cols + 1);
    expect(count(html, 'role="rowheader"')).toBe(rows);
    expect(count(html, 'role="gridcell"')).toBe(rows * cols);
    expect(html).toContain(`aria-rowcount="${rows + 1}"`);
    expect(html).toContain(`aria-colcount="${cols + 1}"`);
    expect(count(html, 'tabindex="0"')).toBe(1);
    expect(html).toContain('data-now-line="14:32"');
  });

  it("aria de celda con la sala, estados de sala y 'sin profesional asignado'", () => {
    const { html } = render();
    expect(html).toContain('aria-label="Nuevo turno en Consultorio 2 a las 09:00 (libre)"');
    expect(html).toContain('aria-label="Nuevo turno en Consultorio 2 a las 10:00 (lleno, 1 de 1 profesional)"');
    expect(html).toContain('aria-label="Nuevo turno en Gimnasio a las 10:00 (1 de 3 profesionales a la vez)"');
    expect(html).toContain('aria-label="Nuevo turno en Consultorio 1 a las 09:00 (sin profesional asignado)"');
    expect(html).toContain('aria-label="Nuevo turno sin sala a las 15:00 (1 turno)"');
    // Bloqueo de sala: no abre el alta, dice el motivo
    expect(html).toContain("11:00, Consultorio 1: bloqueado: Mantenimiento");
    expect(html).toContain('aria-disabled="true"');
    expect(count(html, "Mantenimiento</span>")).toBe(1);
    expect(html).toMatch(/data-state="lleno" data-room="r-c2" data-time="10:00"/);
    expect(html).not.toContain("data-practitioner=");
  });

  it("header: nombre, tipo, 'hasta N', asignación con iniciales y horario; chip de bloqueo", () => {
    const { html } = render();
    expect(html).toContain("Consultorio · hasta 1");
    expect(html).toContain("Gimnasio · hasta 3");
    expect(html).toContain('title="hasta 3 profesionales a la vez"');
    expect(html).toContain("Asignada: AP 9–13 · BF 14–18");
    expect(html).toContain("Asignada: CG 8–19:30");
    expect(html).toContain("Sin asignar");
    expect(html).toContain('aria-label="Sala: Parcial · Mantenimiento"');
    expect(html).toMatch(/data-count="5"[^>]*>5 turnos/);
  });

  it("tarjetas con las iniciales del profesional (PractitionerBadge neutro, sin color nuevo)", () => {
    const { html } = render();
    expect(html).toContain('data-initials="AP"');
    expect(html).toContain('data-initials="CG"');
    expect(html).toContain('data-initials="BF"');
    expect(html).toContain("Lucía Sala");
    // Sin colores nuevos: los únicos hex del markup son el del servicio de las cards
    // y los que ya existían (ámbar del sobreturno, naranja de la línea de "ahora").
    const hexes = new Set(html.match(/#[0-9a-fA-F]{6}\b/g) ?? []);
    for (const h of hexes) expect(["#3d74b5", "#9A5B00", "#C2410C", "#E4572E"]).toContain(h);
  });

  it("'+N más' en la sala densa (dice 'en <sala>')", () => {
    const comfy = render();
    expect(comfy.html).toContain("+1 más");
    expect(comfy.html).toContain('aria-label="Ver 1 turno más en Gimnasio a las 10:00"');
    const compact = render({ density: "compact" });
    expect(compact.html).toContain("+2 más");
  });

  it("sobreturno de sala: dos profesionales en un consultorio de 1", () => {
    const { html } = render({ list: [bk("p1", "10:00", "r-c2"), bk("p2", "10:00", "r-c2")] });
    expect(html).toContain('data-occupancy="2/1"');
    expect(html).toContain("con más profesionales que lugares, 2 de 1");
    expect(html).not.toContain("Turnos sin sala asignada"); // sin turnos sin sala, no hay columna
  });

  it("resaltado: el header cuenta coincidencias", () => {
    const { html } = render({ highlight: { kind: "loose" } });
    expect(html).toContain("data-highlight-count");
  });

  it("sin salas → mensaje; sede de respaldo → aviso", () => {
    const empty = buildRoomColumns([], [], { dayKey: DAY, zoom: 30, now: NOW, assignments: {} });
    const html = renderToStaticMarkup(
      <RoomDayView dayKey={DAY} layout={empty} zoom={30} density="compact" now={NOW} onSlotClick={() => {}} onBookingClick={() => {}} practitionerById={{}} />
    );
    // SRZ (FX2a B3): sin `canConfigureRooms` (la Secretaria no entra a
    // Configuración) el vacío no la manda a un lugar que no puede abrir.
    expect(html).toContain("Esta sede no tiene salas. Pedile a quien administra el consultorio que las cargue.");
    expect(html).not.toContain("Configuración");
    expect(render({ fallback: "Centro" }).html).toContain("Mostrando las salas de Centro. Elegí otra sede arriba.");
  });

  it("[SRZ-FX2a B3] vacío con permiso de configurar: 'Cargalas en Configuración › Sedes.'", () => {
    const empty = buildRoomColumns([], [], { dayKey: DAY, zoom: 30, now: NOW, assignments: {} });
    const html = renderToStaticMarkup(
      <RoomDayView dayKey={DAY} layout={empty} zoom={30} density="compact" now={NOW} onSlotClick={() => {}} onBookingClick={() => {}} practitionerById={{}} canConfigureRooms />
    );
    expect(html).toContain("Esta sede no tiene salas. Cargalas en Configuración › Sedes.");
    expect(html).not.toContain("Pedile");
  });

  it("zoom 15 compacto y zoom 60 renderizan", () => {
    expect(count(render({ zoom: 15, density: "compact" }).html, 'role="gridcell"')).toBeGreaterThan(0);
    expect(count(render({ zoom: 60 }).html, 'role="gridcell"')).toBeGreaterThan(0);
  });
});

describe("SR-U4 helpers puros", () => {
  it("roomAssignmentText", () => {
    expect(roomAssignmentText([], PRACS)).toBe("Sin asignar");
    expect(
      roomAssignmentText(
        [
          { practitionerId: "p1", startMin: 9 * 60 + 30, endMin: 13 * 60 },
          { practitionerId: "pX", startMin: 14 * 60, endMin: 24 * 60 },
        ],
        PRACS
      )
    ).toBe("Asignada: AP 9:30–13 · ? 14–24");
  });

  it("roomSlotStateText", () => {
    const base = { used: 0, cap: 1, blockReason: null, overbooked: false, total: 0 };
    expect(roomSlotStateText({ ...base, state: "libre" })).toBe("libre");
    expect(roomSlotStateText({ ...base, state: "fuera-de-horario" })).toBe("sin profesional asignado");
    expect(roomSlotStateText({ ...base, state: "fuera-de-horario", used: 1, total: 2 })).toBe("sin profesional asignado, 2 turnos");
    expect(roomSlotStateText({ ...base, state: "bloqueado", blockReason: "Pintura" })).toBe("bloqueado: Pintura");
    expect(roomSlotStateText({ ...base, state: "parcial", used: 1, cap: 3 })).toBe("1 de 3 profesionales a la vez");
    expect(roomSlotStateText({ ...base, state: "parcial", used: 2, cap: null, total: 3 })).toBe("3 turnos");
  });

  it("roomBlockStatus: sala sin asignar y bloqueada entera = Bloqueado", () => {
    const layout = buildRoomColumns([ROOMS[1]], [], {
      dayKey: DAY,
      zoom: 60,
      now: NOW,
      assignments: {},
      window: { startMin: 11 * 60, endMin: 12 * 60 },
      roomBlocks: ROOM_BLOCKS,
    });
    expect(roomBlockStatus(layout.columns[0])).toEqual({ status: "locked", label: "Bloqueado", detail: "Mantenimiento" });
  });
});
