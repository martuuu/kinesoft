/**
 * Salas del motor (corrida SR, SR1a): `defaultRoomFor`, `roomOccupancyAt`,
 * `roomAssignmentsFor` y `roomRangesFor`, más la paridad de AUDIT §5.27:
 * `scheduledRanges`/`workingRanges`/`dayLockState`/`classifyInstant` dan
 * EXACTAMENTE lo mismo con y sin `roomId` en las franjas.
 *
 * Puro; corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`) con el mismo
 * resultado. Los instantes se escriben con offset -03:00 explícito.
 */
import { describe, expect, it } from "vitest";
import {
  dayLockState,
  roomRangesFor,
  scheduledRanges,
  workingRanges,
} from "@/lib/availability/ranges";
import { defaultRoomFor, roomAssignmentsFor, roomOccupancyAt } from "@/lib/availability/rooms";
import { classifyInstant } from "@/lib/availability/classify";
import * as barrel from "@/lib/availability";
import {
  NO_LOCATION_ID,
  type AvailabilityBooking,
  type AvailabilityInput,
  type RoomBlock,
  type ScheduleExceptionInput,
  type ScheduleTemplateRange,
  type TimeBlockInput,
} from "@/lib/availability/types";
import type { RoomAssignment } from "@/lib/availability-actions-types";

// 2026-10-05 es lunes; 2026-10-06, martes; 2026-09-28, el lunes anterior.
const MONDAY = "2026-10-05";
const TUESDAY = "2026-10-06";
const PREV_MONDAY = "2026-09-28";
const P1 = "prac-1";
const P2 = "prac-2";
const P3 = "prac-3";
const MAIN = "loc-main";
const NORTE = "loc-norte";
const R1 = "room-1";
const R2 = "room-2";
const R3 = "room-3";
const R4 = "room-4";

const ar = (local: string) => new Date(`${local}:00-03:00`);

function tpl(
  dow: ScheduleTemplateRange["dow"],
  startH: number,
  endH: number,
  extra: Partial<ScheduleTemplateRange> = {}
): ScheduleTemplateRange {
  return {
    dow,
    startMin: Math.round(startH * 60),
    endMin: Math.round(endH * 60),
    locationId: MAIN,
    validFrom: null,
    validUntil: null,
    ...extra,
  };
}

function input(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    tenantId: "t1",
    from: "2026-09-01",
    to: "2026-10-31",
    primaryLocationId: MAIN,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [
      {
        practitionerId: P1,
        isFallback: false,
        ranges: [tpl(1, 9, 13, { roomId: R1 }), tpl(1, 15, 19, { roomId: R2 }), tpl(1, 13, 15)],
      },
    ],
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [],
    ...over,
  };
}

function exc(over: Partial<ScheduleExceptionInput>): ScheduleExceptionInput {
  return {
    id: "ex-" + Math.random().toString(36).slice(2),
    practitionerId: P1,
    date: MONDAY,
    kind: "CUSTOM_HOURS",
    ranges: [],
    reason: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// defaultRoomFor
// ─────────────────────────────────────────────────────────────────────────────

describe("defaultRoomFor", () => {
  it("plantilla: la sala de la franja que contiene el turno; franja sin sala o fuera de horario → null", () => {
    const i = input();
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R1);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T16:00"), 45, MAIN)).toBe(R2);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T13:30"), 45, null)).toBeNull(); // 13-15 sin sala
    expect(defaultRoomFor(i, P1, ar("2026-10-05T20:00"), 45, null)).toBeNull(); // fuera de horario
    expect(defaultRoomFor(i, P1, ar("2026-10-06T10:00"), 45, null)).toBeNull(); // martes: sin franjas
    expect(defaultRoomFor(i, "otro", ar("2026-10-05T10:00"), 45, null)).toBeNull(); // sin plantilla → fallback
  });

  it("borde semiabierto: un turno que arranca justo cuando termina la franja no es de esa franja", () => {
    const i = input();
    // 13:00 no está en [9, 13): cae en 13-15 (sin sala).
    expect(defaultRoomFor(i, P1, ar("2026-10-05T13:00"), 30, null)).toBeNull();
    // 15:00 está en [15, 19).
    expect(defaultRoomFor(i, P1, ar("2026-10-05T15:00"), 30, null)).toBe(R2);
  });

  it("excepción que manda: CUSTOM_HOURS reemplaza la plantilla (con su sala); CLOSED → null", () => {
    const custom = input({
      exceptions: [exc({ ranges: [{ startMin: 600, endMin: 720, locationId: MAIN, roomId: R3 }] })],
    });
    expect(defaultRoomFor(custom, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R3);
    // 9:00 estaba en la plantilla (R1) pero la excepción manda: fuera de franja.
    expect(defaultRoomFor(custom, P1, ar("2026-10-05T09:00"), 45, null)).toBeNull();

    const closed = input({ exceptions: [exc({ kind: "CLOSED", ranges: null })] });
    expect(defaultRoomFor(closed, P1, ar("2026-10-05T10:00"), 45, null)).toBeNull();

    // La del profesional gana sobre la del consultorio entero.
    const both = input({
      exceptions: [
        exc({ practitionerId: null, ranges: [{ startMin: 540, endMin: 780, locationId: MAIN, roomId: R4 }] }),
        exc({ ranges: [{ startMin: 540, endMin: 780, locationId: MAIN, roomId: R3 }] }),
      ],
    });
    expect(defaultRoomFor(both, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R3);
    // Otro profesional (sin excepción propia) toma la del consultorio.
    const clinic = input({
      templates: [...input().templates, { practitionerId: P2, isFallback: false, ranges: [tpl(1, 9, 13, { roomId: R2 })] }],
      exceptions: [exc({ practitionerId: null, ranges: [{ startMin: 540, endMin: 780, locationId: MAIN, roomId: R4 }] })],
    });
    expect(defaultRoomFor(clinic, P2, ar("2026-10-05T10:00"), 45, null)).toBe(R4);
  });

  it("vigencia: solo la fila de plantilla vigente ese día (validFrom/validUntil inclusive)", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [
            tpl(1, 9, 13, { roomId: R1, validUntil: "2026-10-04" }),
            tpl(1, 9, 13, { roomId: R2, validFrom: MONDAY }),
          ],
        },
      ],
    });
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R2);
    expect(defaultRoomFor(i, P1, ar("2026-09-28T10:00"), 45, null)).toBe(R1);
    // Inclusive en el borde: una fila que vence el mismo lunes todavía vale.
    const edge = input({
      templates: [
        { practitionerId: P1, isFallback: false, ranges: [tpl(1, 9, 13, { roomId: R3, validUntil: MONDAY })] },
      ],
    });
    expect(defaultRoomFor(edge, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R3);
    expect(defaultRoomFor(edge, P1, ar("2026-10-12T10:00"), 45, null)).toBeNull();
  });

  it("filtro de sede: solo las franjas de la sede resuelta; null = la principal", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 9, 13, { roomId: R1 }), tpl(1, 9, 13, { locationId: NORTE, roomId: R4 })],
        },
      ],
    });
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R1);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, MAIN)).toBe(R1);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, NORTE)).toBe(R4);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, "loc-otra")).toBeNull();
    // Sin sede principal: null = NO_LOCATION_ID, que no matchea sedes reales.
    expect(defaultRoomFor({ ...i, primaryLocationId: null }, P1, ar("2026-10-05T10:00"), 45, null)).toBeNull();
  });

  it("primero la que contiene el turno ENTERO; si ninguna, la que contiene el inicio", () => {
    const overlapping = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 9, 10, { roomId: R1 }), tpl(1, 9, 12, { roomId: R2 })],
        },
      ],
    });
    // 9:30-10:30: R1 contiene solo el inicio, R2 lo contiene entero → R2.
    expect(defaultRoomFor(overlapping, P1, ar("2026-10-05T09:30"), 60, null)).toBe(R2);
    // 9:00-10:00: las dos lo contienen entero → orden (startMin, roomId) → R1.
    expect(defaultRoomFor(overlapping, P1, ar("2026-10-05T09:00"), 60, null)).toBe(R1);

    const split = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 11, 13, { roomId: R2 }), tpl(1, 9, 11, { roomId: R1 })],
        },
      ],
    });
    // 10:30-11:30 no entra entero en ninguna: la que contiene el inicio (R1).
    expect(defaultRoomFor(split, P1, ar("2026-10-05T10:30"), 60, null)).toBe(R1);
    // Arranca antes de toda franja → null aunque termine adentro.
    expect(defaultRoomFor(split, P1, ar("2026-10-05T08:30"), 60, null)).toBeNull();
  });

  it("ante dos franjas iguales, gana la que tiene sala", () => {
    const i = input({
      templates: [{ practitionerId: P1, isFallback: false, ranges: [tpl(1, 9, 13), tpl(1, 9, 13, { roomId: R3 })] }],
    });
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R3);
  });

  it("cruce de medianoche AR: usa el día AR del inicio (no el UTC) y cae a la franja del inicio", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 22, 24, { roomId: R1 }), tpl(2, 0, 2, { roomId: R2 })],
        },
      ],
    });
    // Lunes 23:30 AR = martes 02:30 UTC. Con el día del host UTC daría martes (R2).
    expect(defaultRoomFor(i, P1, ar("2026-10-05T23:30"), 60, null)).toBe(R1);
    expect(defaultRoomFor(i, P1, ar("2026-10-05T23:00"), 60, null)).toBe(R1); // entra entera (termina 24:00)
    // Martes 00:30 AR = martes 03:30 UTC.
    expect(defaultRoomFor(i, P1, ar("2026-10-06T00:30"), 60, null)).toBe(R2);
    // Lunes 21:30 AR = martes 00:30 UTC: el lunes no tiene franja a esa hora.
    expect(defaultRoomFor(i, P1, ar("2026-10-05T21:30"), 30, null)).toBeNull();
  });

  it("fallback (isFallback) → null aunque el turno caiga en el horario del tenant", () => {
    const i = input({ templates: [{ practitionerId: P1, isFallback: true, ranges: [tpl(1, 8, 19)] }] });
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBeNull();
    // Pero una excepción del profesional con sala manda sobre el fallback.
    const withExc = {
      ...i,
      exceptions: [exc({ ranges: [{ startMin: 540, endMin: 720, locationId: MAIN, roomId: R3 }] })],
    };
    expect(defaultRoomFor(withExc, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R3);
  });

  it("los bloqueos (de profesional, de todos o de sala) no cambian la sala por defecto (§17.5)", () => {
    const block: TimeBlockInput = {
      id: "blk",
      practitionerId: null,
      locationId: null,
      startsAt: ar("2026-10-05T09:00"),
      endsAt: ar("2026-10-05T13:00"),
      allDay: false,
      reason: "Feriado",
      groupId: null,
    };
    const roomBlock: RoomBlock = { id: "rb", roomId: R1, startsAt: ar("2026-10-05T09:00"), endsAt: ar("2026-10-05T13:00"), reason: "Pintura" };
    const i = input({ blocks: [block], roomBlocks: [roomBlock] });
    expect(defaultRoomFor(i, P1, ar("2026-10-05T10:00"), 45, null)).toBe(R1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roomOccupancyAt
// ─────────────────────────────────────────────────────────────────────────────

type B = AvailabilityBooking & { roomId: string | null };
let seq = 0;
function bk(over: Partial<B> & { scheduledFor: Date }): B {
  seq += 1;
  return {
    id: `b-${seq}`,
    durationMin: 60,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: ar("2026-10-01T09:00"),
    patientId: `pat-${seq}`,
    idempotencyKey: `key-${seq}`,
    practitionerId: P2,
    serviceId: "svc",
    locationId: MAIN,
    roomId: R1,
    ...over,
  };
}

const NOW = ar("2026-10-05T08:00");
const Q = { roomId: R1, practitionerId: P1, when: ar("2026-10-05T10:00"), durationMin: 60, capacity: 1, now: NOW };

describe("roomOccupancyAt", () => {
  it("cuenta profesionales DISTINTOS con turno en la sala que solapa", () => {
    const rows = [
      bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:30") }),
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T09:30") }),
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T10:15"), durationMin: 30 }), // mismo P2: no suma
    ];
    const occ = roomOccupancyAt(rows, { ...Q, capacity: 3 });
    expect(occ).toEqual({ used: 2, capacity: 3, atCapacity: false, practitionerIds: [P2, P3], blocked: null });
  });

  it("el mismo profesional nunca choca consigo mismo; otra sala o sin sala no cuentan", () => {
    const rows = [
      bk({ practitionerId: P1, scheduledFor: ar("2026-10-05T10:00") }),
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T10:00"), roomId: R2 }),
      bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:00"), roomId: null }),
    ];
    expect(roomOccupancyAt(rows, Q)).toEqual({ used: 0, capacity: 1, atCapacity: false, practitionerIds: [], blocked: null });
  });

  it("cancelado y reserva pública impaga vencida (isHoldingCapacity §5.18) no cuentan; a los 30 min justos sí", () => {
    const pub = (createdAt: Date) =>
      bk({
        practitionerId: P2,
        scheduledFor: ar("2026-10-05T10:00"),
        status: "PENDING",
        paymentStatus: "UNPAID",
        idempotencyKey: "pub:t1:4b1c7d0e-0000-4000-8000-000000000000",
        patientId: "pat-pub",
        createdAt,
      });
    const cancelled = bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:00"), status: "CANCELLED" });
    const expired = pub(new Date(NOW.getTime() - 31 * 60_000));
    expect(roomOccupancyAt([cancelled, expired], Q).used).toBe(0);
    const justHeld = pub(new Date(NOW.getTime() - 30 * 60_000));
    expect(roomOccupancyAt([justHeld], Q)).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
    // Un guest PENDING/UNPAID de la recepción (key sin "pub:") retiene siempre.
    const guest = bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:00"), status: "PENDING", patientId: null, createdAt: new Date(0) });
    expect(roomOccupancyAt([guest], Q).used).toBe(1);
  });

  it("tocarse en el borde no choca (semiabierto)", () => {
    const rows = [
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T09:00") }), // 9-10
      bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T11:00") }), // 11-12
    ];
    expect(roomOccupancyAt(rows, Q).used).toBe(0);
    // Un minuto adentro de cada lado sí.
    const inside = [
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T09:01") }),
      bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:59") }),
    ];
    expect(roomOccupancyAt(inside, { ...Q, capacity: 5 }).practitionerIds).toEqual([P2, P3]);
  });

  it("capacidad N: lleno cuando used >= capacity", () => {
    const rows = [
      bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T10:00") }),
      bk({ practitionerId: P3, scheduledFor: ar("2026-10-05T10:00") }),
    ];
    expect(roomOccupancyAt(rows.slice(0, 1), { ...Q, capacity: 2 }).atCapacity).toBe(false);
    expect(roomOccupancyAt(rows, { ...Q, capacity: 2 })).toMatchObject({ used: 2, capacity: 2, atCapacity: true });
    expect(roomOccupancyAt(rows, { ...Q, capacity: 3 }).atCapacity).toBe(false);
  });

  it("excludeBookingId y excludeKey sacan la fila propia", () => {
    const own = bk({ practitionerId: P2, scheduledFor: ar("2026-10-05T10:00"), id: "mine", idempotencyKey: "retry-key" });
    expect(roomOccupancyAt([own], Q).used).toBe(1);
    expect(roomOccupancyAt([own], { ...Q, excludeBookingId: "mine" }).used).toBe(0);
    expect(roomOccupancyAt([own], { ...Q, excludeKey: "retry-key" }).used).toBe(0);
    expect(roomOccupancyAt([own], { ...Q, excludeBookingId: null, excludeKey: null }).used).toBe(1);
  });

  it("bloqueo de sala → atCapacity con blocked (el primero por inicio, id); otra sala o borde no", () => {
    const blocks: RoomBlock[] = [
      { id: "rb-b", roomId: R1, startsAt: ar("2026-10-05T10:30"), endsAt: ar("2026-10-05T12:00"), reason: null },
      { id: "rb-a", roomId: R1, startsAt: ar("2026-10-05T10:30"), endsAt: ar("2026-10-05T11:00"), reason: "Mantenimiento" },
      { id: "rb-0", roomId: R1, startsAt: ar("2026-10-05T11:00"), endsAt: ar("2026-10-05T12:00"), reason: "Borde" },
      { id: "rb-x", roomId: R2, startsAt: ar("2026-10-05T09:00"), endsAt: ar("2026-10-05T12:00"), reason: "Otra" },
    ];
    const occ = roomOccupancyAt([], { ...Q, capacity: 5 }, blocks);
    expect(occ).toEqual({
      used: 0,
      capacity: 5,
      atCapacity: true,
      practitionerIds: [],
      blocked: { blockId: "rb-a", reason: "Mantenimiento" },
    });
    // Solo el que toca en el borde (11:00) o el de otra sala → libre.
    expect(roomOccupancyAt([], Q, [blocks[2], blocks[3]])).toMatchObject({ atCapacity: false, blocked: null });
    // Sin roomBlocks (ausente) = ninguno.
    expect(roomOccupancyAt([], Q).blocked).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roomRangesFor y roomAssignmentsFor
// ─────────────────────────────────────────────────────────────────────────────

describe("roomRangesFor", () => {
  it("franjas crudas con roomId (null si no tiene), sin fusionar, ordenadas", () => {
    expect(roomRangesFor(input(), P1, MONDAY)).toEqual([
      { startMin: 540, endMin: 780, locationId: MAIN, roomId: R1 },
      { startMin: 780, endMin: 900, locationId: MAIN, roomId: null },
      { startMin: 900, endMin: 1140, locationId: MAIN, roomId: R2 },
    ]);
    // scheduledRanges las fusiona (se tocan) y no tiene sala.
    expect(scheduledRanges(P1, MONDAY, input())).toEqual([{ startMin: 540, endMin: 1140, locationId: MAIN }]);
  });

  it("CLOSED → []; fallback → la franja del tenant sin sala; sin sede principal → NO_LOCATION_ID", () => {
    expect(roomRangesFor(input({ exceptions: [exc({ kind: "CLOSED", ranges: null })] }), P1, MONDAY)).toEqual([]);
    const fb = input({ templates: [{ practitionerId: P1, isFallback: true, ranges: [] }] });
    expect(roomRangesFor(fb, P1, MONDAY)).toEqual([{ startMin: 480, endMin: 1140, locationId: MAIN, roomId: null }]);
    expect(roomRangesFor({ ...fb, primaryLocationId: null }, P1, MONDAY)).toEqual([
      { startMin: 480, endMin: 1140, locationId: NO_LOCATION_ID, roomId: null },
    ]);
  });
});

describe("roomAssignmentsFor", () => {
  it("por sala, las franjas crudas con sala de los profesionales, por (startMin, practitionerId)", () => {
    const i = input({
      templates: [
        ...input().templates,
        { practitionerId: P2, isFallback: false, ranges: [tpl(1, 9, 12, { roomId: R1 }), tpl(1, 8, 9, { roomId: R3 })] },
        { practitionerId: P3, isFallback: true, ranges: [] },
      ],
      exceptions: [exc({ practitionerId: P2, date: TUESDAY, ranges: [{ startMin: 600, endMin: 660, locationId: MAIN, roomId: R2 }] })],
    });
    const got: Record<string, RoomAssignment[]> = roomAssignmentsFor(i, MONDAY);
    expect(got).toEqual({
      [R1]: [
        { practitionerId: P1, startMin: 540, endMin: 780 },
        { practitionerId: P2, startMin: 540, endMin: 720 },
      ],
      [R2]: [{ practitionerId: P1, startMin: 900, endMin: 1140 }],
      [R3]: [{ practitionerId: P2, startMin: 480, endMin: 540 }],
    });
    // Solo los pedidos.
    expect(Object.keys(roomAssignmentsFor(i, MONDAY, [P2])).sort()).toEqual([R1, R3]);
    // Martes: la excepción de P2 manda.
    expect(roomAssignmentsFor(i, TUESDAY)).toEqual({ [R2]: [{ practitionerId: P2, startMin: 600, endMin: 660 }] });
    // Nadie con sala → {}.
    expect(roomAssignmentsFor(i, "2026-10-07")).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paridad §5.27: el roomId no mueve nada del motor de horarios
// ─────────────────────────────────────────────────────────────────────────────

describe("paridad AUDIT §5.27: con y sin roomId, el motor da lo mismo", () => {
  const strip = (i: AvailabilityInput): AvailabilityInput => ({
    ...i,
    templates: i.templates.map((t) => ({
      ...t,
      ranges: t.ranges.map(({ roomId: _r, ...r }) => r),
    })),
    exceptions: i.exceptions.map((e) => ({
      ...e,
      ranges: e.ranges ? e.ranges.map(({ roomId: _r, ...r }) => r) : null,
    })),
  });

  const withRooms = input({
    templates: [
      {
        practitionerId: P1,
        isFallback: false,
        ranges: [
          tpl(1, 9, 13, { roomId: R1 }),
          tpl(1, 12, 14, { roomId: R2 }), // se pisa con la anterior: se fusionan por sede
          tpl(1, 15, 19, { locationId: NORTE, roomId: R4 }),
          tpl(1, 19, 20),
          tpl(2, 9, 13, { roomId: R1, validUntil: "2026-10-01" }),
          tpl(2, 9, 11, { roomId: R2, validFrom: "2026-10-02" }),
          tpl(3, 0, 24, { roomId: R3 }),
        ],
      },
      { practitionerId: P2, isFallback: true, ranges: [] },
    ],
    exceptions: [
      exc({
        date: "2026-10-08",
        ranges: [
          { startMin: 600, endMin: 720, locationId: MAIN, roomId: R1 },
          { startMin: 700, endMin: 800, locationId: MAIN, roomId: R2 },
          { startMin: 900, endMin: 960, locationId: NORTE },
        ],
      }),
      exc({ practitionerId: null, date: "2026-10-09", ranges: [{ startMin: 480, endMin: 600, locationId: MAIN, roomId: R3 }] }),
    ],
    blocks: [
      {
        id: "blk-1",
        practitionerId: null,
        locationId: MAIN,
        startsAt: ar("2026-10-05T10:00"),
        endsAt: ar("2026-10-05T11:00"),
        allDay: false,
        reason: "Reunión",
        groupId: null,
      },
    ],
  });
  const without = strip(withRooms);
  const days = ["2026-09-29", PREV_MONDAY, MONDAY, TUESDAY, "2026-10-07", "2026-10-08", "2026-10-09"];

  it("el fixture sin sala realmente no tiene roomId (el test no es vacío)", () => {
    expect(JSON.stringify(withRooms)).toContain(R1);
    expect(JSON.stringify(without)).not.toContain("roomId");
  });

  it("scheduledRanges / workingRanges / dayLockState idénticos, con y sin filtro de sede", () => {
    for (const day of days) {
      for (const p of [P1, P2]) {
        for (const opts of [{}, { locationId: MAIN }, { locationId: NORTE }]) {
          const a = scheduledRanges(p, day, withRooms, opts);
          expect(a).toEqual(scheduledRanges(p, day, without, opts));
          // Ni siquiera la clave: la salida no lleva roomId.
          expect(JSON.stringify(a)).not.toContain("roomId");
          expect(workingRanges(p, day, withRooms, opts)).toEqual(workingRanges(p, day, without, opts));
          expect(dayLockState(p, day, withRooms, opts)).toEqual(dayLockState(p, day, without, opts));
        }
      }
      expect(dayLockState(null, day, withRooms)).toEqual(dayLockState(null, day, without));
    }
  });

  it("classifyInstant idéntico", () => {
    const instants = [
      ar("2026-10-05T09:00"),
      ar("2026-10-05T10:30"),
      ar("2026-10-05T12:30"),
      ar("2026-10-05T15:00"),
      ar("2026-10-06T10:00"),
      ar("2026-10-07T23:30"),
      ar("2026-10-08T11:30"),
      ar("2026-10-09T09:00"),
    ];
    for (const when of instants) {
      for (const locationId of [null, MAIN, NORTE]) {
        const base = {
          when,
          durationMin: 60,
          practitionerId: P1,
          serviceId: "svc",
          locationId,
          cap: 1,
          bookings: [],
          now: NOW,
        };
        const a = classifyInstant({
          ...base,
          rangesFor: (p, d) => scheduledRanges(p, d, withRooms),
          blocks: withRooms.blocks,
        });
        const b = classifyInstant({
          ...base,
          rangesFor: (p, d) => scheduledRanges(p, d, without),
          blocks: without.blocks,
        });
        expect(a).toEqual(b);
      }
    }
  });
});

describe("barrel", () => {
  it("lib/availability exporta las funciones de salas", () => {
    expect(barrel.defaultRoomFor).toBe(defaultRoomFor);
    expect(barrel.roomOccupancyAt).toBe(roomOccupancyAt);
    expect(barrel.roomAssignmentsFor).toBe(roomAssignmentsFor);
    expect(barrel.roomRangesFor).toBe(roomRangesFor);
  });
});
