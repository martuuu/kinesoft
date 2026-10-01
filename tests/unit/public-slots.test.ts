/**
 * `buildPublicSlots` / `checkPublicSlot` (A2b-S-pub): la grilla del turnero
 * público y la validación del submit. Pura; corre en TZ=UTC y TZ=AR y tiene que
 * dar lo mismo (el instante de cada slot es la hora de pared AR, UTC−3).
 */
import { describe, expect, it } from "vitest";
import {
  PUBLIC_SLOT_STEP_MIN,
  arDayWindow,
  buildPublicSlots,
  checkPublicSlot,
  type PublicSlotBooking,
} from "@/lib/public-booking-slots";

// 2026-10-05 es lunes; 2026-10-04, domingo.
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";
// "Ahora" = el viernes anterior: nada del lunes cae dentro de la hora de anticipación.
const FRIDAY = new Date("2026-10-02T12:00:00.000Z");

const base = {
  date: MONDAY,
  openHour: 8,
  closeHour: 19,
  durationMin: 45,
  maxConcurrent: 1 as number | null,
  existing: [] as PublicSlotBooking[],
  now: FRIDAY,
};

function booking(iso: string, extra: Partial<PublicSlotBooking> = {}): PublicSlotBooking {
  return {
    scheduledFor: new Date(iso),
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: "p1",
    // Formato de la reserva pública (discriminante de isHoldingCapacity).
    idempotencyKey: "pub:t1:0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10",
    ...extra,
  };
}

describe("arDayWindow", () => {
  it("ancla el día a la medianoche AR (03:00 UTC), 24 h exactas", () => {
    const w = arDayWindow(MONDAY)!;
    expect(w.dayStart.toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(w.dayEnd.toISOString()).toBe("2026-10-06T03:00:00.000Z");
  });
  it("rechaza una fecha mal formada", () => {
    expect(arDayWindow("2026-10-5")).toBeNull();
    expect(arDayWindow("nope")).toBeNull();
  });
});

describe("buildPublicSlots", () => {
  it("arma la grilla en hora de pared AR, cada 45 min, sin pasarse del cierre", () => {
    const slots = buildPublicSlots(base);
    expect(slots[0]).toEqual({ iso: "2026-10-05T11:00:00.000Z", time: "08:00", available: true });
    expect(slots[1].time).toBe("08:45");
    // 08:00 + 45·14 = 18:30 → termina 19:15 > 19:00: el último es 17:45.
    expect(slots.at(-1)!.time).toBe("17:45");
    expect(slots).toHaveLength(14);
    expect(PUBLIC_SLOT_STEP_MIN).toBe(45);
  });

  it("usa el horario por defecto (8-19) si el tenant no lo configuró", () => {
    const slots = buildPublicSlots({ ...base, openHour: null, closeHour: undefined });
    expect(slots[0].time).toBe("08:00");
    expect(slots.at(-1)!.time).toBe("17:45");
  });

  it("domingo → cerrado", () => {
    expect(buildPublicSlots({ ...base, date: SUNDAY })).toEqual([]);
  });

  it("anticipación de 1 h: lo que arranca antes de now+1h no está disponible", () => {
    // Lunes 09:30 AR = 12:30 UTC. 10:15 AR arranca a 45 min → no; 11:00 AR a 90 min → sí.
    const now = new Date("2026-10-05T12:30:00.000Z");
    const slots = buildPublicSlots({ ...base, now });
    const at = (t: string) => slots.find((s) => s.time === t)!;
    expect(at("08:00").available).toBe(false);
    expect(at("10:15").available).toBe(false);
    expect(at("11:00").available).toBe(true);
  });

  it("cupo 1: un turno que solapa bloquea el slot; ilimitado nunca bloquea", () => {
    const existing = [booking("2026-10-05T11:00:00.000Z")]; // 08:00 AR
    const full = buildPublicSlots({ ...base, existing });
    expect(full.find((s) => s.time === "08:00")!.available).toBe(false);
    expect(full.find((s) => s.time === "08:45")!.available).toBe(true);
    const unlimited = buildPublicSlots({ ...base, existing, maxConcurrent: null });
    expect(unlimited.find((s) => s.time === "08:00")!.available).toBe(true);
  });

  it("una reserva pública impaga de más de 30 min deja de bloquear (isHoldingCapacity)", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const pendingOld = booking("2026-10-05T11:00:00.000Z", {
      status: "PENDING",
      paymentStatus: "UNPAID",
      createdAt: new Date(now.getTime() - 31 * 60_000),
    });
    const pendingFresh = { ...pendingOld, createdAt: new Date(now.getTime() - 10 * 60_000) };
    const at8 = (existing: PublicSlotBooking[]) =>
      buildPublicSlots({ ...base, now, existing }).find((s) => s.time === "08:00")!.available;
    expect(at8([pendingOld])).toBe(true);
    expect(at8([pendingFresh])).toBe(false);
    // Un guest (sin paciente) cargado por la recepción nunca vence.
    expect(at8([{ ...pendingOld, patientId: null }])).toBe(false);
    // Revisión A2: un turno de la AGENDA con paciente en PENDING/UNPAID (guest
    // al que se le asignó paciente) tampoco vence: no tiene key pública.
    expect(at8([{ ...pendingOld, idempotencyKey: "0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10" }])).toBe(false);
  });
});

describe("checkPublicSlot", () => {
  const slots = buildPublicSlots({
    ...base,
    existing: [booking("2026-10-05T11:45:00.000Z")], // 08:45 AR ocupado
  });
  it("ok para un slot exacto y libre", () => {
    expect(checkPublicSlot(new Date("2026-10-05T11:00:00.000Z"), slots)).toBe("ok");
  });
  it("unavailable si es de la grilla pero está lleno", () => {
    expect(checkPublicSlot(new Date("2026-10-05T11:45:00.000Z"), slots)).toBe("unavailable");
  });
  it("off-grid si no está alineado, está fuera de horario o es otro día", () => {
    expect(checkPublicSlot(new Date("2026-10-05T11:07:00.000Z"), slots)).toBe("off-grid");
    expect(checkPublicSlot(new Date("2026-10-05T06:00:00.000Z"), slots)).toBe("off-grid"); // 03:00 AR
    expect(checkPublicSlot(new Date("2026-10-05T22:00:00.000Z"), slots)).toBe("off-grid"); // 19:00 AR
  });
});
