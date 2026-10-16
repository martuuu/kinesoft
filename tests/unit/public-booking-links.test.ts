import { describe, expect, it } from "vitest";
import { bookingHref, withSearchParams } from "@/lib/public-booking-links";
import { initialWizardSelection } from "@/lib/public-wizard-state";
import type { PublicClinic } from "@/lib/public-booking-types";

// DIR-2d (C-DIR7): links al turnero y estado inicial del wizard con `?pro=`. El redirect real del alias y el payload
// sin `rating` se prueban contra Postgres en tests/integration/public-booking-deeplink.test.ts.

describe("bookingHref", () => {
  it("sin profesional: el turnero del consultorio", () => {
    expect(bookingHref("kine-demo")).toBe("/c/kine-demo/booking");
    expect(bookingHref("kine-demo", null)).toBe("/c/kine-demo/booking");
    expect(bookingHref("kine-demo", "")).toBe("/c/kine-demo/booking");
  });
  it("con profesional: ?pro=, escapado", () => {
    expect(bookingHref("kine-demo", "cm123")).toBe("/c/kine-demo/booking?pro=cm123");
    expect(bookingHref("a b", "x&y=z")).toBe("/c/a%20b/booking?pro=x%26y%3Dz");
  });
});

describe("withSearchParams", () => {
  it("sin query devuelve el path tal cual (sin `?` colgando)", () => {
    expect(withSearchParams("/c/x/booking", {})).toBe("/c/x/booking");
    expect(withSearchParams("/c/x/booking", { a: undefined })).toBe("/c/x/booking");
    expect(withSearchParams("/c/x/booking", undefined)).toBe("/c/x/booking");
  });
  it("conserva repetidos en orden, descarta undefined, escapa", () => {
    const out = withSearchParams("/c/x/booking", { pro: "p1", utm: ["a", "b c"], nada: undefined, vacio: "" });
    expect(out).toBe("/c/x/booking?pro=p1&utm=a&utm=b+c&vacio=");
    const back = new URL(out, "http://x.test").searchParams;
    expect(back.getAll("utm")).toEqual(["a", "b c"]);
    expect(back.get("pro")).toBe("p1");
  });
  it("un path que ya trae query se extiende con &", () => {
    expect(withSearchParams("/c/x/booking?pro=p1", { utm: "a" })).toBe("/c/x/booking?pro=p1&utm=a");
  });
});

const pro = (id: string) => ({ id, name: `Lic. ${id}`, specialty: null, licenseNumber: null, yearsExp: null });
const clinicWith = (ids: string[]): PublicClinic => ({
  slug: "demo",
  name: "Demo",
  legalName: null,
  palette: "sky",
  practitioners: ids.map(pro),
  services: [],
});

describe("initialWizardSelection", () => {
  it("pro reservable → paso 1 con él", () => {
    expect(initialWizardSelection(clinicWith(["A", "B"]), "B")).toEqual({ step: 1, practitionerId: "B", mode: "pick" });
  });
  it("pro ausente, vacío o que no está en el consultorio → el default (paso 0)", () => {
    const c = clinicWith(["A", "B"]);
    for (const p of [null, undefined, "", "Z"]) {
      expect(initialWizardSelection(c, p)).toEqual({ step: 0, practitionerId: null, mode: "pick" });
    }
  });
  it("un solo profesional: paso 1 con él, aunque el pro sea inválido", () => {
    const c = clinicWith(["A"]);
    expect(initialWizardSelection(c, null)).toEqual({ step: 1, practitionerId: "A", mode: "pick" });
    expect(initialWizardSelection(c, "Z")).toEqual({ step: 1, practitionerId: "A", mode: "pick" });
  });
});
