import { describe, it, expect } from "vitest";
import { denseOverflow, isPastUnclosed, overflowButtonText, visibleSlotWindow } from "@/lib/agenda-slot-helpers";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/** [PF1.1-agenda-a] Lógica pura de las vistas de la agenda (G3, G5). */

const hours = (from: number, to: number, step = 60) => {
  const out: number[] = [];
  for (let m = from * 60; m < to * 60; m += step) out.push(m);
  return out;
};

describe("[PF1.1-agenda-a] visibleSlotWindow (G3)", () => {
  const slots = hours(8, 22); // 08:00 … 21:00

  it("sin turnos → el horario entero", () => {
    expect(visibleSlotWindow(slots, [], 60)).toEqual({ from: 0, to: slots.length - 1 });
  });

  it("turnos 09-10 → 08:00 … 11:00 (± 1 h, contando el fin de la franja)", () => {
    const w = visibleSlotWindow(slots, [9 * 60, 10 * 60], 60);
    expect(slots[w.from]).toBe(8 * 60);
    expect(slots[w.to]).toBe(11 * 60);
  });

  it("turno de tarde → pliega la mañana y la noche", () => {
    const w = visibleSlotWindow(slots, [15 * 60], 60);
    expect(slots[w.from]).toBe(14 * 60);
    expect(slots[w.to]).toBe(16 * 60);
  });

  it("no pliega una sola fila (no vale el botón)", () => {
    const w = visibleSlotWindow(slots, [9 * 60 + 0, 20 * 60], 60);
    expect(w).toEqual({ from: 0, to: slots.length - 1 });
  });

  it("franjas de 30 min", () => {
    const half = hours(8, 20, 30);
    const w = visibleSlotWindow(half, [12 * 60 + 30], 30);
    expect(half[w.from]).toBe(11 * 60 + 30);
    expect(half[w.to]).toBe(13 * 60 + 30);
  });
});

describe("[PF1.1-agenda-a] isPastUnclosed (G5)", () => {
  const at = (h: string) => new Date(`2026-10-05T${h}:00-03:00`).toISOString();
  const now = new Date("2026-10-05T12:00:00-03:00");

  it("Confirmado o Pendiente que ya terminó → sin cerrar", () => {
    expect(isPastUnclosed({ status: "CONFIRMED", scheduledFor: at("09:00"), durationMin: 45 }, now)).toBe(true);
    expect(isPastUnclosed({ status: "PENDING", scheduledFor: at("11:15"), durationMin: 45 }, now)).toBe(true);
  });

  it("en curso, por venir, Atendido, Ausente o Cancelado → no", () => {
    expect(isPastUnclosed({ status: "CONFIRMED", scheduledFor: at("11:30"), durationMin: 45 }, now)).toBe(false);
    expect(isPastUnclosed({ status: "CONFIRMED", scheduledFor: at("15:00"), durationMin: 45 }, now)).toBe(false);
    for (const status of ["COMPLETED", "NO_SHOW", "CANCELLED"]) {
      expect(isPastUnclosed({ status, scheduledFor: at("09:00"), durationMin: 45 }, now)).toBe(false);
    }
  });
});

// [HF-2a] Un paciente en sala no puede quedar escondido detrás del «+N más» (H-LL2).
describe("[HF-2a] denseOverflow con los que esperan", () => {
  const at = (h: string) => new Date(`2026-10-18T${h}:00-03:00`).toISOString();
  const now = new Date("2026-10-18T10:20:00-03:00");
  const mk = (id: string, extra: Partial<BookingDTO> = {}): BookingDTO =>
    ({
      id,
      scheduledFor: at("10:00"),
      durationMin: 30,
      status: "CONFIRMED",
      serviceId: "s1",
      serviceName: "Kine",
      serviceColor: null,
      practitionerId: "p1",
      patientId: "pat",
      patientName: id,
      patientCondition: null,
      obraSocial: "Particular",
      copagoCents: 0,
      updatedAt: at("08:00"),
      notes: null,
      title: null,
      description: null,
      patientAccess: "full",
      ...extra,
    }) as BookingDTO;

  it("[HF-2a] denseOverflow promueve los en sala y cuenta los ocultos", () => {
    const list = [mk("a"), mk("b"), mk("c"), mk("s1", { arrivedAt: at("10:08") }), mk("s2", { arrivedAt: at("10:02") })];
    const o = denseOverflow(list, 2, false, null, now);
    expect(o.shown.map((b) => b.id)).toEqual(["s1", "s2"]);
    expect(o.hidden).toBe(3);
    expect(o.hiddenWaiting).toBe(0);
    // Con tope 1, uno de los que esperan queda oculto y se cuenta.
    const o1 = denseOverflow(list, 1, false, null, now);
    expect(o1.shown.map((b) => b.id)).toEqual(["s1"]);
    expect(o1.hiddenWaiting).toBe(1);
    expect(overflowButtonText(o1, false, "a las 10:00").text).toBe("+4 más · 1 en sala");
    expect(overflowButtonText(o1, false, "a las 10:00").ariaLabel).toContain("1 en sala de espera");
    // Sin `now` (callers viejos): orden y conteo de siempre.
    const legacy = denseOverflow(list, 2, false, null);
    expect(legacy.shown.map((b) => b.id)).toEqual(["a", "b"]);
    expect(legacy.hiddenWaiting).toBe(0);
    // Con resaltado: primero los resaltados, después los que esperan.
    const hl = { kind: "service", serviceId: "s9" } as const;
    const withHl = [mk("a"), mk("x", { serviceId: "s9" }), mk("s1", { arrivedAt: at("10:08") }), mk("b")];
    const oh = denseOverflow(withHl, 3, false, hl as never, now);
    expect(oh.shown.map((b) => b.id)).toEqual(["x", "s1", "a"]);
  });
});
