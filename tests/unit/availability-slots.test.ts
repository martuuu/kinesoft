/**
 * `lib/availability/slots.ts` (B2.1a): grilla de slots de un día a partir de
 * las franjas efectivas. Incluye la PARIDAD con `buildPublicSlots`
 * (`lib/public-booking-slots.ts`, el turnero de hoy) usado como oráculo: con la
 * plantilla de fallback (lun-sáb, horario del tenant), paso 45 y anticipación
 * 60, `buildSlots` tiene que dar exactamente lo mismo. Corre en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import { buildSlots } from "@/lib/availability/slots";
import { workingRanges } from "@/lib/availability/ranges";
import { instantAt } from "@/lib/availability/day";
import {
  PUBLIC_DEFAULT_MIN_LEAD_MINUTES,
  PUBLIC_SLOT_STEP_MIN,
  type AvailabilityBooking,
  type AvailabilityInput,
  type BuildSlotsInput,
} from "@/lib/availability/types";
import { buildPublicSlots, type PublicSlotBooking } from "@/lib/public-booking-slots";

// 2026-10-05 es lunes; 2026-10-04, domingo.
const MONDAY = "2026-10-05";
const MAIN = "loc-main";
const NORTE = "loc-norte";
// "Ahora" = el viernes anterior.
const FRIDAY = new Date("2026-10-02T12:00:00.000Z");

const r = (s: number, e: number, locationId = MAIN) => ({ startMin: s, endMin: e, locationId });

function bk(iso: string, over: Partial<AvailabilityBooking> = {}): AvailabilityBooking {
  return {
    id: "bk-" + Math.random().toString(36).slice(2),
    locationId: MAIN,
    practitionerId: "p1",
    serviceId: "s1",
    scheduledFor: new Date(iso),
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: "pat-1",
    idempotencyKey: "0b6f2c1e3f7a4d0e9a512f7c1d9e8a10",
    ...over,
  };
}

/** Reserva pública impaga (PENDING/UNPAID) creada en `createdAt`. */
function publicPending(iso: string, createdAt: Date, over: Partial<AvailabilityBooking> = {}) {
  return bk(iso, {
    status: "PENDING",
    paymentStatus: "UNPAID",
    createdAt,
    idempotencyKey: "pub:t1:0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10",
    ...over,
  });
}

function base(over: Partial<BuildSlotsInput> = {}): BuildSlotsInput {
  return {
    dayKey: MONDAY,
    ranges: [r(540, 720)], // 09-12
    stepMin: 30,
    durationMin: 60,
    lead: { minMinutes: 0, maxDays: null },
    now: FRIDAY,
    bookings: [],
    cap: 1,
    ...over,
  };
}

const times = (s: ReturnType<typeof buildSlots>) => s.map((x) => x.time);

describe("buildSlots — grilla", () => {
  it("anclada al inicio de la franja; el turno entra entero", () => {
    const s = buildSlots(base());
    expect(times(s)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    expect(s[0]).toEqual({
      iso: "2026-10-05T12:00:00.000Z",
      time: "09:00",
      available: true,
      reason: null,
      used: 0,
      cap: 1,
    });
  });
  it("sin franjas (día bloqueado/cerrado) → sin slots", () => {
    expect(buildSlots(base({ ranges: [] }))).toEqual([]);
  });
  it("cada franja ancla su propia grilla (bloqueo parcial respeta franjas)", () => {
    // 09-10 y 10:20-12 (un bloqueo 10:00-10:20 partió la franja).
    const s = buildSlots(base({ ranges: [r(540, 600), r(620, 720)], stepMin: 45, durationMin: 45 }));
    expect(times(s)).toEqual(["09:00", "10:20", "11:05"]);
  });
  it("varias franjas y sedes, en orden cronológico aunque vengan desordenadas", () => {
    const s = buildSlots(
      base({ ranges: [r(900, 960, NORTE), r(540, 600)], stepMin: 30, durationMin: 30 })
    );
    expect(times(s)).toEqual(["09:00", "09:30", "15:00", "15:30"]);
  });
  it("franja más corta que la duración → nada", () => {
    expect(buildSlots(base({ ranges: [r(540, 570)], durationMin: 45 }))).toEqual([]);
  });
  it("no duplica un instante si dos franjas (dato roto) se pisan", () => {
    const s = buildSlots(base({ ranges: [r(540, 660), r(540, 660, NORTE)], stepMin: 60, durationMin: 60 }));
    expect(times(s)).toEqual(["09:00", "10:00"]);
  });
  it("paso o duración no positivos → vacío (sin loop infinito)", () => {
    expect(buildSlots(base({ stepMin: 0 }))).toEqual([]);
    expect(buildSlots(base({ durationMin: 0 }))).toEqual([]);
  });
  it("cruce de medianoche UTC: franja 20-23 AR cae después de las 00:00 UTC del día siguiente", () => {
    const s = buildSlots(base({ ranges: [r(1200, 1380)], stepMin: 60, durationMin: 60 }));
    expect(s.map((x) => [x.time, x.iso])).toEqual([
      ["20:00", "2026-10-05T23:00:00.000Z"],
      ["21:00", "2026-10-06T00:00:00.000Z"],
      ["22:00", "2026-10-06T01:00:00.000Z"],
    ]);
  });
});

describe("buildSlots — anticipación", () => {
  // now = lunes 10:10 AR.
  const now = instantAt(MONDAY, 610);
  it("pasado antes de now; anticipación mínima antes de now + minLead", () => {
    const s = buildSlots(base({ now, lead: { minMinutes: 60, maxDays: null } }));
    expect(s.map((x) => [x.time, x.reason])).toEqual([
      ["09:00", "pasado"],
      ["09:30", "pasado"],
      ["10:00", "pasado"],
      ["10:30", "anticipacion-minima"],
      ["11:00", "anticipacion-minima"],
    ]);
    expect(s.every((x) => !x.available)).toBe(true);
  });
  it("exactamente now + minLead ya se ofrece", () => {
    const s = buildSlots(base({ now: instantAt(MONDAY, 540), lead: { minMinutes: 60, maxDays: null } }));
    expect(s.find((x) => x.time === "10:00")).toMatchObject({ available: true, reason: null });
    expect(s.find((x) => x.time === "09:30")).toMatchObject({ reason: "anticipacion-minima" });
  });
  it("anticipación máxima: más allá de now + maxDays → fuera-de-horizonte", () => {
    // now = jueves 01/10 09:30 AR; maxDays 4 → tope = lunes 05/10 09:30 AR.
    const s = buildSlots(base({ now: new Date("2026-10-01T12:30:00.000Z"), lead: { minMinutes: 0, maxDays: 4 } }));
    expect(s.map((x) => [x.time, x.available, x.reason])).toEqual([
      ["09:00", true, null],
      ["09:30", true, null], // justo en el tope: entra
      ["10:00", false, "fuera-de-horizonte"],
      ["10:30", false, "fuera-de-horizonte"],
      ["11:00", false, "fuera-de-horizonte"],
    ]);
  });
  it("pasado gana sobre cupo-completo", () => {
    const s = buildSlots(base({ now, bookings: [bk("2026-10-05T12:00:00.000Z", { durationMin: 60 })] }));
    expect(s[0]).toMatchObject({ time: "09:00", reason: "pasado", used: 1 });
  });
});

describe("buildSlots — cupo", () => {
  const at9 = "2026-10-05T12:00:00.000Z"; // 09:00 AR
  it("cap 1: un turno solapado llena; used/cap se informan", () => {
    const s = buildSlots(base({ bookings: [bk(at9, { durationMin: 60 })] }));
    expect(s.map((x) => [x.time, x.used, x.available, x.reason])).toEqual([
      ["09:00", 1, false, "cupo-completo"],
      ["09:30", 1, false, "cupo-completo"],
      ["10:00", 0, true, null], // tocarse en el borde no es solape
      ["10:30", 0, true, null],
      ["11:00", 0, true, null],
    ]);
  });
  it("cap 2: con uno queda lugar ('1/2'), con dos se llena ('2/2')", () => {
    const one = buildSlots(base({ cap: 2, bookings: [bk(at9, { durationMin: 60 })] }));
    expect(one[0]).toMatchObject({ used: 1, cap: 2, available: true, reason: null });
    const two = buildSlots(
      base({
        cap: 2,
        bookings: [bk(at9, { durationMin: 60 }), bk(at9, { durationMin: 60, patientId: "pat-2" })],
      })
    );
    expect(two[0]).toMatchObject({ used: 2, cap: 2, available: false, reason: "cupo-completo" });
  });
  it("cap null = ilimitado: nunca se llena, pero cuenta", () => {
    const s = buildSlots(
      base({ cap: null, bookings: [bk(at9, { durationMin: 60 }), bk(at9, { durationMin: 60, patientId: "pat-2" })] })
    );
    expect(s[0]).toMatchObject({ used: 2, cap: null, available: true, reason: null });
  });
  it("un turno que arrancó antes de la franja (lookback) igual ocupa", () => {
    const s = buildSlots(base({ bookings: [bk("2026-10-05T11:00:00.000Z", { durationMin: 90 })] })); // 08:00-09:30 AR
    expect(s.slice(0, 3).map((x) => [x.time, x.used])).toEqual([
      ["09:00", 1],
      ["09:30", 0],
      ["10:00", 0],
    ]);
  });
  it("reserva pública impaga VENCIDA no cuenta; la vigente sí", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const expired = publicPending(at9, new Date(now.getTime() - 31 * 60_000), { durationMin: 60 });
    const fresh = publicPending(at9, new Date(now.getTime() - 29 * 60_000), { durationMin: 60 });
    expect(buildSlots(base({ now, bookings: [expired] }))[0]).toMatchObject({ used: 0, available: true });
    expect(buildSlots(base({ now, bookings: [fresh] }))[0]).toMatchObject({ used: 1, available: false });
  });
  it("una reserva pública PAGA sigue ocupando aunque sea vieja", () => {
    const paid = publicPending(at9, new Date("2026-09-01T00:00:00.000Z"), {
      durationMin: 60,
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    expect(buildSlots(base({ bookings: [paid] }))[0]).toMatchObject({ used: 1, available: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paridad con el turnero de hoy (oráculo: buildPublicSlots, sin modificar).
// ─────────────────────────────────────────────────────────────────────────────

function fallbackInput(openHour: number | null, closeHour: number | null): AvailabilityInput {
  // Mismo default que buildPublicSlots (8-19) — FALLBACK_TENANT_HOURS.
  const startMin = (openHour ?? 8) * 60;
  const endMin = (closeHour ?? 19) * 60;
  return {
    tenantId: "t1",
    from: "2026-09-28",
    to: "2026-10-11",
    primaryLocationId: MAIN,
    tenantHours: { startMin, endMin },
    templates: [{ practitionerId: "p1", isFallback: true, ranges: [] }],
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [],
  };
}

function toPublic(b: AvailabilityBooking): PublicSlotBooking {
  return {
    scheduledFor: b.scheduledFor,
    durationMin: b.durationMin,
    status: b.status,
    paymentStatus: b.paymentStatus,
    createdAt: b.createdAt,
    patientId: b.patientId,
    idempotencyKey: b.idempotencyKey,
  };
}

describe("paridad buildSlots ↔ buildPublicSlots (fallback lun-sáb, paso 45, lead 60)", () => {
  const days = [
    "2026-10-04", // domingo
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
    "2026-10-10", // sábado
    "2026-12-31",
    "2027-01-01",
  ];
  const hours: Array<[number | null, number | null]> = [
    [8, 19],
    [9, 13],
    [null, null],
    [7, 21],
    [14, 22], // cruza la medianoche UTC
  ];
  const durations = [30, 45, 50, 60, 90];
  const caps: Array<number | null> = [null, 1, 2];
  const nows = [
    FRIDAY,
    new Date("2026-10-05T13:10:00.000Z"), // lunes 10:10 AR
    new Date("2026-10-05T13:00:00.000Z"), // lunes 10:00 AR exacto
    new Date("2026-10-10T20:00:00.000Z"), // sábado 17:00 AR
  ];
  function bookingsFor(day: string, now: Date): AvailabilityBooking[] {
    const at = (min: number) => instantAt(day, min).toISOString();
    return [
      bk(at(8 * 60), { durationMin: 45 }),
      bk(at(8 * 60 + 30), { durationMin: 60, patientId: "pat-2" }),
      bk(at(12 * 60), { durationMin: 90, patientId: "pat-3" }),
      // pública impaga vencida y vigente (contra `now`)
      publicPending(at(15 * 60), new Date(now.getTime() - 45 * 60_000), { patientId: "pat-4" }),
      publicPending(at(16 * 60 + 30), new Date(now.getTime() - 5 * 60_000), { patientId: "pat-5" }),
      // arrancó el día anterior a las 22:00 AR y dura 11 h (lookback largo)
      {
        ...bk(at(0), { durationMin: 660, patientId: "pat-6" }),
        scheduledFor: new Date(instantAt(day, 0).getTime() - 2 * 3_600_000),
      },
    ];
  }

  let cases = 0;
  for (const day of days) {
    for (const [openHour, closeHour] of hours) {
      it(`${day} ${openHour}-${closeHour}`, () => {
        for (const durationMin of durations) {
          for (const cap of caps) {
            for (const now of nows) {
              for (const withBookings of [false, true]) {
                cases++;
                const label = `dur=${durationMin} cap=${cap} now=${now.toISOString()} bk=${withBookings}`;
                const bookings = withBookings ? bookingsFor(day, now) : [];
                const oracle = buildPublicSlots({
                  date: day,
                  openHour,
                  closeHour,
                  durationMin,
                  maxConcurrent: cap,
                  existing: bookings.map(toPublic),
                  now,
                });
                const ranges = workingRanges("p1", day, fallbackInput(openHour, closeHour));
                const mine = buildSlots({
                  dayKey: day,
                  ranges,
                  stepMin: PUBLIC_SLOT_STEP_MIN,
                  durationMin,
                  lead: { minMinutes: PUBLIC_DEFAULT_MIN_LEAD_MINUTES, maxDays: null },
                  now,
                  bookings,
                  cap,
                });
                expect(mine.map(({ iso, time, available }) => ({ iso, time, available })), label).toEqual(
                  oracle
                );
              }
            }
          }
        }
      });
    }
  }
  it("la matriz no es trivial", () => {
    expect(cases).toBeGreaterThan(1000);
  });
});
