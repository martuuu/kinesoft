/**
 * [AS-3h] Lógica pura de Agenda → Ocupación (`lib/agenda-occupancy.ts`). Corre en TZ=UTC y en TZ=AR: las ventanas y
 * los rótulos salen de DayKeys AR, nunca del reloj del host. La sentencia (bucket AR −3) la fija la integración
 * `tests/integration/as3h-occupancy.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  buildPastTable,
  buildUpcomingTables,
  canSeeTeamOccupancy,
  countOccupancyBuckets,
  formatOccupancyAverage,
  occupancyLevel,
  occupancyWindow,
  parseOccupancyParams,
  resolveOccupancyScope,
  upcomingCell,
  type OccupancySqlRow,
} from "@/lib/agenda-occupancy";
import { capabilitiesFor } from "@/lib/capabilities";

const ar = (local: string) => new Date(`${local}:00-03:00`);
const NOW = ar("2027-11-10T15:00"); // miércoles

describe("[AS-3h] scope por rol", () => {
  it("Titular, Administrador/a, Secretaria y Facturación ven al equipo; el Profesional no", () => {
    expect(canSeeTeamOccupancy(capabilitiesFor("OWNER"))).toBe(true);
    expect(canSeeTeamOccupancy(capabilitiesFor("ADMIN"))).toBe(true);
    expect(canSeeTeamOccupancy(capabilitiesFor("ASSISTANT"))).toBe(true);
    expect(canSeeTeamOccupancy(capabilitiesFor("BILLING"))).toBe(true);
    expect(canSeeTeamOccupancy(capabilitiesFor("PRACTITIONER"))).toBe(false);
    // Sin `agenda.viewAll` no alcanza con operar.
    expect(canSeeTeamOccupancy(new Set(["agenda.operateAll"]))).toBe(false);
  });

  it("el Profesional mira SIEMPRE el suyo aunque pida otro; el equipo elige solo entre los del consultorio", () => {
    const pro = capabilitiesFor("PRACTITIONER");
    expect(resolveOccupancyScope(pro, "p-1", "p-2", ["p-1", "p-2"])).toEqual({ kind: "own", practitionerId: "p-1" });
    expect(resolveOccupancyScope(pro, null, "p-2", [])).toEqual({ kind: "none" });
    const sec = capabilitiesFor("ASSISTANT");
    expect(resolveOccupancyScope(sec, null, "p-2", ["p-1", "p-2"])).toEqual({ kind: "team", practitionerId: "p-2" });
    expect(resolveOccupancyScope(sec, null, "ajeno", ["p-1"])).toEqual({ kind: "team", practitionerId: null });
    expect(resolveOccupancyScope(sec, null, null, ["p-1"])).toEqual({ kind: "team", practitionerId: null });
  });
});

describe("[AS-3h] parámetros y ventanas", () => {
  it("defaults: «Lo que pasó» 8 semanas, «Lo que viene» 1; semanas fuera de las opciones → default", () => {
    expect(parseOccupancyParams({})).toEqual({ tab: "pasado", weeks: 8, pro: null });
    expect(parseOccupancyParams({ tab: "proximo", semanas: "8" })).toEqual({ tab: "proximo", weeks: 1, pro: null });
    expect(parseOccupancyParams({ tab: "proximo", semanas: "4", pro: "p-1" })).toEqual({
      tab: "proximo",
      weeks: 4,
      pro: "p-1",
    });
    expect(parseOccupancyParams({ semanas: "12", tab: ["pasado", "x"] }).weeks).toBe(12);
    expect(parseOccupancyParams({ pro: "x".repeat(65) }).pro).toBeNull();
  });

  it("«Lo que pasó» = semanas completas lun→dom AR, sin la semana en curso", () => {
    const w = occupancyWindow("pasado", 4, "2027-11-10");
    expect(w.fromKey).toBe("2027-10-11");
    expect(w.toKey).toBe("2027-11-08");
    expect(w.from.toISOString()).toBe("2027-10-11T03:00:00.000Z");
    expect(w.to.toISOString()).toBe("2027-11-08T03:00:00.000Z");
  });

  it("«Lo que viene» = desde hoy AR, 7 × semanas días", () => {
    const w = occupancyWindow("proximo", 2, "2027-11-10");
    expect(w.fromKey).toBe("2027-11-10");
    expect(w.toKey).toBe("2027-11-24");
  });
});

const hold = (o: { createdAt: Date; pub: boolean; patientId?: string | null }) => ({
  status: "PENDING",
  paymentStatus: "UNPAID",
  createdAt: o.createdAt,
  patientId: o.patientId === undefined ? "pat-1" : o.patientId,
  idempotencyKey: o.pub ? "pub:t-1:3f1c" : "8d1e6c1c-5c1e-4b2a-9d3e-0e1f2a3b4c5d",
});

describe("[AS-3h] conteo y holds", () => {
  it("reserva pública vencida afuera; vigente y la de la recepción (key no pública) adentro", () => {
    const rows: OccupancySqlRow[] = [
      { day: null, dow: 2, hour: 10, q: null, n: 3, hold: null },
      { day: null, dow: 2, hour: 10, q: null, n: 1, hold: hold({ createdAt: ar("2027-11-10T13:00"), pub: true }) },
      { day: null, dow: 2, hour: 10, q: null, n: 1, hold: hold({ createdAt: ar("2027-11-10T14:45"), pub: true }) },
      { day: null, dow: 2, hour: 10, q: null, n: 1, hold: hold({ createdAt: ar("2027-11-01T09:00"), pub: false }) },
    ];
    expect(countOccupancyBuckets(rows, NOW).get("2|10|")).toBe(5);
  });

  it("promedio = turnos / semanas (también las semanas vacías), una decimal con coma", () => {
    const rows: OccupancySqlRow[] = [{ day: null, dow: 2, hour: 10, q: null, n: 3, hold: null }];
    const t = buildPastTable(rows, {
      weeks: 4,
      now: NOW,
      fromKey: "2027-10-11",
      toKey: "2027-11-08",
      businessHours: { start: 8, end: 19 },
    });
    const ci = t.columns.findIndex((c) => c.key === "2");
    const cell = t.rows.find((r) => r.hour === 10)!.cells[ci];
    expect(cell.value).toBe(0.75);
    expect(cell.text).toBe("0,8");
    expect(cell.level).toBe(5);
    expect(t.columns.map((c) => c.short)).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]); // sin domingo vacío
    expect(t.rows[0].label).toBe("08:00");
    expect(t.rows.at(-1)!.label).toBe("18:00");
    expect(t.caption).toContain("del 11/10 al 07/11");
  });

  it("formato y niveles", () => {
    expect(formatOccupancyAverage(0)).toBe("0");
    expect(formatOccupancyAverage(2)).toBe("2");
    expect(formatOccupancyAverage(1 / 12)).toBe("0,1");
    expect(formatOccupancyAverage(1.25)).toBe("1,3");
    expect(occupancyLevel(0, 10)).toBe(0);
    expect(occupancyLevel(1, 10)).toBe(1);
    expect(occupancyLevel(5, 10)).toBe(3);
    expect(occupancyLevel(10, 10)).toBe(5);
  });
});

describe("[AS-3h] tope por intervalo en la tabla por hora", () => {
  it("intervalo 60 → «x/tope» y en el tope desde x = tope", () => {
    expect(upcomingCell([1, 0, 0, 0], { count: 2, intervalMin: 60 }, 4)).toMatchObject({ text: "1/2", atCap: false });
    expect(upcomingCell([1, 1, 0, 0], { count: 2, intervalMin: 60 }, 4)).toMatchObject({ text: "2/2", atCap: true });
    expect(upcomingCell([2, 1, 0, 0], { count: 2, intervalMin: 60 }, 4).note).toMatch(/sobreturnos/);
  });

  it("intervalo 15/30 → conteo de la hora y marca si ALGÚN intervalo llegó", () => {
    // 2+1+1+1 con tope 2 cada 15': un intervalo topeado.
    const a = upcomingCell([2, 1, 1, 1], { count: 2, intervalMin: 15 }, 5);
    expect(a).toMatchObject({ text: "5", atCap: true });
    expect(a.note).toMatch(/1 de 4 intervalos de 15 min/);
    // 1+1+1+1 con tope 2 cada 15': ninguno.
    expect(upcomingCell([1, 1, 1, 1], { count: 2, intervalMin: 15 }, 5).atCap).toBe(false);
    // Con 30': 1+1 | 0+1 y tope 2 → la primera media hora topeó.
    const b = upcomingCell([1, 1, 0, 1], { count: 2, intervalMin: 30 }, 5);
    expect(b.atCap).toBe(true);
    expect(b.note).toMatch(/1 de 2 intervalos de 30 min/);
    // Sin tope: solo el número.
    expect(upcomingCell([3, 0, 0, 0], null, 3)).toMatchObject({ text: "3", atCap: false, note: null });
  });

  it("[T3-Z M6] con intervalo < 60 la celda NO se pinta como topeada (solo ▲) y la nota dice el tope", () => {
    // La hora tiene 5 turnos pero solo UN intervalo de 15' llegó: pintarla entera de «en el tope» mentía.
    const a = upcomingCell([2, 1, 1, 1], { count: 2, intervalMin: 15 }, 5);
    expect(a).toMatchObject({ atCap: true, capFill: false });
    expect(a.note).toBe("En 1 de 4 intervalos de 15 min se llegó al tope de 2 turnos.");
    const b = upcomingCell([1, 1, 0, 1], { count: 2, intervalMin: 30 }, 5);
    expect(b.note).toBe("En 1 de 2 intervalos de 30 min se llegó al tope de 2 turnos.");
    // Con 60 la hora ES el intervalo: ahí sí se pinta.
    expect(upcomingCell([1, 1, 0, 0], { count: 2, intervalMin: 60 }, 4)).toMatchObject({ atCap: true, capFill: true });
    expect(upcomingCell([1, 0, 0, 0], { count: 2, intervalMin: 60 }, 4).capFill).toBe(false);
  });

  it("«Lo que viene»: una tabla por semana, columnas por fecha AR y domingo solo con turnos", () => {
    const rows: OccupancySqlRow[] = [
      { day: "2027-11-11", dow: 4, hour: 10, q: 0, n: 2, hold: null },
      { day: "2027-11-21", dow: 7, hour: 9, q: 1, n: 1, hold: null },
    ];
    const tables = buildUpcomingTables(rows, {
      weeks: 2,
      now: NOW,
      fromKey: "2027-11-10",
      cap: { count: 2, intervalMin: 15 },
      businessHours: { start: 8, end: 19 },
    });
    expect(tables).toHaveLength(2);
    expect(tables[0].columns[0].short).toBe("Mié 10/11");
    expect(tables[0].columns.some((c) => c.key === "2027-11-14")).toBe(false); // domingo vacío
    expect(tables[1].columns.some((c) => c.key === "2027-11-21")).toBe(true);
    const ci = tables[0].columns.findIndex((c) => c.key === "2027-11-11");
    expect(tables[0].rows.find((r) => r.hour === 10)!.cells[ci]).toMatchObject({ text: "2", atCap: true });
    expect(tables[0].caption).toContain("tope: 2 cada 15 min");
  });
});
