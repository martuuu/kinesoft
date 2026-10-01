/**
 * B3.4 CFG-UI-1 — estado puro del editor de horarios
 * (`lib/schedule-editor-state.ts`). Sin reloj: corre igual en TZ=UTC y TZ=AR.
 *
 * Lo que importa probar: que un error del server (`fieldErrors["ranges.<i>"]`)
 * vuelva a la fila correcta aunque el usuario haya agregado/quitado/copiado
 * franjas, y que el fallback precargue lo que el motor ya aplica.
 */
import { describe, it, expect } from "vitest";
import {
  copyDay,
  dayKeyLabel,
  dowOfDayKey,
  draftFromView,
  draftToPayload,
  emptyWeek,
  fieldErrorsToRowErrors,
  monthLabel,
  monthRange,
  nextRange,
  rangesLabel,
  shiftMonth,
  timeOptions,
  validateDayDraft,
  validateDraft,
  weekSignature,
  type DraftRange,
} from "@/lib/schedule-editor-state";
import { rangeErrorsToFieldErrors, validateWeekRanges, MAX_RANGES_PER_DAY } from "@/lib/schedule-validate";

const L1 = "loc-1";
const L2 = "loc-2";
const r = (startMin: number, endMin: number, locationId = L1, key = `k${startMin}-${endMin}`): DraftRange => ({
  key,
  startMin,
  endMin,
  locationId,
});

describe("draftFromView", () => {
  it("fallback: precarga lun-sáb con el horario del consultorio en la sede principal", () => {
    const w = draftFromView(
      { ranges: [], isFallback: true, tenantHours: { startMin: 480, endMin: 1200 } },
      L1
    );
    expect(w[0]).toEqual([]);
    for (const dow of [1, 2, 3, 4, 5, 6]) {
      expect(w[dow]).toHaveLength(1);
      expect(w[dow][0]).toMatchObject({ startMin: 480, endMin: 1200, locationId: L1 });
    }
  });

  it("con franjas: agrupa por dow y ordena por inicio", () => {
    const w = draftFromView(
      {
        ranges: [
          { dow: 1, startMin: 900, endMin: 1140, locationId: L2 },
          { dow: 1, startMin: 480, endMin: 780, locationId: L1 },
          { dow: 6, startMin: 540, endMin: 720, locationId: L1 },
        ],
        isFallback: false,
        tenantHours: { startMin: 480, endMin: 1200 },
      },
      L1
    );
    expect(w[1].map((x) => x.startMin)).toEqual([480, 900]);
    expect(w[6]).toHaveLength(1);
    expect(w[2]).toEqual([]);
    // keys únicas
    const keys = w.flat().map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("draftToPayload + fieldErrorsToRowErrors", () => {
  it("aplana Lun…Dom (domingo al final) y el error del server vuelve a su fila", () => {
    const week = emptyWeek();
    week[0] = [r(540, 720, L1, "dom")];
    week[1] = [r(480, 780, L1, "lun-a"), r(700, 900, L1, "lun-b")]; // solape
    week[3] = [r(480, 600, L1, "mie")];
    const { ranges, keys } = draftToPayload(week);
    expect(ranges.map((x) => x.dow)).toEqual([1, 1, 3, 0]);
    expect(keys).toEqual(["lun-a", "lun-b", "mie", "dom"]);

    // Mismo camino que la action: validateWeekRanges → rangeErrorsToFieldErrors.
    const res = validateWeekRanges(ranges);
    expect(res.ok).toBe(false);
    const fe = rangeErrorsToFieldErrors(res.ok ? [] : res.errors);
    const rows = fieldErrorsToRowErrors(fe, keys);
    expect(Object.keys(rows).sort()).toEqual(["lun-a", "lun-b"]);
    expect(rows["lun-a"]).toMatch(/superpone/);
  });

  it("ignora claves que no son de fila y posiciones inexistentes", () => {
    expect(
      fieldErrorsToRowErrors({ practitionerId: ["x"], "ranges.9": ["y"], "ranges.0": ["z"] }, ["a"])
    ).toEqual({ a: "z" });
    expect(fieldErrorsToRowErrors(undefined, ["a"])).toEqual({});
  });
});

describe("validateDraft / validateDayDraft", () => {
  it("marca por key: solape entre sedes, fin antes de inicio y sede archivada", () => {
    const week = emptyWeek();
    week[2] = [r(480, 780, L1, "a"), r(720, 900, L2, "b")];
    week[4] = [r(600, 540, L1, "c")];
    week[5] = [r(480, 600, "loc-arch", "d")];
    const errs = validateDraft(week, new Set([L1, L2]));
    expect(errs.a).toMatch(/otra sede/);
    expect(errs.b).toMatch(/otra sede/);
    expect(errs.c).toMatch(/posterior/);
    expect(errs.d).toMatch(/archivada/);
  });

  it("semana válida → sin errores; bordes que se tocan no solapan", () => {
    const week = emptyWeek();
    week[1] = [r(480, 780, L1, "a"), r(780, 1140, L2, "b")];
    expect(validateDraft(week, new Set([L1, L2]))).toEqual({});
  });

  it("día de excepción: mismo validador por fila", () => {
    expect(validateDayDraft([r(540, 600, L1, "x"), r(590, 700, L1, "y")])).toMatchObject({
      x: expect.any(String),
      y: expect.any(String),
    });
    expect(validateDayDraft([r(540, 600, L1, "x")])).toEqual({});
  });
});

describe("nextRange", () => {
  const defaults = { startMin: 480, endMin: 1200, locationId: L1 };
  it("día vacío → horario del consultorio", () => {
    expect(nextRange([], defaults)).toMatchObject({ startMin: 480, endMin: 1200, locationId: L1 });
  });
  it("arranca donde termina la última, 4 h, hereda la sede", () => {
    expect(nextRange([r(480, 780, L2)], defaults)).toMatchObject({ startMin: 780, endMin: 1020, locationId: L2 });
  });
  it("tope a 24:00 y null si ya no entra", () => {
    expect(nextRange([r(1200, 1380)], defaults)).toMatchObject({ startMin: 1380, endMin: 1440 });
    expect(nextRange([r(1200, 1440)], defaults)).toBeNull();
  });
  it("null al llegar al máximo por día", () => {
    const day = Array.from({ length: MAX_RANGES_PER_DAY }, (_, i) => r(i * 60, i * 60 + 30));
    expect(nextRange(day, defaults)).toBeNull();
  });
});

describe("copyDay", () => {
  it("reemplaza los días destino con keys nuevas y no toca el origen ni el resto", () => {
    const week = emptyWeek();
    week[1] = [r(480, 780, L1, "a"), r(900, 1140, L2, "b")];
    week[2] = [r(600, 700, L1, "old")];
    week[6] = [r(540, 720, L1, "sab")];
    const out = copyDay(week, 1, [2, 3, 1]);
    expect(out[1]).toBe(week[1]);
    expect(out[6]).toBe(week[6]);
    for (const dow of [2, 3]) {
      expect(out[dow].map((x) => [x.startMin, x.endMin, x.locationId])).toEqual([
        [480, 780, L1],
        [900, 1140, L2],
      ]);
      expect(out[dow].some((x) => x.key === "a" || x.key === "b")).toBe(false);
    }
    expect(weekSignature(out)).not.toBe(weekSignature(week));
  });
});

describe("weekSignature (dirty-guard)", () => {
  it("no depende de keys ni del orden de carga", () => {
    const a = emptyWeek();
    a[1] = [r(900, 1000, L1, "x"), r(480, 600, L1, "y")];
    const b = emptyWeek();
    b[1] = [r(480, 600, L1, "z"), r(900, 1000, L1, "w")];
    expect(weekSignature(a)).toBe(weekSignature(b));
    b[1][0].locationId = L2;
    expect(weekSignature(a)).not.toBe(weekSignature(b));
  });
});

describe("timeOptions", () => {
  it("inicio 00:00…23:55, fin 00:05…24:00, de a 5", () => {
    const s = timeOptions("start");
    const e = timeOptions("end");
    expect(s[0]).toEqual({ value: 0, label: "00:00" });
    expect(s.at(-1)).toEqual({ value: 1435, label: "23:55" });
    expect(e[0].value).toBe(5);
    expect(e.at(-1)).toEqual({ value: 1440, label: "24:00" });
    expect(s).toHaveLength(288);
  });
});

describe("meses y días", () => {
  it("shiftMonth cruza años", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
  });
  it("monthRange: último día real (bisiesto incluido)", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
  it("dowOfDayKey y labels sin depender del TZ del host", () => {
    expect(dowOfDayKey("2026-10-01")).toBe(4); // jueves
    expect(dowOfDayKey("2026-10-04")).toBe(0); // domingo
    expect(dayKeyLabel("2026-10-01")).toBe("jue 1 oct");
    expect(monthLabel("2026-10")).toBe("Octubre 2026");
    expect(rangesLabel([{ startMin: 900, endMin: 1140 }, { startMin: 540, endMin: 780 }])).toBe(
      "09:00–13:00, 15:00–19:00"
    );
  });
});
