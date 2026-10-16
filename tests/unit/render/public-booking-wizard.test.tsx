import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { DataStep, PublicBookingWizard, type PatientHC } from "@/components/booking/public-booking-wizard";
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
    // Google sigue siendo form POST, ahora a la ruta canónica (VX2-d1).
    expect(html).toMatch(/<form action="\/api\/auth\/oauth\/google\?next=%2Fc%2Fdemo%2Fbooking" method="post"/);
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

const HC: PatientHC = {
  firstName: "", lastName: "", email: "", phone: "", documentId: "", dateOfBirth: "", coverageInsurer: "",
  coveragePlan: "", emergencyName: "", emergencyPhone: "", notes: "", title: "", description: "",
};

describe("VX2-d1 · turnero", () => {
  it("horario real del consultorio en el nav; sin franjas no se muestra ninguno", () => {
    const c = { ...clinic(1, false), openingSummary: "Lun a vie 8 a 19 · Sáb 9 a 13" };
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={c} session={null} prefill={null} />);
    expect(html).toContain("Lun a vie 8 a 19 · Sáb 9 a 13");
    expect(html).toContain("Horario de atención");
    const none = renderToStaticMarkup(
      <PublicBookingWizard clinic={{ ...clinic(1, false), openingSummary: null }} session={null} prefill={null} />
    );
    expect(none).not.toContain("Horario de atención");
    expect(none).not.toMatch(/lun-sáb|8 a 19hs/);
  });

  it("sin <style> embebido ni clases globales .booking-*; una sola h1", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} />);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/class="[^"]*\bbooking-/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/en 30 segundos/);
    expect(html).toContain('aria-current="step"');
  });

  it("resumen sin claims sin evidencia (handoff 12)", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} />);
    expect(html).not.toMatch(/100%|cifrad/i);
    expect(html).toContain("Total a pagar");
  });

  it("datos con Field: label asociada y autocomplete del paciente; emergencia sin autocompletar", () => {
    const html = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} hc={HC} setHc={() => {}} error="Ese horario ya no está." />
    );
    const input = (id: string) => html.match(new RegExp(`<input[^>]*id="booking-${id}"[^>]*>`))?.[0] ?? "";
    expect(html).toContain('<label for="booking-firstName" class="k-label">Nombre</label>');
    expect(input("firstName")).toContain('autoComplete="given-name"');
    expect(input("lastName")).toContain('autoComplete="family-name"');
    expect(input("email")).toMatch(/type="email"[^>]*autoComplete="email"|autoComplete="email"[^>]*type="email"/);
    expect(input("phone")).toContain('autoComplete="tel"');
    expect(input("phone")).toContain('type="tel"');
    expect(input("dateOfBirth")).toContain('autoComplete="bday"');
    expect(input("emergencyPhone")).toContain('autoComplete="off"');
    expect(input("emergencyName")).toContain('autoComplete="off"');
    expect(html).toContain('class="k-alert" role="alert"');
    expect(html).toContain("Ingresar con Google");
  });

  it("[VX-Z · D-VX16] Google apagado → ni «Ingresar con Google» en datos ni el form del nav; queda el portal", () => {
    const step = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} googleEnabled={false} hc={HC} setHc={() => {}} error={null} />
    );
    expect(step).not.toContain("Ingresar con Google");
    const html = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} googleEnabled={false} />
    );
    expect(html).not.toContain("/api/auth/oauth/google");
    expect(html).toMatch(/<a[^>]*href="\/portal"[^>]*>Iniciar sesión<\/a>/);
  });

  it("[VX2-d1] el CSS del turnero vive en su módulo (sin outline:none)", () => {
    const css = readFileSync("components/booking/public-booking.module.css", "utf8");
    expect(css).toMatch(/\.body\s*\{/);
    expect(css).not.toMatch(/outline:\s*none/);
    expect(css).not.toMatch(/filter:\s*blur/);
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).not.toContain("RESPONSIVE_CSS");
  });
});
