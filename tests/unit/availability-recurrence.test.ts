/**
 * `lib/availability/recurrence.ts` (B2.1b): fechas del multi-turno / Planes.
 *
 *   • weekly  → paridad EXACTA con `expandBatchDates` (oráculo = copia literal
 *     de ef3281f `lib/bookings.ts:1341-1352`, la misma que fija
 *     `tests/unit/booking-schedule.test.ts`), incluido el tope heredado de 400
 *     iteraciones (count 60 semanal → 58).
 *   • biweekly → los mismos días, una semana sí y una no (semanas lun-dom AR
 *     contadas desde la del ancla).
 *   • monthly → mismo día del mes que el ancla, ajustado al último día cuando
 *     no existe (decisión 4), misma hora de pared AR.
 *   • tope 60 para todas.
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`).
 */
import { describe, it, expect } from "vitest";
import { toARDow } from "@/lib/datetime-ar";
import { expandBatchDates } from "@/lib/booking-schedule";
import {
  RECURRENCE_MAX_COUNT,
  expandDates,
  summarizeRange,
  frequencyLabel,
} from "@/lib/availability/recurrence";
import type { Frequency } from "@/lib/availability/types";

/** Expansión de fechas del batch de ef3281f (copia literal, no editar). */
function legacyExpand(anchor: Date, count: number, daysOfWeek: number[] | undefined): Date[] {
  const dowSet = new Set((daysOfWeek ?? []).map((d) => ((d % 7) + 7) % 7));
  if (dowSet.size === 0) dowSet.add((toARDow(anchor) + 6) % 7);
  const dates: Date[] = [];
  let cursor = new Date(anchor);
  let guard = 0;
  while (dates.length < count && guard++ < 400) {
    const monDow = (toARDow(cursor) + 6) % 7;
    if (dowSet.has(monDow)) dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const iso = (local: string) => ar(local).toISOString();
const isos = (ds: Date[]) => ds.map((d) => d.toISOString());
const exp = (anchor: string, count: number, frequency: Frequency, daysOfWeek?: number[]) =>
  isos(expandDates({ anchor: ar(anchor), count, frequency, daysOfWeek }));

// 2027-03-10 = miércoles.

describe("weekly — golden (mismas goldens que booking-schedule)", () => {
  it("sin días elegidos repite el día AR del ancla", () => {
    expect(exp("2027-03-10T10:00", 3, "weekly")).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-17T10:00"),
      iso("2027-03-24T10:00"),
    ]);
  });

  it("ancla 23:30 AR (jueves UTC) sigue siendo miércoles AR", () => {
    expect(exp("2027-03-10T23:30", 2, "weekly", [])).toEqual([iso("2027-03-10T23:30"), iso("2027-03-17T23:30")]);
  });

  it("días 0=Lun..6=Dom desde el ancla inclusive; normaliza fuera de rango", () => {
    expect(exp("2027-03-10T10:00", 4, "weekly", [0, 2])).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-15T10:00"),
      iso("2027-03-17T10:00"),
      iso("2027-03-22T10:00"),
    ]);
    expect(exp("2027-03-10T10:00", 2, "weekly", [-1, 7])).toEqual([iso("2027-03-14T10:00"), iso("2027-03-15T10:00")]);
  });

  it("count 0 → vacío; el tope heredado de 400 iteraciones da 58 con count 60", () => {
    expect(exp("2027-03-10T10:00", 0, "weekly")).toEqual([]);
    expect(exp("2027-03-10T10:00", 60, "weekly")).toHaveLength(58);
  });
});

describe("paridad weekly ↔ oráculo ↔ expandBatchDates", () => {
  const ANCHORS = [
    "2027-03-10T10:00",
    "2027-03-10T23:30",
    "2027-03-13T20:45",
    "2027-03-14T00:15",
    "2026-12-28T09:00", // cruza de año
    "2028-02-28T21:30", // bisiesto, 00:30 UTC del 29
  ];
  const DOWS: (number[] | undefined)[] = [undefined, [], [0], [0, 2, 4], [5, 6], [-1, 3, 10], [0, 1, 2, 3, 4, 5, 6]];

  it("anclas × días × count (≤ 60, el rango del caller)", () => {
    let checked = 0;
    const lengths = new Set<number>();
    for (const a of ANCHORS) {
      for (const dows of DOWS) {
        for (const count of [1, 2, 7, 13, 59, 60]) {
          const anchor = ar(a);
          const want = isos(legacyExpand(anchor, count, dows));
          expect(isos(expandDates({ anchor, count, daysOfWeek: dows, frequency: "weekly" }))).toEqual(want);
          // Y el módulo extraído de B1.6 sigue igual (los tres coinciden).
          expect(isos(expandBatchDates(anchor, count, dows))).toEqual(want);
          lengths.add(want.length);
          checked++;
        }
      }
    }
    expect(checked).toBe(ANCHORS.length * DOWS.length * 6);
    // Anti-false-green: la matriz produce largos distintos (incluido el 58 del tope).
    expect(lengths.size).toBeGreaterThan(4);
    expect(lengths.has(58)).toBe(true);
  });
});

describe("biweekly", () => {
  it("sin días: el día del ancla cada 14 días", () => {
    expect(exp("2027-03-10T10:00", 3, "biweekly")).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-24T10:00"),
      iso("2027-04-07T10:00"),
    ]);
  });

  it("Lun + Mié desde un miércoles: el lunes de la semana del ancla ya pasó, sigue la semana +2", () => {
    expect(exp("2027-03-10T10:00", 5, "biweekly", [0, 2])).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-22T10:00"),
      iso("2027-03-24T10:00"),
      iso("2027-04-05T10:00"),
      iso("2027-04-07T10:00"),
    ]);
  });

  it("Mié + Vie desde un miércoles: los dos de la semana del ancla cuentan", () => {
    expect(exp("2027-03-10T10:00", 4, "biweekly", [2, 4])).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-12T10:00"),
      iso("2027-03-24T10:00"),
      iso("2027-03-26T10:00"),
    ]);
  });

  it("domingo (6) está en la misma semana lun-dom que el ancla", () => {
    // Ancla miércoles 10/3, días Dom: 14/3 es de la semana del ancla → entra; después 28/3.
    expect(exp("2027-03-10T10:00", 2, "biweekly", [6])).toEqual([iso("2027-03-14T10:00"), iso("2027-03-28T10:00")]);
  });

  it("ancla 23:30 AR: la semana se cuenta en hora AR, no UTC", () => {
    // Domingo 14/3 23:30 AR = lunes 15/3 02:30 UTC. Semana del ancla = 8..14/3.
    expect(exp("2027-03-14T23:30", 3, "biweekly", [0, 6])).toEqual([
      iso("2027-03-14T23:30"),
      iso("2027-03-22T23:30"),
      iso("2027-03-28T23:30"),
    ]);
  });

  it("count 60 entrega 60 (sin el tope de 400 heredado de semanal)", () => {
    const ds = expandDates({ anchor: ar("2027-03-10T10:00"), count: 60, frequency: "biweekly" });
    expect(ds).toHaveLength(60);
    for (let i = 1; i < ds.length; i++) expect(ds[i].getTime() - ds[i - 1].getTime()).toBe(14 * 86_400_000);
  });
});

describe("monthly (decisión 4: mismo día, ajustado al último)", () => {
  it("28/09 → 28/10 → 28/11, misma hora AR", () => {
    expect(exp("2026-09-28T18:30", 3, "monthly")).toEqual([
      iso("2026-09-28T18:30"),
      iso("2026-10-28T18:30"),
      iso("2026-11-28T18:30"),
    ]);
  });

  it("31 → 30 / 28 / 29 (bisiesto) y vuelve a 31 cuando existe", () => {
    expect(exp("2027-01-31T10:00", 5, "monthly")).toEqual([
      iso("2027-01-31T10:00"),
      iso("2027-02-28T10:00"),
      iso("2027-03-31T10:00"),
      iso("2027-04-30T10:00"),
      iso("2027-05-31T10:00"),
    ]);
    expect(exp("2028-01-31T10:00", 2, "monthly")).toEqual([iso("2028-01-31T10:00"), iso("2028-02-29T10:00")]);
    expect(exp("2027-08-31T10:00", 2, "monthly")).toEqual([iso("2027-08-31T10:00"), iso("2027-09-30T10:00")]);
  });

  it("cruza de año", () => {
    expect(exp("2026-12-15T09:00", 2, "monthly")).toEqual([iso("2026-12-15T09:00"), iso("2027-01-15T09:00")]);
  });

  it("ancla 22:00 AR (día siguiente en UTC): el día del mes es el AR", () => {
    // 31/01 22:00 AR = 01/02 01:00 UTC. Mensual = 31 AR → 28/02 22:00 AR.
    expect(exp("2027-01-31T22:00", 2, "monthly")).toEqual([iso("2027-01-31T22:00"), iso("2027-02-28T22:00")]);
  });

  it("ignora daysOfWeek (el día lo fija el ancla)", () => {
    expect(exp("2026-09-28T18:30", 2, "monthly", [4])).toEqual(exp("2026-09-28T18:30", 2, "monthly"));
  });

  it("conserva segundos/ms del ancla", () => {
    const anchor = new Date(ar("2026-09-28T18:30").getTime() + 12_345);
    const ds = expandDates({ anchor, count: 2, frequency: "monthly" });
    expect(ds[1].getTime() - ar("2026-10-28T18:30").getTime()).toBe(12_345);
  });
});

describe("tope y entradas raras", () => {
  it.each(["weekly", "biweekly", "monthly"] as const)("%s: count > 60 se acota a 60; ≤ 0 o NaN → vacío", (f) => {
    const all = { anchor: ar("2027-03-10T10:00"), frequency: f, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    expect(expandDates({ ...all, count: 500 }).length).toBeLessThanOrEqual(RECURRENCE_MAX_COUNT);
    expect(expandDates({ ...all, count: 500 })).toHaveLength(60);
    expect(expandDates({ ...all, count: 0 })).toEqual([]);
    expect(expandDates({ ...all, count: -3 })).toEqual([]);
    expect(expandDates({ ...all, count: Number.NaN })).toEqual([]);
  });

  it("count fraccionario se trunca (2.7 → 2)", () => {
    expect(exp("2027-03-10T10:00", 2.7, "weekly")).toHaveLength(2);
  });

  it("las fechas devueltas son instancias nuevas (mutarlas no toca el ancla)", () => {
    const anchor = ar("2027-03-10T10:00");
    const ds = expandDates({ anchor, count: 1, frequency: "monthly" });
    ds[0].setTime(0);
    expect(anchor.toISOString()).toBe(iso("2027-03-10T10:00"));
  });
});

describe("summarizeRange", () => {
  it("el ejemplo del diseño", () => {
    const ds = expandDates({ anchor: ar("2026-09-28T18:30"), count: 2, frequency: "monthly" });
    expect(summarizeRange(ds, "monthly")).toBe("2 sesiones · Mensual 28/09 → 28/10");
  });

  it("semanal y cada 2 semanas", () => {
    expect(summarizeRange(expandDates({ anchor: ar("2027-03-10T10:00"), count: 3, frequency: "weekly" }), "weekly")).toBe(
      "3 sesiones · Semanal 10/03 → 24/03"
    );
    expect(
      summarizeRange(expandDates({ anchor: ar("2027-03-10T10:00"), count: 3, frequency: "biweekly" }), "biweekly")
    ).toBe("3 sesiones · Cada 2 semanas 10/03 → 07/04");
  });

  it("singular y vacío", () => {
    expect(summarizeRange([ar("2027-03-10T10:00")], "weekly")).toBe("1 sesión · 10/03");
    expect(summarizeRange([], "weekly")).toBe("Sin sesiones");
  });

  it("si cruza de año muestra el año", () => {
    const ds = expandDates({ anchor: ar("2026-12-15T09:00"), count: 2, frequency: "monthly" });
    expect(summarizeRange(ds, "monthly")).toBe("2 sesiones · Mensual 15/12/2026 → 15/01/2027");
  });

  it("usa el día AR (23:30 AR no se corre al día siguiente en UTC)", () => {
    const ds = expandDates({ anchor: ar("2027-03-10T23:30"), count: 2, frequency: "weekly" });
    expect(summarizeRange(ds, "weekly")).toBe("2 sesiones · Semanal 10/03 → 17/03");
  });

  it("toma el mínimo y el máximo aunque vengan desordenadas", () => {
    expect(summarizeRange([ar("2027-03-24T10:00"), ar("2027-03-10T10:00")], "weekly")).toBe(
      "2 sesiones · Semanal 10/03 → 24/03"
    );
  });

  it("frequencyLabel", () => {
    expect(frequencyLabel("weekly")).toBe("Semanal");
    expect(frequencyLabel("biweekly")).toBe("Cada 2 semanas");
    expect(frequencyLabel("monthly")).toBe("Mensual");
  });
});
