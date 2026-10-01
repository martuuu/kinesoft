/**
 * B3.2 AV-public: el turnero público sobre el motor de disponibilidad (puro).
 *
 *   1. Paridad: `buildPublicSlots` (envoltorio) ↔ la implementación de
 *      A2b-S-pub copiada LITERAL acá como oráculo (antes de B3.2 vivía en
 *      `lib/public-booking-slots.ts`). Matriz de días × horarios × duraciones ×
 *      cupos × "ahora" × turnos existentes.
 *   2. `publicDaySlots`: franjas por profesional, excepción CUSTOM, bloqueo
 *      duro, PractitionerService (PRIVATE / deshabilitado / override de
 *      duración, anticipación y horizonte), sede de la franja.
 *   3. `firstPublicSlotAcross` ("cualquier profesional"), con cobertura.
 * Corre igual en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import { localToARIso, toARDow } from "@/lib/datetime-ar";
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import {
  arDayWindow,
  buildPublicSlots,
  checkPublicSlot,
  firstPublicSlotAcross,
  publicDaySlots,
  resolvePublicOffer,
  type PublicSlotBooking,
} from "@/lib/public-booking-slots";
import type {
  AvailabilityBooking,
  AvailabilityInput,
  PractitionerServiceRule,
  ScheduleTemplateRange,
} from "@/lib/availability";
import type { PublicSlot } from "@/lib/public-booking-types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Oráculo: buildPublicSlots de A2b-S-pub, literal (sin el motor)
// ─────────────────────────────────────────────────────────────────────────────
function legacyBuildPublicSlots(input: {
  date: string;
  openHour: number | null | undefined;
  closeHour: number | null | undefined;
  durationMin: number;
  maxConcurrent: number | null | undefined;
  existing: ReadonlyArray<PublicSlotBooking>;
  now: Date;
}): PublicSlot[] {
  const win = arDayWindow(input.date);
  if (!win) return [];
  if (toARDow(win.dayStart) === 0) return [];
  const holding = input.existing.filter((b) => isHoldingCapacity(b, input.now));
  const openHour = input.openHour ?? 8;
  const closeHour = input.closeHour ?? 19;
  const total = input.durationMin;
  const earliest = input.now.getTime() + 60 * 60_000;
  const slots: PublicSlot[] = [];
  for (let m = openHour * 60; m + total <= closeHour * 60; m += 45) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const slot = new Date(localToARIso(`${input.date}T${hh}:${mm}:00`));
    const slotEnd = new Date(slot.getTime() + total * 60_000);
    const tooSoon = slot.getTime() < earliest;
    const overlapCount = holding.filter((b) => {
      const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
      return b.scheduledFor < slotEnd && bEnd > slot;
    }).length;
    const full = overlapBlocks(overlapCount, input.maxConcurrent);
    slots.push({ iso: slot.toISOString(), time: `${hh}:${mm}`, available: !full && !tooSoon });
  }
  return slots;
}

const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

function pubBooking(iso: Date, extra: Partial<PublicSlotBooking> = {}): PublicSlotBooking {
  return {
    scheduledFor: iso,
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: "p1",
    idempotencyKey: "pub:t1:0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10",
    ...extra,
  };
}

describe("paridad buildPublicSlots (envoltorio del motor) ↔ A2b-S-pub", () => {
  // Lunes a domingo de una semana + fin de mes.
  const days = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-10", "2026-10-31", "2026-11-02"];
  const hours: Array<[number | null, number | null]> = [
    [8, 19],
    [null, null],
    [9, 13],
    [7, 21],
    [10, 10],
    [0, 24],
  ];
  const durations = [30, 45, 60, 90];
  const caps: Array<number | null> = [null, 1, 2];
  const nows = [
    new Date("2026-10-02T12:00:00.000Z"),
    new Date("2026-10-05T12:30:00.000Z"), // lunes 09:30 AR
    new Date("2026-10-31T20:00:00.000Z"),
  ];
  const existingSets = (day: string): PublicSlotBooking[][] => [
    [],
    [pubBooking(at(day, "08:00"))],
    [pubBooking(at(day, "08:00")), pubBooking(at(day, "08:30"), { durationMin: 90 })],
    // Reserva pública impaga vieja: ya no retiene.
    [pubBooking(at(day, "09:30"), { status: "PENDING", createdAt: new Date("2026-09-01T00:00:00Z") })],
  ];

  it("misma salida en toda la matriz", () => {
    let cases = 0;
    for (const date of days)
      for (const [openHour, closeHour] of hours)
        for (const durationMin of durations)
          for (const maxConcurrent of caps)
            for (const now of nows)
              for (const existing of existingSets(date)) {
                const input = { date, openHour, closeHour, durationMin, maxConcurrent, existing, now };
                expect(buildPublicSlots(input), JSON.stringify({ date, openHour, closeHour, durationMin, maxConcurrent })).toEqual(
                  legacyBuildPublicSlots(input)
                );
                cases++;
              }
    expect(cases).toBeGreaterThan(1000);
  });

  it("checkPublicSlot sigue siendo un lookup exacto sobre la grilla", () => {
    const slots = buildPublicSlots({
      date: "2026-10-05",
      openHour: 8,
      closeHour: 19,
      durationMin: 45,
      maxConcurrent: 1,
      existing: [],
      now: new Date("2026-10-02T12:00:00.000Z"),
    });
    expect(checkPublicSlot(at("2026-10-05", "08:45"), slots)).toBe("ok");
    expect(checkPublicSlot(at("2026-10-05", "08:50"), slots)).toBe("off-grid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. publicDaySlots sobre un AvailabilityInput armado a mano
// ─────────────────────────────────────────────────────────────────────────────
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";
const NOW = new Date("2026-10-02T12:00:00.000Z"); // viernes anterior
const P1 = "prac-1";
const P2 = "prac-2";
const S = "svc-1";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

function tpl(dow: number, startMin: number, endMin: number, locationId = LOC_A): ScheduleTemplateRange {
  return { dow: dow as ScheduleTemplateRange["dow"], startMin, endMin, locationId, validFrom: null, validUntil: null };
}

function psRule(patch: Partial<PractitionerServiceRule> & { practitionerId: string }): PractitionerServiceRule {
  return {
    serviceId: S,
    enabled: true,
    visibility: "PUBLIC",
    durationMin: null,
    minLeadMinutes: null,
    maxLeadDays: null,
    concurrencyOverride: false,
    maxConcurrent: null,
    ...patch,
  };
}

function baseInput(patch: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    tenantId: "t1",
    from: SUNDAY,
    to: "2026-10-31",
    primaryLocationId: LOC_A,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [
      // P1: lunes 14-18 en la sede B (distinto del horario del tenant).
      { practitionerId: P1, isFallback: false, ranges: [tpl(1, 14 * 60, 18 * 60, LOC_B)] },
      // P2: sin franjas → horario del tenant lun-sáb en la principal.
      { practitionerId: P2, isFallback: true, ranges: [] },
    ],
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [{ id: S, durationMin: 45, maxConcurrent: 1, practitionerId: null }],
    practitionerPayers: [],
    ...patch,
  };
}

const q = (practitionerId: string, dayKey = MONDAY, extra: { locationId?: string | null; now?: Date } = {}) => ({
  practitionerId,
  serviceId: S,
  dayKey,
  now: extra.now ?? NOW,
  locationId: extra.locationId,
});

describe("publicDaySlots (B3.2)", () => {
  it("franja propia del profesional (no el horario del tenant) y sede de la franja", () => {
    const slots = publicDaySlots(baseInput(), q(P1));
    expect(slots.map((s) => s.time)).toEqual(["14:00", "14:45", "15:30", "16:15", "17:00"]);
    expect(slots.every((s) => s.locationId === LOC_B && s.available)).toBe(true);
  });

  it("sin franjas → horario del tenant lun-sáb en la sede principal", () => {
    const slots = publicDaySlots(baseInput(), q(P2));
    expect(slots[0]).toMatchObject({ time: "08:00", locationId: LOC_A, available: true });
    expect(slots.at(-1)!.time).toBe("17:45");
    expect(publicDaySlots(baseInput(), q(P2, SUNDAY))).toEqual([]);
  });

  it("sin sede principal → locationId null", () => {
    const slots = publicDaySlots(baseInput({ primaryLocationId: null }), q(P2));
    expect(slots[0].locationId).toBeNull();
  });

  it("filtro por sede: P1 no atiende en la sede A", () => {
    expect(publicDaySlots(baseInput(), q(P1, MONDAY, { locationId: LOC_A }))).toEqual([]);
    expect(publicDaySlots(baseInput(), q(P1, MONDAY, { locationId: LOC_B }))).toHaveLength(5);
  });

  it("excepción CUSTOM_HOURS abre un domingo", () => {
    const input = baseInput({
      exceptions: [
        {
          id: "ex1",
          practitionerId: P1,
          date: SUNDAY,
          kind: "CUSTOM_HOURS",
          ranges: [{ startMin: 10 * 60, endMin: 12 * 60, locationId: LOC_A }],
          reason: "Jornada",
        },
      ],
    });
    const slots = publicDaySlots(input, q(P1, SUNDAY));
    expect(slots.map((s) => s.time)).toEqual(["10:00", "10:45"]);
    expect(slots[0].locationId).toBe(LOC_A);
  });

  it("excepción CLOSED cierra el día", () => {
    const input = baseInput({
      exceptions: [{ id: "ex2", practitionerId: null, date: MONDAY, kind: "CLOSED", ranges: null, reason: "Feriado" }],
    });
    expect(publicDaySlots(input, q(P1))).toEqual([]);
    expect(publicDaySlots(input, q(P2))).toEqual([]);
  });

  it("bloqueo duro: el día bloqueado no ofrece nada; uno parcial saca los slots que pisa", () => {
    const allDay = baseInput({
      blocks: [
        {
          id: "b1",
          practitionerId: null,
          locationId: null,
          startsAt: at(MONDAY, "00:00"),
          endsAt: at("2026-10-06", "00:00"),
          allDay: true,
          reason: "Feriado",
          groupId: null,
        },
      ],
    });
    expect(publicDaySlots(allDay, q(P1))).toEqual([]);
    const partial = baseInput({
      blocks: [
        {
          id: "b2",
          practitionerId: P1,
          locationId: null,
          startsAt: at(MONDAY, "15:00"),
          endsAt: at(MONDAY, "16:00"),
          allDay: false,
          reason: null,
          groupId: null,
        },
      ],
    });
    const slots = publicDaySlots(partial, q(P1));
    // 14:00-15:00 (un slot de 45) + franja 16:00-18:00 anclada a las 16:00.
    expect(slots.map((s) => s.time)).toEqual(["14:00", "16:00", "16:45"]);
    // El instante 14:45 (pisa el bloqueo) no está en la grilla → el submit lo rechaza.
    expect(checkPublicSlot(at(MONDAY, "14:45"), slots)).toBe("off-grid");
  });

  it("servicio PRIVATE o deshabilitado para el profesional → no se ofrece", () => {
    const priv = baseInput({ practitionerServices: [psRule({ practitionerId: P1, visibility: "PRIVATE" })] });
    expect(resolvePublicOffer(priv, P1, S)).toBeNull();
    expect(publicDaySlots(priv, q(P1))).toEqual([]);
    const off = baseInput({ practitionerServices: [psRule({ practitionerId: P2, enabled: false })] });
    expect(publicDaySlots(off, q(P2))).toEqual([]);
    // El otro profesional sigue ofreciéndolo (sin fila = default habilitado).
    expect(publicDaySlots(off, q(P1))).toHaveLength(5);
  });

  it("servicio de OTRO profesional sin fila PS → no se ofrece (default de Configuración)", () => {
    const owned = baseInput({ services: [{ id: S, durationMin: 45, maxConcurrent: 1, practitionerId: P1 }] });
    expect(publicDaySlots(owned, q(P2))).toEqual([]);
    expect(publicDaySlots(owned, q(P1))).toHaveLength(5);
  });

  it("override de duración, anticipación y horizonte del PractitionerService", () => {
    const input = baseInput({
      practitionerServices: [psRule({ practitionerId: P1, durationMin: 90, minLeadMinutes: 0, maxLeadDays: 2 })],
    });
    expect(resolvePublicOffer(input, P1, S)).toMatchObject({ durationMin: 90, minLeadMinutes: 0, maxLeadDays: 2 });
    // 14-18 con 90 min y paso 45: 14:00, 14:45, 15:30, 16:15 (17:00+90 > 18:00).
    const far = publicDaySlots(input, q(P1));
    expect(far.map((s) => s.time)).toEqual(["14:00", "14:45", "15:30", "16:15"]);
    // Lunes queda a más de 2 días del viernes 09:00 AR → fuera de horizonte.
    expect(far.every((s) => !s.available)).toBe(true);
    // Mismo lunes 13:50 AR: anticipación 0 → 14:00 disponible (con 60 por defecto, no).
    const nowMon = new Date(at(MONDAY, "13:50"));
    expect(publicDaySlots(input, q(P1, MONDAY, { now: nowMon }))[0].available).toBe(true);
    expect(publicDaySlots(baseInput(), q(P1, MONDAY, { now: nowMon }))[0].available).toBe(false);
  });

  it("cupo profesional + servicio con isHoldingCapacity", () => {
    const b = (pid: string, hhmm: string): AvailabilityBooking => ({
      id: `bk-${pid}-${hhmm}`,
      scheduledFor: at(MONDAY, hhmm),
      durationMin: 45,
      status: "CONFIRMED",
      paymentStatus: "PAID",
      createdAt: NOW,
      patientId: "pp",
      idempotencyKey: "k",
      practitionerId: pid,
      serviceId: S,
      locationId: LOC_B,
    });
    const input = baseInput({ bookings: [b(P1, "14:00"), b(P2, "14:45")] });
    const slots = publicDaySlots(input, q(P1));
    expect(slots.find((s) => s.time === "14:00")!.available).toBe(false);
    // El turno de OTRO profesional no ocupa el cupo de P1.
    expect(slots.find((s) => s.time === "14:45")!.available).toBe(true);
  });

  it("profesional fuera del input o día inválido → []", () => {
    expect(publicDaySlots(baseInput(), q("ajeno"))).toEqual([]);
    expect(publicDaySlots(baseInput(), q(P1, "2026-02-30"))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cualquier profesional
// ─────────────────────────────────────────────────────────────────────────────
describe("firstPublicSlotAcross (B3.2)", () => {
  const base = { serviceId: S, practitionerIds: [P1, P2], fromDay: MONDAY, now: NOW };

  it("el hueco más temprano entre los elegibles (P2 a las 08:00 gana a P1 a las 14:00)", () => {
    expect(firstPublicSlotAcross(baseInput(), base)).toEqual({
      practitionerId: P2,
      iso: at(MONDAY, "08:00").toISOString(),
      time: "08:00",
      date: MONDAY,
      durationMin: 45,
      locationId: LOC_A,
    });
  });

  it("respeta PRIVATE y cobertura (PractitionerPayer inactivo)", () => {
    const input = baseInput({
      practitionerServices: [psRule({ practitionerId: P2, visibility: "PRIVATE" })],
    });
    expect(firstPublicSlotAcross(input, base)!.practitionerId).toBe(P1);
    const noOsde = baseInput({ practitionerPayers: [{ practitionerId: P2, insurerId: "osde", active: false }] });
    expect(firstPublicSlotAcross(noOsde, { ...base, insurerId: "osde" })!.practitionerId).toBe(P1);
    expect(firstPublicSlotAcross(noOsde, { ...base, insurerId: "ioma" })!.practitionerId).toBe(P2);
  });

  it("saltea días bloqueados y devuelve el siguiente día con lugar", () => {
    const input = baseInput({
      templates: [{ practitionerId: P1, isFallback: false, ranges: [tpl(1, 14 * 60, 18 * 60, LOC_B)] }],
      blocks: [
        {
          id: "b1",
          practitionerId: null,
          locationId: null,
          startsAt: at(MONDAY, "00:00"),
          endsAt: at("2026-10-06", "00:00"),
          allDay: true,
          reason: "Feriado",
          groupId: null,
        },
      ],
    });
    const r = firstPublicSlotAcross(input, { ...base, practitionerIds: [P1] });
    expect(r).toMatchObject({ practitionerId: P1, date: "2026-10-12", time: "14:00" });
  });

  it("nadie elegible → null", () => {
    const input = baseInput({
      practitionerServices: [
        psRule({ practitionerId: P1, enabled: false }),
        psRule({ practitionerId: P2, visibility: "PRIVATE" }),
      ],
    });
    expect(firstPublicSlotAcross(input, base)).toBeNull();
  });
});
