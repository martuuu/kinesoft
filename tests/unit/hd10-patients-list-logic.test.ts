/**
 * HD-10 / HD-14 (PV §27) · lógica pura del directorio de pacientes (`lib/patients-list-logic.ts`).
 * Corre igual en TZ=UTC y en TZ=America/Argentina/Buenos_Aires: nada depende del TZ del host.
 */
import { describe, it, expect } from "vitest";
// CF2 (decisión 3): `directoryTotals` («con/sin plan») se borró; su reemplazo `directoryTotalsAll` vive en
// tests/unit/cf2-patients-logic.test.ts.
import {
  clampPatientsPage,
  dobBoundsForAge,
  isDirectoryVisible,
  normalizeAgeBound,
  normalizeDirectoryQuery,
  parseLastVisitBound,
  sortByDateKey,
} from "@/lib/patients-list-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { PARTICULAR_INSURER_KEY } from "@/lib/patients-os-filter";

const row = { firstName: "Ana", lastName: "Pérez", documentId: "30111222", currentCoverage: null };
const none = { clinicalFilter: false, maskedFilter: false };

describe("[HD-10] isDirectoryVisible (movido tal cual de listPatients)", () => {
  it("full siempre entra; admin entra salvo filtro clínico; basic no entra con filtro clínico ni enmascarado", () => {
    expect(isDirectoryVisible(row, "full", { clinicalFilter: true, maskedFilter: true })).toBe(true);
    expect(isDirectoryVisible(row, "admin", { ...none, maskedFilter: true })).toBe(true);
    expect(isDirectoryVisible(row, "admin", { ...none, clinicalFilter: true })).toBe(false);
    expect(isDirectoryVisible(row, "basic", { ...none, clinicalFilter: true })).toBe(false);
    expect(isDirectoryVisible(row, "basic", { ...none, maskedFilter: true })).toBe(false);
    expect(isDirectoryVisible(row, "basic", none)).toBe(true);
  });

  it("sin acceso en el mapa cuenta como basic", () => {
    expect(isDirectoryVisible(row, undefined, { ...none, clinicalFilter: true })).toBe(false);
    expect(isDirectoryVisible(row, undefined, none)).toBe(true);
  });

  it("q: una fila basic queda solo si matchea por nombre, apellido o DNI (no por email)", () => {
    expect(isDirectoryVisible(row, "basic", { ...none, qLower: "pér" })).toBe(true);
    expect(isDirectoryVisible(row, "basic", { ...none, qLower: "3011" })).toBe(true);
    expect(isDirectoryVisible(row, "basic", { ...none, qLower: "ana@mail" })).toBe(false);
    expect(isDirectoryVisible(row, "full", { ...none, qLower: "ana@mail" })).toBe(true);
  });

  it("?os=: decide la cobertura vigente, antes que el acceso (también para full)", () => {
    const osde = { ...row, currentCoverage: { insurerId: "ins-osde", insurerRef: { isParticular: false } } };
    expect(isDirectoryVisible(osde, "full", { ...none, insurerKey: "ins-osde" })).toBe(true);
    expect(isDirectoryVisible(osde, "full", { ...none, insurerKey: "ins-otra" })).toBe(false);
    expect(isDirectoryVisible(row, "full", { ...none, insurerKey: PARTICULAR_INSURER_KEY })).toBe(true);
    expect(isDirectoryVisible(osde, "full", { ...none, insurerKey: PARTICULAR_INSURER_KEY })).toBe(false);
  });
});

describe("[HD-14] dobBoundsForAge sobre el día AR, en UTC puro", () => {
  it("sin bordes → null", () => {
    expect(dobBoundsForAge("2026-10-27", undefined, undefined)).toBeNull();
  });

  it("edad exacta: nació entre el día siguiente de hace (max+1) años y hoy hace min años", () => {
    const b = dobBoundsForAge("2026-10-27", 26, 26)!;
    expect(b.lte!.toISOString()).toBe("2000-10-27T00:00:00.000Z");
    expect(b.gte!.toISOString()).toBe("1999-10-28T00:00:00.000Z");
  });

  it("23:30 AR = 02:30 UTC del día siguiente: el día que cuenta es el AR", () => {
    const now = new Date("2026-10-27T23:30:00-03:00");
    expect(toARDateKey(now)).toBe("2026-10-27");
    const b = dobBoundsForAge(toARDateKey(now), 26, undefined)!;
    // Nacido el 28-oct-2000 todavía no cumplió 26 en AR.
    expect(+new Date("2000-10-28T00:00:00Z") <= +b.lte!).toBe(false);
    expect(+new Date("2000-10-27T00:00:00Z") <= +b.lte!).toBe(true);
  });

  it("29 de febrero: se recorta al 28 en años no bisiestos (no desborda al 1-mar)", () => {
    const b = dobBoundsForAge("2028-02-29", 3, 4)!;
    expect(b.lte!.toISOString()).toBe("2025-02-28T00:00:00.000Z");
    // max 4 → hace 5 años = 2023-02-28 (recortado) + 1 día.
    expect(b.gte!.toISOString()).toBe("2023-03-01T00:00:00.000Z");
  });

  it("solo uno de los bordes", () => {
    expect(dobBoundsForAge("2026-01-01", 0, undefined)).toEqual({ lte: new Date("2026-01-01T00:00:00Z") });
    expect(dobBoundsForAge("2026-01-01", undefined, 0)).toEqual({ gte: new Date("2025-01-02T00:00:00Z") });
  });
});

describe("[HD-14] parseLastVisitBound", () => {
  it("from = 00:00 AR, to = 23:59:59.999 AR", () => {
    expect(parseLastVisitBound("2026-03-10", "from")!.toISOString()).toBe("2026-03-10T03:00:00.000Z");
    expect(parseLastVisitBound("2026-03-10", "to")!.toISOString()).toBe("2026-03-11T02:59:59.999Z");
  });

  it("lo que no es yyyy-mm-dd real se ignora", () => {
    for (const bad of ["", "2026-3-10", "2026-03-10T00:00", "2026-02-31", "2026-13-01", "hoy", "2026-03-10' OR 1=1"]) {
      expect(parseLastVisitBound(bad, "from")).toBeUndefined();
    }
    expect(parseLastVisitBound(undefined, "to")).toBeUndefined();
    expect(parseLastVisitBound("2028-02-29", "from")).toBeDefined();
  });
});

describe("[HD-10] normalización de la URL", () => {
  it("q: recortado a 100 y vacío = sin búsqueda", () => {
    expect(normalizeDirectoryQuery("  ana ")).toBe("ana");
    expect(normalizeDirectoryQuery("   ")).toBeUndefined();
    expect(normalizeDirectoryQuery(undefined)).toBeUndefined();
    expect(normalizeDirectoryQuery("x".repeat(300))).toHaveLength(100);
  });

  it("edad: entero en 0..130", () => {
    expect(normalizeAgeBound(undefined)).toBeUndefined();
    expect(normalizeAgeBound(Number.NaN)).toBeUndefined();
    expect(normalizeAgeBound(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeAgeBound(-3)).toBe(0);
    expect(normalizeAgeBound(400)).toBe(130);
    expect(normalizeAgeBound(30.9)).toBe(30);
  });
});

describe("[HD-10] clampPatientsPage", () => {
  it("recorta a [1, pageCount] y calcula el inicio", () => {
    expect(clampPatientsPage(120, 1, 50)).toEqual({ page: 1, pageCount: 3, start: 0 });
    expect(clampPatientsPage(120, 3, 50)).toEqual({ page: 3, pageCount: 3, start: 100 });
    expect(clampPatientsPage(120, 9, 50)).toEqual({ page: 3, pageCount: 3, start: 100 });
    expect(clampPatientsPage(120, 0, 50)).toEqual({ page: 1, pageCount: 3, start: 0 });
    expect(clampPatientsPage(120, Number.NaN, 50)).toEqual({ page: 1, pageCount: 3, start: 0 });
    expect(clampPatientsPage(120, 2.7, 50)).toEqual({ page: 2, pageCount: 3, start: 50 });
    expect(clampPatientsPage(0, 5, 50)).toEqual({ page: 1, pageCount: 1, start: 0 });
    expect(clampPatientsPage(50, 2, 50)).toEqual({ page: 1, pageCount: 1, start: 0 });
  });
});

describe("[HD-10] sortByDateKey", () => {
  const d = (iso: string) => new Date(iso);
  const items = [
    { id: "a", k: null },
    { id: "b", k: d("2026-01-02") },
    { id: "c", k: d("2026-01-01") },
    { id: "d", k: null },
    { id: "e", k: d("2026-01-02") },
  ];
  it("asc: null al final y empates estables", () => {
    expect(sortByDateKey(items, (x) => x.k, "asc").map((x) => x.id)).toEqual(["c", "b", "e", "a", "d"]);
  });
  it("desc: null al final y empates estables", () => {
    expect(sortByDateKey(items, (x) => x.k, "desc").map((x) => x.id)).toEqual(["b", "e", "c", "a", "d"]);
  });
  it("no muta la entrada", () => {
    const copy = items.map((x) => x.id);
    sortByDateKey(items, (x) => x.k, "asc");
    expect(items.map((x) => x.id)).toEqual(copy);
  });
});
