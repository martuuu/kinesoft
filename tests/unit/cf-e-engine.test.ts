/**
 * [CF-E1..7] CF (§28, decisiones 1 y 2 de Martin del 30-oct; M20) — «no atiende servicios distintos a la vez» en el
 * motor puro: `classifyInstant` (clase "otro-servicio"), `classifyBatchInstant` (lote: sube a sobreturno),
 * `buildSlots` (razón "otro-servicio"), `nextFreeSlot` / `firstFreeAcrossPractitioners` (saltea el choque) y
 * `classifyPlanRows` / `suggestRowSlot` (Planes: se pliega en `capacityFull`, forzable con `force.capacity`).
 *
 * Reglas que se fijan:
 *   • precedencia duplicado > bloqueado > fuera-de-horario > paciente-superpuesto > sobreturno > otro-servicio >
 *     tope-intervalo > libre; `otherServiceBusy` / `otherServiceId` se informan aunque gane otra clase;
 *   • bordes del predicado único (`isOtherServiceConflict`): el mismo paciente no cuenta (CF-D3), un guest sí, el solape
 *     es semiabierto, NO_SHOW y COMPLETED cuentan (CF-D5), CANCELLED no, una reserva pública vencida tampoco;
 *   • CARVE-OUT: sin el flag (ausente o false) la salida es la de antes, byte a byte y sin claves nuevas. Los fijados
 *     `availability-classify.test.ts:372` y `booking-schedule.test.ts:434` no se tocan;
 *   • pasos 30/45 anclados al inicio de cada franja; `nextFreeSlot` sigue en 15 (paridad §5.27).
 *
 * Corre en TZ=UTC y en TZ=America/Argentina/Buenos_Aires. Símbolos reales; nada mockeado.
 */
import { describe, expect, it } from "vitest";
import { buildSlots } from "@/lib/availability/slots";
import {
  classifyBatchInstant,
  classifyInstant,
  type ClassifyInstantInput,
  type RangesFor,
} from "@/lib/availability/classify";
import { firstFreeAcrossPractitioners, nextFreeSlot } from "@/lib/availability/next-free";
import {
  classifyPlanRows,
  suggestRowSlot,
  type ClassifyPlanRowsInput,
  type PlanAvailabilityBooking,
} from "@/lib/availability/plan";
import type { IntervalCap } from "@/lib/availability/interval-cap";
import type { AvailabilityBooking, BuildSlotsInput, ServiceInfo, TimeBlockInput } from "@/lib/availability/types";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const iso = (local: string) => ar(local).toISOString();
const LOC = "loc-main";
const P = "p1";
const KINE = "s-kine"; // el servicio pedido
const EVAL = "s-eval"; // el otro servicio del mismo profesional
const NOW = new Date("2026-10-01T12:00:00.000Z");
const MONDAY = "2026-10-05";

let seq = 0;
function bk(local: string, durationMin: number, over: Partial<AvailabilityBooking> = {}): AvailabilityBooking {
  seq++;
  return {
    id: `bk-${seq}`,
    locationId: LOC,
    practitionerId: P,
    serviceId: EVAL,
    scheduledFor: ar(local),
    durationMin,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
    patientId: `pat-otro-${seq}`,
    idempotencyKey: `0b6f2c1e3f7a4d0e9a512f7c1d9e8a${String(seq).padStart(2, "0")}`,
    ...over,
  };
}
/** Reserva pública impaga creada hace `ageMin` minutos (retiene 30', AUDIT §5.18). */
const pub = (local: string, durationMin: number, ageMin: number) =>
  bk(local, durationMin, {
    status: "PENDING",
    paymentStatus: "UNPAID",
    patientId: `pat-pub-${seq}`,
    createdAt: new Date(NOW.getTime() - ageMin * 60_000),
    idempotencyKey: `pub:t1:0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a${String(seq).padStart(2, "0")}`,
  });

const hours: RangesFor = () => [{ startMin: 540, endMin: 1080, locationId: LOC }]; // 09-18 todos los días

function ci(over: Partial<ClassifyInstantInput> = {}): ClassifyInstantInput {
  return {
    when: ar("2026-10-05T10:30"),
    durationMin: 15,
    patientId: "pat-nuevo",
    practitionerId: P,
    serviceId: KINE,
    locationId: LOC,
    cap: 2,
    rangesFor: hours,
    blocks: [],
    bookings: [],
    now: NOW,
    ...over,
  };
}
const EX = { exclusiveService: true } as const;

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E1] classifyInstant — clase "otro-servicio"
// ─────────────────────────────────────────────────────────────────────────────

describe("[CF-E1] classifyInstant — otro-servicio, precedencia y bordes del predicado", () => {
  const evalAt10 = () => [bk("2026-10-05T10:00", 60)]; // Evaluación 10:00-11:00, otro paciente

  it("otro servicio del profesional (otro paciente) que solapa → otro-servicio, con otherServiceId", () => {
    const c = classifyInstant(ci({ ...EX, bookings: evalAt10() }));
    expect(c).toMatchObject({ class: "otro-servicio", otherServiceBusy: true, otherServiceId: EVAL, used: 0, cap: 2 });
  });

  it("otherServiceId = el servicio del PRIMER turno que choca (orden de entrada)", () => {
    const rows = [bk("2026-10-05T10:00", 60, { serviceId: "s-tercero" }), bk("2026-10-05T10:15", 30)];
    expect(classifyInstant(ci({ ...EX, bookings: rows })).otherServiceId).toBe("s-tercero");
  });

  it("sin choque, con el flag: libre con otherServiceBusy false y otherServiceId null", () => {
    const c = classifyInstant(ci({ ...EX, bookings: [] }));
    expect(c).toMatchObject({ class: "libre", otherServiceBusy: false, otherServiceId: null });
  });

  it("sobreturno (cupo del servicio lleno) gana, pero el choque se informa igual", () => {
    const rows = [...evalAt10(), bk("2026-10-05T10:30", 15, { serviceId: KINE })];
    const c = classifyInstant(ci({ ...EX, cap: 1, bookings: rows }));
    expect(c).toMatchObject({ class: "sobreturno", otherServiceBusy: true, otherServiceId: EVAL, used: 1 });
  });

  it("bloqueado, fuera de horario y paciente superpuesto ganan; el choque se informa igual", () => {
    const block: TimeBlockInput = {
      id: "tb1",
      practitionerId: P,
      locationId: null,
      startsAt: ar("2026-10-05T10:30"),
      endsAt: ar("2026-10-05T10:45"),
      allDay: false,
      reason: "Trámite",
      groupId: null,
    };
    expect(classifyInstant(ci({ ...EX, bookings: evalAt10(), blocks: [block] }))).toMatchObject({
      class: "bloqueado",
      otherServiceBusy: true,
    });
    const shortHours: RangesFor = () => [{ startMin: 540, endMin: 630, locationId: LOC }]; // 09:00-10:30
    expect(classifyInstant(ci({ ...EX, bookings: evalAt10(), rangesFor: shortHours }))).toMatchObject({
      class: "fuera-de-horario",
      otherServiceBusy: true,
    });
    const mine = bk("2026-10-05T10:20", 30, { practitionerId: "p2", serviceId: KINE, patientId: "pat-nuevo" });
    expect(classifyInstant(ci({ ...EX, bookings: [...evalAt10(), mine] }))).toMatchObject({
      class: "paciente-superpuesto",
      otherServiceBusy: true,
    });
  });

  it("otro-servicio gana sobre tope-intervalo; intervalCapped se informa igual", () => {
    const cap1: IntervalCap = { count: 1, intervalMin: 60 };
    const c = classifyInstant(ci({ ...EX, bookings: evalAt10(), intervalCap: cap1 }));
    expect(c).toMatchObject({ class: "otro-servicio", intervalCapped: true, otherServiceBusy: true });
  });

  it("borde CF-D3: el MISMO paciente en otro servicio no cuenta", () => {
    const overlapping = [bk("2026-10-05T10:00", 60, { patientId: "pat-nuevo" })];
    // Solapa con su propio turno: lo dice paciente-superpuesto, no otro-servicio.
    expect(classifyInstant(ci({ ...EX, bookings: overlapping }))).toMatchObject({
      class: "paciente-superpuesto",
      otherServiceBusy: false,
    });
  });

  it("borde: un guest (sin paciente) sí cuenta, también contra un turno sin paciente", () => {
    const rows = [bk("2026-10-05T10:00", 60, { patientId: null })];
    expect(classifyInstant(ci({ ...EX, patientId: null, bookings: rows })).class).toBe("otro-servicio");
    expect(classifyInstant(ci({ ...EX, patientId: undefined, bookings: evalAt10() })).class).toBe("otro-servicio");
  });

  it("borde: solape semiabierto (termina 10:30 / empieza 10:45 → libre)", () => {
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 30)] })).class).toBe("libre");
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:45", 30)] })).class).toBe("libre");
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:44", 30)] })).class).toBe("otro-servicio");
  });

  it("borde CF-D5: NO_SHOW y COMPLETED cuentan; CANCELLED y una reserva pública vencida no", () => {
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 60, { status: "NO_SHOW" })] })).class).toBe(
      "otro-servicio"
    );
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 60, { status: "COMPLETED" })] })).class).toBe(
      "otro-servicio"
    );
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 60, { status: "CANCELLED" })] }))).toMatchObject(
      { class: "libre", otherServiceBusy: false }
    );
    expect(classifyInstant(ci({ ...EX, bookings: [pub("2026-10-05T10:00", 60, 31)] })).class).toBe("libre");
    expect(classifyInstant(ci({ ...EX, bookings: [pub("2026-10-05T10:00", 60, 30)] })).class).toBe("otro-servicio");
  });

  it("otro profesional no cuenta; el turno que se edita (excludeBookingId) tampoco", () => {
    expect(classifyInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 60, { practitionerId: "p2" })] })).class).toBe(
      "libre"
    );
    const self = bk("2026-10-05T10:00", 60);
    expect(classifyInstant(ci({ ...EX, bookings: [self], excludeBookingId: self.id })).class).toBe("libre");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E2] carve-out: sin el flag, la salida de antes
// ─────────────────────────────────────────────────────────────────────────────

describe("[CF-E2] carve-out — sin exclusiveService (ausente o false) la salida es la de hoy, sin claves nuevas", () => {
  const rows = () => [bk("2026-10-05T10:00", 60)];

  it("classifyInstant: libre, sin otherServiceBusy ni otherServiceId; false = ausente", () => {
    const plain = classifyInstant(ci({ bookings: rows() }));
    expect(plain.class).toBe("libre");
    expect(plain).not.toHaveProperty("otherServiceBusy");
    expect(plain).not.toHaveProperty("otherServiceId");
    expect(classifyInstant(ci({ bookings: rows(), exclusiveService: false }))).toStrictEqual(plain);
  });

  it("classifyBatchInstant: status libre, sin la clave otherServiceBusy", () => {
    const plain = classifyBatchInstant(ci({ bookings: rows() }));
    expect(plain.status).toBe("libre");
    expect(plain).not.toHaveProperty("otherServiceBusy");
    expect(classifyBatchInstant(ci({ bookings: rows(), exclusiveService: false }))).toStrictEqual(plain);
  });

  it("buildSlots: exclusive ausente o null = la grilla de siempre", () => {
    const input: BuildSlotsInput = {
      dayKey: MONDAY,
      ranges: [{ startMin: 600, endMin: 660, locationId: LOC }],
      stepMin: 15,
      durationMin: 15,
      lead: { minMinutes: 0, maxDays: null },
      now: NOW,
      bookings: [],
      cap: null,
    };
    const plain = buildSlots(input);
    expect(plain.every((s) => s.available)).toBe(true);
    expect(buildSlots({ ...input, exclusive: null })).toStrictEqual(plain);
  });

  it("nextFreeSlot y classifyPlanRows: false = ausente", () => {
    const base = {
      from: ar("2026-10-05T09:45"),
      durationMin: 15,
      patientId: "pat-nuevo",
      practitionerId: P,
      serviceId: KINE,
      locationId: LOC,
      cap: 1,
      rangesFor: hours,
      blocks: [],
      bookings: rows(),
      now: NOW,
    };
    expect(nextFreeSlot(base)).toBe(iso("2026-10-05T10:00"));
    expect(nextFreeSlot({ ...base, exclusiveService: false })).toBe(iso("2026-10-05T10:00"));
    const pin = planInput({ bookings: rows() as PlanAvailabilityBooking[] });
    const plain = classifyPlanRows(pin);
    expect(plain[0].class).toBe("libre");
    expect(plain[0].flags).not.toHaveProperty("otherServiceBusy");
    expect(classifyPlanRows({ ...pin, exclusiveService: false })).toStrictEqual(plain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E3] lote
// ─────────────────────────────────────────────────────────────────────────────

describe("[CF-E3] classifyBatchInstant — el choque sube libre a sobreturno (CF-D4)", () => {
  it("con el flag: sobreturno + otherServiceBusy; sin choque: libre + false", () => {
    expect(classifyBatchInstant(ci({ ...EX, bookings: [bk("2026-10-05T10:00", 60)] }))).toMatchObject({
      status: "sobreturno",
      otherServiceBusy: true,
      used: 0,
    });
    expect(classifyBatchInstant(ci({ ...EX, bookings: [] }))).toMatchObject({ status: "libre", otherServiceBusy: false });
  });

  it("duplicado no se toca; el mismo paciente en otro servicio no sube nada por la regla", () => {
    const dup = bk("2026-10-05T10:30", 15, { patientId: "pat-nuevo" });
    expect(classifyBatchInstant(ci({ ...EX, bookings: [dup, bk("2026-10-05T10:00", 60)] }))).toMatchObject({
      status: "duplicado",
      otherServiceBusy: true,
    });
    // El propio turno de Evaluación 10:15-10:45: sobreturno por superposición del paciente (como hoy), no por la regla.
    const own = bk("2026-10-05T10:15", 30, { patientId: "pat-nuevo" });
    expect(classifyBatchInstant(ci({ ...EX, bookings: [own] }))).toMatchObject({
      status: "sobreturno",
      otherServiceBusy: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E4] buildSlots
// ─────────────────────────────────────────────────────────────────────────────

function slotsInput(over: Partial<BuildSlotsInput> = {}): BuildSlotsInput {
  return {
    dayKey: MONDAY,
    ranges: [{ startMin: 600, endMin: 720, locationId: LOC }], // 10-12
    stepMin: 15,
    durationMin: 30,
    lead: { minMinutes: 0, maxDays: null },
    now: NOW,
    bookings: [], // profesional + servicio pedido
    cap: null,
    ...over,
  };
}
const exclusive = (bookings: AvailabilityBooking[], patientId: string | null = null) => ({
  serviceId: KINE,
  patientId,
  bookings,
});

describe("[CF-E4] buildSlots — razón otro-servicio", () => {
  it("Evaluación 10:30-11:00: los slots de 30' que la pisan quedan no disponibles", () => {
    const s = buildSlots(slotsInput({ exclusive: exclusive([bk("2026-10-05T10:30", 30)]) }));
    expect(s.map((x) => [x.time, x.reason])).toEqual([
      ["10:00", null],
      ["10:15", "otro-servicio"],
      ["10:30", "otro-servicio"],
      ["10:45", "otro-servicio"],
      ["11:00", null],
      ["11:15", null],
      ["11:30", null],
    ]);
    expect(s[1]).toMatchObject({ available: false, used: 0, cap: null });
    // Sin claves nuevas en el slot.
    expect(Object.keys(s[1]).sort()).toEqual(["available", "cap", "iso", "reason", "time", "used"]);
  });

  it("cupo-completo y pasado ganan; otro-servicio gana sobre tope-intervalo", () => {
    const same = bk("2026-10-05T10:00", 30, { serviceId: KINE });
    const other = bk("2026-10-05T10:00", 30);
    const s = buildSlots(slotsInput({ bookings: [same], cap: 1, exclusive: exclusive([same, other]) }));
    expect(s[0].reason).toBe("cupo-completo");
    const past = buildSlots(slotsInput({ now: ar("2026-10-05T10:10"), exclusive: exclusive([other]) }));
    expect(past[0].reason).toBe("pasado");
    const capped = buildSlots(
      slotsInput({
        exclusive: exclusive([other]),
        intervalCap: { practitionerId: P, cap: { count: 1, intervalMin: 60 }, bookings: [other] },
      })
    );
    expect(capped[0]).toMatchObject({ reason: "otro-servicio", intervalCapUse: { used: 1 } });
  });

  it("mismo paciente, mismo servicio, CANCELLED y reserva pública vencida no cuentan; guest sí", () => {
    const rows = [
      bk("2026-10-05T10:00", 30, { patientId: "pat-nuevo" }),
      bk("2026-10-05T10:00", 30, { serviceId: KINE }),
      bk("2026-10-05T10:00", 30, { status: "CANCELLED" }),
      pub("2026-10-05T10:00", 30, 31),
    ];
    expect(buildSlots(slotsInput({ exclusive: exclusive(rows, "pat-nuevo") }))[0].available).toBe(true);
    expect(buildSlots(slotsInput({ exclusive: exclusive(rows, null) }))[0].reason).toBe("otro-servicio");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E5] pasos 30/45 anclados
// ─────────────────────────────────────────────────────────────────────────────

describe("[CF-E5] buildSlots — pasos 30 y 45 anclados al inicio de cada franja, con la regla", () => {
  it("paso 30 en dos franjas (09:00-10:00 y 10:20-12:00): la grilla arranca en cada franja", () => {
    const s = buildSlots(
      slotsInput({
        ranges: [
          { startMin: 540, endMin: 600, locationId: LOC },
          { startMin: 620, endMin: 720, locationId: LOC },
        ],
        stepMin: 30,
        exclusive: exclusive([bk("2026-10-05T10:40", 20)]), // 10:40-11:00
      })
    );
    expect(s.map((x) => [x.time, x.reason])).toEqual([
      ["09:00", null],
      ["09:30", null],
      ["10:20", "otro-servicio"],
      ["10:50", "otro-servicio"],
      ["11:20", null],
    ]);
  });

  it("paso 45 con duración 45 desde 09:00: 09:45 pisa 10:00-10:30; 10:30 es borde (libre)", () => {
    const s = buildSlots(
      slotsInput({
        ranges: [{ startMin: 540, endMin: 720, locationId: LOC }],
        stepMin: 45,
        durationMin: 45,
        exclusive: exclusive([bk("2026-10-05T10:00", 30)]),
      })
    );
    expect(s.map((x) => [x.time, x.reason])).toEqual([
      ["09:00", null],
      ["09:45", "otro-servicio"],
      ["10:30", null],
      ["11:15", null],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E6] nextFreeSlot / firstFreeAcrossPractitioners
// ─────────────────────────────────────────────────────────────────────────────

describe("[CF-E6] nextFreeSlot — saltea otro servicio, en la grilla de 15", () => {
  const from = ar("2026-10-05T09:45"); // primer cursor 10:00
  const rows = () => [bk("2026-10-05T10:00", 20)]; // Evaluación 10:00-10:20
  const base = {
    from,
    durationMin: 15,
    patientId: "pat-nuevo",
    practitionerId: P,
    serviceId: KINE,
    locationId: LOC,
    cap: 1,
    rangesFor: hours,
    blocks: [],
    now: NOW,
  };

  it("con la regla: el prefiltro conserva el otro servicio → 10:30 (paso 15, no 10:20)", () => {
    expect(nextFreeSlot({ ...base, bookings: rows() })).toBe(iso("2026-10-05T10:00"));
    expect(nextFreeSlot({ ...base, bookings: rows(), ...EX })).toBe(iso("2026-10-05T10:30"));
  });

  it("mismo paciente: lo frena la superposición (igual que sin la regla); otro profesional: 10:00", () => {
    const own = [bk("2026-10-05T10:00", 20, { patientId: "pat-nuevo" })];
    expect(nextFreeSlot({ ...base, bookings: own })).toBe(iso("2026-10-05T10:30"));
    expect(nextFreeSlot({ ...base, bookings: own, ...EX })).toBe(iso("2026-10-05T10:30"));
    const other = rows().map((b) => ({ ...b, practitionerId: "p2" }));
    expect(nextFreeSlot({ ...base, bookings: other, ...EX })).toBe(iso("2026-10-05T10:00"));
  });

  it("firstFreeAcrossPractitioners: la regla de cada profesional sale de agendaRules", () => {
    const services: ServiceInfo[] = [{ id: KINE, durationMin: 15, maxConcurrent: 1 } as ServiceInfo];
    const q = {
      practitionerIds: [P, "p2"],
      serviceId: KINE,
      from,
      services,
      practitionerServices: [],
      rangesFor: hours,
      blocks: [],
      bookings: rows(),
      now: NOW,
    };
    const rule = (exclusiveService: boolean) => ({ exclusiveService, agendaStepMin: 15 as const, publicStepMin: null });
    expect(firstFreeAcrossPractitioners(q)).toMatchObject({ practitionerId: P, iso: iso("2026-10-05T10:00") });
    expect(firstFreeAcrossPractitioners({ ...q, practitionerIds: [P], agendaRules: { [P]: rule(true) } })).toMatchObject({
      practitionerId: P,
      iso: iso("2026-10-05T10:30"),
    });
    expect(firstFreeAcrossPractitioners({ ...q, agendaRules: { [P]: rule(true), p2: rule(false) } })).toMatchObject({
      practitionerId: "p2",
      iso: iso("2026-10-05T10:00"),
    });
    expect(firstFreeAcrossPractitioners({ ...q, practitionerIds: [P], agendaRules: { [P]: rule(false) } })).toMatchObject({
      practitionerId: P,
      iso: iso("2026-10-05T10:00"),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [CF-E7] Planes
// ─────────────────────────────────────────────────────────────────────────────

function planInput(over: Partial<ClassifyPlanRowsInput> = {}): ClassifyPlanRowsInput {
  return {
    rows: [{ index: 1, at: ar("2026-10-05T10:00") }],
    patientId: "pat-plan",
    practitionerId: P,
    serviceId: KINE,
    locationId: LOC,
    durationMin: 30,
    cap: 1,
    rangesFor: hours,
    blocks: [],
    bookings: [bk("2026-10-05T10:00", 30)] as PlanAvailabilityBooking[],
    now: NOW,
    ...over,
  };
}

describe("[CF-E7] classifyPlanRows — fold en capacityFull, forzable con force.capacity", () => {
  it("fila que choca con otro servicio: otro-servicio, capacityFull + otherServiceBusy, sugerencia 10:30", () => {
    const [r] = classifyPlanRows(planInput({ ...EX }));
    expect(r.class).toBe("otro-servicio");
    expect(r.flags).toMatchObject({ capacityFull: true, otherServiceBusy: true });
    expect(r.used).toBe(0);
    expect(r.allowedResolutions).toEqual(["move", "force", "none"]);
    expect(r.suggestion).toBe(iso("2026-10-05T10:30"));
    expect(r.defaultResolution).toBe("move");
  });

  it("force.capacity la destraba como sobreturno; sin force o con create, stale", () => {
    const forced = classifyPlanRows(
      planInput({ ...EX, rows: [{ index: 1, at: ar("2026-10-05T10:00"), resolution: { index: 1, kind: "force", force: { capacity: true } } }] })
    )[0];
    expect(forced).toMatchObject({ resolutionOk: true, overbooked: true, effectiveResolution: "force" });
    const bare = classifyPlanRows(
      planInput({ ...EX, rows: [{ index: 1, at: ar("2026-10-05T10:00"), resolution: { index: 1, kind: "force", force: {} } }] })
    )[0];
    expect(bare).toMatchObject({ resolutionOk: false, staleReason: "not-allowed" });
    const create = classifyPlanRows(
      planInput({ ...EX, rows: [{ index: 1, at: ar("2026-10-05T10:00"), resolution: { index: 1, kind: "create" } }] })
    )[0];
    expect(create.resolutionOk).toBe(false);
  });

  it("move a un destino que choca pide force.capacity; las filas del plan (mismo servicio) no se chocan entre sí", () => {
    const moved = classifyPlanRows(
      planInput({
        ...EX,
        bookings: [bk("2026-10-05T11:00", 30)] as PlanAvailabilityBooking[],
        rows: [{ index: 1, at: ar("2026-10-05T09:00"), resolution: { index: 1, kind: "move", at: iso("2026-10-05T11:00") } }],
      })
    )[0];
    expect(moved).toMatchObject({ resolutionOk: false, targetClass: "otro-servicio" });
    expect(moved.targetFlags).toMatchObject({ capacityFull: true, otherServiceBusy: true });

    const two = classifyPlanRows(
      planInput({
        ...EX,
        cap: 2,
        bookings: [],
        rows: [
          { index: 1, at: ar("2026-10-05T10:00") },
          { index: 2, at: ar("2026-10-05T10:00") },
        ],
      })
    );
    // La 2.ª choca con la 1.ª por ser el mismo paciente (duplicado), nunca por la regla.
    expect(two[0]).toMatchObject({ class: "libre" });
    expect(two[0].flags.otherServiceBusy).toBe(false);
    expect(two[1].flags.otherServiceBusy).toBe(false);
  });

  it("con tope-intervalo además, la clase sigue siendo otro-servicio (no se baja a libre)", () => {
    const [r] = classifyPlanRows(planInput({ ...EX, intervalCap: { count: 1, intervalMin: 60 } }));
    expect(r.class).toBe("otro-servicio");
    expect(r.flags).toMatchObject({ overIntervalCap: true, otherServiceBusy: true, capacityFull: true });
  });

  it("suggestRowSlot recibe exclusiveService: con la regla saltea el otro servicio", () => {
    const sug = {
      at: ar("2026-10-05T10:00"),
      nextDayKey: null,
      now: NOW,
      patientId: "pat-plan",
      practitionerId: P,
      serviceId: KINE,
      locationId: LOC,
      durationMin: 30,
      cap: 1,
      rangesFor: hours,
      blocks: [],
      bookings: [bk("2026-10-05T10:00", 30)],
    };
    expect(suggestRowSlot(sug)).toBe(iso("2026-10-05T10:00"));
    expect(suggestRowSlot({ ...sug, ...EX })).toBe(iso("2026-10-05T10:30"));
  });
});
