import { describe, expect, it } from "vitest";
import { formatLeadTime, leadFromParts, leadToParts } from "@/lib/lead-time";

// CF-D8: la anticipación del consultorio se guarda en minutos (0..80 640) y la UI la edita en horas/días/semanas.
// La ida y vuelta tiene que ser exacta: si `leadToParts` eligiera una unidad que no divide, el form reescribiría
// el valor guardado al abrir y cerrar sin tocar nada.
describe("[CF-C2] lead-time", () => {
  it.each([
    [60, { value: 1, unit: "hours" }],
    [120, { value: 2, unit: "hours" }],
    [90 * 60, { value: 90, unit: "hours" }],
    [1440, { value: 1, unit: "days" }],
    [2880, { value: 2, unit: "days" }],
    [36 * 60, { value: 36, unit: "hours" }],
    [10080, { value: 1, unit: "weeks" }],
    [80_640, { value: 8, unit: "weeks" }],
    [0, { value: 0, unit: "hours" }],
  ] as const)("leadToParts(%i) = mayor unidad exacta", (min, parts) => {
    expect(leadToParts(min)).toEqual(parts);
    expect(leadFromParts(parts.value, parts.unit)).toBe(min);
  });

  it("ida y vuelta en todo el rango de horas enteras", () => {
    for (let h = 0; h <= 80_640 / 60; h++) {
      const p = leadToParts(h * 60);
      expect(leadFromParts(p.value, p.unit)).toBe(h * 60);
    }
  });

  it("minutos sueltos (no múltiplo de hora) se redondean hacia arriba a horas", () => {
    // Un valor viejo de PS (minutos sueltos) no se puede mostrar en horas sin perder: se muestra el techo.
    expect(leadToParts(90)).toEqual({ value: 2, unit: "hours" });
  });

  it("leadFromParts", () => {
    expect(leadFromParts(3, "hours")).toBe(180);
    expect(leadFromParts(2, "days")).toBe(2880);
    expect(leadFromParts(1, "weeks")).toBe(10080);
  });

  it.each([
    [0, "sin anticipación"],
    [60, "1 hora"],
    [120, "2 horas"],
    [1440, "1 día"],
    [2880, "2 días"],
    [10080, "1 semana"],
    [20160, "2 semanas"],
    [36 * 60, "36 horas"],
    [30, "30 minutos"],
    [1, "1 minuto"],
  ] as const)("formatLeadTime(%i) = %s", (min, txt) => {
    expect(formatLeadTime(min)).toBe(txt);
  });
});
