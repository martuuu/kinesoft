/**
 * `lib/availability/day.ts` (B2.1a): el puente día AR ↔ instantes del motor de
 * disponibilidad. Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`)
 * y tiene que dar lo mismo: nada depende del huso del host.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  dayKeyOf,
  dayKeyRange,
  dayKeyToDbDate,
  dayWindow,
  dbDateToDayKey,
  dowOfDayKey,
  formatWallTime,
  instantAt,
  isDayKey,
  minutesOfDayAR,
  minuteInDay,
} from "@/lib/availability/day";
import { arDayWindow } from "@/lib/public-booking-slots";

// 2026-10-05 es lunes; 2026-10-04, domingo.
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";

describe("isDayKey", () => {
  it("acepta YYYY-MM-DD reales y rechaza el resto", () => {
    expect(isDayKey(MONDAY)).toBe(true);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2026-02-29")).toBe(false); // no existe
    expect(isDayKey("2026-13-01")).toBe(false);
    expect(isDayKey("2026-10-5")).toBe(false);
    expect(isDayKey("nope")).toBe(false);
  });
});

describe("dayWindow / instantAt", () => {
  it("ancla el día a la medianoche AR (03:00 UTC), 24 h exactas", () => {
    const w = dayWindow(MONDAY);
    expect(w.start.toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-06T03:00:00.000Z");
  });
  it("es la misma ventana que arDayWindow del turnero (paridad)", () => {
    for (const k of [MONDAY, SUNDAY, "2026-12-31", "2027-01-01", "2028-02-29"]) {
      const old = arDayWindow(k)!;
      const w = dayWindow(k);
      expect(w.start.getTime()).toBe(old.dayStart.getTime());
      expect(w.end.getTime()).toBe(old.dayEnd.getTime());
    }
  });
  it("tira con una clave inválida (el loader valida antes)", () => {
    expect(() => dayWindow("2026-10-5")).toThrow(RangeError);
    expect(() => instantAt("x", 0)).toThrow(RangeError);
  });
  it("instantAt = hora de pared AR de ese día", () => {
    expect(instantAt(MONDAY, 8 * 60).toISOString()).toBe("2026-10-05T11:00:00.000Z");
    expect(instantAt(MONDAY, 0).toISOString()).toBe("2026-10-05T03:00:00.000Z");
    // 1440 = la medianoche siguiente (fin semiabierto de la última franja).
    expect(instantAt(MONDAY, 1440).toISOString()).toBe("2026-10-06T03:00:00.000Z");
  });
  it("cruce de medianoche UTC: 21:00 AR es el día siguiente en UTC, pero sigue siendo el mismo dayKey AR", () => {
    const i = instantAt(MONDAY, 21 * 60);
    expect(i.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(dayKeyOf(i)).toBe(MONDAY);
    expect(minutesOfDayAR(i)).toBe(21 * 60);
    const late = instantAt(MONDAY, 23 * 60 + 45);
    expect(late.toISOString()).toBe("2026-10-06T02:45:00.000Z");
    expect(dayKeyOf(late)).toBe(MONDAY);
  });
  it("rechaza minutos fuera de 0..1440", () => {
    expect(() => instantAt(MONDAY, -1)).toThrow(RangeError);
    expect(() => instantAt(MONDAY, 1441)).toThrow(RangeError);
  });
});

describe("minutesOfDayAR", () => {
  it("medianoche AR es 0, no 1440 (Intl devuelve hora '24' con hour12:false)", () => {
    expect(minutesOfDayAR(new Date("2026-10-05T03:00:00.000Z"))).toBe(0);
    expect(minutesOfDayAR(new Date("2026-10-05T03:01:00.000Z"))).toBe(1);
  });
  it("devuelve minutos de pared AR", () => {
    expect(minutesOfDayAR(new Date("2026-10-05T16:30:00.000Z"))).toBe(13 * 60 + 30);
    expect(minutesOfDayAR(new Date("2026-10-06T02:59:00.000Z"))).toBe(23 * 60 + 59);
  });
});

describe("minuteInDay", () => {
  it("minutos (fraccionarios) desde la medianoche AR del día pedido, sin recortar", () => {
    expect(minuteInDay(MONDAY, new Date("2026-10-05T11:00:00.000Z"))).toBe(480);
    expect(minuteInDay(MONDAY, new Date("2026-10-05T02:00:00.000Z"))).toBe(-60);
    expect(minuteInDay(MONDAY, new Date("2026-10-06T04:00:00.000Z"))).toBe(1500);
    expect(minuteInDay(MONDAY, new Date("2026-10-05T11:00:30.000Z"))).toBe(480.5);
  });
});

describe("dowOfDayKey", () => {
  it("0=Dom … 6=Sáb (convención toARDow / PractitionerSchedule.dow)", () => {
    expect(dowOfDayKey(SUNDAY)).toBe(0);
    expect(dowOfDayKey(MONDAY)).toBe(1);
    expect(dowOfDayKey("2026-10-10")).toBe(6);
  });
});

describe("dayKeyOf", () => {
  it("un instante de madrugada UTC sigue siendo el día anterior en AR", () => {
    expect(dayKeyOf(new Date("2026-10-06T02:59:59.999Z"))).toBe(MONDAY);
    expect(dayKeyOf(new Date("2026-10-06T03:00:00.000Z"))).toBe("2026-10-06");
  });
});

describe("@db.Date ↔ DayKey", () => {
  it("un @db.Date llega a medianoche UTC: el slice UTC es intencional", () => {
    // Si se usara toARDateKey daría el día ANTERIOR (00:00 UTC = 21:00 AR).
    const fromPrisma = new Date("2026-10-05T00:00:00.000Z");
    expect(dbDateToDayKey(fromPrisma)).toBe(MONDAY);
    expect(dayKeyToDbDate(MONDAY).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(dbDateToDayKey(dayKeyToDbDate("2028-02-29"))).toBe("2028-02-29");
  });
  it("dbDateToDayKey(null) = null (validFrom/validUntil opcionales)", () => {
    expect(dbDateToDayKey(null)).toBeNull();
  });
  it("dayKeyToDbDate tira con una clave inválida", () => {
    expect(() => dayKeyToDbDate("2026-02-30")).toThrow(RangeError);
  });
});

describe("addDays / dayKeyRange", () => {
  it("aritmética de calendario (fin de mes, año bisiesto, cambio de año)", () => {
    expect(addDays(MONDAY, 1)).toBe("2026-10-06");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays(MONDAY, 0)).toBe(MONDAY);
  });
  it("rango inclusive en ambos extremos; vacío si from > to", () => {
    expect(dayKeyRange("2026-09-29", "2026-10-02")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(dayKeyRange(MONDAY, MONDAY)).toEqual([MONDAY]);
    expect(dayKeyRange("2026-10-06", MONDAY)).toEqual([]);
  });
});

describe("formatWallTime", () => {
  it("HH:MM de minutos de pared", () => {
    expect(formatWallTime(0)).toBe("00:00");
    expect(formatWallTime(8 * 60 + 45)).toBe("08:45");
    expect(formatWallTime(21 * 60 + 5)).toBe("21:05");
  });
});
