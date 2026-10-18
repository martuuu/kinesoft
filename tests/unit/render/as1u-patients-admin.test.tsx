import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

/**
 * [AS-1u] UI de pacientes para Secretaria, Admin y Facturación (T3d-1u, plan §23.4-§23.5). Se montan los componentes
 * reales con `renderToStaticMarkup`; solo se mockean el router y las server actions (no se invocan en un render
 * estático). Los payloads salen del módulo puro que usan los formularios (`patient-form-payload.ts`).
 *
 *  - «Nuevo paciente» para quien tiene `agenda.operateAll` sin `clinical.read`, con «Profesional a cargo» obligatorio y
 *    sin notas ni diagnóstico.
 *  - Perfil admin: «Editar datos» (con `patients.editAdmin`) y pestaña «Facturación».
 *  - El payload del modo admin no tiene claves clínicas (ni vacías: el server rechaza el pedido entero).
 *  - Facturación (BILLING) ve el pedido del portal pero no Aprobar/Rechazar.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({
  assignPatientToPractitioner: vi.fn(),
  createPatient: vi.fn(),
  getPatientBookingsAll: vi.fn(),
  sendPatientPortalInvite: vi.fn(),
  setPatientArchived: vi.fn(),
  setPatientCoverage: vi.fn(),
  setPatientDefaultCopago: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingInsurerPaid: vi.fn(), setBookingCopagoPaid: vi.fn() }));
vi.mock("@/lib/plans-read", () => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
vi.mock("@/lib/clinical-notes-read", () => ({ getPatientClinicalSummary: vi.fn() }));
vi.mock("@/lib/catalog", () => ({ listPayerPlans: vi.fn(async () => []), proposePayerPlan: vi.fn() }));
vi.mock("@/lib/patient-portal-requests", () => ({
  decidePatientPortalRequest: vi.fn(),
  listPatientPortalRequests: vi.fn(async () => ({ ok: true, data: [] })),
  previewPortalRequestImpact: vi.fn(),
}));

import { NewPatientModal } from "@/components/patients/new-patient-drawer";
import { EditPatientModal } from "@/components/patients/profile/edit-patient-drawer";
import { PortalRequestCard } from "@/components/patients/profile/portal-request-banner";
import { PatientAdminProfile, ADMIN_PROFILE_TABS } from "@/components/patients/patient-profile";
import {
  CLINICAL_FORM_KEYS,
  newPatientMode,
  copagoFieldFromCents,
  patientCreatePayload,
  patientUpdatePayload,
} from "@/components/patients/patient-form-payload";
import { PATIENT_CLINICAL_KEYS } from "@/lib/validation";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { capabilitiesFor, capabilitiesForMember } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import type { PatientAdminCore, PatientBookingFull } from "@/lib/patients-types";
import type { PortalRequestRow } from "@/lib/patient-portal-requests-internal";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

function wrap(node: ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={Array.from(KINE)}>{node}</TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** FormData mínimo para los builders (en el navegador es el `FormData` del form). */
function form(values: Record<string, string>) {
  return { get: (k: string) => (k in values ? values[k] : null) };
}

const ASSIGNEES = [
  { id: "pr_1", name: "Juan Kine" },
  { id: "pr_2", name: "Ana Osteo" },
];

describe("[AS-1u] Nuevo paciente desde /pacientes", () => {
  it("newPatientMode: Secretaria (operateAll sin clinical.read) → admin; profesional → full; Facturación y soporte → nada", () => {
    expect(newPatientMode(capabilitiesFor("ASSISTANT"), { support: false })).toBe("admin");
    expect(newPatientMode(capabilitiesFor("PRACTITIONER"), { support: false })).toBe("full");
    expect(newPatientMode(capabilitiesFor("BILLING"), { support: false })).toBeNull();
    expect(newPatientMode(capabilitiesFor("ASSISTANT"), { support: true })).toBeNull();
    // Admin que no atiende: sin clinical.read, con agenda.operateAll → mismo alta que la Secretaria.
    const adminCaps = capabilitiesForMember({ role: "ADMIN", clinical: false, grantSettings: true, grantBilling: true });
    expect(newPatientMode(adminCaps, { support: false })).toBe(adminCaps.has("clinical.read") ? "full" : "admin");
  });

  it("la página arma el botón con `newPatientMode` y la lista de profesionales reservables cacheada", () => {
    const page = src("app/(app)/pacientes/page.tsx");
    expect(page).toMatch(/newPatientMode\(/);
    expect(page).toMatch(/listPractitioners\(\)/);
    expect(page).not.toMatch(/const canCreateHere = caps\.has\("clinical\.read"\)/);
  });

  it("Secretaria ve «Profesional a cargo» obligatorio y no ve notas ni diagnóstico", () => {
    const html = wrap(<NewPatientModal insurers={[]} assignees={ASSIGNEES} onClose={() => {}} />);
    expect(html).toContain("Profesional a cargo");
    expect(html).toContain("Juan Kine");
    expect(html).toContain("Ana Osteo");
    expect(html).toMatch(/<select[^>]*required/);
    for (const s of ["Diagnóstico", "Motivo de consulta", "Notas generales", 'name="notes"', 'name="diagnosisTitle"']) {
      expect(html).not.toContain(s);
    }
  });

  it("el profesional sigue con el alta completa (sin selector de profesional)", () => {
    const html = wrap(<NewPatientModal insurers={[]} onClose={() => {}} />);
    expect(html).toContain("Diagnóstico");
    expect(html).toContain("Notas generales");
    expect(html).not.toContain("Profesional a cargo");
  });

  it("payload del alta admin: sin claves clínicas", () => {
    const fd = form({ firstName: "Ana", lastName: "Paz", documentId: "1", notes: "x", diagnosisTitle: "y", diagnosisNote: "z" });
    const admin = patientCreatePayload("admin", fd, "particular", "");
    for (const k of CLINICAL_FORM_KEYS) expect(k in admin).toBe(false);
    const full = patientCreatePayload("full", fd, "ins:os_1", "");
    expect(full).toMatchObject({ notes: "x", diagnosisTitle: "y", diagnosisNote: "z", insurerId: "os_1" });
  });
});

const core: PatientAdminCore = {
  id: "pat_1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: "lucia@example.com",
  phone: "1155550001",
  dateOfBirth: new Date("1990-03-15T00:00:00Z"),
  coverage: { insurer: "OSDE", insurerId: "os_1", planName: "310", payerPlanId: null, memberId: "AF-1", copagoCents: null },
  emergency: [],
  assignedPractitionerName: "Juan Kine",
  nextBookingAt: null,
  updatedAt: new Date("2026-09-01T12:00:00Z"),
  access: "admin",
};

function booking(over: Partial<PatientBookingFull> = {}): PatientBookingFull {
  return {
    id: "bk_1",
    tenantId: "t1",
    patientId: core.id,
    practitionerId: "pr_1",
    serviceId: "sv_1",
    scheduledFor: new Date("2026-09-01T13:00:00Z"),
    durationMin: 45,
    copagoCents: 250000,
    status: "COMPLETED",
    paymentStatus: "UNPAID",
    copagoPaymentMethod: null,
    insurerPaidAt: null,
    title: null,
    description: null,
    notes: null,
    serviceName: "Kinesiología",
    obraSocial: "OSDE",
    osAmountCents: 800000,
    updatedAt: new Date("2026-09-01T12:00:00Z"),
    createdAt: new Date("2026-08-01T12:00:00Z"),
    ...over,
  } as unknown as PatientBookingFull;
}

function adminProfile(role: "ASSISTANT" | "BILLING", initialTab?: (typeof ADMIN_PROFILE_TABS)[number]) {
  return wrap(
    <PatientAdminProfile
      patient={core}
      initialBookings={{ rows: [booking()], hasMore: false, nextCursor: null }}
      canBook={role === "ASSISTANT"}
      capabilities={Array.from(capabilitiesFor(role))}
      viewerPractitionerId={null}
      insurers={[{ id: "os_1", name: "OSDE", payerId: null }]}
      initialTab={initialTab}
    />
  );
}

function tabLabels(html: string) {
  return [...html.matchAll(/<button type="button"[^>]*>([^<]+)/g)].map((m) => m[1].trim());
}

describe("[AS-1u] perfil admin", () => {
  it("pestañas Datos, Turnos y Facturación", () => {
    expect(ADMIN_PROFILE_TABS).toEqual(["resumen", "turnos", "fact"]);
    const labels = tabLabels(adminProfile("ASSISTANT"));
    expect(labels).toEqual(expect.arrayContaining(["Datos", "Turnos", "Facturación"]));
  });

  it("Secretaria ve «Editar datos»; Facturación no", () => {
    expect(adminProfile("ASSISTANT")).toContain("Editar datos");
    expect(adminProfile("BILLING")).not.toContain("Editar datos");
  });

  it("Facturación: la vista real; la Secretaria cobra el copago y Facturación además confirma la obra social", async () => {
    // `FacturacionView` es diferida (`next/dynamic`): el primer render dispara la carga del chunk.
    adminProfile("ASSISTANT", "fact");
    await import("@/components/patients/profile/views/facturacion-view");
    await new Promise((r) => setTimeout(r, 0));
    const buttons = (html: string, label: string) => html.match(new RegExp(`<button type="button"[^>]*>${label}</button>`, "g"))?.length ?? 0;
    const sec = adminProfile("ASSISTANT", "fact");
    expect(sec).toContain("Kinesiología");
    // Copago sí (`billing.collect`, «Cobrar» desde T3-Z M1), obra social no (`billing.manage`, «Confirmar»).
    expect(buttons(sec, "Cobrar")).toBe(1);
    expect(buttons(sec, "Confirmar")).toBe(0);
    const fact = adminProfile("BILLING", "fact");
    expect(buttons(fact, "Cobrar")).toBe(1);
    expect(buttons(fact, "Confirmar")).toBe(1);
  });

  it("el perfil completo y el admin pasan `billingAccess` con el profesional del viewer", () => {
    const shell = src("components/patients/patient-profile.tsx");
    expect(shell.match(/billingAccess=\{/g)?.length).toBeGreaterThanOrEqual(2);
    expect(shell).toMatch(/viewerPractitionerId\?: string \| null/);
    expect(src("app/(app)/pacientes/[id]/page.tsx").match(/viewerPractitionerId=\{actor\.practitionerId \?\? null\}/g)?.length).toBe(2);
  });
});

describe("[AS-1u] «Editar datos» en modo admin", () => {
  it("el payload admin no tiene claves clínicas (ni vacías); el completo sí", () => {
    expect([...CLINICAL_FORM_KEYS]).toEqual([...PATIENT_CLINICAL_KEYS]);
    const fd = form({ firstName: "Lucía", lastName: "Gómez", phone: "11", notes: "", diagnosisTitle: "", diagnosisNote: "" });
    const admin = patientUpdatePayload("admin", "pat_1", null, fd);
    for (const k of PATIENT_CLINICAL_KEYS) expect(k in admin).toBe(false);
    expect("expectedUpdatedAt" in admin).toBe(false);
    expect(admin).toMatchObject({ id: "pat_1", firstName: "Lucía", phone: "11" });
    const full = patientUpdatePayload("full", "pat_1", "2026-09-01T12:00:00.000Z", fd);
    expect(full).toMatchObject({ notes: "", diagnosisTitle: "", diagnosisNote: "", expectedUpdatedAt: "2026-09-01T12:00:00.000Z" });
  });

  it("el drawer en modo admin usa el builder con su modo", () => {
    expect(src("components/patients/profile/edit-patient-drawer.tsx")).toMatch(/patientUpdatePayload\(\s*mode/);
  });

  it("formulario admin: datos, cobertura y copago propio; sin notas ni diagnóstico", () => {
    const html = wrap(
      <EditPatientModal mode="admin" patient={core} insurers={[{ id: "os_1", name: "OSDE", payerId: null }]} onClose={() => {}} />
    );
    for (const s of ["Datos personales", "Cobertura", "N° de afiliado", "Copago propio", "AF-1", "Lucía"]) {
      expect(html).toContain(s);
    }
    // T3e-2p: la proyección admin trae `insurerId` (antes se reconocía por nombre).
    expect(html).toMatch(/<option value="ins:os_1"[^>]*selected/);
    for (const s of ["Diagnóstico", "Motivo de consulta", "Notas generales", 'name="notes"', "Kinesiólogo asignado"]) {
      expect(html).not.toContain(s);
    }
  });

  it("copago propio: vacío o igual no escribe; monto nuevo sí; inválido avisa", () => {
    // T3-Z B1: desde el `MoneyInput` (centavos); el texto inválido lo marca el control.
    expect(copagoFieldFromCents(null, false, 5000_00)).toEqual({ kind: "none" });
    expect(copagoFieldFromCents(5000_00, false, 5000_00)).toEqual({ kind: "none" });
    expect(copagoFieldFromCents(6000_00, false, 5000_00)).toEqual({ kind: "set", cents: 6000_00 });
    expect(copagoFieldFromCents(6000_00, false, null)).toEqual({ kind: "set", cents: 6000_00 });
    expect(copagoFieldFromCents(null, true, null)).toEqual({ kind: "invalid" });
    expect(copagoFieldFromCents(100_000_01, false, null)).toEqual({ kind: "invalid" });
  });

  it("[T3Z-s1] copago propio: teclado decimal, «ej: 6.000» y la ayuda de qué pasa si se borra", () => {
    const html = wrap(
      <EditPatientModal mode="admin" patient={core} insurers={[{ id: "os_1", name: "OSDE", payerId: null }]} onClose={() => {}} />
    );
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('placeholder="ej: 6.000"');
    expect(html).toContain(
      "Reemplaza el copago de la cobertura en los próximos turnos. Si lo borrás no cambia: para volver al de la obra social, cambiá la cobertura."
    );
  });

  // T3-Y (decisión de Martin 19-oct): se revirtió el bloqueo de T3-Z A1; la recepción carga y corrige el email.
  it("[T3-Y] «Editar datos» en modo admin: el email es editable y sin la ayuda del bloqueo", () => {
    const emailInput = (html: string) => html.match(/<input[^>]*name="email"[^>]*>/)?.[0] ?? "";
    const html = wrap(<EditPatientModal mode="admin" patient={core} insurers={[]} onClose={() => {}} />);
    expect(emailInput(html)).not.toBe("");
    expect(emailInput(html)).not.toMatch(/disabled/);
    expect(html).not.toContain("El email lo cambia el profesional a cargo");
  });

  it("[T3Z-s1] payload: un email que no viaja en el form no se manda; vacío sí (borrar)", () => {
    const without = patientUpdatePayload("admin", "pat_1", null, form({ firstName: "Lucía", lastName: "Gómez", phone: "11" }));
    expect("email" in without).toBe(false);
    const cleared = patientUpdatePayload("admin", "pat_1", null, form({ firstName: "Lucía", lastName: "Gómez", email: "" }));
    expect(cleared).toMatchObject({ email: "" });
  });
});

const portalRow: PortalRequestRow = {
  id: "req_1",
  updatedAt: "2026-10-01T12:00:00.000Z",
  createdAt: "2026-10-01T12:00:00.000Z",
  fields: ["phone"],
  changes: { phone: "1199990000" } as PortalRequestRow["changes"],
  current: { phone: "1155550001", email: null, emergencyContact: null, coverage: null },
  emailApplies: true,
  osChanges: false,
};

describe("[AS-1u] pedido del portal", () => {
  it("con permiso de decidir: Aprobar y Rechazar", () => {
    const html = wrap(<PortalRequestCard row={portalRow} reload={async () => {}} error={null} setError={() => {}} canDecide />);
    expect(html).toContain("Aprobar y aplicar");
    expect(html).toContain("Rechazar");
  });

  it("Facturación (sin full ni patients.editAdmin) ve el pedido pero no Aprobar/Rechazar", () => {
    const html = wrap(
      <PortalRequestCard row={portalRow} reload={async () => {}} error={null} setError={() => {}} canDecide={false} />
    );
    expect(html).toContain("Pidió actualizar sus datos");
    expect(html).not.toContain("Aprobar y aplicar");
    expect(html).not.toContain(">Rechazar<");
  });

  it("el perfil admin le pasa al banner `patients.editAdmin`", () => {
    expect(src("components/patients/profile/hero.tsx")).toMatch(/<PortalRequestBanner patientId=\{patient\.id\} canDecide=\{/);
  });
});
