import { describe, it, expect } from "vitest";
import { isPastUnclosed, visibleSlotWindow } from "@/lib/agenda-slot-helpers";

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
