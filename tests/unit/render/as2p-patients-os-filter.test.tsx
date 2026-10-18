import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

/**
 * [AS-2p] T3e-2p (plan §23.9): filtro por obra social de /pacientes y «Editar datos» admin con los campos nuevos de la
 * proyección (H-1u-1). Componentes reales con `renderToStaticMarkup` y la regla pura real; solo se mockean el router y
 * las server actions (no se invocan en un render estático).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({
  assignPatientToPractitioner: vi.fn(),
  setPatientCoverage: vi.fn(),
  setPatientDefaultCopago: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock("@/lib/catalog", () => ({ listPayerPlans: vi.fn(async () => []), proposePayerPlan: vi.fn() }));

import { matchesInsurerKey, PARTICULAR_INSURER_KEY } from "@/lib/patients-os-filter";
import { InsurerFilterSelect } from "@/components/patients/insurer-filter-select";
import { EditPatientModal, coverageChangeConfirm } from "@/components/patients/profile/edit-patient-drawer";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import { formatARS } from "@/lib/format";
import type { PatientAdminCore } from "@/lib/patients-types";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={Array.from(KINE)}>{node}</TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("[AS-2p] matchesInsurerKey (cobertura vigente)", () => {
  const os = (insurerId: string | null, isParticular = false) => ({
    insurerId,
    insurerRef: insurerId ? { isParticular } : null,
  });

  it("por id: solo si la vigente es esa OS", () => {
    expect(matchesInsurerKey(os("os_1"), "os_1")).toBe(true);
    expect(matchesInsurerKey(os("os_2"), "os_1")).toBe(false);
    expect(matchesInsurerKey(undefined, "os_1")).toBe(false);
    expect(matchesInsurerKey(os(null), "os_1")).toBe(false);
  });

  it("«Particular»: sin cobertura, texto libre o la fila isParticular; no una OS", () => {
    expect(matchesInsurerKey(undefined, PARTICULAR_INSURER_KEY)).toBe(true);
    expect(matchesInsurerKey(null, PARTICULAR_INSURER_KEY)).toBe(true);
    expect(matchesInsurerKey(os(null), PARTICULAR_INSURER_KEY)).toBe(true);
    expect(matchesInsurerKey(os("os_p", true), PARTICULAR_INSURER_KEY)).toBe(true);
    expect(matchesInsurerKey(os("os_1"), PARTICULAR_INSURER_KEY)).toBe(false);
  });
});

describe("[AS-2p] select «Obra social» de /pacientes", () => {
  const INS = [
    { id: "os_1", name: "OSDE" },
    { id: "os_2", name: "Swiss Medical" },
  ];

  it("<select> nativo con «Todas», «Particular» y el catálogo (orden de la agenda, Z-u2 M9); conserva el resto de la query", () => {
    const html = renderToStaticMarkup(
      <InsurerFilterSelect value="os_2" insurers={INS} preserved={{ q: "ana", sort: "lastName.asc", ageMin: undefined }} />
    );
    expect(html).toMatch(/<select[^>]*name="os"/);
    expect(html).toContain('aria-label="Filtrar por obra social"');
    const opts = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)/g)].map((m) => [m[1], m[2]]);
    expect(opts).toEqual([
      ["", "Todas las obras sociales"],
      ["particular", "Particular"],
      ["os_1", "OSDE"],
      ["os_2", "Swiss Medical"],
    ]);
    expect(html).toMatch(/<option value="os_2" selected/);
    expect(html).toContain('name="q" value="ana"');
    expect(html).toContain('name="sort" value="lastName.asc"');
    expect(html).not.toContain('name="ageMin"');
  });

  it("un ?os= que ya no está en el catálogo activo se muestra (no «Todas» con la lista filtrada)", () => {
    const html = renderToStaticMarkup(<InsurerFilterSelect value="os_viejo" insurers={INS} preserved={{}} />);
    expect(html).toMatch(/<option value="os_viejo" selected[^>]*>Obra social inactiva/);
    // [Z-u2 M9] la inactiva va al final, después del catálogo.
    const vals = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(vals).toEqual(["", "particular", "os_1", "os_2", "os_viejo"]);
  });

  it("[Z-u2 M9] mobile: 44 px de alto y 16 px de letra bajo 768 (sin `style` inline que lo pise)", () => {
    const html = renderToStaticMarkup(<InsurerFilterSelect value="" insurers={INS} preserved={{}} />);
    expect(html).not.toMatch(/<select[^>]*style=/);
    const css = src("components/patients/insurer-filter-select.module.css");
    const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(mobile).toMatch(/min-height: 44px/);
    expect(mobile).toMatch(/font-size: 16px/);
  });

  it("la página manda `insurerKey` desde `?os=` y ya no tiene el input de texto", () => {
    const page = src("app/(app)/pacientes/page.tsx");
    expect(page).toMatch(/insurerKey: os \|\| undefined/);
    expect(page).toMatch(/<InsurerFilterSelect/);
    expect(page).not.toMatch(/name="insurer"/);
    expect(src("lib/patients.ts")).not.toMatch(/insurer: \{ contains/);
  });
});

const core = (coverage: PatientAdminCore["coverage"]): PatientAdminCore => ({
  id: "pat_1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: null,
  phone: null,
  dateOfBirth: null,
  coverage,
  emergency: [],
  assignedPractitionerName: "Juan Kine",
  nextBookingAt: null,
  updatedAt: new Date("2026-09-01T12:00:00Z"),
  portalLinked: true,
  access: "admin",
});
const INSURERS = [
  { id: "os_1", name: "OSDE", payerId: null },
  { id: "os_2", name: "Swiss Medical", payerId: null },
];

describe("[AS-2p] «Editar datos» admin con la proyección nueva", () => {
  it("reconoce la OS por id aunque el nombre cacheado no coincida con el catálogo, y arranca con el copago propio", () => {
    const html = wrap(
      <EditPatientModal
        mode="admin"
        patient={core({ insurer: "OSDE (nombre viejo)", insurerId: "os_1", planName: null, payerPlanId: null, memberId: "AF-1", copagoCents: 600000 })}
        insurers={INSURERS}
        onClose={() => {}}
      />
    );
    expect(html).toMatch(/<option value="ins:os_1"[^>]*selected/);
    expect(html).toMatch(/inputMode="decimal"[^>]*value="6\.000"/);
  });

  it("texto libre (sin insurerId) queda como «Otra», igual que el perfil completo (no se adivina por nombre)", () => {
    const html = wrap(
      <EditPatientModal
        mode="admin"
        patient={core({ insurer: "OSDE", insurerId: null, planName: null, payerPlanId: null, memberId: null, copagoCents: null })}
        insurers={INSURERS}
        onClose={() => {}}
      />
    );
    expect(html).toMatch(/<option value="other"[^>]*selected/);
    expect(html).not.toMatch(/<option value="ins:os_1"[^>]*selected/);
  });

  it("cambiar la OS con copago propio: el confirm avisa el monto que se borra; sin copago propio no pregunta", () => {
    const ask = coverageChangeConfirm(600000);
    expect(ask).toMatchObject({ title: "Cambiar la obra social", confirmLabel: "Cambiar y borrar el copago", tone: "danger" });
    expect(ask!.message).toContain(`copago propio de ${formatARS(600000)}`);
    expect(ask!.message).toContain("se va a borrar");
    expect(coverageChangeConfirm(null)).toBeNull();
    expect(coverageChangeConfirm(0)).not.toBeNull();
  });

  it("el drawer pregunta con ese helper en los dos modos y manda `expectedUpdatedAt` del lock", () => {
    const drawer = src("components/patients/profile/edit-patient-drawer.tsx");
    expect(drawer).toMatch(/osChanged \? coverageChangeConfirm\(currentCoverage\?\.copagoCents \?\? null\)/);
    expect(drawer).toMatch(/patientUpdatePayload\(mode, patient\.id, expectedUpdatedAt\.current, formData\)/);
    expect(drawer).toMatch(/updatedAt: toIso\(p\.updatedAt\)/);
  });
});
