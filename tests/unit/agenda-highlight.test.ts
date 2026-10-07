import { describe, it, expect } from "vitest";
import {
  anyHighlightMatch,
  highlightState,
  matchesHighlight,
  sameHighlight,
  toggleHighlight,
  type AgendaHighlight,
  type HighlightableBooking,
} from "@/lib/agenda-highlight";

/**
 * [P3-C] `AgendaHighlight`: el resaltado de la leyenda (servicio, plan o
 * suelto) en un solo lugar. Lo de servicio tiene que dar EXACTAMENTE lo que
 * hacían las vistas con `highlightedServiceId` (rename mecánico, sin cambio
 * de conducta); plan/suelto no adivinan sin C9.
 */

const loose: HighlightableBooking = { serviceId: "s1", programId: null, plan: null };
const kine: HighlightableBooking = {
  serviceId: "s1",
  programId: "p1",
  plan: { discipline: "KINESIOLOGY" },
};
const legacy: HighlightableBooking = { serviceId: "s2", programId: "p2", plan: { discipline: null } };
const noC9: HighlightableBooking = { serviceId: "s1" };

describe("highlightState", () => {
  it("sin resaltado: none para todos", () => {
    for (const b of [loose, kine, legacy, noC9]) expect(highlightState(null, b)).toBe("none");
  });

  it("servicio: igual que la comparación vieja por serviceId (con y sin C9)", () => {
    const h: AgendaHighlight = { kind: "service", serviceId: "s1" };
    for (const b of [loose, kine, legacy, noC9]) {
      const old = b.serviceId === "s1" ? "match" : "dimmed";
      expect(highlightState(h, b)).toBe(old);
    }
  });

  it("plan: turnos con programId; con disciplina solo esa (el legacy sin disciplina no)", () => {
    expect(highlightState({ kind: "plan" }, kine)).toBe("match");
    expect(highlightState({ kind: "plan" }, legacy)).toBe("match");
    expect(highlightState({ kind: "plan" }, loose)).toBe("dimmed");
    expect(highlightState({ kind: "plan", discipline: "KINESIOLOGY" }, kine)).toBe("match");
    expect(highlightState({ kind: "plan", discipline: "OSTEOPATHY" }, kine)).toBe("dimmed");
    expect(highlightState({ kind: "plan", discipline: "KINESIOLOGY" }, legacy)).toBe("dimmed");
  });

  it("suelto: programId null; sin C9 (undefined) no adivina en ninguno de los dos", () => {
    expect(highlightState({ kind: "loose" }, loose)).toBe("match");
    expect(highlightState({ kind: "loose" }, kine)).toBe("dimmed");
    expect(matchesHighlight({ kind: "loose" }, noC9)).toBe(false);
    expect(matchesHighlight({ kind: "plan" }, noC9)).toBe(false);
  });
});

describe("anyHighlightMatch (celda de Semana)", () => {
  it("se levanta si algún turno coincide", () => {
    expect(anyHighlightMatch({ kind: "plan" }, [loose, kine])).toBe(true);
    expect(anyHighlightMatch({ kind: "plan" }, [loose])).toBe(false);
    expect(anyHighlightMatch({ kind: "service", serviceId: "s2" }, [])).toBe(false);
  });
});

describe("toggleHighlight / sameHighlight", () => {
  it("selección única: el mismo ítem apaga, otro reemplaza", () => {
    const s1: AgendaHighlight = { kind: "service", serviceId: "s1" };
    expect(toggleHighlight(null, s1)).toEqual(s1);
    expect(toggleHighlight(s1, { kind: "service", serviceId: "s1" })).toBeNull();
    expect(toggleHighlight(s1, { kind: "loose" })).toEqual({ kind: "loose" });
    expect(toggleHighlight({ kind: "plan" }, { kind: "plan", discipline: "OSTEOPATHY" })).toEqual({
      kind: "plan",
      discipline: "OSTEOPATHY",
    });
  });

  it("igualdad por valor", () => {
    expect(sameHighlight(null, null)).toBe(true);
    expect(sameHighlight({ kind: "loose" }, null)).toBe(false);
    expect(sameHighlight({ kind: "service", serviceId: "a" }, { kind: "service", serviceId: "b" })).toBe(false);
    expect(sameHighlight({ kind: "plan" }, { kind: "plan" })).toBe(true);
    expect(sameHighlight({ kind: "plan" }, { kind: "loose" })).toBe(false);
  });
});
