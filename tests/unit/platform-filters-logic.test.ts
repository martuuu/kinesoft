import { describe, it, expect } from "vitest";
import { activeFilterCount, filtersButtonLabel } from "@/components/plataforma/filters-logic";

describe("[MB-1f] filtros de Plataforma en el celular", () => {
  it("cuenta solo los valores no vacíos", () => {
    expect(activeFilterCount([])).toBe(0);
    expect(activeFilterCount(["", null, undefined, false])).toBe(0);
    expect(activeFilterCount(["movare", "", "SUSPENDED", null])).toBe(2);
    expect(activeFilterCount([0, true])).toBe(2);
  });

  it("rótulo «Filtros» / «Filtros (n)»", () => {
    expect(filtersButtonLabel(0)).toBe("Filtros");
    expect(filtersButtonLabel(3)).toBe("Filtros (3)");
  });
});
