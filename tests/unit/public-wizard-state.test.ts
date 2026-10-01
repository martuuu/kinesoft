import { describe, expect, it } from "vitest";
import {
  attemptSignature,
  coverageInsurerPrefill,
  coverageOptions,
  durationFor,
  filterPractitioners,
  firstSlotQuery,
  formatLocationAddress,
  hasMultipleLocations,
  locationsForPractitioner,
  nextAttempt,
  nextDayKey,
  reconcileSelection,
  selectionFromFirstSlot,
  servicesForAny,
  servicesForPractitioner,
} from "@/lib/public-wizard-state";
import type { PublicClinic, PublicLocation } from "@/lib/public-booking-types";

// B5.6 — lógica pura del turnero público (sin DOM). El componente
// `components/booking/public-booking-wizard.tsx` usa exactamente estas
// funciones; acá se fija el contrato con el payload de `getPublicClinic` (B3.2).

const loc = (id: string, extra: Partial<PublicLocation> = {}): PublicLocation => ({
  id,
  name: `Sede ${id}`,
  address: null,
  addressLine2: null,
  city: null,
  province: null,
  isPrimary: false,
  ...extra,
});

const pro = (id: string, extra: Partial<PublicClinic["practitioners"][number]> = {}) => ({
  id,
  name: `Lic. ${id}`,
  specialty: null,
  licenseNumber: null,
  yearsExp: null,
  rating: null,
  ...extra,
});

const svc = (id: string, extra: Partial<PublicClinic["services"][number]> = {}) => ({
  id,
  name: `Servicio ${id}`,
  description: null,
  durationMin: 45,
  priceCents: 1_000_000,
  practitionerId: null,
  ...extra,
});

/** 3 profesionales, 2 sedes, Particular + 2 OS. */
function clinic(): PublicClinic {
  return {
    slug: "demo",
    name: "Demo",
    legalName: null,
    palette: "sky",
    practitioners: [
      pro("A", { locationIds: ["L1"], acceptedInsurerIds: ["PART", "OSDE"] }),
      pro("B", { locationIds: ["L1", "L2"], acceptedInsurerIds: ["PART", "OSDE", "SWISS"] }),
      pro("C", { locationIds: ["L2"], acceptedInsurerIds: ["PART"] }),
    ],
    services: [
      // Lo ofrecen A y B: el `practitionerId` legacy es null y el filtro viejo
      // se lo mostraba también a C (bug que cierra B5.6).
      svc("S-AB", { practitionerIds: ["A", "B"], durationByPractitioner: { A: 45, B: 60 } }),
      svc("S-C", { practitionerId: "C", practitionerIds: ["C"], durationByPractitioner: { C: 30 } }),
    ],
    locations: [loc("L1", { isPrimary: true, address: "Av. Pellegrini 1200", city: "Rosario" }), loc("L2")],
    insurers: [
      { id: "SWISS", name: "Swiss Medical", isParticular: false },
      { id: "PART", name: "Particular", isParticular: true },
      { id: "OSDE", name: "OSDE", isParticular: false },
    ],
  };
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("servicios por profesional (practitionerIds)", () => {
  it("filtra con practitionerIds, no con el practitionerId legacy", () => {
    const c = clinic();
    expect(ids(servicesForPractitioner(c, "A"))).toEqual(["S-AB"]);
    expect(ids(servicesForPractitioner(c, "B"))).toEqual(["S-AB"]);
    // Antes C veía S-AB (practitionerId null = "de todos").
    expect(ids(servicesForPractitioner(c, "C"))).toEqual(["S-C"]);
  });

  it("compat: sin practitionerIds usa practitionerId === elegido || null", () => {
    const c = clinic();
    c.services = [svc("X", { practitionerId: "A" }), svc("Y", { practitionerId: null })];
    expect(ids(servicesForPractitioner(c, "A"))).toEqual(["X", "Y"]);
    expect(ids(servicesForPractitioner(c, "B"))).toEqual(["Y"]);
  });

  it("duración por profesional, con fallback a la del servicio", () => {
    const s = clinic().services[0];
    expect(durationFor(s, "A")).toBe(45);
    expect(durationFor(s, "B")).toBe(60);
    expect(durationFor(s, "Z")).toBe(45);
    expect(durationFor(s, null)).toBe(45);
    expect(durationFor(svc("Q", { durationMin: 50 }), "A")).toBe(50);
  });

  it("modo cualquiera: servicios que ofrece al menos un profesional filtrado", () => {
    const c = clinic();
    expect(ids(servicesForAny(c, { insurerId: null, locationId: null }))).toEqual(["S-AB", "S-C"]);
    // Sede L1: A y B → solo S-AB.
    expect(ids(servicesForAny(c, { insurerId: null, locationId: "L1" }))).toEqual(["S-AB"]);
    // Swiss: solo B.
    expect(ids(servicesForAny(c, { insurerId: "SWISS", locationId: null }))).toEqual(["S-AB"]);
  });
});

describe("filtros de cobertura y sede", () => {
  it("cobertura filtra por acceptedInsurerIds; Particular la aceptan todos", () => {
    const c = clinic();
    expect(ids(filterPractitioners(c, { insurerId: null, locationId: null }))).toEqual(["A", "B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "PART", locationId: null }))).toEqual(["A", "B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: null }))).toEqual(["A", "B"]);
    expect(ids(filterPractitioners(c, { insurerId: "SWISS", locationId: null }))).toEqual(["B"]);
  });

  it("sede filtra por locationIds; combinado con cobertura", () => {
    const c = clinic();
    expect(ids(filterPractitioners(c, { insurerId: null, locationId: "L2" }))).toEqual(["B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: "L2" }))).toEqual(["B"]);
    expect(ids(filterPractitioners(c, { insurerId: "SWISS", locationId: "L1" }))).toEqual(["B"]);
  });

  it("payload sin campos de B3.2 no filtra a nadie", () => {
    const c = clinic();
    c.practitioners = [pro("A"), pro("B")];
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: "L2" }))).toEqual(["A", "B"]);
  });

  it("opciones de cobertura: Particular primero, OS por nombre; vacío si solo hay Particular", () => {
    const c = clinic();
    expect(coverageOptions(c).map((i) => i.name)).toEqual(["Particular", "OSDE", "Swiss Medical"]);
    c.insurers = [{ id: "PART", name: "Particular", isParticular: true }];
    expect(coverageOptions(c)).toEqual([]);
    c.insurers = undefined;
    expect(coverageOptions(c)).toEqual([]);
  });

  it("sedes: elegir solo con más de una; las del profesional en orden del consultorio", () => {
    const c = clinic();
    expect(hasMultipleLocations(c)).toBe(true);
    expect(ids(locationsForPractitioner(c, "B"))).toEqual(["L1", "L2"]);
    expect(ids(locationsForPractitioner(c, "C"))).toEqual(["L2"]);
    c.locations = [loc("L1")];
    expect(hasMultipleLocations(c)).toBe(false);
  });

  it("dirección legible con lo que haya", () => {
    expect(
      formatLocationAddress(
        loc("x", { address: "Av. Pellegrini 1200", addressLine2: "Piso 2", city: "Rosario", province: "Santa Fe" })
      )
    ).toBe("Av. Pellegrini 1200, Piso 2 · Rosario, Santa Fe");
    expect(formatLocationAddress(loc("x"))).toBe("");
  });

  it("cambiar filtros limpia profesional/servicio que dejaron de aplicar", () => {
    const c = clinic();
    // C no acepta OSDE → se limpia, y S-C (solo de C) también.
    expect(
      reconcileSelection(c, { insurerId: "OSDE", locationId: null }, { practitionerId: "C", serviceId: "S-C" })
    ).toEqual({ practitionerId: null, serviceId: null });
    // B sigue valiendo en L2 → se conserva todo.
    expect(
      reconcileSelection(c, { insurerId: null, locationId: "L2" }, { practitionerId: "B", serviceId: "S-AB" })
    ).toEqual({ practitionerId: "B", serviceId: "S-AB" });
    // Modo cualquiera (sin profesional): S-C ya no lo ofrece nadie en L1.
    expect(
      reconcileSelection(c, { insurerId: null, locationId: "L1" }, { practitionerId: null, serviceId: "S-C" })
    ).toEqual({ practitionerId: null, serviceId: null });
  });
});

describe("idempotencia por instancia (AUDIT §5)", () => {
  let n = 0;
  const mint = () => `k${++n}`;

  it("misma firma = misma key (doble click / reintento tras error de MP)", () => {
    const sig = attemptSignature({ practitionerId: "A", serviceId: "S", slotISO: "2026-10-01T13:00:00.000Z" });
    const a1 = nextAttempt(null, sig, mint);
    const a2 = nextAttempt(a1, sig, mint);
    expect(a2.key).toBe(a1.key);
  });

  it("rota si cambia profesional, servicio u horario", () => {
    const base = { practitionerId: "A", serviceId: "S", slotISO: "2026-10-01T13:00:00.000Z" };
    const a1 = nextAttempt(null, attemptSignature(base), mint);
    for (const change of [{ practitionerId: "B" }, { serviceId: "T" }, { slotISO: "2026-10-01T14:00:00.000Z" }]) {
      const a2 = nextAttempt(a1, attemptSignature({ ...base, ...change }), mint);
      expect(a2.key).not.toBe(a1.key);
    }
  });
});

describe('"cualquier profesional"', () => {
  it("arma la query solo con los filtros elegidos", () => {
    const f = { insurerId: null, locationId: null };
    expect(firstSlotQuery({ tenantSlug: "demo", serviceId: "S", filters: f })).toEqual({
      tenantSlug: "demo",
      serviceId: "S",
    });
    expect(
      firstSlotQuery({
        tenantSlug: "demo",
        serviceId: "S",
        filters: { insurerId: "OSDE", locationId: "L2" },
        fromDate: "2026-10-02",
      })
    ).toEqual({ tenantSlug: "demo", serviceId: "S", insurerId: "OSDE", locationId: "L2", fromDate: "2026-10-02" });
  });

  it("el primer turno se convierte en una selección concreta (profesional + día + horario + sede)", () => {
    expect(
      selectionFromFirstSlot({
        practitionerId: "B",
        iso: "2026-10-02T00:30:00.000Z",
        time: "21:30",
        date: "2026-10-01",
        durationMin: 60,
        locationId: "L2",
      })
    ).toEqual({ practitionerId: "B", dateISO: "2026-10-01", slotISO: "2026-10-02T00:30:00.000Z", slotLocationId: "L2" });
  });

  it("buscar más adelante: día siguiente sin depender del huso (fin de mes)", () => {
    expect(nextDayKey("2026-10-31")).toBe("2026-11-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
  });
});

describe("precarga de obra social en Tus datos", () => {
  it("usa el nombre de la OS elegida solo si el campo está vacío; Particular no precarga", () => {
    const c = clinic();
    expect(coverageInsurerPrefill("", c, "OSDE")).toBe("OSDE");
    expect(coverageInsurerPrefill("  ", c, "SWISS")).toBe("Swiss Medical");
    expect(coverageInsurerPrefill("IOMA", c, "OSDE")).toBe("IOMA");
    expect(coverageInsurerPrefill("", c, "PART")).toBe("");
    expect(coverageInsurerPrefill("", c, null)).toBe("");
  });
});
