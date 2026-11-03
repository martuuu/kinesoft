import { describe, expect, it } from "vitest";
import {
  AGENDA_VIEWS,
  initialPractitionerSelection,
  isDayScoped,
  monthGridRange,
  resolveAgendaView,
  scopeHeadingOf,
  segmentOf,
  shiftMonthDay,
  showModeToggle,
  viewForSegment,
} from "@/lib/agenda-client-state";
import { dowOfDayKey } from "@/lib/availability/day";

// CF2 A-K (plan §29 D-CF2-1, D-CF2-2, D-CF2-7; brief A.1 y A.4 «Cliente»): selección inicial de profesionales,
// título de alcance de la agenda y la aritmética de la vista Mes. Puros: corre en TZ=UTC (npm test) y en TZ=AR
// (npm run test:tz-ar); nada depende de la TZ del host (DayKeys de calendario).

const VALID = ["p1", "p2", "p3"];

describe("[CF2-AK1] initialPractitionerSelection: URL > guardada > rol", () => {
  const base = { url: {}, saved: undefined, ownPractitionerId: null, validIds: VALID };

  it("?pros= válido gana sobre la guardada y el rol", () => {
    const r = initialPractitionerSelection({ ...base, url: { pros: "p2" }, saved: ["p3"], ownPractitionerId: "p1" });
    expect(r).toEqual({ ids: ["p2"], source: "url" });
  });

  it("?pros= con ids desconocidos se limpia; todos inválidos cae al ?practitioner= legado", () => {
    expect(initialPractitionerSelection({ ...base, url: { pros: "zz,p3,p3" } })).toEqual({ ids: ["p3"], source: "url" });
    expect(initialPractitionerSelection({ ...base, url: { pros: "zz", practitioner: "p1" }, saved: ["p2"] })).toEqual({
      ids: ["p1"],
      source: "url",
    });
  });

  it("URL toda inválida cae a la guardada", () => {
    const r = initialPractitionerSelection({ ...base, url: { pros: "zz", practitioner: "yy" }, saved: ["p2", "p3"] });
    expect(r).toEqual({ ids: ["p2", "p3"], source: "saved" });
  });

  it("guardada: se filtra a los válidos; [] = eligió «Todos» (no cae al rol)", () => {
    expect(initialPractitionerSelection({ ...base, saved: ["gone", "p3"] })).toEqual({ ids: ["p3"], source: "saved" });
    expect(initialPractitionerSelection({ ...base, saved: [], ownPractitionerId: "p1" })).toEqual({
      ids: [],
      source: "saved",
    });
  });

  it("guardada con todos inválidos = nunca eligió → rol", () => {
    expect(initialPractitionerSelection({ ...base, saved: ["gone"], ownPractitionerId: "p1" })).toEqual({
      ids: ["p1"],
      source: "default",
    });
  });

  it("rol: profesional en consultorio multi → su agenda; Secretaria/resto → Todos", () => {
    expect(initialPractitionerSelection({ ...base, ownPractitionerId: "p2" })).toEqual({ ids: ["p2"], source: "default" });
    expect(initialPractitionerSelection(base)).toEqual({ ids: [], source: "default" });
    // Un profesional que no está entre los válidos (archivado) no se autoselecciona.
    expect(initialPractitionerSelection({ ...base, ownPractitionerId: "gone" })).toEqual({ ids: [], source: "default" });
  });

  it("consultorio de un profesional: siempre [] (cubre a todos)", () => {
    expect(initialPractitionerSelection({ ...base, validIds: ["p1"], ownPractitionerId: "p1" })).toEqual({
      ids: [],
      source: "default",
    });
  });

  it("si la selección cubre a todos colapsa a [] (URL y guardada)", () => {
    expect(initialPractitionerSelection({ ...base, url: { pros: "p3,p1,p2" } })).toEqual({ ids: [], source: "url" });
    expect(initialPractitionerSelection({ ...base, saved: ["p1", "p2", "p3", "gone"] })).toEqual({
      ids: [],
      source: "saved",
    });
  });
});

describe("[CF2-AK2] scopeHeadingOf: título de alcance", () => {
  const people = [
    { id: "p1", name: "Laura Pérez", initials: "LP" },
    { id: "p2", name: "Martín Gómez", initials: "MG" },
    { id: "p3", name: "Ana Rodríguez", initials: "AR" },
    { id: "p4", name: "Sofía Díaz", initials: "SD" },
    { id: "p5", name: "Juan Carlos López", initials: "JL" },
  ];
  const h = (selectedIds: string[], ownPractitionerId: string | null = null, view: "timeline" | "room" | "week" | "month" = "timeline") =>
    scopeHeadingOf({ view, selectedIds, ordered: people, ownPractitionerId });

  it("propia: «Tu agenda · Laura Pérez»", () => {
    expect(h(["p1"], "p1")).toEqual({ kind: "one", title: "Tu agenda · Laura Pérez", people: [people[0]] });
  });

  it("de otro: «Agenda de Laura Pérez»", () => {
    expect(h(["p1"], "p2")).toEqual({ kind: "one", title: "Agenda de Laura Pérez", people: [people[0]] });
  });

  it("dos: «Agenda de Laura Pérez y Martín Gómez», en el orden de la agenda", () => {
    expect(h(["p2", "p1"])).toEqual({
      kind: "some",
      title: "Agenda de Laura Pérez y Martín Gómez",
      people: [people[0], people[1]],
    });
  });

  it("3+: «3 profesionales: Laura P., Martín G., Ana R.»", () => {
    const r = h(["p3", "p1", "p2"]);
    expect(r?.kind).toBe("some");
    expect(r?.title).toBe("3 profesionales: Laura P., Martín G., Ana R.");
    expect(r?.people.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    // Nombre compuesto: primer nombre + inicial del apellido.
    expect(h(["p1", "p2", "p5"])?.title).toBe("3 profesionales: Laura P., Martín G., Juan L.");
  });

  it("vacía o todos: «Todos los profesionales (5)»", () => {
    expect(h([])).toEqual({ kind: "all", title: "Todos los profesionales (5)", people });
    expect(h(["p1", "p2", "p3", "p4", "p5"])?.kind).toBe("all");
    // Ids que ya no están en la agenda se ignoran; si no queda ninguno = todos.
    expect(h(["gone"])?.title).toBe("Todos los profesionales (5)");
    expect(h(["gone", "p2"])?.title).toBe("Agenda de Martín Gómez");
  });

  it("Por sala ignora la selección: «Por sala · todos los profesionales»", () => {
    expect(h(["p1"], "p1", "room")).toEqual({ kind: "room", title: "Por sala · todos los profesionales", people });
  });

  it("Semana y Mes usan la misma regla que el Día", () => {
    expect(h(["p1"], "p1", "week")?.title).toBe("Tu agenda · Laura Pérez");
    expect(h([], null, "month")?.kind).toBe("all");
  });

  it("consultorio de un profesional → null (markup igual que hoy)", () => {
    expect(scopeHeadingOf({ view: "timeline", selectedIds: [], ordered: [people[0]], ownPractitionerId: "p1" })).toBeNull();
    expect(scopeHeadingOf({ view: "room", selectedIds: [], ordered: [people[0]], ownPractitionerId: null })).toBeNull();
    expect(scopeHeadingOf({ view: "timeline", selectedIds: [], ordered: [], ownPractitionerId: null })).toBeNull();
  });
});

describe("[CF2-AK3] vista Mes: resolución, segmento y alcance", () => {
  const ctx = { mode: "day" as const, practitionerCount: 3, canReception: true };

  it("`month` es una vista válida de la URL", () => {
    expect(AGENDA_VIEWS).toContain("month");
    expect(resolveAgendaView("month", ctx)).toBe("month");
    expect(resolveAgendaView("month", { ...ctx, practitionerCount: 1, canReception: false })).toBe("month");
  });

  it("segmento «month», no es de un día y no muestra el toggle de modo", () => {
    expect(segmentOf("month")).toBe("month");
    expect(viewForSegment("month", ctx)).toBe("month");
    expect(isDayScoped("month")).toBe(false);
    expect(showModeToggle("month", 3, 2)).toBe(false);
  });
});

describe("[CF2-AK4] monthGridRange: lunes a domingo que cubren el mes", () => {
  it("noviembre 2026: 1 = domingo → arranca lun 26-oct, 6 semanas", () => {
    expect(monthGridRange("2026-11-15")).toEqual({ monthKey: "2026-11", from: "2026-10-26", to: "2026-12-06", weeks: 6 });
  });

  it("febrero 2021 (28 días, 1 = lunes): 4 semanas exactas", () => {
    expect(monthGridRange("2021-02-10")).toEqual({ monthKey: "2021-02", from: "2021-02-01", to: "2021-02-28", weeks: 4 });
  });

  it("octubre 2026 (1 = jueves): 5 semanas", () => {
    expect(monthGridRange("2026-10-31")).toEqual({ monthKey: "2026-10", from: "2026-09-28", to: "2026-11-01", weeks: 5 });
  });

  it("febrero bisiesto 2028 y cruce de año (diciembre 2026)", () => {
    expect(monthGridRange("2028-02-29")).toEqual({ monthKey: "2028-02", from: "2028-01-31", to: "2028-03-05", weeks: 5 });
    expect(monthGridRange("2026-12-01")).toEqual({ monthKey: "2026-12", from: "2026-11-30", to: "2027-01-03", weeks: 5 });
  });

  it("siempre lunes→domingo y ≤ 42 días para todo 2026-2028", () => {
    for (let y = 2026; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        const r = monthGridRange(`${y}-${String(m).padStart(2, "0")}-01`);
        expect(dowOfDayKey(r.from)).toBe(1);
        expect(dowOfDayKey(r.to)).toBe(0);
        expect([4, 5, 6]).toContain(r.weeks);
      }
    }
  });
});

describe("[CF2-AK5] shiftMonthDay: ±N meses con clamp al último día", () => {
  it("31-ene +1 → 28-feb (no bisiesto) / 29-feb (bisiesto)", () => {
    expect(shiftMonthDay("2027-01-31", 1)).toBe("2027-02-28");
    expect(shiftMonthDay("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("cruza años en las dos direcciones", () => {
    expect(shiftMonthDay("2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftMonthDay("2026-01-15", -1)).toBe("2025-12-15");
    expect(shiftMonthDay("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonthDay("2026-05-31", 13)).toBe("2027-06-30");
    expect(shiftMonthDay("2026-05-31", -17)).toBe("2024-12-31");
  });

  it("delta 0 devuelve el mismo día", () => {
    expect(shiftMonthDay("2026-11-02", 0)).toBe("2026-11-02");
  });
});
