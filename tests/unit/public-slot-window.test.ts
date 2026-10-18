/**
 * TP-1 (plan §22.5, decisión TP-D2 de Martin): ventana de 5 días HÁBILES del turnero, lado puro
 * (`publicSlotWindow` de `lib/public-booking-slots.ts`).
 *
 * Día hábil = el profesional atiende (franjas efectivas después de excepciones y bloqueos de día completo) y todavía
 * tiene horarios por delante desde ahora + la anticipación mínima. Un hábil sin libres es `full` («Completo»); si los 5
 * primeros están completos la ventana avanza sola (`skippedFrom`). Se recorre con el MISMO motor que la lista de un día
 * y el submit (`publicDaySlots` / `checkPublicSlot`): la paridad se afirma acá contra esas funciones reales.
 *
 * Corre igual en TZ=UTC y TZ=America/Argentina/Buenos_Aires: el «ahora» es un instante UTC y los días salen de
 * `lib/datetime-ar.ts`, nunca del host.
 */
import { describe, expect, it } from "vitest";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { addDays } from "@/lib/availability/day";
import {
  PUBLIC_MAX_AHEAD_DAYS,
  PUBLIC_WINDOW_DAYS,
  PUBLIC_WINDOW_SCAN_DAYS,
  checkPublicSlot,
  firstPublicSlotAcross,
  publicDaySlots,
  publicSlotWindow,
} from "@/lib/public-booking-slots";
import type {
  AvailabilityBooking,
  AvailabilityInput,
  PractitionerServiceRule,
  ScheduleTemplateRange,
} from "@/lib/availability";

const P1 = "prac-1";
const S = "svc-1";
const LOC = "loc-a";
/** Sábado 17-oct-2026 22:30 AR (= domingo 18 01:30 UTC): el ejemplo de Martin. */
const SAT_NIGHT = new Date(localToARIso("2026-10-17T22:30:00"));
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

function tpl(dow: number, startMin: number, endMin: number): ScheduleTemplateRange {
  return { dow: dow as ScheduleTemplateRange["dow"], startMin, endMin, locationId: LOC, validFrom: null, validUntil: null };
}

function rule(patch: Partial<PractitionerServiceRule> = {}): PractitionerServiceRule {
  return {
    practitionerId: P1,
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

/** P1 atiende lun-vie 09:00-12:00 (slots 09:00, 09:45, 10:30, 11:15 con 45 min), cupo 1. */
function baseInput(patch: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    tenantId: "t1",
    from: "2026-10-17",
    to: "2027-01-31",
    primaryLocationId: LOC,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [{ practitionerId: P1, isFallback: false, ranges: [1, 2, 3, 4, 5].map((d) => tpl(d, 9 * 60, 12 * 60)) }],
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [{ id: S, durationMin: 45, maxConcurrent: 1, practitionerId: null }],
    practitionerPayers: [],
    ...patch,
  };
}

let seq = 0;
/** Turno CONFIRMED que retiene cupo en ese instante. */
function booked(day: string, hhmm: string): AvailabilityBooking {
  return {
    id: `b-${seq++}`,
    practitionerId: P1,
    serviceId: S,
    locationId: LOC,
    scheduledFor: at(day, hhmm),
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: "pat",
    idempotencyKey: `k-${seq}`,
  };
}
const fillDay = (day: string) => ["09:00", "09:45", "10:30", "11:15"].map((t) => booked(day, t));

function windowOf(input: AvailabilityInput, opts: { now?: Date; fromDay?: string; lastDay?: string } = {}) {
  const now = opts.now ?? SAT_NIGHT;
  const fromDay = opts.fromDay ?? toARDateKey(now);
  return publicSlotWindow(input, {
    practitionerId: P1,
    serviceId: S,
    fromDay,
    lastDay: opts.lastDay ?? addDays(fromDay, PUBLIC_WINDOW_SCAN_DAYS - 1),
    now,
  });
}

describe("publicSlotWindow (TP-1)", () => {
  it("constantes del plan", () => {
    expect([PUBLIC_WINDOW_DAYS, PUBLIC_WINDOW_SCAN_DAYS, PUBLIC_MAX_AHEAD_DAYS]).toEqual([5, 42, 90]);
  });

  it("[TP-1] sábado 17-oct 22:30 AR en TZ=UTC → lun 19..vie 23", () => {
    // El día AR del «ahora» es el sábado aunque el host (UTC) ya esté en el domingo 18.
    expect(toARDateKey(SAT_NIGHT)).toBe("2026-10-17");
    const w = windowOf(baseInput());
    expect(w.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(w.days.every((d) => d.status === "open" && d.slots.length === 4)).toBe(true);
    expect(w.days[0].slots.map((s) => s.time)).toEqual(["09:00", "09:45", "10:30", "11:15"]);
    expect(w).toMatchObject({ nextFrom: "2026-10-24", reachedEnd: false, skippedFrom: null });
  });

  it("[TP-1] hoy con horarios ya pasados o dentro de la anticipación: hábil solo si queda alguno por delante", () => {
    // Lunes 19 a las 10:00: 09:00/09:45 pasaron, 10:30 cae dentro de la hora de anticipación, 11:15 sigue.
    const w = windowOf(baseInput(), { now: at("2026-10-19", "10:00") });
    expect(w.days[0]).toMatchObject({ date: "2026-10-19", status: "open" });
    expect(w.days[0].slots.map((s) => s.time)).toEqual(["11:15"]);
    // A las 10:30 ya no queda nada por delante: el lunes no es hábil y la ventana arranca el martes.
    const late = windowOf(baseInput(), { now: at("2026-10-19", "10:30") });
    expect(late.days.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26"]);
  });

  it("[TP-1] excepción CLOSED y bloqueo de día completo sacan el día; uno parcial lo deja hábil", () => {
    const input = baseInput({
      exceptions: [{ id: "ex", practitionerId: null, date: "2026-10-20", kind: "CLOSED", ranges: null, reason: "Feriado" }],
      blocks: [
        {
          id: "b-all",
          practitionerId: P1,
          locationId: null,
          startsAt: at("2026-10-21", "00:00"),
          endsAt: at("2026-10-22", "00:00"),
          allDay: true,
          reason: "Congreso",
          groupId: null,
        },
        {
          id: "b-part",
          practitionerId: P1,
          locationId: null,
          startsAt: at("2026-10-22", "09:00"),
          endsAt: at("2026-10-22", "10:30"),
          allDay: false,
          reason: "Trámite",
          groupId: null,
        },
      ],
    });
    const w = windowOf(input);
    expect(w.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"]);
    expect(w.days[1].slots.map((s) => s.time)).toEqual(["10:30", "11:15"]);
  });

  it("[TP-1] día lleno → full; 5 llenos → avanza y skippedFrom", () => {
    const one = windowOf(baseInput({ bookings: fillDay("2026-10-20") }));
    expect(one.days[1]).toEqual({ date: "2026-10-20", status: "full", slots: [] });
    expect(one.skippedFrom).toBeNull();

    const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
    const all = windowOf(baseInput({ bookings: week.flatMap(fillDay) }));
    expect(all.days.map((d) => d.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(all.days.every((d) => d.status === "open")).toBe(true);
    expect(all).toMatchObject({ skippedFrom: "2026-10-17", nextFrom: "2026-10-31", reachedEnd: false });

    // Si la siguiente tanda tiene al menos un día libre, se muestra con sus «Completo».
    const mixed = windowOf(baseInput({ bookings: [...week, "2026-10-26", "2026-10-27"].flatMap(fillDay) }));
    expect(mixed.days.map((d) => [d.date, d.status])).toEqual([
      ["2026-10-26", "full"],
      ["2026-10-27", "full"],
      ["2026-10-28", "open"],
      ["2026-10-29", "open"],
      ["2026-10-30", "open"],
    ]);
    expect(mixed.skippedFrom).toBe("2026-10-17");
  });

  it("[TP-1] sin ningún libre en toda la búsqueda: la primera tanda, toda «Completo», sin avanzar", () => {
    const days = Array.from({ length: PUBLIC_WINDOW_SCAN_DAYS + 2 }, (_, i) => addDays("2026-10-17", i));
    const w = windowOf(baseInput({ bookings: days.flatMap(fillDay) }));
    expect(w.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(w.days.every((d) => d.status === "full")).toBe(true);
    expect(w).toMatchObject({ skippedFrom: null, nextFrom: "2026-10-24", reachedEnd: false });
  });

  it("[TP-1] todo slot de la ventana es ok en checkPublicSlot(publicDaySlots(día))", () => {
    const input = baseInput({
      bookings: [...fillDay("2026-10-21"), booked("2026-10-22", "09:45")],
      practitionerServices: [rule({ minLeadMinutes: 0 })],
    });
    for (const now of [SAT_NIGHT, at("2026-10-19", "09:10"), at("2026-10-22", "09:00")]) {
      const w = windowOf(input, { now });
      expect(w.days.length).toBe(PUBLIC_WINDOW_DAYS);
      for (const day of w.days) {
        const grid = publicDaySlots(input, { practitionerId: P1, serviceId: S, dayKey: day.date, now });
        expect(day.slots).toEqual(grid.filter((s) => s.available));
        for (const s of day.slots) expect(checkPublicSlot(new Date(s.iso), grid)).toBe("ok");
        expect(day.status).toBe(day.slots.length > 0 ? "open" : "full");
      }
    }
  });

  it("[TP-1] primer libre de la ventana = firstPublicSlotAcross([pid])", () => {
    const cases: Array<{ now: Date; bookings: AvailabilityBooking[] }> = [
      { now: SAT_NIGHT, bookings: [] },
      { now: SAT_NIGHT, bookings: [...fillDay("2026-10-19"), booked("2026-10-20", "09:00")] },
      { now: at("2026-10-21", "09:30"), bookings: [booked("2026-10-21", "11:15")] },
    ];
    for (const { now, bookings } of cases) {
      const input = baseInput({ bookings });
      const fromDay = toARDateKey(now);
      const first = windowOf(input, { now }).days.find((d) => d.status === "open")!.slots[0];
      const oracle = firstPublicSlotAcross(input, { serviceId: S, practitionerIds: [P1], fromDay, now });
      expect(oracle).not.toBeNull();
      expect(first.iso).toBe(oracle!.iso);
      expect(first.time).toBe(oracle!.time);
    }
  });

  it("[TP-1] respeta maxLeadDays y tope 90; reachedEnd", () => {
    // maxLeadDays 3 desde el sábado 22:30 → hasta el martes 20 22:30: solo lun 19 y mar 20.
    const lead = windowOf(baseInput({ practitionerServices: [rule({ maxLeadDays: 3 })] }));
    expect(lead.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(lead).toMatchObject({ nextFrom: null, reachedEnd: true, skippedFrom: null });

    // Tope de 90 días desde hoy aunque el caller pida más allá.
    const today = toARDateKey(SAT_NIGHT);
    const cap = addDays(today, PUBLIC_MAX_AHEAD_DAYS); // 2027-01-15, viernes
    expect(cap).toBe("2027-01-15");
    const near = windowOf(baseInput(), { fromDay: addDays(cap, -2), lastDay: addDays(cap, 30) });
    expect(near.days.map((d) => d.date)).toEqual(["2027-01-13", "2027-01-14", "2027-01-15"]);
    expect(near).toMatchObject({ nextFrom: null, reachedEnd: true });

    // Ventana completa que termina justo en el tope: no hay «Siguientes».
    const exact = windowOf(baseInput(), { fromDay: addDays(cap, -4), lastDay: addDays(cap, 30) });
    expect(exact.days.map((d) => d.date)).toEqual(["2027-01-11", "2027-01-12", "2027-01-13", "2027-01-14", "2027-01-15"]);
    expect(exact).toMatchObject({ nextFrom: null, reachedEnd: true });

    // Desde más allá del tope: ventana vacía.
    expect(windowOf(baseInput(), { fromDay: addDays(cap, 1) })).toEqual({
      days: [],
      nextFrom: null,
      reachedEnd: true,
      skippedFrom: null,
    });
  });

  it("[TP-1] la búsqueda de 6 semanas se corta en lastDay sin dar el final por alcanzado", () => {
    // Atiende solo los lunes: en 42 días hay 6 lunes, la ventana sale con 5 y sigue habiendo más.
    const mondays = baseInput({ templates: [{ practitionerId: P1, isFallback: false, ranges: [tpl(1, 9 * 60, 12 * 60)] }] });
    const w = windowOf(mondays);
    expect(w.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(w).toMatchObject({ nextFrom: "2026-11-17", reachedEnd: false });
    // Con una búsqueda corta (lastDay antes del tope) que no junta 5, sigue después de lastDay.
    const short = windowOf(mondays, { lastDay: "2026-11-03" });
    expect(short.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(short).toMatchObject({ nextFrom: "2026-11-04", reachedEnd: false });
  });

  it("[TP-1] servicio no ofrecido online o profesional sin franjas → ventana vacía", () => {
    const empty = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null };
    expect(windowOf(baseInput({ practitionerServices: [rule({ visibility: "PRIVATE" })] }))).toEqual(empty);
    expect(windowOf(baseInput({ templates: [] }))).toEqual(empty);
  });
});
