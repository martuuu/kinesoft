/**
 * `lib/availability/next-free.ts` (B2.1b): próximo hueco y "cualquier
 * profesional".
 *
 * Paridad: con la plantilla fallback (lun-sáb, horario del tenant — la regla de
 * hoy) y sin bloqueos, `nextFreeSlot` reproduce `suggestNextFreeSlot` de
 * ef3281f (oráculo literal, el mismo de `tests/unit/booking-schedule.test.ts`)
 * y `findNextFreeSlot` de `lib/booking-schedule.ts`.
 *
 * DIFERENCIA INTENCIONAL (hallazgo de B1.6), excluida de la paridad y fijada
 * con un caso explícito: el suggest viejo cargaba solo turnos con
 * `scheduledFor ≥ from + 15 min`, así que un turno EN CURSO (arrancó antes y
 * sigue) no ocupaba cupo y podía sugerir un hueco ocupado. `nextFreeSlot` ve
 * todos los turnos que recibe (el loader trae 240 min hacia atrás,
 * `BOOKING_LOOKBACK_MIN`). Por eso la matriz de paridad le pasa al motor nuevo
 * los turnos ya recortados a la ventana vieja; con la ventana completa solo
 * puede diferir en ese caso, y el test lo comprueba.
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`).
 */
import { describe, it, expect } from "vitest";
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { toARDow, toARHour } from "@/lib/datetime-ar";
import { findNextFreeSlot, suggestLoadWindow, SUGGEST_HORIZON_DAYS, SUGGEST_STEP_MIN } from "@/lib/booking-schedule";
import {
  nextFreeSlot,
  firstFreeAcrossPractitioners,
  resolvePractitionerService,
  eligiblePractitioners,
  acceptsInsurer,
  type NextFreeSlotInput,
} from "@/lib/availability/next-free";
import { classifyInstant, type RangesFor } from "@/lib/availability/classify";
import { workingRanges } from "@/lib/availability/ranges";
import {
  BOOKING_LOOKBACK_MIN,
  NEXT_FREE_HORIZON_DAYS,
  NEXT_FREE_STEP_MIN,
  type AvailabilityBooking,
  type PractitionerPayerRule,
  type PractitionerServiceRule,
  type ScheduleRange,
  type ServiceInfo,
  type TimeBlockInput,
} from "@/lib/availability/types";

// ─────────────────────────────────────────────────────────────────────────────
// Oráculo: suggestNextFreeSlot de ef3281f (copia literal, no editar)
// ─────────────────────────────────────────────────────────────────────────────

type HoldRow = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
};

function legacySuggest(o: {
  from: Date;
  durationMin: number;
  maxConcurrent: number | null;
  rows: HoldRow[];
  businessHoursStart: number | null;
  businessHoursEnd: number | null;
  now: Date;
}): string | null {
  const { from, durationMin, maxConcurrent } = o;
  const STEP_MIN = 15;
  const HORIZON_MS = 14 * 86_400_000;
  const start = new Date(from.getTime() + STEP_MIN * 60_000);
  const bookings = o.rows.filter(
    (b) => b.scheduledFor >= start && b.scheduledFor < new Date(start.getTime() + HORIZON_MS)
  );
  const tenant = { businessHoursStart: o.businessHoursStart, businessHoursEnd: o.businessHoursEnd };
  const now = o.now;
  const holding = bookings.filter((b) => isHoldingCapacity(b, now));
  const openHour = tenant?.businessHoursStart ?? 8;
  const closeHour = tenant?.businessHoursEnd ?? 19;
  const atCapacity = (slot: Date, end: Date) =>
    overlapBlocks(
      holding.filter((b) => {
        const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
        return b.scheduledFor < end && bEnd > slot;
      }).length,
      maxConcurrent
    );
  const cursor = new Date(start);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / STEP_MIN) * STEP_MIN, 0, 0);
  while (cursor.getTime() - from.getTime() < HORIZON_MS) {
    const dow = toARDow(cursor);
    const arHour = toARHour(cursor);
    const endMinutes = arHour * 60 + durationMin;
    if (dow !== 0 && arHour >= openHour && endMinutes <= closeHour * 60) {
      const end = new Date(cursor.getTime() + durationMin * 60_000);
      if (!atCapacity(cursor, end)) {
        return cursor.toISOString();
      }
    }
    cursor.setTime(cursor.getTime() + STEP_MIN * 60_000);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PRAC = "cmg1prac00000000000000001";
const PRAC2 = "cmg1prac00000000000000002";
const PRAC3 = "cmg1prac00000000000000003";
const SVC = "cmg1svc000000000000000001";
const SVC2 = "cmg1svc000000000000000002";
const PAT = "cmg1pat000000000000000001";
const PAT2 = "cmg1pat000000000000000002";
const LOC = "cmg1loc000000000000000001";
const LOC2 = "cmg1loc000000000000000002";
const INS = "cmg1ins000000000000000001";
const UUID = "0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const iso = (local: string) => ar(local).toISOString();
// 2027-03-10 = miércoles; 13 = sábado; 14 = domingo; 15 = lunes.
const NOW = ar("2027-03-10T09:00");

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
const pubPending = (at: Date, durationMin: number, minAgo: number) =>
  bk(at, durationMin, {
    status: "PENDING",
    paymentStatus: "UNPAID",
    createdAt: new Date(NOW.getTime() - minAgo * 60_000),
    idempotencyKey: `pub:tenant:${UUID}-${++seq}`,
  });

const dowOfKey = (key: string) => new Date(`${key}T12:00:00-03:00`).getUTCDay();

/** La red de seguridad del loader: lun-sáb con el horario del tenant (null → 8-19). */
function fallbackRanges(start: number | null, end: number | null, locationId = LOC): RangesFor {
  const r: ScheduleRange[] = [{ startMin: (start ?? 8) * 60, endMin: (end ?? 19) * 60, locationId }];
  return (_p, key) => (dowOfKey(key) === 0 ? [] : r);
}

const nf = (o: Partial<NextFreeSlotInput> & { from: Date }): NextFreeSlotInput => ({
  durationMin: 60,
  practitionerId: PRAC,
  serviceId: SVC,
  cap: 1,
  rangesFor: fallbackRanges(8, 19),
  blocks: [],
  bookings: [],
  now: NOW,
  ...o,
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

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("constantes del contrato = las del suggest (handoff de B2.0)", () => {
  it("paso 15, horizonte 14, lookback 240", () => {
    expect(NEXT_FREE_STEP_MIN).toBe(SUGGEST_STEP_MIN);
    expect(NEXT_FREE_HORIZON_DAYS).toBe(SUGGEST_HORIZON_DAYS);
    expect(BOOKING_LOOKBACK_MIN).toBe(240);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Golden (las del suggest, con la plantilla fallback)
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFreeSlot — golden con plantilla fallback", () => {
  it("arranca 15 min después de `from`, sobre el borde de 15; los segundos se descartan", () => {
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00") }))).toBe(iso("2027-03-10T10:15"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:07") }))).toBe(iso("2027-03-10T10:30"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:53") }))).toBe(iso("2027-03-10T11:15"));
    expect(nextFreeSlot(nf({ from: new Date(ar("2027-03-10T10:00").getTime() + 30_000) }))).toBe(
      iso("2027-03-10T10:15")
    );
  });

  it("entra entero antes del cierre; cruce de medianoche AR; domingo se saltea", () => {
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T18:30") }))).toBe(iso("2027-03-11T08:00"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T23:50") }))).toBe(iso("2027-03-11T08:00"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-13T18:30") }))).toBe(iso("2027-03-15T08:00"));
  });

  it("cupo 1 / 2 / null y reserva pública vencida", () => {
    const rows = [bk("2027-03-10T10:15", 60), bk("2027-03-10T11:15", 45)];
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), bookings: rows }))).toBe(iso("2027-03-10T12:00"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), bookings: rows, cap: 2 }))).toBe(iso("2027-03-10T10:15"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), bookings: rows, cap: null }))).toBe(iso("2027-03-10T10:15"));
    expect(
      nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), bookings: [pubPending(ar("2027-03-10T10:15"), 60, 31)] }))
    ).toBe(iso("2027-03-10T10:15"));
  });

  it("nada entra en 14 días → null", () => {
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), durationMin: 90, rangesFor: fallbackRanges(9, 10) }))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diferencia intencional: turnos en curso
// ─────────────────────────────────────────────────────────────────────────────

describe("diferencia intencional con el suggest viejo (excluida de la paridad)", () => {
  it("un turno EN CURSO (arrancó antes de from+15) ocupa el cupo: el viejo lo ignoraba", () => {
    const rows = [bk("2027-03-10T09:30", 90)]; // 09:30-11:00, cupo 1
    const from = ar("2027-03-10T10:00");
    const old = legacySuggest({
      from,
      durationMin: 60,
      maxConcurrent: 1,
      rows,
      businessHoursStart: 8,
      businessHoursEnd: 19,
      now: NOW,
    });
    expect(old).toBe(iso("2027-03-10T10:15")); // hueco que en realidad está ocupado
    expect(nextFreeSlot(nf({ from, bookings: rows }))).toBe(iso("2027-03-10T11:00"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paridad sobre una matriz
// ─────────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Mismo profesional + servicio (lo que carga el suggest), densos para forzar saltos de días. */
function randomRows(seed: number, base: Date, n: number): AvailabilityBooking[] {
  const r = rng(seed);
  const out: AvailabilityBooking[] = [];
  for (let i = 0; i < n; i++) {
    const offMin = Math.floor(r() * (3 * 24 * 4)) * 15 - 120;
    const at = new Date(base.getTime() + offMin * 60_000);
    const dur = [30, 45, 60, 90][Math.floor(r() * 4)];
    if (r() < 0.15) out.push(pubPending(at, dur, r() < 0.5 ? 10 : 45));
    else out.push(bk(at, dur, { patientId: r() < 0.3 ? PAT : r() < 0.5 ? null : PAT2 }));
  }
  return out;
}

const FROMS = [
  "2027-03-10T00:10",
  "2027-03-10T07:59",
  "2027-03-10T08:00",
  "2027-03-10T10:07",
  "2027-03-10T12:53",
  "2027-03-10T18:44",
  "2027-03-10T20:59",
  "2027-03-10T21:00",
  "2027-03-10T23:50",
  "2027-03-13T17:30",
  "2027-03-14T09:00",
];
const HOURS: [number | null, number | null][] = [
  [8, 19],
  [9, 13],
  [null, null],
];
const DURATIONS = [30, 45, 60];
const CAPS: (number | null)[] = [1, 2, null];

describe("paridad nextFreeSlot ↔ suggest ef3281f ↔ findNextFreeSlot (plantilla fallback, sin bloqueos)", () => {
  let totalInProgressDiffs = 0;
  it.each(FROMS)("from %s × horarios × duraciones × cupos × 4 sets de turnos", (fromLocal) => {
    const from = ar(fromLocal);
    const w = suggestLoadWindow(from);
    let checked = 0;
    let inProgressDiffs = 0;
    const seen = new Set<string | null>();
    for (const [hs, he] of HOURS) {
      for (const durationMin of DURATIONS) {
        for (const cap of CAPS) {
          for (let seed = 1; seed <= 4; seed++) {
            const rows = randomRows(seed * 97 + durationMin, from, 40 * seed);
            const want = legacySuggest({
              from,
              durationMin,
              maxConcurrent: cap,
              rows,
              businessHoursStart: hs,
              businessHoursEnd: he,
              now: NOW,
            });
            const oldWindow = rows.filter((b) => b.scheduledFor >= w.gte && b.scheduledFor < w.lt);
            expect(
              findNextFreeSlot({
                from,
                durationMin,
                maxConcurrent: cap,
                businessHours: { start: hs, end: he },
                bookings: oldWindow,
                now: NOW,
              })
            ).toBe(want);
            const input = nf({ from, durationMin, cap, rangesFor: fallbackRanges(hs, he), bookings: oldWindow });
            // Paridad: mismos turnos que veía el suggest viejo.
            expect(nextFreeSlot(input)).toBe(want);
            // Con la carga nueva (240 min hacia atrás) solo puede moverse a un
            // hueco igual o posterior, y solo por un turno en curso.
            const lookback = rows.filter((b) => b.scheduledFor.getTime() >= from.getTime() - BOOKING_LOOKBACK_MIN * 60_000);
            const full = nextFreeSlot({ ...input, bookings: lookback });
            if (full !== want) {
              inProgressDiffs++;
              expect(want).not.toBeNull();
              if (full !== null) expect(Date.parse(full)).toBeGreaterThan(Date.parse(want as string));
              expect(lookback.some((b) => b.scheduledFor < w.gte && b.scheduledFor.getTime() + b.durationMin * 60_000 > Date.parse(want as string))).toBe(true);
            }
            seen.add(want);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(HOURS.length * DURATIONS.length * CAPS.length * 4);
    // Anti-false-green: respuestas variadas.
    expect(seen.size).toBeGreaterThan(3);
    totalInProgressDiffs += inProgressDiffs;
  });

  it("con la carga de 240 min hacia atrás la matriz SÍ difiere en algún caso (turnos en curso)", () => {
    // Anti-false-green de la diferencia intencional: si nunca difiriera, el
    // lookback no estaría llegando al motor.
    expect(totalInProgressDiffs).toBeGreaterThan(0);
  });
});

describe("el barrido optimizado = recorrer con classifyInstant paso a paso", () => {
  function naive(input: NextFreeSlotInput): string | null {
    const start = Math.ceil(Math.floor((input.from.getTime() + 15 * 60_000) / 60_000) / 15) * 15 * 60_000;
    for (let t = start; t - input.from.getTime() < 14 * 86_400_000; t += 15 * 60_000) {
      if (classifyInstant({ ...input, when: new Date(t) }).class === "libre") return new Date(t).toISOString();
    }
    return null;
  }
  const split: RangesFor = (_p, key) =>
    dowOfKey(key) === 0
      ? key === "2027-03-21"
        ? [{ startMin: 600, endMin: 660, locationId: LOC2 }]
        : []
      : [
          { startMin: 9 * 60, endMin: 13 * 60, locationId: LOC },
          { startMin: 14 * 60 + 30, endMin: 20 * 60, locationId: LOC2 },
        ];

  it("franjas partidas, sedes, bloqueos, paciente, turnos aleatorios", () => {
    const seen = new Set<string | null>();
    for (const fromLocal of FROMS) {
      const from = ar(fromLocal);
      for (let seed = 1; seed <= 3; seed++) {
        const bookings = randomRows(seed * 31, from, 60).map((b, i) =>
          i % 5 === 0 ? { ...b, practitionerId: PRAC2, patientId: PAT } : b
        );
        const blocks = [
          block("2027-03-11T00:00", "2027-03-12T00:00", { practitionerId: null }),
          block("2027-03-15T09:00", "2027-03-15T12:00", { locationId: LOC }),
        ];
        for (const locationId of [undefined, LOC, LOC2]) {
          for (const durationMin of [30, 60]) {
            for (const patientId of [undefined, PAT]) {
              const input = nf({ from, durationMin, cap: seed === 3 ? null : seed, rangesFor: split, blocks, bookings, locationId, patientId });
              const want = naive(input);
              expect(nextFreeSlot(input)).toBe(want);
              seen.add(want);
            }
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lo nuevo: franjas, bloqueos, sedes, paciente
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFreeSlot — franjas y bloqueos", () => {
  const split: RangesFor = (_p, key) =>
    dowOfKey(key) === 0
      ? []
      : [
          { startMin: 9 * 60, endMin: 13 * 60, locationId: LOC },
          { startMin: 14 * 60, endMin: 18 * 60, locationId: LOC2 },
        ];

  it("salta el hueco entre franjas", () => {
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T12:00"), rangesFor: split }))).toBe(iso("2027-03-10T14:00"));
  });

  it("respeta la sede pedida", () => {
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T08:00"), rangesFor: split, locationId: LOC2 }))).toBe(
      iso("2027-03-10T14:00")
    );
  });

  it("salta un bloqueo parcial y uno de todo el día de todo el consultorio", () => {
    const partial = block("2027-03-10T09:00", "2027-03-10T11:00");
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T08:30"), rangesFor: split, blocks: [partial] }))).toBe(
      iso("2027-03-10T11:00")
    );
    const day = block("2027-03-10T00:00", "2027-03-11T00:00", { practitionerId: null, allDay: true });
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T08:30"), rangesFor: split, blocks: [day] }))).toBe(
      iso("2027-03-11T09:00")
    );
  });

  it("una excepción CUSTOM que abre un domingo se usa", () => {
    const sundayOpen: RangesFor = (p, key) =>
      key === "2027-03-14" ? [{ startMin: 10 * 60, endMin: 12 * 60, locationId: LOC }] : split(p, key);
    expect(nextFreeSlot(nf({ from: ar("2027-03-13T18:00"), rangesFor: sundayOpen }))).toBe(iso("2027-03-14T10:00"));
  });

  it("con paciente, también saltea donde el paciente ya está ocupado (cualquier profesional)", () => {
    const busy = [bk("2027-03-10T10:15", 60, { patientId: PAT, practitionerId: PRAC2, serviceId: SVC2 })];
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), cap: null, bookings: busy }))).toBe(iso("2027-03-10T10:15"));
    expect(nextFreeSlot(nf({ from: ar("2027-03-10T10:00"), cap: null, bookings: busy, patientId: PAT }))).toBe(
      iso("2027-03-10T11:15")
    );
  });

  it("pide las franjas una vez por día (memo), no una por paso", () => {
    const calls: string[] = [];
    const spy: RangesFor = (p, k) => {
      calls.push(k);
      return split(p, k);
    };
    nextFreeSlot(nf({ from: ar("2027-03-10T08:00"), durationMin: 600, rangesFor: spy }));
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls.length).toBeGreaterThanOrEqual(14);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reglas por profesional y "cualquier profesional"
// ─────────────────────────────────────────────────────────────────────────────

const svc: ServiceInfo = { id: SVC, durationMin: 60, maxConcurrent: 1 };
const rule = (practitionerId: string, extra: Partial<PractitionerServiceRule> = {}): PractitionerServiceRule => ({
  practitionerId,
  serviceId: SVC,
  enabled: true,
  visibility: "PUBLIC",
  durationMin: null,
  minLeadMinutes: null,
  maxLeadDays: null,
  concurrencyOverride: false,
  maxConcurrent: null,
  ...extra,
});
const payer = (practitionerId: string, active = true): PractitionerPayerRule => ({ practitionerId, insurerId: INS, active });

describe("resolvePractitionerService", () => {
  it("hereda duración y cupo del servicio; override de cupo (null = ilimitado)", () => {
    expect(resolvePractitionerService(rule(PRAC), svc, PRAC)).toEqual({ enabled: true, visibility: "PUBLIC", durationMin: 60, cap: 1 });
    expect(resolvePractitionerService(rule(PRAC, { durationMin: 45 }), svc, PRAC).durationMin).toBe(45);
    expect(resolvePractitionerService(rule(PRAC, { maxConcurrent: 3 }), svc, PRAC).cap).toBe(1); // sin override no pisa
    expect(resolvePractitionerService(rule(PRAC, { concurrencyOverride: true, maxConcurrent: 3 }), svc, PRAC).cap).toBe(3);
    expect(resolvePractitionerService(rule(PRAC, { concurrencyOverride: true, maxConcurrent: null }), svc, PRAC).cap).toBeNull();
  });

  // Integrador B2: mismo criterio que `listPractitionerServices` (Configuración).
  it("sin fila → habilitado y PUBLIC si el servicio es del consultorio o propio; deshabilitado si es de otro", () => {
    const def = { enabled: true, visibility: "PUBLIC", durationMin: 60, cap: 1 };
    expect(resolvePractitionerService(undefined, svc, PRAC)).toEqual(def); // practitionerId ausente = consultorio
    expect(resolvePractitionerService(undefined, { ...svc, practitionerId: null }, PRAC)).toEqual(def);
    expect(resolvePractitionerService(undefined, { ...svc, practitionerId: PRAC }, PRAC)).toEqual(def);
    expect(resolvePractitionerService(undefined, { ...svc, practitionerId: PRAC2 }, PRAC).enabled).toBe(false);
  });

  it("una fila explícita gana sobre el default (deshabilitado aunque sea del consultorio)", () => {
    expect(resolvePractitionerService(rule(PRAC, { enabled: false }), svc, PRAC).enabled).toBe(false);
    expect(resolvePractitionerService(rule(PRAC, { visibility: "PRIVATE" }), svc, PRAC).visibility).toBe("PRIVATE");
  });
});

describe("acceptsInsurer", () => {
  it("fila activa sí, inactiva no; sin fila (o sin lista) = aceptada", () => {
    expect(acceptsInsurer([payer(PRAC)], PRAC, INS)).toBe(true);
    expect(acceptsInsurer([payer(PRAC, false)], PRAC, INS)).toBe(false);
    expect(acceptsInsurer([payer(PRAC2, false)], PRAC, INS)).toBe(true);
    expect(acceptsInsurer(undefined, PRAC, INS)).toBe(true);
  });
});

describe("eligiblePractitioners", () => {
  const services = [rule(PRAC), rule(PRAC2, { enabled: false }), rule(PRAC3, { visibility: "PRIVATE" })];

  it("PractitionerService enabled; sin fila y sin el servicio en `services` → no (conservador)", () => {
    expect(
      eligiblePractitioners({
        practitionerIds: [PRAC, PRAC2, PRAC3, "sin-fila"],
        serviceId: SVC,
        practitionerServices: [...services, rule("sin-fila", { serviceId: SVC2 })],
        practitionerPayers: [],
      })
    ).toEqual([PRAC, PRAC3]);
  });

  it("sin fila + servicio conocido → default de Configuración (consultorio/propio sí, ajeno no)", () => {
    const q = {
      practitionerIds: [PRAC, PRAC2, "sin-fila"],
      serviceId: SVC,
      practitionerServices: [rule(PRAC2, { enabled: false })],
    };
    expect(eligiblePractitioners({ ...q, services: [svc] })).toEqual([PRAC, "sin-fila"]);
    expect(eligiblePractitioners({ ...q, services: [{ ...svc, practitionerId: "sin-fila" }] })).toEqual(["sin-fila"]);
    // publicOnly: el default es PUBLIC.
    expect(eligiblePractitioners({ ...q, services: [svc], publicOnly: true })).toEqual([PRAC, "sin-fila"]);
  });

  it("publicOnly excluye PRIVATE", () => {
    expect(
      eligiblePractitioners({
        practitionerIds: [PRAC, PRAC3],
        serviceId: SVC,
        practitionerServices: services,
        practitionerPayers: [],
        publicOnly: true,
      })
    ).toEqual([PRAC]);
  });

  it("con cobertura: fila inactiva → afuera; activa o sin fila → adentro (default de Configuración)", () => {
    expect(
      eligiblePractitioners({
        practitionerIds: [PRAC, PRAC3],
        serviceId: SVC,
        insurerId: INS,
        practitionerServices: services,
        practitionerPayers: [payer(PRAC, false), payer(PRAC3)],
      })
    ).toEqual([PRAC3]);
    expect(
      eligiblePractitioners({
        practitionerIds: [PRAC],
        serviceId: SVC,
        insurerId: INS,
        practitionerServices: services,
        practitionerPayers: [],
      })
    ).toEqual([PRAC]);
  });
});

describe("firstFreeAcrossPractitioners", () => {
  const common = {
    serviceId: SVC,
    services: [svc],
    rangesFor: fallbackRanges(8, 19),
    blocks: [] as TimeBlockInput[],
    now: NOW,
  };

  it("el más temprano entre los habilitados, con su duración y cupo", () => {
    const bookings = [bk("2027-03-10T10:15", 120, { practitionerId: PRAC }), bk("2027-03-10T10:15", 60, { practitionerId: PRAC2 })];
    expect(
      firstFreeAcrossPractitioners({
        ...common,
        from: ar("2027-03-10T10:00"),
        practitionerIds: [PRAC, PRAC2],
        practitionerServices: [rule(PRAC), rule(PRAC2)],
        practitionerPayers: [],
        bookings,
      })
    ).toEqual({ practitionerId: PRAC2, iso: iso("2027-03-10T11:15"), durationMin: 60, cap: 1 });
  });

  it("empate → el primero en el orden pedido", () => {
    const base = {
      ...common,
      from: ar("2027-03-10T10:00"),
      practitionerServices: [rule(PRAC), rule(PRAC2)],
      practitionerPayers: [],
      bookings: [],
    };
    expect(firstFreeAcrossPractitioners({ ...base, practitionerIds: [PRAC2, PRAC] })?.practitionerId).toBe(PRAC2);
    expect(firstFreeAcrossPractitioners({ ...base, practitionerIds: [PRAC, PRAC2] })?.practitionerId).toBe(PRAC);
  });

  it("filtra por cobertura y por las franjas de cada uno", () => {
    const onlyPrac2Monday: RangesFor = (p, key) =>
      p === PRAC2 ? (dowOfKey(key) === 1 ? [{ startMin: 600, endMin: 720, locationId: LOC }] : []) : fallbackRanges(8, 19)(p, key);
    const r = firstFreeAcrossPractitioners({
      ...common,
      rangesFor: onlyPrac2Monday,
      from: ar("2027-03-10T10:00"),
      practitionerIds: [PRAC, PRAC2],
      insurerId: INS,
      practitionerServices: [rule(PRAC), rule(PRAC2, { durationMin: 30 })],
      practitionerPayers: [payer(PRAC, false), payer(PRAC2)], // sin fila sería aceptada
      bookings: [],
    });
    expect(r).toEqual({ practitionerId: PRAC2, iso: iso("2027-03-15T10:00"), durationMin: 30, cap: 1 });
  });

  it("durationMin explícito pisa la del profesional", () => {
    const r = firstFreeAcrossPractitioners({
      ...common,
      from: ar("2027-03-10T18:00"),
      durationMin: 90,
      practitionerIds: [PRAC],
      practitionerServices: [rule(PRAC, { durationMin: 30 })],
      practitionerPayers: [],
      bookings: [],
    });
    expect(r).toEqual({ practitionerId: PRAC, iso: iso("2027-03-11T08:00"), durationMin: 90, cap: 1 });
  });

  it("nadie habilitado, servicio desconocido o nada en el horizonte → null", () => {
    const base = { ...common, from: ar("2027-03-10T10:00"), practitionerIds: [PRAC], practitionerPayers: [], bookings: [] };
    expect(firstFreeAcrossPractitioners({ ...base, practitionerServices: [rule(PRAC, { enabled: false })] })).toBeNull();
    expect(firstFreeAcrossPractitioners({ ...base, services: [], practitionerServices: [rule(PRAC)] })).toBeNull();
    expect(
      firstFreeAcrossPractitioners({ ...base, rangesFor: () => [], practitionerServices: [rule(PRAC)] })
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// De punta a punta con las franjas reales de B2.1a (`workingRanges`)
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFreeSlot sobre workingRanges (plantilla fallback = backfill) ↔ suggest viejo", () => {
  it("horarios × froms × cupos: misma salida que ef3281f", () => {
    const seen = new Set<string | null>();
    for (const [hs, he] of HOURS) {
      const input = {
        primaryLocationId: LOC,
        tenantHours: { startMin: (hs ?? 8) * 60, endMin: (he ?? 19) * 60 },
        templates: [{ practitionerId: PRAC, ranges: [], isFallback: true }],
        exceptions: [],
        blocks: [],
      };
      const rangesFor: RangesFor = (p, k) => workingRanges(p, k, input);
      for (const fromLocal of FROMS) {
        const from = ar(fromLocal);
        const w = suggestLoadWindow(from);
        for (const cap of CAPS) {
          const rows = randomRows(cap ?? 7, from, 80).filter((b) => b.scheduledFor >= w.gte && b.scheduledFor < w.lt);
          const want = legacySuggest({
            from,
            durationMin: 45,
            maxConcurrent: cap,
            rows,
            businessHoursStart: hs,
            businessHoursEnd: he,
            now: NOW,
          });
          expect(nextFreeSlot(nf({ from, durationMin: 45, cap, rangesFor, bookings: rows }))).toBe(want);
          seen.add(want);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});
