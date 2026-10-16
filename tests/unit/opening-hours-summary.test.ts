/**
 * VX2-d1 · `summarizeOpeningHours` / `publicOpeningRanges` (AUDIT `turnero-texto-fijo-lun-sab`).
 * Corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`): el día de «hoy» para las vigencias sale de
 * `toARDateKey`, nunca del huso del host. Los instantes de los casos borde están elegidos para que UTC y AR caigan en
 * días distintos (después de las 21:00 AR).
 */
import { describe, expect, it } from "vitest";
import {
  publicOpeningRanges,
  summarizeOpeningHours,
  type OpeningRange,
  type OpeningScheduleRow,
} from "@/lib/opening-hours-summary";

const NOW = new Date("2026-10-15T15:00:00Z"); // jueves 15-oct, 12:00 AR
const r = (dow: number, from: string, to: string, extra: Partial<OpeningRange> = {}): OpeningRange => {
  const [fh, fm = "0"] = from.split(":");
  const [th, tm = "0"] = to.split(":");
  return { dow, startMin: +fh * 60 + +fm, endMin: +th * 60 + +tm, validFrom: null, validUntil: null, ...extra };
};
const weekdays = (from: string, to: string) => [1, 2, 3, 4, 5].map((d) => r(d, from, to));

describe("summarizeOpeningHours", () => {
  it("lunes a viernes + sábado corto (el ejemplo del brief)", () => {
    expect(summarizeOpeningHours([...weekdays("8", "19"), r(6, "9", "13")], NOW)).toBe("Lun a vie 8 a 19 · Sáb 9 a 13");
  });

  it("sin franjas → null (no se muestra nada)", () => {
    expect(summarizeOpeningHours([], NOW)).toBeNull();
  });

  it("une las franjas de varios profesionales que se pisan o se tocan; deja el hueco del mediodía", () => {
    const ranges = [r(2, "8", "12"), r(2, "11", "14"), r(2, "14", "15:30"), r(2, "17", "20")];
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Mar 8 a 15:30 y 17 a 20");
  });

  it("días sueltos y de a dos: lunes, martes y jueves; domingo al final", () => {
    const ranges = [r(1, "9", "13"), r(2, "9", "13"), r(4, "9", "13"), r(0, "10", "12")];
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Lun, mar y jue 9 a 13 · Dom 10 a 12");
  });

  it("minutos y medianoche: 7:30 a 24", () => {
    expect(summarizeOpeningHours([r(5, "7:30", "24")], NOW)).toBe("Vie 7:30 a 24");
  });

  it("ignora franjas inválidas (dow fuera de rango, invertidas)", () => {
    expect(summarizeOpeningHours([r(7, "8", "9"), r(3, "12", "10")], NOW)).toBeNull();
  });

  it("vigencias: vencida o futura no cuentan; la que vence hoy sí", () => {
    const ranges = [
      r(1, "8", "12", { validUntil: "2026-10-14" }), // venció ayer
      r(2, "8", "12", { validFrom: "2026-10-16" }), // arranca mañana
      r(3, "8", "12", { validUntil: "2026-10-15" }), // vence hoy
      r(4, "8", "12", { validFrom: "2026-10-15" }), // arranca hoy
    ];
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Mié y jue 8 a 12");
  });

  it("[TZ] a las 22:30 AR del 14-oct (01:30 UTC del 15) una franja que vence el 14 sigue vigente", () => {
    const late = new Date("2026-10-15T01:30:00Z");
    expect(summarizeOpeningHours([r(1, "8", "12", { validUntil: "2026-10-14" })], late)).toBe("Lun 8 a 12");
    // …y una que arranca el 15 todavía no (en UTC ya sería el 15).
    expect(summarizeOpeningHours([r(1, "8", "12", { validFrom: "2026-10-15" })], late)).toBeNull();
  });
});

describe("publicOpeningRanges (reglas del motor)", () => {
  const row = (p: Partial<OpeningScheduleRow>): OpeningScheduleRow => ({
    practitionerId: "A", dow: 1, startMin: 540, endMin: 780, validFrom: null, validUntil: null, locationActive: true, ...p,
  });
  const tenant = { businessHoursStart: 9, businessHoursEnd: 18 };

  it("profesional sin franjas → horario del consultorio lunes a sábado (red de seguridad)", () => {
    const ranges = publicOpeningRanges({ practitionerIds: ["A"], rows: [], tenant });
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Lun a sáb 9 a 18");
  });

  it("horario del consultorio inválido → 8 a 19, como `tenantHoursOf`", () => {
    const ranges = publicOpeningRanges({ practitionerIds: ["A"], rows: [], tenant: { businessHoursStart: 20, businessHoursEnd: 8 } });
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Lun a sáb 8 a 19");
  });

  it("franjas solo en sedes inactivas: no ofrece nada y NO cae al fallback", () => {
    const ranges = publicOpeningRanges({ practitionerIds: ["A"], rows: [row({ locationActive: false })], tenant });
    expect(summarizeOpeningHours(ranges, NOW)).toBeNull();
  });

  it("solo cuentan los profesionales ofrecidos", () => {
    const ranges = publicOpeningRanges({
      practitionerIds: ["A"],
      rows: [row({}), row({ practitionerId: "B", dow: 6, startMin: 600, endMin: 720 })],
      tenant,
    });
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Lun 9 a 13");
  });

  it("[TZ] las fechas @db.Date (00:00 UTC) se leen como ese día, no el anterior en AR", () => {
    const ranges = publicOpeningRanges({
      practitionerIds: ["A"],
      rows: [row({ validFrom: new Date("2026-10-15T00:00:00.000Z"), validUntil: new Date("2026-10-15T00:00:00.000Z") })],
      tenant,
    });
    expect(ranges[0]).toMatchObject({ validFrom: "2026-10-15", validUntil: "2026-10-15" });
    expect(summarizeOpeningHours(ranges, NOW)).toBe("Lun 9 a 13");
  });
});
