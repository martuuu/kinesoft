/**
 * `lib/agenda-layout.ts` (B3.6 AG-layout): lógica pura de la agenda
 * multi-profesional (columnas por profesional, celdas con cupo, carriles de
 * simultaneidad, ventana visible, ocupación de la semana, línea de "ahora").
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`): nada depende del
 * huso del host.
 */
import { describe, expect, it } from "vitest";
import * as agendaLayout from "@/lib/agenda-layout";
import {
  buildPractitionerColumns,
  capResolver,
  nowOffset,
  practitionerInitials,
  practitionerOrder,
  visibleWindow,
  weekOccupancy,
  type LayoutBooking,
  type LayoutBlock,
  type SlotCell,
} from "@/lib/agenda-layout";
// SRZ (FX2a #8): lo de "Por sala" vive aparte, fuera del first load de /agenda.
import { buildRoomColumns, NO_ROOM_COLUMN_ID, type RoomLayoutBooking } from "@/lib/agenda-layout-rooms";

// 2026-10-05 es lunes. 08:00 AR = 11:00Z.
const DAY = "2026-10-05";
const MAIN = "loc-main";
const NOW = new Date("2026-10-05T09:00:00.000Z"); // 06:00 AR del mismo día

/** Instante ISO de una hora de pared AR del día de prueba. */
const ar = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-03:00`);

const KINE = "svc-kine"; // cupo null (gimnasio)
const OSTEO = "svc-osteo"; // cupo 1
const GRUPO = "svc-grupo"; // cupo 3
const CAPS: Record<string, number | null> = { [KINE]: null, [OSTEO]: 1, [GRUPO]: 3 };
const capOf = (_pid: string, sid: string) => CAPS[sid] ?? null;

let seq = 0;
function bk(hhmm: string, over: Partial<LayoutBooking> = {}): LayoutBooking {
  seq += 1;
  return {
    id: `bk-${String(seq).padStart(3, "0")}`,
    scheduledFor: ar(hhmm),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: KINE,
    practitionerId: "p1",
    ...over,
  };
}

const range8to19 = [{ startMin: 8 * 60, endMin: 19 * 60, locationId: MAIN }];
const P1 = { id: "p1", name: "María José Pérez García" };
const P2 = { id: "p2", name: "Juan Gómez" };

function cell<T extends LayoutBooking>(slots: SlotCell<T>[], hhmm: string): SlotCell<T> {
  const found = slots.find((s) => s.time === hhmm);
  if (!found) throw new Error(`sin celda ${hhmm}`);
  return found;
}

describe("visibleWindow", () => {
  it("unión de franjas de todos los profesionales, redondeada a la grilla", () => {
    const w = visibleWindow(
      {
        p1: [{ startMin: 8 * 60 + 15, endMin: 12 * 60 }],
        p2: [{ startMin: 14 * 60, endMin: 19 * 60 + 10 }],
      },
      { startMin: 9 * 60, endMin: 18 * 60 },
      { zoom: 30 }
    );
    expect(w).toEqual({ startMin: 8 * 60, endMin: 19 * 60 + 30 });
  });

  it("sin franjas → horario del tenant", () => {
    expect(visibleWindow({ p1: [] }, { startMin: 9 * 60, endMin: 18 * 60 }, { zoom: 60 })).toEqual({
      startMin: 9 * 60,
      endMin: 18 * 60,
    });
  });

  it("incluye un turno a las 7:00 fuera del horario 8-19 (no queda invisible)", () => {
    const w = visibleWindow({ p1: range8to19 }, { startMin: 8 * 60, endMin: 19 * 60 }, {
      zoom: 30,
      dayKey: DAY,
      bookings: [bk("07:00", { durationMin: 30 })],
    });
    expect(w).toEqual({ startMin: 7 * 60, endMin: 19 * 60 });
  });

  it("un turno que termina a las 19:40 estira el final; turnos de otro día no cuentan", () => {
    const w = visibleWindow({ p1: range8to19 }, { startMin: 8 * 60, endMin: 19 * 60 }, {
      zoom: 60,
      dayKey: DAY,
      bookings: [bk("19:00", { durationMin: 40 }), { ...bk("06:00"), scheduledFor: ar("06:00", "2026-10-06") }],
    });
    expect(w).toEqual({ startMin: 8 * 60, endMin: 20 * 60 });
  });

  it("acepta scheduledFor como ISO string (DTO del cliente)", () => {
    const w = visibleWindow({}, { startMin: 8 * 60, endMin: 19 * 60 }, {
      zoom: 15,
      dayKey: DAY,
      bookings: [{ ...bk("07:50"), scheduledFor: ar("07:50").toISOString() }],
    });
    expect(w.startMin).toBe(7 * 60 + 45);
  });
});

describe("buildPractitionerColumns · cupo, estados y carriles", () => {
  it("kinesio cupo null: 4 pacientes simultáneos → 4 carriles, '4/∞', parcial", () => {
    const four = [0, 1, 2, 3].map((i) => bk("10:00", { patientIdHint: i } as Partial<LayoutBooking>));
    const { columns } = buildPractitionerColumns([P1], four, {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const col = columns[0];
    const c = cell(col.slots, "10:00");
    expect(c.bookings.map((b) => b.id)).toEqual(four.map((b) => b.id));
    expect(c.used).toBe(4);
    expect(c.cap).toBeNull();
    expect(c.label).toBe("4/∞");
    expect(c.state).toBe("parcial");
    // Carriles: 0..3 en orden, los cuatro comparten laneCount 4.
    expect(four.map((b) => col.lanes[b.id])).toEqual([
      { lane: 0, laneCount: 4 },
      { lane: 1, laneCount: 4 },
      { lane: 2, laneCount: 4 },
      { lane: 3, laneCount: 4 },
    ]);
    expect(col.maxLanes).toBe(4);
    // El turno de 45' sigue en la celda de 10:30 como "continúa".
    expect(cell(col.slots, "10:30").continuing).toHaveLength(4);
    expect(cell(col.slots, "10:30").used).toBe(4);
    expect(cell(col.slots, "11:00").state).toBe("libre");
  });

  it("carriles greedy: un carril se reutiliza cuando el turno anterior terminó", () => {
    const a = bk("09:00", { durationMin: 60 });
    const b = bk("09:30", { durationMin: 60 });
    const c = bk("10:00", { durationMin: 30 }); // a terminó a las 10:00 → carril 0
    const d = bk("12:00", { durationMin: 30 }); // grupo nuevo
    const { columns } = buildPractitionerColumns([P1], [d, c, b, a], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const lanes = columns[0].lanes;
    expect(lanes[a.id]).toEqual({ lane: 0, laneCount: 2 });
    expect(lanes[b.id]).toEqual({ lane: 1, laneCount: 2 });
    expect(lanes[c.id]).toEqual({ lane: 0, laneCount: 2 });
    expect(lanes[d.id]).toEqual({ lane: 0, laneCount: 1 });
  });

  it("osteo cupo 1 ocupado → '1/1' lleno", () => {
    const o = bk("10:00", { serviceId: OSTEO, durationMin: 30 });
    const { columns } = buildPractitionerColumns([P1], [o], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const c = cell(columns[0].slots, "10:00");
    expect(c).toMatchObject({ used: 1, cap: 1, label: "1/1", state: "lleno", overbooked: false });
  });

  it("zoom 60: dos turnos osteo consecutivos de 30' en la misma celda NO son sobreturno (pico, no conteo)", () => {
    const a = bk("10:00", { serviceId: OSTEO, durationMin: 30 });
    const b = bk("10:30", { serviceId: OSTEO, durationMin: 30 });
    const { columns } = buildPractitionerColumns([P1], [a, b], {
      dayKey: DAY,
      zoom: 60,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const c = cell(columns[0].slots, "10:00");
    expect(c.bookings).toHaveLength(2);
    expect(c).toMatchObject({ used: 1, cap: 1, label: "1/1", state: "lleno" });
  });

  it("sobreturno: dos osteo solapados en cupo 1 → '2/1' sobreturno; también por isOverbooked con cupo libre", () => {
    const a = bk("10:00", { serviceId: OSTEO, durationMin: 30 });
    const b = bk("10:00", { serviceId: OSTEO, durationMin: 30, isOverbooked: true });
    const k = bk("15:00", { serviceId: KINE, isOverbooked: true });
    const { columns } = buildPractitionerColumns([P1], [a, b, k], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    expect(cell(columns[0].slots, "10:00")).toMatchObject({ used: 2, cap: 1, label: "2/1", state: "sobreturno" });
    expect(cell(columns[0].slots, "15:00")).toMatchObject({ label: "1/∞", state: "sobreturno", overbooked: true });
  });

  it("servicios mezclados: manda el de mayor ocupación relativa (cupo finito) y byService trae el detalle", () => {
    const ks = [0, 1, 2, 3].map(() => bk("10:00", { serviceId: KINE }));
    const g = [bk("10:00", { serviceId: GRUPO }), bk("10:00", { serviceId: GRUPO })];
    const { columns } = buildPractitionerColumns([P1], [...ks, ...g], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const c = cell(columns[0].slots, "10:00");
    expect(c).toMatchObject({ used: 2, cap: 3, label: "2/3", state: "parcial" });
    expect(c.byService).toEqual([
      { serviceId: GRUPO, used: 2, cap: 3 },
      { serviceId: KINE, used: 4, cap: null },
    ]);
    expect(c.total).toBe(6);
  });

  it("solo cupo ilimitado: manda el de más uso", () => {
    const { columns } = buildPractitionerColumns([P1], [bk("10:00"), bk("10:00")], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    expect(cell(columns[0].slots, "10:00").label).toBe("2/∞");
  });

  it("cancelados se dibujan pero no ocupan cupo; reserva pública vencida tampoco", () => {
    const cancelled = bk("10:00", { serviceId: OSTEO, durationMin: 30, status: "CANCELLED" });
    const expired = bk("11:00", {
      serviceId: OSTEO,
      durationMin: 30,
      status: "PENDING",
      paymentStatus: "UNPAID",
      publicReservation: true,
      createdAt: new Date(NOW.getTime() - 31 * 60_000),
    });
    const fresh = bk("12:00", {
      serviceId: OSTEO,
      durationMin: 30,
      status: "PENDING",
      paymentStatus: "UNPAID",
      publicReservation: true,
      createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const { columns } = buildPractitionerColumns([P1], [cancelled, expired, fresh], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const s = columns[0].slots;
    expect(cell(s, "10:00")).toMatchObject({ used: 0, state: "libre", label: null });
    expect(cell(s, "10:00").bookings).toHaveLength(1);
    expect(cell(s, "11:00")).toMatchObject({ used: 0, state: "libre" });
    expect(cell(s, "12:00")).toMatchObject({ used: 1, state: "lleno" });
    expect(columns[0].bookingCount).toBe(2); // sin el cancelado
  });

  it("fuera de horario: turno a las 7:00 con horario 8-19 → la ventana lo incluye y la celda es fuera-de-horario", () => {
    const early = bk("07:00", { durationMin: 30 });
    const layout = buildPractitionerColumns([P1], [early], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    expect(layout.window).toEqual({ startMin: 7 * 60, endMin: 19 * 60 });
    expect(layout.rows[0]).toEqual({ startMin: 420, endMin: 450, time: "07:00" });
    const c = cell(layout.columns[0].slots, "07:00");
    expect(c).toMatchObject({ state: "fuera-de-horario", outOfHours: true, used: 1, label: "1/∞" });
    expect(c.bookings.map((b) => b.id)).toEqual([early.id]);
    expect(cell(layout.columns[0].slots, "07:30").state).toBe("fuera-de-horario");
    expect(cell(layout.columns[0].slots, "08:00").state).toBe("libre");
  });

  it("profesional sin franjas ese día → todas sus celdas fuera-de-horario; el otro, libre", () => {
    const { columns } = buildPractitionerColumns([P1, P2], [], {
      dayKey: DAY,
      zoom: 60,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    expect(columns.map((c) => c.practitionerId)).toEqual(["p1", "p2"]);
    expect(columns[1].slots.every((s) => s.state === "fuera-de-horario")).toBe(true);
    expect(columns[0].slots.every((s) => s.state === "libre")).toBe(true);
    expect(columns[1].initials).toBe("JG");
  });

  it("bloqueo parcial 10:00-11:15 → solo esas celdas bloqueadas (con motivo), aunque tengan turnos", () => {
    const blocks: LayoutBlock[] = [
      { id: "tb1", practitionerId: "p1", locationId: null, startsAt: ar("10:00"), endsAt: ar("11:15"), reason: "Congreso" },
      // de otro profesional: no afecta a p1
      { id: "tb2", practitionerId: "p2", startsAt: ar("08:00"), endsAt: ar("19:00") },
    ];
    // Las franjas efectivas (workingRanges) ya vienen con el bloqueo restado.
    const effective = [
      { startMin: 480, endMin: 600, locationId: MAIN },
      { startMin: 675, endMin: 1140, locationId: MAIN },
    ];
    const inBlock = bk("10:30", { isOverbooked: true });
    const { columns } = buildPractitionerColumns([P1], [inBlock], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: effective },
      blocks,
      capOf,
      now: NOW,
    });
    const s = columns[0].slots;
    expect(cell(s, "09:30").state).toBe("libre");
    expect(cell(s, "10:00")).toMatchObject({ state: "bloqueado", blocked: true, blockIds: ["tb1"], blockReason: "Congreso" });
    expect(cell(s, "10:30")).toMatchObject({ state: "bloqueado", overbooked: true, used: 1 });
    expect(cell(s, "11:00").state).toBe("bloqueado"); // 11:00-11:15 bloqueado
    expect(cell(s, "11:30").state).toBe("libre");
  });

  it("bloqueo de todos los profesionales (practitionerId null) y allDay tapa el día entero", () => {
    const blocks: LayoutBlock[] = [
      { id: "fer", practitionerId: null, startsAt: ar("00:00"), endsAt: ar("23:59"), allDay: true, reason: "Feriado" },
    ];
    const { columns } = buildPractitionerColumns([P1, P2], [], {
      dayKey: DAY,
      zoom: 60,
      ranges: { p1: range8to19, p2: range8to19 },
      blocks,
      capOf,
      now: NOW,
    });
    for (const col of columns) expect(col.slots.every((s) => s.state === "bloqueado")).toBe(true);
  });

  it("bloqueo de una sede no tapa la franja que el profesional tiene en otra sede", () => {
    const ranges = {
      p1: [
        { startMin: 480, endMin: 720, locationId: "norte" },
        { startMin: 840, endMin: 1140, locationId: "sur" },
      ],
    };
    const blocks: LayoutBlock[] = [
      { id: "n", practitionerId: "p1", locationId: "norte", startsAt: ar("08:00"), endsAt: ar("19:00") },
    ];
    const { columns } = buildPractitionerColumns([P1], [], { dayKey: DAY, zoom: 60, ranges, blocks, capOf, now: NOW });
    expect(cell(columns[0].slots, "09:00").state).toBe("bloqueado");
    expect(cell(columns[0].slots, "15:00").state).toBe("libre");
  });

  it("turnos de otros profesionales o de otro día no se mezclan", () => {
    const mine = bk("10:00");
    const other = bk("10:00", { practitionerId: "p2" });
    const tomorrow = { ...bk("10:00"), scheduledFor: ar("10:00", "2026-10-06") };
    const { columns } = buildPractitionerColumns([P1], [mine, other, tomorrow], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    expect(cell(columns[0].slots, "10:00").bookings.map((b) => b.id)).toEqual([mine.id]);
    expect(columns[0].bookingCount).toBe(1);
  });

  it("devuelve el mismo objeto del caller (genérico), no una copia", () => {
    const b = { ...bk("10:00"), patientName: "Ana" };
    const { columns } = buildPractitionerColumns([P1], [b], {
      dayKey: DAY,
      zoom: 30,
      ranges: { p1: range8to19 },
      capOf,
      now: NOW,
    });
    const got = cell(columns[0].slots, "10:00").bookings[0];
    expect(got).toBe(b);
    expect(got.patientName).toBe("Ana");
  });
});

describe("capResolver", () => {
  it("cupo del servicio salvo override del profesional (override + null = ilimitado)", () => {
    const cap = capResolver(
      [
        { id: OSTEO, durationMin: 45, maxConcurrent: 1 },
        { id: GRUPO, durationMin: 60, maxConcurrent: 3 },
      ],
      [
        {
          practitionerId: "p2",
          serviceId: OSTEO,
          enabled: true,
          visibility: "PUBLIC",
          durationMin: null,
          minLeadMinutes: null,
          maxLeadDays: null,
          concurrencyOverride: true,
          maxConcurrent: 2,
        },
        {
          practitionerId: "p2",
          serviceId: GRUPO,
          enabled: true,
          visibility: "PUBLIC",
          durationMin: null,
          minLeadMinutes: null,
          maxLeadDays: null,
          concurrencyOverride: true,
          maxConcurrent: null,
        },
      ]
    );
    expect(cap("p1", OSTEO)).toBe(1);
    expect(cap("p2", OSTEO)).toBe(2);
    expect(cap("p2", GRUPO)).toBeNull();
    expect(cap("p1", "desconocido")).toBeNull();
  });
});

describe("practitionerInitials", () => {
  it.each([
    ["María José Pérez García", "MP"],
    ["Juan Gómez", "JG"],
    ["  ángel   ñúñez ", "ÁÑ"],
    ["Lic. Laura de la Fuente", "LF"],
    ["Dra. Ana María Pérez Gil", "AP"],
    ["Ana María Pérez", "AM"], // 3 palabras: ambiguo, se toman las dos primeras (documentado)
    ["Pedro", "PE"],
    ["José Luis Martínez", "JL"],
    ["Ana Pérez García", "AP"],
    ["", "?"],
    ["   ", "?"],
  ])("%j → %s", (name, expected) => {
    expect(practitionerInitials(name)).toBe(expected);
  });

  it("NFD (tilde combinante) se normaliza", () => {
    expect(practitionerInitials("Álvaro Ibáñez")).toBe("ÁI");
  });

  it("nombre y apellido separados: primera del nombre + primera del apellido", () => {
    expect(practitionerInitials({ firstName: "María José", lastName: "Pérez García" })).toBe("MP");
    expect(practitionerInitials({ firstName: "Laura", lastName: "de la Fuente" })).toBe("LF");
  });
});

describe("practitionerOrder", () => {
  const list = [
    { id: "a", name: "Ana" },
    { id: "b", name: "Bruno" },
    { id: "c", name: "Carla" },
    { id: "d", name: "Diego" },
  ];
  it("favoritos primero en el orden de la preferencia; el resto conserva el orden de entrada", () => {
    expect(practitionerOrder(list, { favoritePractitionerIds: ["c", "zz", "a", "c"] }).map((p) => p.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
  it("sin prefs → mismo orden, sin mutar la entrada", () => {
    const out = practitionerOrder(list, null);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(out).not.toBe(list);
  });
});

describe("weekOccupancy", () => {
  it("conteo por profesional y total por celda y por día (sin cancelados)", () => {
    const tue = "2026-10-06";
    const bookings: LayoutBooking[] = [
      bk("10:00", { durationMin: 60 }),
      bk("10:00", { practitionerId: "p2", durationMin: 30 }),
      bk("10:30", { status: "CANCELLED" }),
      { ...bk("09:00"), scheduledFor: ar("09:00", tue) },
      bk("10:00", { practitionerId: "p3" }), // no pedido
    ];
    const occ = weekOccupancy({
      days: [DAY, tue],
      practitionerIds: ["p1", "p2"],
      bookings,
      zoom: 60,
      window: { startMin: 9 * 60, endMin: 12 * 60 },
      now: NOW,
    });
    expect(occ).toHaveLength(2);
    const mon = occ[0];
    expect(mon.dayKey).toBe(DAY);
    expect(mon.total).toBe(2);
    expect(mon.byPractitioner).toEqual({ p1: 1, p2: 1 });
    expect(mon.slots.map((s) => s.startMin)).toEqual([540, 600, 660]);
    expect(mon.slots[1]).toEqual({ startMin: 600, total: 2, byPractitioner: { p1: 1, p2: 1 } });
    expect(mon.slots[0].total).toBe(0);
    expect(occ[1]).toMatchObject({ dayKey: tue, total: 1, byPractitioner: { p1: 1, p2: 0 } });
    expect(occ[1].slots[0]).toEqual({ startMin: 540, total: 1, byPractitioner: { p1: 1, p2: 0 } });
  });
});

describe("nowOffset", () => {
  const win = { startMin: 8 * 60, endMin: 20 * 60 };
  it("hoy dentro de la ventana → minuto, offset y ratio", () => {
    expect(nowOffset(DAY, ar("14:00"), win)).toEqual({ minute: 840, offsetMin: 360, ratio: 0.5 });
  });
  it("otro día → null (21:30 AR del domingo ya es 00:30Z del lunes en UTC)", () => {
    expect(nowOffset(DAY, ar("21:30", "2026-10-04"), win)).toBeNull();
  });
  it("hoy pero fuera de la ventana → null", () => {
    expect(nowOffset(DAY, ar("07:00"), win)).toBeNull();
    expect(nowOffset(DAY, ar("20:30"), win)).toBeNull();
  });
  it("hoy a las 22:00 AR (01:00Z del día siguiente) sigue siendo hoy", () => {
    expect(nowOffset(DAY, ar("22:00"), { startMin: 0, endMin: 1440 })).toEqual({
      minute: 1320,
      offsetMin: 1320,
      ratio: 1320 / 1440,
    });
  });
});

// ─── SR-U4 · vista "Por sala" ────────────────────────────────────────────────
// capacity = PROFESIONALES a la vez (SR-D1, §17.5). TZ=UTC: el reloj del host
// no puede correr nada (23:30 AR = 02:30Z del día siguiente).

describe("[SRZ-FX2a] bundle: 'Por sala' fuera de agenda-layout", () => {
  // `agenda-layout.ts` está en el first load de /agenda (vista Día, Semana).
  // webpack no separa un módulo por export: si `buildRoomColumns` vuelve a
  // vivir (o a re-exportarse) ahí, el consultorio sin salas lo paga igual.
  it("agenda-layout no exporta nada de salas; agenda-layout-rooms sí", () => {
    for (const name of ["buildRoomColumns", "peakDistinctPractitioners", "NO_ROOM_COLUMN_ID"]) {
      expect(name in agendaLayout).toBe(false);
    }
    expect(typeof buildRoomColumns).toBe("function");
    expect(NO_ROOM_COLUMN_ID).toBe("none");
  });
});

describe("buildRoomColumns · capacidad, estados y 'Sin sala'", () => {
  const C1 ={ id: "r-c1", name: "Consultorio 1", kind: "CONSULTORIO" as const, capacity: 1, locationId: MAIN };
  const GYM = { id: "r-gym", name: "Gimnasio", kind: "GIMNASIO" as const, capacity: 3, locationId: MAIN };
  const allDay = (pid: string) => ({ practitionerId: pid, startMin: 8 * 60, endMin: 19 * 60 });
  const assignments = { [C1.id]: [allDay("p1"), allDay("p2")], [GYM.id]: [allDay("p3")] };
  const inRoom = (roomId: string | null, hhmm: string, over: Partial<LayoutBooking> = {}) => ({ ...bk(hhmm, over), roomId });
  const build = (list: RoomLayoutBooking[], extra: Partial<Parameters<typeof buildRoomColumns>[2]> = {}) =>
    buildRoomColumns([C1, GYM], list, { dayKey: DAY, zoom: 30, now: NOW, assignments, ...extra });

  it("consultorio cap 1 vs gimnasio cap 3: cuenta profesionales distintos, no pacientes", () => {
    const list = [
      // Consultorio 1 a las 10: dos turnos del MISMO profesional → 1/1 lleno (no choca consigo mismo)
      inRoom(C1.id, "10:00", { practitionerId: "p1", durationMin: 30 }),
      inRoom(C1.id, "10:00", { practitionerId: "p1", durationMin: 30 }),
      // Gimnasio a las 10: 4 pacientes de p3 + 1 de p4 → 2 profesionales de 3 → parcial
      ...[0, 1, 2, 3].map(() => inRoom(GYM.id, "10:00", { practitionerId: "p3", durationMin: 30 })),
      inRoom(GYM.id, "10:00", { practitionerId: "p4", durationMin: 30 }),
      // Gimnasio a las 11: 3 profesionales → lleno
      ...["p3", "p4", "p5"].map((pid) => inRoom(GYM.id, "11:00", { practitionerId: pid, durationMin: 30 })),
    ];
    const { columns } = build(list);
    expect(columns.map((c) => c.roomId)).toEqual([C1.id, GYM.id]); // sin "Sin sala": no hay turnos sin sala
    const [c1, gym] = columns;
    expect(cell(c1.slots, "10:00")).toMatchObject({ used: 1, cap: 1, label: "1/1", state: "lleno", total: 2, byService: [] });
    expect(cell(gym.slots, "10:00")).toMatchObject({ used: 2, cap: 3, label: "2/3", state: "parcial", total: 5 });
    expect(cell(gym.slots, "11:00")).toMatchObject({ used: 3, cap: 3, state: "lleno" });
    expect(cell(gym.slots, "12:00")).toMatchObject({ used: 0, label: null, state: "libre" });
    expect(c1).toMatchObject({ name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, bookingCount: 2, maxLanes: 2 });
    expect(gym.bookingCount).toBe(8);
  });

  it("sobreturno cuando used > capacity; isOverbooked del turno NO marca la sala (SR-D2)", () => {
    const list = [
      inRoom(C1.id, "10:00", { practitionerId: "p1", durationMin: 30 }),
      inRoom(C1.id, "10:00", { practitionerId: "p2", durationMin: 30 }),
      inRoom(C1.id, "12:00", { practitionerId: "p1", durationMin: 30, isOverbooked: true }),
    ];
    const [c1] = build(list).columns;
    expect(cell(c1.slots, "10:00")).toMatchObject({ used: 2, cap: 1, label: "2/1", state: "sobreturno", overbooked: true });
    expect(cell(c1.slots, "12:00")).toMatchObject({ used: 1, state: "lleno", overbooked: false });
  });

  it("pico de simultaneidad: dos profesionales consecutivos en zoom 60 son 1/1, no 2/1", () => {
    const list = [
      inRoom(C1.id, "10:00", { practitionerId: "p1", durationMin: 30 }),
      inRoom(C1.id, "10:30", { practitionerId: "p2", durationMin: 30 }),
    ];
    const [c1] = buildRoomColumns([C1], list, { dayKey: DAY, zoom: 60, now: NOW, assignments }).columns;
    expect(cell(c1.slots, "10:00")).toMatchObject({ used: 1, state: "lleno" });
  });

  it("'sin profesional asignado' (fuera-de-horario) donde nadie tiene la sala; con un turno igual se ve", () => {
    const only = { [C1.id]: [{ practitionerId: "p1", startMin: 9 * 60, endMin: 13 * 60 }] };
    const list = [inRoom(C1.id, "15:00", { practitionerId: "p2", durationMin: 30 })];
    const { columns, window } = buildRoomColumns([C1, GYM], list, {
      dayKey: DAY,
      zoom: 30,
      now: NOW,
      assignments: only,
    });
    expect(window).toEqual({ startMin: 9 * 60, endMin: 15 * 60 + 30 });
    const [c1, gym] = columns;
    expect(cell(c1.slots, "09:00")).toMatchObject({ state: "libre", outOfHours: false });
    expect(cell(c1.slots, "14:00")).toMatchObject({ state: "fuera-de-horario", outOfHours: true });
    expect(cell(c1.slots, "15:00")).toMatchObject({ state: "fuera-de-horario", used: 1, label: "1/1" });
    expect(gym.slots.every((s) => s.state === "fuera-de-horario")).toBe(true);
    expect(c1.assignments).toEqual(only[C1.id]);
    expect(gym.assignments).toEqual([]);
  });

  it("assignments se ordenan por (startMin, practitionerId) y descartan franjas vacías", () => {
    const messy = {
      [C1.id]: [
        { practitionerId: "p2", startMin: 14 * 60, endMin: 18 * 60 },
        { practitionerId: "p9", startMin: 10 * 60, endMin: 10 * 60 },
        { practitionerId: "p1", startMin: 9 * 60, endMin: 13 * 60 },
      ],
    };
    const [c1] = buildRoomColumns([C1], [], { dayKey: DAY, zoom: 30, now: NOW, assignments: messy }).columns;
    expect(c1.assignments.map((a) => a.practitionerId)).toEqual(["p1", "p2"]);
  });

  it("bloqueo de sala: pinta SOLO esa sala; un bloqueo de profesional no; uno de todos sí (por sede)", () => {
    const roomBlocks = [{ id: "rb-1", roomId: C1.id, startsAt: ar("10:00"), endsAt: ar("11:00"), reason: "Mantenimiento" }];
    const blocks: LayoutBlock[] = [
      { id: "pb-1", practitionerId: "p3", startsAt: ar("12:00"), endsAt: ar("13:00"), reason: "Trámite" },
      { id: "tb-1", practitionerId: null, locationId: MAIN, startsAt: ar("16:00"), endsAt: ar("17:00"), reason: "Corte de luz" },
      { id: "tb-2", practitionerId: null, locationId: "loc-otra", startsAt: ar("18:00"), endsAt: ar("19:00"), reason: "Otra" },
    ];
    const list = [inRoom(C1.id, "10:00", { practitionerId: "p1", durationMin: 30 })];
    const [c1, gym] = build(list, { roomBlocks, blocks }).columns;
    expect(cell(c1.slots, "10:00")).toMatchObject({ state: "bloqueado", blocked: true, blockIds: ["rb-1"], blockReason: "Mantenimiento", used: 1 });
    expect(cell(c1.slots, "10:30").state).toBe("bloqueado");
    expect(cell(c1.slots, "11:00").state).toBe("libre");
    expect(cell(gym.slots, "10:00").state).toBe("libre");
    expect(cell(gym.slots, "12:00").state).toBe("libre"); // bloqueo de p3 no pinta la sala
    expect(cell(c1.slots, "16:00")).toMatchObject({ state: "bloqueado", blockReason: "Corte de luz" });
    expect(cell(gym.slots, "16:00").state).toBe("bloqueado");
    expect(cell(gym.slots, "18:00").state).toBe("libre"); // bloqueo de otra sede
  });

  it("'Sin sala' aparece solo si hay turnos sin sala; va al final, sin cap ni horario", () => {
    expect(build([inRoom(C1.id, "10:00")]).columns.map((c) => c.roomId)).toEqual([C1.id, GYM.id]);
    const list: RoomLayoutBooking[] = [
      inRoom(null, "10:00", { practitionerId: "p1" }),
      { ...bk("10:00", { practitionerId: "p2" }) }, // roomId ausente (proyección sin sala) = sin sala
      inRoom("r-otra-sede", "10:00"), // sala fuera del catálogo: no se dibuja
    ];
    const { columns } = build(list);
    expect(columns.map((c) => c.roomId)).toEqual([C1.id, GYM.id, "none"]);
    const none = columns[2];
    expect(none).toMatchObject({ name: "Sin sala", kind: null, capacity: null, bookingCount: 2, assignments: [] });
    expect(cell(none.slots, "10:00")).toMatchObject({ used: 2, cap: null, label: null, state: "parcial", outOfHours: false });
    expect(cell(none.slots, "08:00").state).toBe("libre");
    expect(columns[0].bookingCount + columns[1].bookingCount).toBe(0);
    expect(build(list, { includeUnassigned: false }).columns.map((c) => c.roomId)).toEqual([C1.id, GYM.id]);
  });

  it("orden de columnas = orden de entrada (el bootstrap ya viene por sortOrder)", () => {
    const { columns } = buildRoomColumns([GYM, C1], [], { dayKey: DAY, zoom: 30, now: NOW, assignments });
    expect(columns.map((c) => c.name)).toEqual(["Gimnasio", "Consultorio 1"]);
  });

  it("borde de las 23:30 AR (02:30Z del día siguiente) en TZ=UTC: cae en su día AR y continúa al otro", () => {
    const late = { [C1.id]: [{ practitionerId: "p1", startMin: 22 * 60, endMin: 24 * 60 }] };
    const b = inRoom(C1.id, "23:30", { practitionerId: "p1", durationMin: 60 });
    expect((b.scheduledFor as Date).toISOString()).toBe("2026-10-06T02:30:00.000Z");
    const today = buildRoomColumns([C1], [b], { dayKey: DAY, zoom: 30, now: NOW, assignments: late });
    expect(today.window).toEqual({ startMin: 22 * 60, endMin: 24 * 60 });
    const c = cell(today.columns[0].slots, "23:30");
    expect(c.bookings.map((x) => x.id)).toEqual([b.id]);
    expect(c).toMatchObject({ used: 1, state: "lleno" });
    // Al día siguiente: arranca a las 00:00 como "continúa" y la sala no tiene asignación.
    const next = buildRoomColumns([C1], [b], { dayKey: "2026-10-06", zoom: 30, now: NOW, assignments: {} });
    const first = cell(next.columns[0].slots, "00:00");
    expect(first.continuing.map((x) => x.id)).toEqual([b.id]);
    expect(first).toMatchObject({ bookings: [], state: "fuera-de-horario", used: 1 });
  });

  it("cancelados y reservas públicas vencidas se dibujan pero no ocupan la sala", () => {
    const list = [
      inRoom(C1.id, "10:00", { practitionerId: "p1", status: "CANCELLED", durationMin: 30 }),
      inRoom(C1.id, "10:00", {
        practitionerId: "p2",
        durationMin: 30,
        status: "PENDING",
        publicReservation: true,
        paymentStatus: "UNPAID",
        createdAt: new Date(NOW.getTime() - 31 * 60_000),
      }),
    ];
    const c = cell(build(list).columns[0].slots, "10:00");
    expect(c.bookings).toHaveLength(2);
    expect(c).toMatchObject({ used: 0, state: "libre", total: 0 });
  });
});

describe("[IAM-4b] columna «Otros» en «Día por profesional»", () => {
  // Turno viejo asignado a la Secretaria (antes de IAM-2e toda membresía tenía
  // Practitioner). Desde 2e la Secretaria no tiene columna (no es reservable):
  // sin la columna «Otros» el turno desaparecía de la vista.
  const opts = { dayKey: DAY, zoom: 30 as const, ranges: { p1: range8to19 }, capOf, now: NOW };

  it("[IAM-4b] un turno viejo de la Secretaria (sin columna) cae en «Otros», no desaparece", () => {
    const mine = bk("10:00");
    const orphan = bk("07:00", { practitionerId: "secretaria", serviceId: OSTEO });
    const orphanCancelled = bk("12:00", { practitionerId: "secretaria", status: "CANCELLED" });
    const tomorrow = { ...bk("10:00", { practitionerId: "secretaria" }), scheduledFor: ar("10:00", "2026-10-06") };
    const layout = buildPractitionerColumns([P1], [mine, orphan, orphanCancelled, tomorrow], {
      ...opts,
      othersColumn: true,
    });
    const ids = layout.columns.map((c) => c.practitionerId);
    expect(ids).toEqual(["p1", agendaLayout.OTHERS_COLUMN_ID]);
    const others = layout.columns[1];
    expect(others.name).toBe(agendaLayout.OTHERS_COLUMN_NAME);
    // El MISMO objeto del caller, en su celda; la ventana se estira a las 7.
    expect(cell(others.slots, "07:00").bookings[0]).toBe(orphan);
    expect(layout.window.startMin).toBe(7 * 60);
    expect(others.bookingCount).toBe(1);
    // Sin franjas ni cupo: no inventa un «lleno» mezclando profesionales.
    expect(others.slots.every((s) => s.outOfHours && s.cap === null)).toBe(true);
    // El profesional real no se mezcla con los huérfanos.
    expect(layout.columns[0].bookingCount).toBe(1);
  });

  it("[IAM-4b] sin huérfanos del día no aparece la columna; sin la opción, como siempre", () => {
    const orphan = bk("10:00", { practitionerId: "secretaria" });
    expect(buildPractitionerColumns([P1], [bk("10:00")], { ...opts, othersColumn: true }).columns).toHaveLength(1);
    expect(buildPractitionerColumns([P1], [orphan], opts).columns.map((c) => c.practitionerId)).toEqual(["p1"]);
  });

  it("[IAM-4b] un bloqueo de «todos» no tapa la columna «Otros» (no es una agenda)", () => {
    const orphan = bk("10:00", { practitionerId: "secretaria" });
    const blocks: LayoutBlock[] = [
      { id: "blk", practitionerId: null, startsAt: ar("09:00"), endsAt: ar("12:00"), allDay: false, reason: "Feriado" },
    ];
    const { columns } = buildPractitionerColumns([P1], [orphan], { ...opts, blocks, othersColumn: true });
    expect(cell(columns[0].slots, "10:00").blocked).toBe(true);
    expect(columns[1].slots.some((s) => s.blocked)).toBe(false);
  });
});
