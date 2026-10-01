/**
 * B2.4a CFG-api-1 — validador puro de franjas (`lib/schedule-validate.ts`).
 * Corre igual en TZ=UTC y TZ=AR (no hay reloj; los helpers de `@db.Date`
 * son por UTC a propósito y se prueban en los dos).
 */
import { describe, it, expect } from "vitest";
import {
  validateWeekRanges,
  validateDayRanges,
  rangeErrorsToFieldErrors,
  summarizeWeek,
  formatMinutes,
  isValidDayKey,
  dayKeyToDbDate,
  dbDateToDayKey,
  dayKeyDiff,
} from "@/lib/schedule-validate";

const L1 = "loc-1";
const L2 = "loc-2";
const r = (dow: number, startMin: number, endMin: number, locationId = L1) => ({ dow, startMin, endMin, locationId });

describe("validateWeekRanges", () => {
  it("acepta mañana y tarde que se tocan en el borde (semiabierto)", () => {
    expect(validateWeekRanges([r(1, 480, 780), r(1, 780, 1140)])).toEqual({ ok: true });
  });

  it("acepta los extremos 0 y 1440", () => {
    expect(validateWeekRanges([r(0, 0, 1440)]).ok).toBe(true);
  });

  it("rechaza start >= end, negativos y > 1440", () => {
    const v = validateWeekRanges([r(1, 600, 600), r(1, 700, 650), r(2, -5, 60), r(3, 1000, 1445)]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(v.errors[0].message).toMatch(/posterior/);
    expect(v.errors[2].message).toMatch(/00:00 y 24:00/);
  });

  it("rechaza minutos que no son múltiplos de 5 o no enteros", () => {
    const v = validateWeekRanges([r(1, 482, 600), r(2, 480, 601), r(3, 480.5, 600)]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(v.errors[0].message).toMatch(/5 minutos/);
    expect(v.errors[2].message).toMatch(/enteros/);
  });

  it("rechaza dow fuera de 0..6", () => {
    const v = validateWeekRanges([r(7, 480, 600), r(-1, 480, 600)]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toHaveLength(2);
  });

  it("marca las DOS filas de un solape en el mismo día y sede", () => {
    const v = validateWeekRanges([r(1, 480, 720), r(2, 480, 720), r(1, 700, 900)]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.index)).toEqual([0, 2]);
    expect(v.errors[0].message).toMatch(/11:40-12:00/);
  });

  it("solape entre sedes distintas: un profesional no está en dos sedes a la vez", () => {
    const v = validateWeekRanges([r(3, 480, 780, L1), r(3, 720, 900, L2)]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.index)).toEqual([0, 1]);
    expect(v.errors[0].message).toMatch(/otra sede/);
  });

  it("misma franja en días distintos y sedes distintas el mismo día sin solape: OK", () => {
    expect(
      validateWeekRanges([r(1, 480, 780, L1), r(2, 480, 780, L1), r(1, 840, 1140, L2)]).ok
    ).toBe(true);
  });

  it("franja contenida dentro de otra cuenta como solape", () => {
    const v = validateWeekRanges([r(5, 480, 1140), r(5, 600, 660)]);
    expect(v.ok).toBe(false);
  });

  it("solape detectado aunque las filas vengan desordenadas y haya una tercera en el medio", () => {
    const v = validateWeekRanges([r(4, 900, 960), r(4, 480, 600), r(4, 590, 620)]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.index)).toEqual([1, 2]);
  });

  it("sede fuera del set de activas → error de esa fila", () => {
    const v = validateWeekRanges([r(1, 480, 600, L1), r(2, 480, 600, "loc-ajena")], {
      activeLocationIds: new Set([L1]),
    });
    expect(v).toEqual({ ok: false, errors: [{ index: 1, message: "La sede no existe o está archivada." }] });
  });

  it("sin sede → error", () => {
    const v = validateWeekRanges([r(1, 480, 600, "")]);
    expect(v.ok).toBe(false);
  });

  it("rangeErrorsToFieldErrors arma las claves ranges.<i>", () => {
    expect(rangeErrorsToFieldErrors([{ index: 2, message: "x" }])).toEqual({ "ranges.2": ["x"] });
  });
});

describe("validateDayRanges (excepción CUSTOM_HOURS)", () => {
  it("mismas reglas sin dow", () => {
    expect(validateDayRanges([{ startMin: 540, endMin: 720, locationId: L1 }]).ok).toBe(true);
    expect(
      validateDayRanges([
        { startMin: 540, endMin: 720, locationId: L1 },
        { startMin: 700, endMin: 800, locationId: L2 },
      ]).ok
    ).toBe(false);
  });
});

describe("summarizeWeek", () => {
  it("agrupa días consecutivos iguales, lunes primero, domingo al final", () => {
    const week = [1, 2, 3, 4, 5].flatMap((d) => [r(d, 480, 780), r(d, 900, 1140)]);
    week.push(r(6, 540, 720), r(0, 600, 660));
    expect(summarizeWeek(week)).toBe("Lun-Vie 8-13, 15-19 · Sáb 9-12 · Dom 10-11");
  });

  it("dos días seguidos con coma; no agrupa días no consecutivos; medias horas", () => {
    expect(summarizeWeek([r(1, 510, 600), r(2, 510, 600), r(4, 510, 600)])).toBe(
      "Lun, Mar 8:30-10 · Jue 8:30-10"
    );
  });

  it("semana vacía → ''", () => {
    expect(summarizeWeek([])).toBe("");
  });

  it("formatMinutes", () => {
    expect(formatMinutes(0)).toBe("0");
    expect(formatMinutes(1440)).toBe("24");
    expect(formatMinutes(545)).toBe("9:05");
  });
});

describe("DayKey ↔ @db.Date", () => {
  it("ida y vuelta exacta, sin correr el día en ningún TZ del host", () => {
    for (const k of ["2026-01-01", "2026-03-01", "2026-12-31", "2028-02-29"]) {
      const d = dayKeyToDbDate(k);
      expect(d.toISOString()).toBe(`${k}T00:00:00.000Z`);
      expect(dbDateToDayKey(d)).toBe(k);
    }
  });

  it("isValidDayKey rechaza formatos y fechas imposibles", () => {
    expect(isValidDayKey("2026-09-30")).toBe(true);
    expect(isValidDayKey("2026-02-30")).toBe(false);
    expect(isValidDayKey("2026-9-30")).toBe(false);
    expect(isValidDayKey("30/09/2026")).toBe(false);
  });

  it("dayKeyDiff", () => {
    expect(dayKeyDiff("2026-09-30", "2026-10-01")).toBe(1);
    expect(dayKeyDiff("2026-01-01", "2027-01-01")).toBe(365);
    expect(dayKeyDiff("2026-10-01", "2026-09-30")).toBe(-1);
  });
});
