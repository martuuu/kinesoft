import { describe, it, expect } from "vitest";
import {
  monthCellModel,
  monthDayAriaLabel,
  monthGridModel,
  monthLabel,
  monthLockToState,
  monthPractitionerCounts,
  monthSummaryMatches,
  type MonthCellContext,
} from "@/lib/agenda-month-view-state";
import { monthGridRange } from "@/lib/agenda-client-state";
import { dayKeyRange } from "@/lib/availability/day";
import type { AgendaMonthDay, AgendaMonthSummary } from "@/lib/agenda-month-types";

/**
 * [CF2-MV] D-CF2-7 (plan §29, brief A.4): modelo PURO de la celda de la vista Mes. El resumen del server trae, por día y
 * por profesional, `[turnos, ausentes]` y el candado; la celda suma solo los profesionales elegidos (resta ausentes si
 * se ocultan) y agrega el candado con `aggregateDayLock` sobre los visibles (los que no atienden no cuentan).
 * Aritmética sobre DayKeys: corre igual en TZ=UTC (lo que importa en Vercel) y en AR.
 */

const PRACS = [
  { id: "p1", name: "Laura Pérez", initials: "LP" },
  { id: "p2", name: "Martín Gómez", initials: "MG" },
  { id: "p3", name: "Ana Ruiz", initials: "AR" },
];

const ctx = (over: Partial<MonthCellContext> = {}): MonthCellContext => ({
  monthKey: "2026-11",
  todayKey: "2026-11-02",
  selectedIds: [],
  practitioners: PRACS,
  hideNoShow: false,
  ...over,
});

// Martes 3 de noviembre de 2026.
const TUE: AgendaMonthDay = {
  k: "2026-11-03",
  c: { p1: [5, 1], p2: [7, 2], p3: [3, 0] },
};

describe("[CF2-MV1] cantidad de la celda", () => {
  it("[CF2-MV1a] con «Todos» suma todos los profesionales (ausentes incluidos si se muestran)", () => {
    expect(monthCellModel(TUE, ctx()).count).toBe(15);
  });

  it("[CF2-MV1b] suma solo los elegidos", () => {
    expect(monthCellModel(TUE, ctx({ selectedIds: ["p1", "p3"] })).count).toBe(8);
    expect(monthCellModel(TUE, ctx({ selectedIds: ["p2"] })).count).toBe(7);
  });

  it("[CF2-MV1c] con los ausentes ocultos los resta", () => {
    expect(monthCellModel(TUE, ctx({ hideNoShow: true })).count).toBe(12);
    expect(monthCellModel(TUE, ctx({ selectedIds: ["p2"], hideNoShow: true })).count).toBe(5);
  });

  it("[CF2-MV1d] día sin `c` = 0; un id elegido que no vino en el resumen no suma", () => {
    expect(monthCellModel({ k: "2026-11-04" }, ctx()).count).toBe(0);
    expect(monthCellModel(TUE, ctx({ selectedIds: ["p-otro"] })).count).toBe(0);
  });

  it("[CF2-MV1e] «Todos» también cuenta turnos de un profesional fuera de la lista (como Semana: el filtro vacío deja pasar todo)", () => {
    const day: AgendaMonthDay = { k: "2026-11-03", c: { p1: [2, 0], p2: [1, 0], "p-viejo": [1, 0] } };
    const m = monthCellModel(day, ctx());
    expect(m.count).toBe(4);
    // Sin iniciales que mostrar para el que no está en la lista.
    expect(m.perPractitioner.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("[CF2-MV1f] desglose por profesional (orden de la lista, solo con turnos) si hay varios visibles; con uno, vacío", () => {
    const m = monthCellModel(TUE, ctx({ hideNoShow: true }));
    expect(m.perPractitioner).toEqual([
      { id: "p1", name: "Laura Pérez", initials: "LP", count: 4 },
      { id: "p2", name: "Martín Gómez", initials: "MG", count: 5 },
      { id: "p3", name: "Ana Ruiz", initials: "AR", count: 3 },
    ]);
    expect(monthCellModel(TUE, ctx({ selectedIds: ["p1"] })).perPractitioner).toEqual([]);
    const sparse: AgendaMonthDay = { k: "2026-11-03", c: { p2: [1, 1] } };
    expect(monthCellModel(sparse, ctx({ hideNoShow: true })).perPractitioner).toEqual([]);
  });
});

describe("[CF2-MV2] candado agregado sobre los visibles", () => {
  it("[CF2-MV2a] códigos del cable → DayLockState del motor", () => {
    expect(monthLockToState(undefined, undefined).status).toBe("open");
    expect(monthLockToState("p", "Reunión")).toMatchObject({ status: "partial", reason: "bloqueo", detail: "Reunión" });
    expect(monthLockToState("l", "Vacaciones")).toMatchObject({ status: "locked", detail: "Vacaciones" });
    expect(monthLockToState("x", undefined)).toMatchObject({ status: "locked", reason: "sin-franjas" });
  });

  it("[CF2-MV2b] todos los que atienden bloqueados → bloqueado (el que no atiende no cuenta)", () => {
    const day: AgendaMonthDay = { k: "2026-11-03", l: { p1: "l", p2: "l", p3: "x" }, d: { p1: "Vacaciones" } };
    expect(monthCellModel(day, ctx()).lock).toEqual({ status: "locked", detail: "Vacaciones" });
  });

  it("[CF2-MV2c] uno bloqueado y otro abierto → parcial; si el abierto no está elegido → bloqueado", () => {
    const day: AgendaMonthDay = { k: "2026-11-03", l: { p1: "l" }, d: { p1: "Congreso" } };
    expect(monthCellModel(day, ctx()).lock.status).toBe("partial");
    expect(monthCellModel(day, ctx({ selectedIds: ["p1"] })).lock).toEqual({ status: "locked", detail: "Congreso" });
    expect(monthCellModel(day, ctx({ selectedIds: ["p2", "p3"] })).lock.status).toBe("open");
  });

  it("[CF2-MV2d] nadie de los visibles atiende → «sin atención» (off)", () => {
    const day: AgendaMonthDay = { k: "2026-11-08", l: { p1: "x", p2: "x", p3: "x" } };
    expect(monthCellModel(day, ctx()).lock.status).toBe("off");
    const some: AgendaMonthDay = { k: "2026-11-08", l: { p1: "x" } };
    expect(monthCellModel(some, ctx({ selectedIds: ["p1"] })).lock.status).toBe("off");
    expect(monthCellModel(some, ctx()).lock.status).toBe("open");
  });

  it("[CF2-MV2e] parcial de uno → parcial con su motivo", () => {
    const day: AgendaMonthDay = { k: "2026-11-03", l: { p2: "p" }, d: { p2: "Reunión" } };
    expect(monthCellModel(day, ctx()).lock).toEqual({ status: "partial", detail: "Reunión" });
  });
});

describe("[CF2-MV3] aria-label y marcas de la celda", () => {
  it("[CF2-MV3a] el texto del brief: «Martes 3 de noviembre: 12 turnos, bloqueado: Vacaciones. Ver el día»", () => {
    expect(
      monthDayAriaLabel({
        key: "2026-11-03",
        isToday: false,
        count: 12,
        perPractitioner: [],
        lock: { status: "locked", detail: "Vacaciones" },
      })
    ).toBe("Martes 3 de noviembre: 12 turnos, bloqueado: Vacaciones. Ver el día");
  });

  it("[CF2-MV3b] singular, sin turnos, parcial, sin atención, hoy y desglose", () => {
    const base = { key: "2026-11-02", isToday: false, perPractitioner: [] as never[] };
    expect(monthDayAriaLabel({ ...base, count: 1, lock: { status: "open", detail: null } })).toBe(
      "Lunes 2 de noviembre: 1 turno. Ver el día"
    );
    expect(monthDayAriaLabel({ ...base, count: 0, lock: { status: "partial", detail: "Reunión" } })).toBe(
      "Lunes 2 de noviembre: sin turnos, bloqueado en parte: Reunión. Ver el día"
    );
    expect(monthDayAriaLabel({ ...base, count: 0, lock: { status: "off", detail: null } })).toBe(
      "Lunes 2 de noviembre: sin turnos, sin atención. Ver el día"
    );
    expect(monthDayAriaLabel({ ...base, isToday: true, count: 0, lock: { status: "locked", detail: null } })).toBe(
      "Hoy, lunes 2 de noviembre: sin turnos, bloqueado. Ver el día"
    );
    expect(
      monthDayAriaLabel({
        ...base,
        count: 9,
        lock: { status: "open", detail: null },
        perPractitioner: [
          { id: "p1", name: "Laura Pérez", initials: "LP", count: 4 },
          { id: "p2", name: "Martín Gómez", initials: "MG", count: 5 },
        ],
      })
    ).toBe("Lunes 2 de noviembre: 9 turnos (Laura Pérez 4, Martín Gómez 5). Ver el día");
  });

  it("[CF2-MV3c] la celda trae hoy, fuera del mes, día y aria-label armado", () => {
    const today = monthCellModel({ k: "2026-11-02" }, ctx());
    expect(today).toMatchObject({ isToday: true, inMonth: true, day: 2, dow: 0 });
    expect(today.ariaLabel).toBe("Hoy, lunes 2 de noviembre: sin turnos. Ver el día");
    const prev = monthCellModel({ k: "2026-10-26" }, ctx());
    expect(prev).toMatchObject({ isToday: false, inMonth: false, day: 26, dow: 0 });
    expect(prev.ariaLabel).toBe("Lunes 26 de octubre: sin turnos. Ver el día");
    expect(monthCellModel({ k: "2026-11-08" }, ctx()).dow).toBe(6);
  });

  it("[CF2-MV3d] título del mes sin depender de la TZ del host", () => {
    expect(monthLabel("2026-11")).toBe("noviembre de 2026");
    expect(monthLabel("2027-01")).toBe("enero de 2027");
  });
});

function summaryOf(dayKey: string, extra: Record<string, Partial<AgendaMonthDay>> = {}): AgendaMonthSummary {
  const r = monthGridRange(dayKey);
  return {
    from: r.from,
    to: r.to,
    locationId: null,
    days: dayKeyRange(r.from, r.to).map((k) => ({ k, ...(extra[k] ?? {}) })),
  };
}

describe("[CF2-MV4] grilla, conteos de chips y coincidencia del resumen", () => {
  it("[CF2-MV4a] noviembre 2026 = 6 semanas lun-dom; sáb/dom según prefs", () => {
    const s = summaryOf("2026-11-15");
    const all = monthGridModel(s, { ...ctx(), showSaturday: true, showSunday: true });
    expect(all.columns).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(all.weeks).toHaveLength(6);
    expect(all.weeks[0].map((c) => c.key)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    const noWeekend = monthGridModel(s, { ...ctx(), showSaturday: false, showSunday: false });
    expect(noWeekend.columns).toEqual([0, 1, 2, 3, 4]);
    expect(noWeekend.weeks[0].map((c) => c.key)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);
    const sunOnly = monthGridModel(s, { ...ctx(), showSaturday: false, showSunday: true });
    expect(sunOnly.columns).toEqual([0, 1, 2, 3, 4, 6]);
  });

  it("[CF2-MV4b] total del mes: solo días del mes y elegidos", () => {
    const s = summaryOf("2026-11-15", {
      "2026-10-31": { c: { p1: [9, 0] } },
      "2026-11-03": { c: { p1: [5, 1], p2: [7, 2] } },
      "2026-11-30": { c: { p2: [1, 0] } },
    });
    const m = monthGridModel(s, { ...ctx({ selectedIds: ["p2"] }), showSaturday: true, showSunday: true });
    expect(m.monthTotal).toBe(8);
  });

  it("[CF2-MV4c] conteos de los chips: días del mes, todos los profesionales, ausentes restados si se ocultan", () => {
    const s = summaryOf("2026-11-15", {
      "2026-10-31": { c: { p1: [9, 0] } },
      "2026-11-03": { c: { p1: [5, 1], p2: [7, 2] } },
      "2026-11-30": { c: { p2: [1, 0] } },
    });
    expect(monthPractitionerCounts(s, { monthKey: "2026-11", hideNoShow: false })).toEqual({ p1: 5, p2: 8 });
    expect(monthPractitionerCounts(s, { monthKey: "2026-11", hideNoShow: true })).toEqual({ p1: 4, p2: 6 });
  });

  it("[CF2-MV4d] el resumen sirve solo si coincide rango y sede", () => {
    const s = summaryOf("2026-11-15");
    const r = monthGridRange("2026-11-15");
    expect(monthSummaryMatches(s, { from: r.from, to: r.to, locationId: null })).toBe(true);
    expect(monthSummaryMatches(s, { from: r.from, to: r.to, locationId: "loc-1" })).toBe(false);
    const dic = monthGridRange("2026-12-01");
    expect(monthSummaryMatches(s, { from: dic.from, to: dic.to, locationId: null })).toBe(false);
    expect(monthSummaryMatches(null, { from: r.from, to: r.to, locationId: null })).toBe(false);
  });
});
