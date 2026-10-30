/**
 * [CF-P] lado puro del turnero con las reglas de agenda (CF, M20; decisiones 1, 2 y 6; CF-D7/D8/D9):
 * `resolvePublicOffer` (paso y anticipación con su precedencia, `exclusiveService`), la grilla con `otro-servicio`
 * (duro, el día sigue siendo hábil) y los días de anticipación que usan `listPublicSlotWindow` / `findFirstPublicSlot`.
 *
 * Un input sin `agendaRules` / `publicMinLeadMinutes` (los oráculos de antes de M20) tiene que dar la oferta de siempre:
 * eso fija el carve-out. Corre igual en TZ=UTC y AR: los días salen de `lib/datetime-ar.ts`.
 */
import { describe, expect, it } from "vitest";
import { localToARIso } from "@/lib/datetime-ar";
import {
  checkPublicSlot,
  earliestPublicLeadDay,
  publicDaySlots,
  publicLeadDay,
  publicSlotWindow,
  resolvePublicOffer,
} from "@/lib/public-booking-slots";
import type {
  AvailabilityBooking,
  AvailabilityInput,
  PractitionerAgendaRules,
  PractitionerServiceRule,
  ScheduleTemplateRange,
} from "@/lib/availability";

const P1 = "prac-1";
const P2 = "prac-2";
const S = "svc-kine";
const OTHER = "svc-eval";
const LOC = "loc-a";
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));
/** Lunes 19-oct-2026 07:00 AR. */
const NOW = at("2026-10-19", "07:00");
const DAY = "2026-10-21"; // miércoles

const tpl = (dow: number): ScheduleTemplateRange => ({
  dow: dow as ScheduleTemplateRange["dow"],
  startMin: 9 * 60,
  endMin: 12 * 60,
  locationId: LOC,
  validFrom: null,
  validUntil: null,
});

const rules = (patch: Partial<PractitionerAgendaRules> = {}): PractitionerAgendaRules => ({
  exclusiveService: true,
  agendaStepMin: 15,
  publicStepMin: null,
  ...patch,
});

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

/** P1 (y P2) atienden todos los días 09:00-12:00; dos servicios de 60' del consultorio, cupo ilimitado. */
function input(patch: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    tenantId: "t1",
    from: "2026-10-19",
    to: "2027-01-31",
    primaryLocationId: LOC,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [P1, P2].map((practitionerId) => ({
      practitionerId,
      isFallback: false,
      ranges: [0, 1, 2, 3, 4, 5, 6].map(tpl),
    })),
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [
      { id: S, durationMin: 60, maxConcurrent: null, practitionerId: null },
      { id: OTHER, durationMin: 60, maxConcurrent: null, practitionerId: null },
    ],
    practitionerPayers: [],
    ...patch,
  };
}

let seq = 0;
function booked(serviceId: string, day: string, hhmm: string, durationMin = 60): AvailabilityBooking {
  return {
    id: `b-${seq++}`,
    practitionerId: P1,
    serviceId,
    locationId: LOC,
    scheduledFor: at(day, hhmm),
    durationMin,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: "pat",
    idempotencyKey: `k-${seq}`,
  };
}

describe("[CF-P] resolvePublicOffer: paso, anticipación y regla de servicio", () => {
  it("sin reglas cargadas = la oferta de antes de M20 (paso automático, 60', sin exclusividad)", () => {
    expect(resolvePublicOffer(input(), P1, S)).toMatchObject({ stepMin: 60, minLeadMinutes: 60, exclusiveService: false });
  });

  it("[CF-P2] paso: profesional > consultorio (ya resuelto en agendaRules) > automático", () => {
    expect(resolvePublicOffer(input({ agendaRules: { [P1]: rules() } }), P1, S)?.stepMin).toBe(60);
    expect(resolvePublicOffer(input({ agendaRules: { [P1]: rules({ publicStepMin: 30 }) } }), P1, S)?.stepMin).toBe(30);
  });

  it("[CF-P3] anticipación: PS > consultorio > 60, y el 0 del PS es un valor", () => {
    const lead = (psLead: number | null, tenantLead: number | null) =>
      resolvePublicOffer(
        input({ practitionerServices: [rule({ minLeadMinutes: psLead })], publicMinLeadMinutes: tenantLead }),
        P1,
        S
      )?.minLeadMinutes;
    expect(lead(null, null)).toBe(60);
    expect(lead(null, 2880)).toBe(2880);
    expect(lead(120, 2880)).toBe(120);
    expect(lead(0, 2880)).toBe(0);
  });

  it("exclusiveService sale de agendaRules[pid] (por profesional, no hereda)", () => {
    const i = input({ agendaRules: { [P1]: rules(), [P2]: rules({ exclusiveService: false }) } });
    expect(resolvePublicOffer(i, P1, S)?.exclusiveService).toBe(true);
    expect(resolvePublicOffer(i, P2, S)?.exclusiveService).toBe(false);
  });
});

describe("[CF-P1] grilla: otro servicio pisado es duro", () => {
  it("con la regla, el horario pisado por otro servicio sale no disponible y el submit lo rechaza; sin la regla se ofrece", () => {
    const bookings = [booked(OTHER, DAY, "10:00"), booked(S, DAY, "11:00")];
    const strict = input({ bookings, agendaRules: { [P1]: rules() } });
    const slots = publicDaySlots(strict, { practitionerId: P1, serviceId: S, dayKey: DAY, now: NOW });
    expect(slots.map((s) => [s.time, s.available])).toEqual([
      ["09:00", true],
      ["10:00", false],
      ["11:00", true], // mismo servicio: solo el cupo (ilimitado)
    ]);
    expect(checkPublicSlot(at(DAY, "10:00"), slots)).toBe("unavailable");

    const relaxed = input({ bookings, agendaRules: { [P1]: rules({ exclusiveService: false }) } });
    const open = publicDaySlots(relaxed, { practitionerId: P1, serviceId: S, dayKey: DAY, now: NOW });
    expect(checkPublicSlot(at(DAY, "10:00"), open)).toBe("ok");
  });

  it("un día ocupado entero por otro servicio es hábil: «Completo», no se salta", () => {
    const i = input({ bookings: [booked(OTHER, DAY, "09:00", 180)], agendaRules: { [P1]: rules() } });
    const w = publicSlotWindow(i, { practitionerId: P1, serviceId: S, fromDay: DAY, lastDay: "2026-11-20", now: NOW });
    expect(w.days[0]).toEqual({ date: DAY, status: "full", slots: [] });
    expect(w.days.slice(1).every((d) => d.status === "open")).toBe(true);
  });
});

describe("[CF-P3] días de anticipación y copy", () => {
  it("publicLeadDay = el día AR de now + anticipación (no el del host)", () => {
    expect(publicLeadDay({ minLeadMinutes: 60 }, NOW)).toBe("2026-10-19");
    expect(publicLeadDay({ minLeadMinutes: 0 }, at("2026-10-19", "23:30"))).toBe("2026-10-19");
    // 23:30 AR + 60' = el día siguiente (en UTC ya era el 20 desde las 21:00 AR).
    expect(publicLeadDay({ minLeadMinutes: 60 }, at("2026-10-19", "23:30"))).toBe("2026-10-20");
    expect(publicLeadDay({ minLeadMinutes: 14 * 1440 }, NOW)).toBe("2026-11-02");
  });

  it("earliestPublicLeadDay: el más temprano entre las ofertas (cada una con su PS > consultorio)", () => {
    const i = input({
      publicMinLeadMinutes: 21 * 1440,
      practitionerServices: [rule({ practitionerId: P2, minLeadMinutes: 7 * 1440 })],
    });
    expect(earliestPublicLeadDay(i, { serviceId: S, practitionerIds: [P1, P2], now: NOW })).toBe("2026-10-26");
    expect(earliestPublicLeadDay(i, { serviceId: S, practitionerIds: [P1], now: NOW })).toBe("2026-11-09");
    expect(earliestPublicLeadDay(i, { serviceId: "nope", practitionerIds: [P1, P2], now: NOW })).toBeNull();
  });

  it("la ventana devuelve la anticipación efectiva (CF-D9) y nada antes de ella", () => {
    const i = input({ publicMinLeadMinutes: 2 * 1440 });
    const w = publicSlotWindow(i, { practitionerId: P1, serviceId: S, fromDay: "2026-10-19", lastDay: "2026-11-29", now: NOW });
    expect(w.minLeadMinutes).toBe(2880);
    expect(w.days[0].date).toBe("2026-10-21");
    expect(w.days[0].slots.map((s) => s.time)).toEqual(["09:00", "10:00", "11:00"]);
  });
});
