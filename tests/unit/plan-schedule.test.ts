/**
 * `lib/plan-schedule.ts` (S07p, ES1): conversión 0=Dom ↔ 0=Lun (C6), armado
 * de un `PlanScheduleV1` desde los días de la UI / del batch, validación y
 * resumen corto ("lun y jue 09:00", C13).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`): ningún
 * resultado puede depender del huso del host.
 */
import { describe, it, expect } from "vitest";
import {
  monToSunDow,
  sunToMonDow,
  planScheduleFromWeekdays,
  planScheduleWeekdays,
  planScheduleFromBatch,
  planScheduleError,
  summarizePlanSchedule,
} from "@/lib/plan-schedule";
import { expandPlanDates } from "@/lib/availability/plan";
import { expandDates } from "@/lib/availability/recurrence";
import { toARDow } from "@/lib/datetime-ar";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);

describe("dow 0=Dom ↔ 0=Lun (C6: la conversión vive solo acá)", () => {
  it("ida y vuelta para los 7 días", () => {
    // 0=Dom → 6 (Lun-first); 1=Lun → 0; 6=Sáb → 5.
    expect([0, 1, 2, 3, 4, 5, 6].map(sunToMonDow)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5, 6].map(monToSunDow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    for (let d = 0; d < 7; d++) {
      expect(monToSunDow(sunToMonDow(d))).toBe(d);
      expect(sunToMonDow(monToSunDow(d))).toBe(d);
    }
  });

  it("normaliza fuera de rango (módulo 7) como el batch", () => {
    expect(sunToMonDow(7)).toBe(6);
    expect(monToSunDow(-1)).toBe(0); // -1 ≡ 6 (Dom, Lun-first) → 0 (Dom)
  });

  it("lun/jue de la UI (0=Lun) → slots dow 1/4 (0=Dom) y de vuelta", () => {
    const s = planScheduleFromWeekdays({ daysOfWeek: [3, 0], startMin: 9 * 60 });
    expect(s).toEqual({
      v: 1,
      frequency: "weekly",
      everyNWeeks: 1,
      slots: [
        { dow: 1, startMin: 540 },
        { dow: 4, startMin: 540 },
      ],
    });
    expect(planScheduleWeekdays(s!)).toEqual([0, 3]);
  });

  it("los slots generados caen en el dow AR que dicen (UTC y AR)", () => {
    // 2027-03-10 = miércoles. Hora 23:30 AR = jueves en UTC: la trampa clásica.
    const s = planScheduleFromWeekdays({ daysOfWeek: [2], startMin: 23 * 60 + 30 })!;
    const rows = expandPlanDates({ schedule: s, startDayKey: "2027-03-08", count: 3 });
    for (const r of rows) expect(toARDow(r.at)).toBe(3);
    expect(rows[0].at.toISOString()).toBe(ar("2027-03-10T23:30").toISOString());
  });

  it("sin días → null (el caller exige al menos uno)", () => {
    expect(planScheduleFromWeekdays({ daysOfWeek: [], startMin: 540 })).toBeNull();
  });
});

describe("planScheduleFromBatch: el multi-turno del modal → PlanScheduleV1 (paridad con expandDates)", () => {
  const cases: Array<{ anchor: string; days?: number[]; frequency: "weekly" | "biweekly" | "monthly"; count: number }> = [
    { anchor: "2027-03-10T10:00", frequency: "weekly", count: 9 },
    { anchor: "2027-03-10T10:00", days: [0, 2, 4], frequency: "weekly", count: 12 },
    { anchor: "2027-03-10T23:30", days: [6], frequency: "weekly", count: 5 },
    { anchor: "2027-03-10T08:15", days: [1, 3], frequency: "biweekly", count: 10 },
    { anchor: "2027-01-31T18:00", frequency: "monthly", count: 6 },
  ];
  for (const c of cases) {
    it(`${c.frequency} ${c.anchor} ${JSON.stringify(c.days ?? [])} ×${c.count}`, () => {
      const { schedule, startDayKey } = planScheduleFromBatch({
        anchor: ar(c.anchor),
        daysOfWeek: c.days,
        frequency: c.frequency,
      });
      expect(planScheduleError(schedule)).toBeNull();
      const plan = expandPlanDates({ schedule, startDayKey, count: c.count }).map((r) => r.at.toISOString());
      const batch = expandDates({ anchor: ar(c.anchor), count: c.count, daysOfWeek: c.days, frequency: c.frequency }).map(
        (d) => d.toISOString()
      );
      expect(plan).toEqual(batch);
    });
  }
});

describe("planScheduleError (C6)", () => {
  const ok = { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 540 }] };
  it("acepta weekly 1..7 slots y monthly 1 slot", () => {
    expect(planScheduleError(ok)).toBeNull();
    expect(planScheduleError({ v: 1, frequency: "monthly", slots: [{ dow: 0, startMin: 0 }] })).toBeNull();
    expect(
      planScheduleError({
        v: 1,
        frequency: "weekly",
        everyNWeeks: 4,
        slots: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, startMin: 1439 })),
      })
    ).toBeNull();
  });
  it.each([
    ["versión", { ...ok, v: 2 }],
    ["frecuencia", { ...ok, frequency: "biweekly" }],
    ["sin slots", { ...ok, slots: [] }],
    ["dow repetido", { ...ok, slots: [{ dow: 1, startMin: 540 }, { dow: 1, startMin: 600 }] }],
    ["dow 7", { ...ok, slots: [{ dow: 7, startMin: 540 }] }],
    ["startMin 1440", { ...ok, slots: [{ dow: 1, startMin: 1440 }] }],
    ["startMin fraccionario", { ...ok, slots: [{ dow: 1, startMin: 540.5 }] }],
    ["everyNWeeks 5", { ...ok, everyNWeeks: 5 }],
    ["monthly con 2 slots", { v: 1, frequency: "monthly", slots: [{ dow: 1, startMin: 0 }, { dow: 2, startMin: 0 }] }],
    ["monthly con everyNWeeks", { v: 1, frequency: "monthly", everyNWeeks: 2, slots: [{ dow: 1, startMin: 0 }] }],
    ["null", null],
  ])("rechaza %s", (_label, s) => {
    expect(planScheduleError(s)).toEqual(expect.any(String));
  });
});

describe("summarizePlanSchedule (C13)", () => {
  it("misma hora en varios días", () => {
    expect(summarizePlanSchedule(planScheduleFromWeekdays({ daysOfWeek: [0, 3], startMin: 540 })!)).toBe(
      "lun y jue 09:00"
    );
    expect(summarizePlanSchedule(planScheduleFromWeekdays({ daysOfWeek: [4, 0, 2], startMin: 18 * 60 })!)).toBe(
      "lun, mié y vie 18:00"
    );
  });
  it("hora distinta por día, ordenado lun → dom", () => {
    expect(
      summarizePlanSchedule({
        v: 1,
        frequency: "weekly",
        slots: [
          { dow: 0, startMin: 600 },
          { dow: 4, startMin: 18 * 60 },
          { dow: 1, startMin: 540 },
        ],
      })
    ).toBe("lun 09:00, jue 18:00 y dom 10:00");
  });
  it("cada N semanas y mensual", () => {
    expect(
      summarizePlanSchedule({ v: 1, frequency: "weekly", everyNWeeks: 3, slots: [{ dow: 2, startMin: 480 }] })
    ).toBe("cada 3 semanas · mar 08:00");
    expect(summarizePlanSchedule({ v: 1, frequency: "monthly", slots: [{ dow: 6, startMin: 570 }] })).toBe(
      "mensual 09:30"
    );
  });
});
