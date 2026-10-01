import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import { PractitionerStep } from "@/components/booking/wizard/practitioner-step";
import type { PublicClinic } from "@/lib/public-booking-types";


const pro = (id: string, extra: object = {}) => ({
  id, name: `Lic. ${id}`, specialty: null, licenseNumber: null, yearsExp: null, rating: null, ...extra,
});
function clinic(locs: number, withOS: boolean): PublicClinic {
  const locations = [
    { id: "L1", name: "Centro", address: "Av. Pellegrini 1200", addressLine2: null, city: "Rosario", province: null, isPrimary: true },
    { id: "L2", name: "Fisherton", address: "Eva Perón 8000", addressLine2: null, city: "Rosario", province: null, isPrimary: false },
  ].slice(0, locs);
  return {
    slug: "demo", name: "Kine Demo", legalName: null, palette: "sky",
    practitioners: [
      pro("Ana", { locationIds: ["L1"], acceptedInsurerIds: ["P", "O"] }),
      pro("Beto", { locationIds: ["L1", "L2"], acceptedInsurerIds: ["P"] }),
    ],
    services: [{ id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1500000, practitionerId: null, practitionerIds: ["Ana", "Beto"] }],
    locations,
    insurers: withOS
      ? [{ id: "P", name: "Particular", isParticular: true }, { id: "O", name: "OSDE", isParticular: false }]
      : [{ id: "P", name: "Particular", isParticular: true }],
  };
}

describe("B5.6 render", () => {
  it("2 sedes + OS: sede, cobertura, cualquiera, profesionales", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} />);
    expect(html).toContain("¿En qué sede?");
    expect(html).toContain("Fisherton");
    expect(html).toContain("Eva Perón 8000 · Rosario");
    expect(html).toContain("¿Con qué cobertura venís? (opcional)");
    expect(html).toContain("OSDE");
    expect(html).toContain("Primer turno disponible");
    expect(html).toContain("Lic. Ana");
    expect(html).not.toMatch(/copago/i);
    // Google sigue siendo form POST.
    expect(html).toMatch(/<form action="\/api\/auth\/google\?next=[^"]+" method="post"/);
  });

  it("1 sede, solo Particular: sin filtros", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} />);
    expect(html).not.toContain("¿En qué sede?");
    expect(html).not.toContain("cobertura venís");
    expect(html).toContain("Primer turno disponible");
  });

  it("filtro de OSDE + sede L2: nadie → mensaje; OSDE solo → sin 'cualquiera' (1 profesional)", () => {
    const c = clinic(2, true);
    const none = renderToStaticMarkup(
      <PractitionerStep clinic={c} filters={{ insurerId: "O", locationId: "L2" }} onFiltersChange={() => {}} mode="pick" value={null} onPick={() => {}} onAny={() => {}} />
    );
    expect(none).toContain("Ningún profesional coincide");
    const one = renderToStaticMarkup(
      <PractitionerStep clinic={c} filters={{ insurerId: "O", locationId: null }} onFiltersChange={() => {}} mode="pick" value={null} onPick={() => {}} onAny={() => {}} />
    );
    expect(one).toContain("Lic. Ana");
    expect(one).not.toContain("Lic. Beto");
    expect(one).not.toContain("Primer turno disponible");
  });

  it("1 profesional: arranca en Servicio (como antes)", () => {
    const c = clinic(1, false);
    c.practitioners = [c.practitioners[0]];
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={c} session={null} prefill={null} />);
    expect(html).toContain("¿Qué servicio necesitás?");
  });
});
