/**
 * `lib/availability/classify.ts` (B2.1b): clase de un instante para el alta
 * suelta, el batch y Planes.
 *
 * Precedencia (contrato `InstantClass` de `lib/availability/types.ts`):
 *   duplicado > bloqueado > fuera-de-horario > paciente-superpuesto / sobreturno > libre
 * con `outOfHours` / `blocked` informados aunque gane otra clase.
 *
 * Paridad: `classifyBatchInstant(...).status` = el clasificador del batch de
 * ef3281f (oráculo literal, el mismo de `tests/unit/booking-schedule.test.ts`)
 * cuando no hay bloqueos, CUALESQUIERA sean las franjas (fuera de horario es
 * solo un flag en el batch — decisión 2). Con bloqueo, el batch lo sube a
 * "sobreturno" (decisión 1: el staff lo confirma como sobreturno).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`).
 */
import { describe, it, expect } from "vitest";
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { classifyBatchSlot } from "@/lib/booking-schedule";
import {
  classifyInstant,
  classifyBatchInstant,
  fitsInRanges,
  blocksHitting,
  type ClassifyInstantInput,
  type RangesFor,
} from "@/lib/availability/classify";
import {
  NO_LOCATION_ID,
  type AvailabilityBooking,
  type ScheduleRange,
  type TimeBlockInput,
} from "@/lib/availability/types";

// ─────────────────────────────────────────────────────────────────────────────
// Oráculo: clasificador del batch de ef3281f (copia literal, no editar)
// ─────────────────────────────────────────────────────────────────────────────

type ExistingRow = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
  practitionerId: string;
  serviceId: string;
};

function legacyClassify(
  when: Date,
  data: { patientId: string | null; practitionerId: string; serviceId: string },
  duration: number,
  maxConcurrent: number | null,
  existing: ExistingRow[],
  now: Date
): "libre" | "sobreturno" | "duplicado" {
  const end = new Date(when.getTime() + duration * 60_000);
  const overlaps = (e: { scheduledFor: Date; durationMin: number }) =>
    e.scheduledFor < end && new Date(e.scheduledFor.getTime() + e.durationMin * 60_000) > when;
  if (data.patientId) {
    if (existing.some((e) => e.patientId === data.patientId && +e.scheduledFor === +when)) {
      return "duplicado";
    }
    if (existing.some((e) => e.patientId === data.patientId && overlaps(e))) {
      return "sobreturno";
    }
  }
  const capacityCount = existing.filter(
    (e) =>
      e.practitionerId === data.practitionerId &&
      e.serviceId === data.serviceId &&
      isHoldingCapacity(e, now) &&
      overlaps(e)
  ).length;
  return overlapBlocks(capacityCount, maxConcurrent) ? "sobreturno" : "libre";
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PRAC = "cmg1prac00000000000000001";
const PRAC2 = "cmg1prac00000000000000002";
const SVC = "cmg1svc000000000000000001";
const SVC2 = "cmg1svc000000000000000002";
const PAT = "cmg1pat000000000000000001";
const PAT2 = "cmg1pat000000000000000002";
const LOC = "cmg1loc000000000000000001";
const LOC2 = "cmg1loc000000000000000002";
const UUID = "0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
// 2027-03-10 = miércoles; 14 = domingo.
const NOW = ar("2027-03-10T07:00");

let seq = 0;
function bk(local: string | Date, durationMin: number, extra: Partial<AvailabilityBooking> = {}): AvailabilityBooking {
  seq++;
  return {
    id: `bk${seq}`,
    locationId: LOC,
    scheduledFor: typeof local === "string" ? ar(local) : local,
    durationMin,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date(NOW.getTime() - 86_400_000),
    patientId: PAT2,
    idempotencyKey: `agenda-key-${seq}`,
    practitionerId: PRAC,
    serviceId: SVC,
    ...extra,
  };
}
const pubPending = (local: string | Date, durationMin: number, minAgo: number, extra: Partial<AvailabilityBooking> = {}) =>
  bk(local, durationMin, {
    status: "PENDING",
    paymentStatus: "UNPAID",
    createdAt: new Date(NOW.getTime() - minAgo * 60_000),
    idempotencyKey: `pub:tenant:${UUID}-${++seq}`,
    ...extra,
  });

function block(startLocal: string, endLocal: string, extra: Partial<TimeBlockInput> = {}): TimeBlockInput {
  return {
    id: `tb${++seq}`,
    practitionerId: PRAC,
    locationId: null,
    startsAt: ar(startLocal),
    endsAt: ar(endLocal),
    allDay: false,
    reason: "Feriado",
    groupId: null,
    ...extra,
  };
}

/** Plantilla lun-sáb 9-13 y 14-18 en LOC; domingo cerrado. */
const SPLIT: ScheduleRange[] = [
  { startMin: 9 * 60, endMin: 13 * 60, locationId: LOC },
  { startMin: 14 * 60, endMin: 18 * 60, locationId: LOC },
];
const dowOfKey = (key: string) => new Date(`${key}T12:00:00-03:00`).getUTCDay(); // 12:00 AR = 15:00 UTC, mismo día
const splitRanges: RangesFor = (_p, key) => (dowOfKey(key) === 0 ? [] : SPLIT);
const allDay: RangesFor = () => [{ startMin: 0, endMin: 1440, locationId: LOC }];

const base = (o: Partial<ClassifyInstantInput> & { when: Date }): ClassifyInstantInput => ({
  durationMin: 60,
  patientId: PAT,
  practitionerId: PRAC,
  serviceId: SVC,
  cap: 1,
  rangesFor: splitRanges,
  blocks: [],
  bookings: [],
  now: NOW,
  ...o,
});
const cls = (o: Partial<ClassifyInstantInput> & { when: Date }) => classifyInstant(base(o));

// ─────────────────────────────────────────────────────────────────────────────
// Golden por clase
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyInstant — libre", () => {
  it("dentro de la franja, sin nada en el camino", () => {
    expect(cls({ when: ar("2027-03-10T10:00") })).toEqual({
      class: "libre",
      outOfHours: false,
      blocked: false,
      blockIds: [],
      used: 0,
      cap: 1,
    });
  });

  it("bordes de la franja: 09:00-10:00 y 12:00-13:00 entran (semiabierto)", () => {
    expect(cls({ when: ar("2027-03-10T09:00") }).class).toBe("libre");
    expect(cls({ when: ar("2027-03-10T12:00") }).class).toBe("libre");
  });
});

describe("classifyInstant — fuera-de-horario", () => {
  it("antes de abrir, termina después de cerrar, o cae en el hueco entre franjas", () => {
    expect(cls({ when: ar("2027-03-10T08:45") }).class).toBe("fuera-de-horario");
    expect(cls({ when: ar("2027-03-10T12:15") }).class).toBe("fuera-de-horario"); // 13:15 > 13:00
    expect(cls({ when: ar("2027-03-10T13:30"), durationMin: 30 }).class).toBe("fuera-de-horario");
    expect(cls({ when: ar("2027-03-10T17:30") }).class).toBe("fuera-de-horario");
  });

  it("no puede repartirse entre dos franjas contiguas de distinta sede si se pide una sede", () => {
    const twoSedes: RangesFor = () => [
      { startMin: 9 * 60, endMin: 12 * 60, locationId: LOC },
      { startMin: 12 * 60, endMin: 15 * 60, locationId: LOC2 },
    ];
    expect(cls({ when: ar("2027-03-10T12:30"), rangesFor: twoSedes, locationId: LOC }).class).toBe("fuera-de-horario");
    expect(cls({ when: ar("2027-03-10T12:30"), rangesFor: twoSedes, locationId: LOC2 }).class).toBe("libre");
    // Sin sede pedida alcanza con cualquier franja.
    expect(cls({ when: ar("2027-03-10T12:30"), rangesFor: twoSedes }).class).toBe("libre");
    // Una franja partida en el borde no se une: 11:30-12:30 cruza de una a otra.
    expect(cls({ when: ar("2027-03-10T11:30"), rangesFor: twoSedes }).class).toBe("fuera-de-horario");
  });

  it("franjas contiguas de la MISMA sede se unen (como normalize de ranges.ts)", () => {
    const chained: RangesFor = () => [
      { startMin: 9 * 60, endMin: 10 * 60, locationId: LOC },
      { startMin: 10 * 60, endMin: 11 * 60, locationId: LOC },
      { startMin: 11 * 60, endMin: 12 * 60, locationId: LOC2 },
    ];
    expect(cls({ when: ar("2027-03-10T09:30"), durationMin: 90, rangesFor: chained }).class).toBe("libre");
    expect(cls({ when: ar("2027-03-10T09:30"), durationMin: 120, rangesFor: chained }).class).toBe("fuera-de-horario");
    expect(fitsInRanges(chained(PRAC, "x"), 9 * 60 + 30, 90, LOC2)).toBe(false);
  });

  it("día sin franjas (domingo de la plantilla)", () => {
    const c = cls({ when: ar("2027-03-14T10:00") });
    expect(c.class).toBe("fuera-de-horario");
    expect(c.outOfHours).toBe(true);
  });

  it("23:30 AR es el MISMO día AR (en UTC ya es el siguiente) y cruza medianoche → fuera", () => {
    const seen: string[] = [];
    const spy: RangesFor = (p, k) => {
      seen.push(k);
      return allDay(p, k);
    };
    expect(cls({ when: ar("2027-03-10T23:30"), durationMin: 30, rangesFor: spy }).class).toBe("libre");
    expect(seen).toEqual(["2027-03-10"]);
    expect(cls({ when: ar("2027-03-10T23:30"), durationMin: 60, rangesFor: allDay }).class).toBe("fuera-de-horario");
  });

  it("segundos cuentan: 12:00:30 + 60 min no entra en una franja que cierra 13:00", () => {
    const when = new Date(ar("2027-03-10T12:00").getTime() + 30_000);
    expect(cls({ when }).class).toBe("fuera-de-horario");
  });

  it("pide las franjas del profesional del turno", () => {
    const byPrac: RangesFor = (p) => (p === PRAC2 ? SPLIT : []);
    expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: byPrac }).class).toBe("fuera-de-horario");
    expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: byPrac, practitionerId: PRAC2 }).class).toBe("libre");
  });
});

describe("classifyInstant — bloqueado", () => {
  it("un bloqueo que pisa aunque sea en parte; tocarse en el borde no", () => {
    const tb = block("2027-03-10T10:30", "2027-03-10T11:00");
    const c = cls({ when: ar("2027-03-10T10:00"), blocks: [tb] });
    expect(c).toMatchObject({ class: "bloqueado", blocked: true, outOfHours: false, blockIds: [tb.id] });
    expect(cls({ when: ar("2027-03-10T11:00"), blocks: [tb] }).class).toBe("libre");
    expect(cls({ when: ar("2027-03-10T09:30"), durationMin: 75, blocks: [tb] }).class).toBe("bloqueado");
    // 09:30 + 60 = 10:30: termina justo cuando arranca el bloqueo → no lo pisa.
    expect(cls({ when: ar("2027-03-10T09:30"), durationMin: 60, blocks: [tb] }).class).toBe("libre");
  });

  it("de todo el consultorio (practitionerId null) aplica; de otro profesional no", () => {
    expect(
      cls({ when: ar("2027-03-10T10:00"), blocks: [block("2027-03-10T00:00", "2027-03-11T00:00", { practitionerId: null })] })
        .class
    ).toBe("bloqueado");
    expect(
      cls({ when: ar("2027-03-10T10:00"), blocks: [block("2027-03-10T00:00", "2027-03-11T00:00", { practitionerId: PRAC2 })] })
        .class
    ).toBe("libre");
  });

  it("sede pedida: null = todas; uno de otra sede no aplica", () => {
    const other = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: LOC2 });
    const all = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: null });
    expect(cls({ when: ar("2027-03-10T10:00"), locationId: LOC, blocks: [other] }).class).toBe("libre");
    expect(cls({ when: ar("2027-03-10T10:00"), locationId: LOC2, blocks: [other] }).class).toBe("bloqueado");
    expect(cls({ when: ar("2027-03-10T10:00"), locationId: LOC, blocks: [all] }).class).toBe("bloqueado");
  });

  it("sin sede pedida: la deciden las franjas donde entra; fuera de horario, conservador", () => {
    const blkLoc = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: LOC });
    const blkLoc2 = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: LOC2 });
    // SPLIT es todo LOC: un bloqueo de LOC2 no lo tapa; uno de LOC sí.
    expect(cls({ when: ar("2027-03-10T10:00"), blocks: [blkLoc2] }).class).toBe("libre");
    expect(cls({ when: ar("2027-03-10T10:00"), blocks: [blkLoc] }).class).toBe("bloqueado");
    // Franjas superpuestas en dos sedes: bloqueado solo si las dos lo están.
    const both: RangesFor = () => [
      { startMin: 9 * 60, endMin: 13 * 60, locationId: LOC },
      { startMin: 9 * 60, endMin: 13 * 60, locationId: LOC2 },
    ];
    expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: both, blocks: [blkLoc] }).class).toBe("libre");
    const c = cls({ when: ar("2027-03-10T10:00"), rangesFor: both, blocks: [blkLoc2, blkLoc] });
    expect(c).toMatchObject({ class: "bloqueado", blockIds: [blkLoc2.id, blkLoc.id] });
    // Fuera de horario (domingo): cualquier bloqueo cuenta.
    const sun = block("2027-03-14T10:00", "2027-03-14T11:00", { locationId: LOC2 });
    expect(cls({ when: ar("2027-03-14T10:00"), blocks: [sun] })).toMatchObject({ class: "bloqueado", outOfHours: true });
  });

  it("NO_LOCATION_ID (sin sede principal): bloqueo de sede concreta no lo tapa, uno de todas sí", () => {
    const noLoc: RangesFor = () => [{ startMin: 8 * 60, endMin: 19 * 60, locationId: NO_LOCATION_ID }];
    const concrete = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: LOC });
    const all = block("2027-03-10T10:00", "2027-03-10T11:00", { locationId: null });
    for (const locationId of [undefined, NO_LOCATION_ID]) {
      expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: noLoc, locationId, blocks: [concrete] }).class).toBe("libre");
      expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: noLoc, locationId, blocks: [all] }).class).toBe("bloqueado");
    }
    // "" es una sede concreta: pedir LOC sobre franjas "" es fuera de horario.
    expect(cls({ when: ar("2027-03-10T10:00"), rangesFor: noLoc, locationId: LOC }).class).toBe("fuera-de-horario");
  });

  it("allDay cubre los días AR completos que toca aunque las horas vengan corridas (como ranges.ts)", () => {
    // Guardado 03:00→03:00 UTC (= 00:00→00:00 AR del 11) pero corrido 3 h: 2027-03-10T21:00 AR → 2027-03-11T21:00 AR.
    const tb = block("2027-03-10T21:00", "2027-03-11T21:00", { allDay: true });
    expect(cls({ when: ar("2027-03-10T10:00"), blocks: [tb] }).class).toBe("bloqueado");
    expect(cls({ when: ar("2027-03-11T22:00"), durationMin: 30, rangesFor: allDay, blocks: [tb] }).class).toBe("bloqueado");
    expect(cls({ when: ar("2027-03-12T10:00"), blocks: [tb] }).class).toBe("libre");
    // El mismo intervalo sin allDay solo tapa sus horas.
    expect(cls({ when: ar("2027-03-10T10:00"), blocks: [{ ...tb, allDay: false }] }).class).toBe("libre");
  });

  it("gana sobre fuera-de-horario y sobre cupo, con los flags y todos los ids", () => {
    const a = block("2027-03-10T12:00", "2027-03-10T12:30");
    const b = block("2027-03-10T13:00", "2027-03-10T14:00", { practitionerId: null });
    const c = cls({ when: ar("2027-03-10T12:15"), blocks: [a, b], bookings: [bk("2027-03-10T12:00", 60)] });
    expect(c).toEqual({ class: "bloqueado", outOfHours: true, blocked: true, blockIds: [a.id, b.id], used: 1, cap: 1 });
  });
});

describe("classifyInstant — duplicado", () => {
  it("el paciente ya tiene un turno que arranca en ese instante (otro profesional, o una reserva vencida)", () => {
    const when = ar("2027-03-10T10:00");
    expect(cls({ when, cap: null, bookings: [bk(when, 30, { patientId: PAT, practitionerId: PRAC2 })] }).class).toBe(
      "duplicado"
    );
    expect(cls({ when, cap: null, bookings: [pubPending(when, 60, 90, { patientId: PAT })] }).class).toBe("duplicado");
  });

  it("gana sobre bloqueado y fuera-de-horario, que igual se informan", () => {
    const when = ar("2027-03-14T10:00"); // domingo
    const tb = block("2027-03-14T00:00", "2027-03-15T00:00");
    const c = cls({ when, blocks: [tb], bookings: [bk(when, 60, { patientId: PAT })] });
    expect(c).toMatchObject({ class: "duplicado", blocked: true, outOfHours: true, blockIds: [tb.id] });
  });

  it("sin paciente (guest) no hay duplicado ni superposición", () => {
    const when = ar("2027-03-10T10:00");
    expect(cls({ when, patientId: null, bookings: [bk(when, 60, { patientId: null, practitionerId: PRAC2 })] }).class).toBe(
      "libre"
    );
  });

  it("excludeBookingId: el propio turno (edición) no se cuenta para nada", () => {
    const when = ar("2027-03-10T10:00");
    const self = bk(when, 60, { patientId: PAT });
    expect(cls({ when, bookings: [self] }).class).toBe("duplicado");
    expect(cls({ when, bookings: [self], excludeBookingId: self.id })).toMatchObject({ class: "libre", used: 0 });
  });
});

describe("classifyInstant — paciente-superpuesto y sobreturno", () => {
  const when = ar("2027-03-10T10:00");

  it("paciente ocupado en la ventana con otro profesional/servicio → paciente-superpuesto", () => {
    const e = [bk("2027-03-10T09:30", 45, { patientId: PAT, practitionerId: PRAC2, serviceId: SVC2 })];
    expect(cls({ when, cap: null, bookings: e }).class).toBe("paciente-superpuesto");
    // Borde: termina justo al arrancar → libre.
    expect(cls({ when, bookings: [bk("2027-03-10T09:00", 60, { patientId: PAT })] }).class).toBe("libre");
  });

  it("cupo del profesional + servicio: 1 → sobreturno, 2 → libre, null → libre; `used` cuenta", () => {
    const e = [bk("2027-03-10T10:30", 60)];
    expect(cls({ when, cap: 1, bookings: e })).toMatchObject({ class: "sobreturno", used: 1, cap: 1 });
    expect(cls({ when, cap: 2, bookings: e })).toMatchObject({ class: "libre", used: 1, cap: 2 });
    expect(cls({ when, cap: null, bookings: e })).toMatchObject({ class: "libre", used: 1, cap: null });
  });

  it("otro profesional u otro servicio no ocupan el cupo", () => {
    const e = [bk(when, 60, { practitionerId: PRAC2 }), bk(when, 60, { serviceId: SVC2 })];
    expect(cls({ when, bookings: e })).toMatchObject({ class: "libre", used: 0 });
  });

  it("reserva pública impaga vencida no ocupa cupo; vigente sí (isHoldingCapacity)", () => {
    expect(cls({ when, bookings: [pubPending("2027-03-10T10:15", 30, 31)] }).class).toBe("libre");
    expect(cls({ when, bookings: [pubPending("2027-03-10T10:15", 30, 30)] }).class).toBe("sobreturno");
  });

  it("si el paciente se superpone Y el cupo está lleno, gana paciente-superpuesto (orden del batch)", () => {
    const e = [bk("2027-03-10T09:30", 60, { patientId: PAT })];
    expect(cls({ when, cap: 1, bookings: e })).toMatchObject({ class: "paciente-superpuesto", used: 1 });
  });

  it("fuera-de-horario gana sobre sobreturno", () => {
    expect(cls({ when: ar("2027-03-10T17:30"), bookings: [bk("2027-03-10T17:30", 60)] })).toMatchObject({
      class: "fuera-de-horario",
      used: 1,
    });
  });
});

describe("helpers", () => {
  it("fitsInRanges: semiabierto, una sola franja, filtro de sede opcional", () => {
    expect(fitsInRanges(SPLIT, 9 * 60, 240)).toBe(true);
    expect(fitsInRanges(SPLIT, 9 * 60, 241)).toBe(false);
    expect(fitsInRanges(SPLIT, 10 * 60, 30, LOC2)).toBe(false);
    expect(fitsInRanges([], 600, 30)).toBe(false);
  });

  it("blocksHitting devuelve los bloqueos que pisan, en orden de entrada", () => {
    const a = block("2027-03-10T10:00", "2027-03-10T10:15");
    const b = block("2027-03-10T11:00", "2027-03-10T12:00");
    const hit = blocksHitting([b, a], {
      practitionerId: PRAC,
      locationId: null,
      start: ar("2027-03-10T10:00"),
      end: ar("2027-03-10T11:30"),
    });
    expect(hit.map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch: status + flags
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyBatchInstant", () => {
  it("fuera de horario es solo un flag (status libre); bloqueado sube a sobreturno (decisión 1)", () => {
    expect(classifyBatchInstant(base({ when: ar("2027-03-14T10:00") }))).toMatchObject({
      status: "libre",
      outOfHours: true,
      blocked: false,
    });
    const tb = block("2027-03-10T10:00", "2027-03-10T11:00");
    expect(classifyBatchInstant(base({ when: ar("2027-03-10T10:00"), blocks: [tb] }))).toMatchObject({
      status: "sobreturno",
      blocked: true,
      blockIds: [tb.id],
    });
  });

  it("duplicado sigue siendo duplicado aunque esté bloqueado", () => {
    const when = ar("2027-03-10T10:00");
    const tb = block("2027-03-10T10:00", "2027-03-10T11:00");
    expect(classifyBatchInstant(base({ when, blocks: [tb], bookings: [bk(when, 60, { patientId: PAT })] })).status).toBe(
      "duplicado"
    );
  });
});

/** LCG con semilla fija. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomBookings(seed: number, from: Date, n: number): AvailabilityBooking[] {
  const r = rng(seed);
  const out: AvailabilityBooking[] = [];
  for (let i = 0; i < n; i++) {
    const offMin = Math.floor(r() * (3 * 24 * 4)) * 15 - 120;
    const at = new Date(from.getTime() + offMin * 60_000);
    const dur = [30, 45, 60, 90][Math.floor(r() * 4)];
    if (r() < 0.15) {
      out.push({ ...pubPending(at, dur, r() < 0.5 ? 10 : 45), patientId: r() < 0.3 ? PAT : PAT2 });
    } else {
      out.push(
        bk(at, dur, {
          patientId: r() < 0.3 ? PAT : r() < 0.5 ? null : PAT2,
          practitionerId: r() < 0.8 ? PRAC : PRAC2,
          serviceId: r() < 0.8 ? SVC : SVC2,
        })
      );
    }
  }
  return out;
}

describe("paridad batch: classifyBatchInstant.status ↔ oráculo ef3281f ↔ classifyBatchSlot (sin bloqueos)", () => {
  it("turnos aleatorios × instantes × duraciones × cupos × paciente/guest × franjas", () => {
    const from = ar("2027-03-10T08:00");
    const tally: Record<string, number> = { libre: 0, sobreturno: 0, duplicado: 0 };
    const classes = new Set<string>();
    let outOfHours = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const existing = randomBookings(seed, from, 25);
      for (let slot = 0; slot < 40; slot++) {
        const when = new Date(from.getTime() + slot * 30 * 60_000);
        for (const durationMin of [30, 45, 60]) {
          for (const cap of [1, 2, null]) {
            for (const patientId of [PAT, null]) {
              const data = { patientId, practitionerId: PRAC, serviceId: SVC };
              const want = legacyClassify(when, data, durationMin, cap, existing, NOW);
              expect(classifyBatchSlot(when, { ...data, durationMin, maxConcurrent: cap, existing, now: NOW })).toBe(want);
              // Las franjas no cambian el status (solo el flag).
              for (const rangesFor of [splitRanges, allDay]) {
                const input = base({ when, durationMin, cap, patientId, bookings: existing, rangesFor });
                const got = classifyBatchInstant(input);
                expect(got.status).toBe(want);
                const c = classifyInstant(input);
                classes.add(c.class);
                if (got.outOfHours) outOfHours++;
                // Coherencia classifyInstant ↔ batch.
                if (c.class === "duplicado") expect(want).toBe("duplicado");
                if (c.class === "sobreturno" || c.class === "paciente-superpuesto") expect(want).toBe("sobreturno");
                if (c.class === "libre") expect(want).toBe("libre");
              }
              tally[want]++;
            }
          }
        }
      }
    }
    // Anti-false-green: las tres salidas del batch y casi todas las clases aparecen.
    expect(tally.libre).toBeGreaterThan(0);
    expect(tally.sobreturno).toBeGreaterThan(0);
    expect(tally.duplicado).toBeGreaterThan(0);
    expect(outOfHours).toBeGreaterThan(0);
    for (const k of ["libre", "duplicado", "fuera-de-horario", "sobreturno", "paciente-superpuesto"]) {
      expect(classes.has(k)).toBe(true);
    }
  });
});
