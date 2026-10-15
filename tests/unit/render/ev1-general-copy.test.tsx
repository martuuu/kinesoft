// EV1-C2 · copy de Clínica general en pacientes, Configuración, portal y turnero.
//
// Contrato: un consultorio GENERAL no ve «Kine», «kinesiólogo», «por sesión» ni
// el fallback «Kinesiología»; Kinesiología queda igual (golden). Render real sin
// jsdom con el `TenantModulesProvider` de cada vertical (la app lo monta en el
// AppShell); en el turnero (sin Actor ni provider) la vertical viaja en el
// `clinic`. Se mockean solo las server actions (DB) y la navegación.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ show: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/catalog", () => proxy());
vi.mock("@/lib/insurers", () => proxy());
vi.mock("@/lib/portal", () => proxy());
vi.mock("@/lib/plans", () => proxy());
vi.mock("@/lib/plans-lifecycle", () => proxy());
vi.mock("@/lib/patient-shares", () => proxy());
vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import { PatientAdminHero } from "@/components/patients/profile/hero";
import { PatientBasicView } from "@/components/patients/patient-basic-view";
import { InsurersPanel } from "@/components/configuracion/panels/insurers-panel";
import { PortalCheckInForm } from "@/components/portal/check-in-form";
import { PractitionerStep } from "@/components/booking/wizard/practitioner-step";
import type { PatientAdminCore } from "@/lib/patients-types";
import type { InsurerRow } from "@/lib/insurers-types";
import type { PublicClinic } from "@/lib/public-booking-types";

const GENERAL = Array.from(modulesFor({ vertical: "GENERAL", plan: "FREE", publicBookingEnabled: false }));
const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: false }));
const inV = (mods: typeof GENERAL, node: ReactNode) =>
  renderToStaticMarkup(<TenantModulesProvider modules={mods}>{node}</TenantModulesProvider>);

const admin: PatientAdminCore = {
  id: "pat_1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: null,
  phone: null,
  dateOfBirth: null,
  coverage: null,
  emergency: [],
  assignedPractitionerName: "Juan Pérez",
  nextBookingAt: null,
  access: "admin",
};

const insurer: InsurerRow = {
  id: "i1",
  name: "OSDE",
  copagoCents: 100000,
  fixedFeeCents: 500000,
  isParticular: false,
  active: true,
  notes: null,
  payerId: null,
  payerName: null,
  patientsCount: 0,
  createdAt: new Date("2026-10-01T12:00:00Z"),
};

describe("[EV1-C2] copy por vertical", () => {
  it("hero administrativo: General dice «Profesional»; Kine sigue con «Kine»", () => {
    const g = inV(GENERAL, <PatientAdminHero patient={admin} canBook={false} />);
    const k = inV(KINE, <PatientAdminHero patient={admin} canBook={false} />);
    expect(g).toContain("Profesional");
    expect(g).not.toMatch(/>Kine</);
    expect(k).toMatch(/>Kine</);
    expect(g).toContain("Juan Pérez");
  });

  it("vista básica: «otro profesional» en las dos; plan y evolución solo en Kine", () => {
    const patient = { id: "p", firstName: "A", lastName: "B", documentId: null, nextBookingAt: null };
    const g = inV(GENERAL, <PatientBasicView patient={patient} />);
    const k = inV(KINE, <PatientBasicView patient={patient} />);
    for (const html of [g, k]) {
      expect(html).toContain("asignado a otro profesional del consultorio");
      expect(html).not.toMatch(/kinesi[oó]log/i);
    }
    expect(g).not.toContain("plan de tratamiento");
    expect(k).toContain("plan de tratamiento o evolución");
  });

  it("obras sociales: General «al profesional por turno»; Kine «al kine por sesión»", () => {
    const g = inV(GENERAL, <InsurersPanel insurers={[insurer]} />);
    const k = inV(KINE, <InsurersPanel insurers={[insurer]} />);
    expect(g).toContain("le abona la prestadora al profesional por turno.");
    expect(g).not.toMatch(/\bkine\b|por sesión/);
    expect(k).toContain("le abona la prestadora al kine por sesión.");
  });

  it("check-in del portal: «Tu profesional», sin kinesiólogo", () => {
    const html = renderToStaticMarkup(<PortalCheckInForm slug="demo" sessionId="s1" />);
    expect(html).toContain("Tu profesional lo va a ver");
    expect(html).not.toMatch(/kinesi[oó]log/i);
  });

  it("turnero, paso Profesional: sin especialidad, General no inventa «Kinesiología»; Kine sí (golden)", () => {
    const clinic = (vertical?: "GENERAL" | "KINESIOLOGY"): PublicClinic & { vertical?: "GENERAL" | "KINESIOLOGY" } => ({
      slug: "demo",
      name: "Demo",
      legalName: null,
      palette: "sky",
      practitioners: [
        { id: "A", name: "Lic. A", specialty: null, licenseNumber: "123", yearsExp: null, rating: null },
        { id: "B", name: "Lic. B", specialty: null, licenseNumber: null, yearsExp: null, rating: null },
      ],
      services: [],
      vertical,
    });
    const props = {
      filters: { insurerId: null, locationId: null },
      onFiltersChange: () => {},
      mode: "pick" as const,
      value: null,
      onPick: () => {},
      onAny: () => {},
    };
    const g = renderToStaticMarkup(<PractitionerStep clinic={clinic("GENERAL")} {...props} />);
    expect(g).not.toContain("Kinesiología");
    expect(g).toContain("MN 123");
    for (const v of ["KINESIOLOGY", undefined] as const) {
      const k = renderToStaticMarkup(<PractitionerStep clinic={clinic(v)} {...props} />);
      expect(k).toContain("Kinesiología · MN 123");
    }
  });
});
