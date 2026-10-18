import { describe, it, expect } from "vitest";
import {
  osLabel,
  billingLine,
  buildSlots,
  slotLabel,
  slotOf,
  coveredSlots,
  agendaGridZoom,
  zoomChoicePatch,
} from "@/components/agenda/agenda-utils";

/** 13:30 AR → minutes-from-midnight. */
const min = (h: number, m = 0) => h * 60 + m;

describe("buildSlots", () => {
  it("one row per hour at 60-minute granularity", () => {
    expect(buildSlots(8, 12, 60)).toEqual([480, 540, 600, 660]);
  });

  it("doubles the rows at 30-minute granularity", () => {
    expect(buildSlots(8, 10, 30)).toEqual([480, 510, 540, 570]);
  });

  it("excludes the closing hour itself (8→19 ends at 18:30)", () => {
    const s = buildSlots(8, 19, 30);
    expect(s[s.length - 1]).toBe(min(18, 30));
    expect(s).toHaveLength(22);
  });

  it("never renders a blank day for a degenerate window", () => {
    expect(buildSlots(10, 10, 60)).toEqual([600]);
  });
});

describe("slotLabel", () => {
  it("prints the half-hour so a 13:30 row is labelled", () => {
    expect(slotLabel(min(13, 30))).toBe("13:30");
    expect(slotLabel(min(8))).toBe("08:00");
  });
});

describe("slotOf", () => {
  const slots30 = buildSlots(8, 19, 30);
  const slots60 = buildSlots(8, 19, 60);

  it("keeps 13:30 in its own row at 30-min granularity", () => {
    expect(slotOf(min(13, 30), slots30, 30)).toEqual({ slot: min(13, 30), outOfRange: null });
  });

  it("folds 13:30 into 13:00 at 60-min granularity", () => {
    expect(slotOf(min(13, 30), slots60, 60)).toEqual({ slot: min(13), outOfRange: null });
  });

  it("floors within the slot (13:59 → 13:30, not 14:00)", () => {
    expect(slotOf(min(13, 59), slots30, 30).slot).toBe(min(13, 30));
    expect(slotOf(min(13, 29), slots30, 30).slot).toBe(min(13));
  });

  it("flags turnos outside the window instead of silently folding them", () => {
    expect(slotOf(min(7), slots30, 30)).toEqual({ slot: min(8), outOfRange: "before" });
    expect(slotOf(min(21), slots30, 30)).toEqual({ slot: min(18, 30), outOfRange: "after" });
  });
});

describe("coveredSlots", () => {
  it("lists the later rows a long turno runs through", () => {
    // 13:00 + 45min at 30-min rows → covers 13:30 (not 14:00).
    expect(coveredSlots(min(13), 45, buildSlots(8, 19, 30), 30)).toEqual([min(13, 30)]);
  });

  it("returns nothing when the turno fits inside its own slot", () => {
    expect(coveredSlots(min(13), 30, buildSlots(8, 19, 30), 30)).toEqual([]);
    expect(coveredSlots(min(13), 45, buildSlots(8, 19, 60), 60)).toEqual([]);
  });

  it("stops at the end of the window", () => {
    // 18:30 + 240min would run past closing; nothing beyond the last row.
    expect(coveredSlots(min(18, 30), 240, buildSlots(8, 19, 30), 30)).toEqual([]);
  });
});

describe("osLabel", () => {
  it("hides the Particular / uninsured label (never prints 'Particular')", () => {
    expect(osLabel("Particular")).toBe("");
    expect(osLabel("particular")).toBe("");
    expect(osLabel("")).toBe("");
  });
  it("shows a real obra social name", () => {
    expect(osLabel("OSDE")).toBe("OSDE");
  });
});

describe("billingLine", () => {
  it("drops the OS segment for a particular patient", () => {
    const line = billingLine({ serviceName: "Consulta", obraSocial: "Particular", copagoCents: 5000 });
    expect(line).not.toContain("Particular");
    expect(line).toContain("Consulta");
  });
  it("includes the obra social when insured", () => {
    const line = billingLine({ serviceName: "Consulta", obraSocial: "OSDE", copagoCents: 3000 });
    expect(line).toContain("OSDE");
    expect(line).toContain("Consulta");
  });
});

// [AS-2g] T3d-2g (plan §23.8): filas de 15' en Día y Semana. Antes `=== 30 ? 30 : 60` leía un 15 como 60 (sin
// error): el consultorio que eligió 15 seguía viendo filas de una hora.
describe("[AS-2g] filas de 15'", () => {
  const slots15 = buildSlots(8, 19, 15);

  it("buildSlots a 15': 4 filas por hora (8→19 = 44)", () => {
    expect(buildSlots(9, 10, 15)).toEqual([min(9), min(9, 15), min(9, 30), min(9, 45)]);
    expect(slots15).toHaveLength(44);
  });

  it("granularidad desconocida = 60 (normalizeSlotMinutes), igual que antes", () => {
    expect(buildSlots(8, 10, 45)).toEqual([min(8), min(9)]);
    expect(slotOf(min(9, 50), buildSlots(8, 19, 45), 45).slot).toBe(min(9));
  });

  it("turnos en :15 y :45 caen en su fila", () => {
    expect(slotOf(min(9, 15), slots15, 15)).toEqual({ slot: min(9, 15), outOfRange: null });
    expect(slotOf(min(9, 45), slots15, 15)).toEqual({ slot: min(9, 45), outOfRange: null });
    expect(slotOf(min(9, 59), slots15, 15).slot).toBe(min(9, 45));
  });

  it("coveredSlots a 15': un turno de 45' sigue en las 2 filas siguientes", () => {
    expect(coveredSlots(min(9), 45, slots15, 15)).toEqual([min(9, 15), min(9, 30)]);
  });

  it("agendaGridZoom: Día/Semana siguen al consultorio salvo que el usuario eligió; columnas siguen el zoom", () => {
    const def = { zoom: 30 as const };
    expect(agendaGridZoom("timeline", def, 15)).toBe(15);
    expect(agendaGridZoom("week", def, 60)).toBe(60);
    expect(agendaGridZoom("timeline", { zoom: 15, zoomSet: true as const }, 60)).toBe(15);
    expect(agendaGridZoom("week", { zoom: 60, zoomSet: true as const }, 15)).toBe(60);
    expect(agendaGridZoom("practitioner", def, 15)).toBe(30);
    expect(agendaGridZoom("room", { zoom: 60 }, 15)).toBe(60);
    expect(agendaGridZoom("list", def, 15)).toBe(15);
  });

  it("zoomChoicePatch: elegir un zoom lo marca como elegido", () => {
    expect(zoomChoicePatch(15)).toEqual({ zoom: 15, zoomSet: true });
  });
});
