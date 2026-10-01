import { describe, it, expect } from "vitest";
import { formatMoneyInput, parseMoneyInput } from "@/lib/format";

// A2b-S-cfg — núcleo puro de <MoneyInput>. Los bugs que cierra: el copago de
// $50 que la validación `step=100` del input numérico rechazaba (el turno no
// se creaba) y el ×100 de leer "1500.5" con el "." como separador de miles.

const cents = (s: string) => {
  const r = parseMoneyInput(s);
  return r.ok ? r.cents : "invalid";
};

describe("parseMoneyInput", () => {
  it("parsea el formato AR a centavos exactos", () => {
    expect(cents("1.500,50")).toBe(150050);
    expect(cents("2750")).toBe(275000);
    expect(cents("1.500")).toBe(150000);
    expect(cents("1.500.000")).toBe(150000000);
    expect(cents("12,5")).toBe(1250);
    expect(cents("0,29")).toBe(29); // float: 0.29*100 = 28.999…
    expect(cents("$ 2.000")).toBe(200000);
    expect(cents(" 1.234,56 ")).toBe(123456);
  });

  it("acepta montos chicos que el step del input numérico bloqueaba", () => {
    expect(cents("50")).toBe(5000);
    expect(cents("0")).toBe(0);
  });

  it("toma un único punto con 1-2 decimales como decimal (teclado numérico / pegado)", () => {
    expect(cents("1500.5")).toBe(150050);
    expect(cents("12.50")).toBe(1250);
    // …y no como miles: el bug ×100.
    expect(cents("1500.5")).not.toBe(15005 * 100);
  });

  it("vacío es válido y vale null (distinto de 0)", () => {
    expect(parseMoneyInput("")).toEqual({ ok: true, cents: null });
    expect(parseMoneyInput("   ")).toEqual({ ok: true, cents: null });
    expect(parseMoneyInput(null)).toEqual({ ok: true, cents: null });
  });

  it("rechaza lo que no entiende en vez de adivinar", () => {
    for (const bad of ["abc", "-5", "1,2,3", "1,555", "1.50,5", "1.5000", "12a", ",", ".", "1.2.3"]) {
      expect(parseMoneyInput(bad), bad).toEqual({ ok: false });
    }
  });

  it("rechaza montos fuera del rango seguro de enteros", () => {
    expect(parseMoneyInput("99999999999999")).toEqual({ ok: false });
    expect(cents("9999999999999")).toBe(999999999999900);
  });
});

describe("formatMoneyInput", () => {
  it("formatea centavos para el input", () => {
    expect(formatMoneyInput(150050)).toBe("1.500,50");
    expect(formatMoneyInput(275000)).toBe("2.750");
    expect(formatMoneyInput(5000)).toBe("50");
    expect(formatMoneyInput(5)).toBe("0,05");
    expect(formatMoneyInput(0)).toBe("0");
    expect(formatMoneyInput(null)).toBe("");
    expect(formatMoneyInput(undefined)).toBe("");
  });

  it("ida y vuelta: parse(format(c)) === c", () => {
    for (const c of [0, 1, 5, 99, 100, 5000, 150050, 275000, 123456789, 100_000_000]) {
      expect(cents(formatMoneyInput(c))).toBe(c);
    }
    expect(formatMoneyInput(cents("1.500,50") as number)).toBe("1.500,50");
    expect(formatMoneyInput(cents("2750") as number)).toBe("2.750");
    expect(cents(formatMoneyInput(null))).toBeNull();
  });
});
