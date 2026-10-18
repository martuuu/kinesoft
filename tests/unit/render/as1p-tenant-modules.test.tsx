/**
 * [AS-1p] T3c-1p (plan §23.6): render de Plataforma → consultorio → Suscripción: fila «Precio» y tabla «Módulos», y
 * el cuerpo del Drawer «Editar módulos» (controlado, con props). Sin jsdom: `renderToStaticMarkup`. Se mockean la
 * action (sin DB en unit), el router, el toast y el confirm; nunca los componentes ni la lógica bajo test.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/platform-tenant-modules", () => ({ setTenantModuleOverrides: vi.fn() }));
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn() }));
vi.mock("@/lib/platform-billing", () => ({ platformPreviewPlanChange: vi.fn(), platformApplyPlanChange: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
import { renderToStaticMarkup } from "react-dom/server";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { TenantSubscriptionView } from "@/components/plataforma/tenants/tenant-subscription";
import { TenantModulesList } from "@/components/plataforma/tenants/tenant-modules-table";
import { TenantModulesForm, newlyDisabled } from "@/components/plataforma/tenants/tenant-modules-drawer";
import { formFromLists } from "@/components/plataforma/tenants/module-overrides-form";

const detail = (over: Partial<PlatformTenantDetail> = {}): PlatformTenantDetail =>
  ({
    id: "t1",
    name: "Movare",
    slug: "movare",
    vertical: "KINESIOLOGY",
    saasPlan: "CLINICA",
    subscriptionStatus: "ACTIVE",
    trialEndsOn: null,
    publicBookingEnabled: true,
    onboardingCompleted: true,
    ownerEmails: [],
    ownerNames: [],
    patientCount: 0,
    memberCount: 1,
    createdAt: "2026-09-01T15:00:00.000Z",
    isPlatformHome: false,
    status: "ACTIVE",
    statusReason: null,
    statusChangedAt: null,
    maxUsersOverride: null,
    maxProfessionalsOverride: null,
    maxStaffOverride: null,
    limits: { maxUsers: 10, maxProfessionals: null, maxStaff: null },
    access: { mode: "full", reason: "active", daysLeft: null },
    effectiveAccessMode: "full",
    slugAliases: [],
    legalName: null,
    taxId: null,
    phone: null,
    whatsapp: null,
    publicEmail: null,
    sharedPatientView: false,
    modules: [],
    moduleGrants: [],
    moduleRevokes: ["diagnostico"],
    price: { planPriceCents: 4_500_000, customPriceCents: 3_000_000, effectivePriceCents: 3_000_000 },
    counts: { members: 1, pendingInvitations: 0, practitioners: 1, patients: 0, services: 0, locations: 0, bookingsTotal: 0, bookingsLast30Days: 0, bookingsUpcoming: 0 },
    lastActivityAt: null,
    recentPlatformEvents: [],
    publicBookingPath: "/c/movare/booking",
    updatedAt: "2026-10-18T12:00:00.000Z",
    ...over,
  }) as PlatformTenantDetail;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("[AS-1p] Suscripción: Precio y Módulos", () => {
  it("fila «Precio» con «a medida» y link a Facturación; sección Módulos con «Editar módulos»", () => {
    const html = renderToStaticMarkup(<TenantSubscriptionView detail={detail()} />);
    const t = text(html);
    expect(t).toContain("Precio");
    expect(t).toContain("a medida");
    expect(html).toContain('href="/plataforma/consultorios/t1/facturacion"');
    expect(t).toContain("Cambiar en Facturación →");
    expect(t).toContain("Módulos");
    expect(t).toContain("Editar módulos");
  });

  it("sin precio a medida: el de lista, sin «a medida»", () => {
    const t = text(renderToStaticMarkup(<TenantSubscriptionView detail={detail({ price: { planPriceCents: 4_500_000, customPriceCents: null, effectivePriceCents: 4_500_000 } })} />));
    expect(t).toContain("/ mes");
    expect(t).not.toContain("a medida (lista");
  });

  it("estados de la tabla y candado (aria-hidden) en el núcleo; fila informativa del turnero", () => {
    const html = renderToStaticMarkup(<TenantModulesList detail={detail()} />);
    const t = text(html);
    expect(t).toContain("Diagnóstico Deshabilitado a mano");
    expect(t).toContain("Planes de tratamiento Del plan");
    expect(t).toContain("Agenda");
    expect(t).toContain("Básico: lo tiene todo consultorio.");
    expect(html).toContain('aria-hidden="true"');
    expect(t).toContain("Turnos online");
    expect(t).toContain("Se prende y apaga con su switch");
    // Kine Clínica: nada «No existe para…».
    expect(t).not.toContain("No existe para");
  });

  it("General: lo de Kine con candado «No existe para Clínica general.»", () => {
    const t = text(renderToStaticMarkup(<TenantModulesList detail={detail({ vertical: "GENERAL", moduleRevokes: [] })} />));
    expect(t).toContain("No existe para Clínica general.");
  });
});

describe("[AS-1p] Drawer «Editar módulos» (cuerpo)", () => {
  const base = { vertical: "KINESIOLOGY" as const, plan: "CLINICA" as const, publicBookingEnabled: false };
  const noop = () => {};

  it("solo filas editables (sin núcleo), un select etiquetado por fila; guardar deshabilitado sin cambios", () => {
    const html = renderToStaticMarkup(
      <TenantModulesForm base={base} form={formFromLists([], [])} dirty={false} pending={false} error={null} onChoice={noop} onFixDependents={noop} onSubmit={noop} onCancel={noop} />
    );
    expect(html).not.toContain('id="module-choice-agenda"');
    expect(html).toContain('for="module-choice-planes"');
    expect(html).toContain('id="module-choice-planes"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("dependencia colgada: aviso con el copy del server y «Deshabilitar también»; guardar deshabilitado aunque haya cambios", () => {
    const html = renderToStaticMarkup(
      <TenantModulesForm base={base} form={formFromLists([], ["planes"])} dirty pending={false} error={null} onChoice={noop} onFixDependents={noop} onSubmit={noop} onCancel={noop} />
    );
    const t = text(html);
    expect(t).toContain("Para deshabilitar Planes de tratamiento, deshabilitá también Sesiones y Plantillas de plan.");
    expect(t).toContain("Deshabilitar también Sesiones y Plantillas de plan");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("newlyDisabled: lo que el equipo deja de ver al guardar (para el useConfirm)", () => {
    expect(newlyDisabled(base, formFromLists([], []), formFromLists([], ["planes", "sesiones", "plantillas"]))).toEqual([
      "planes",
      "sesiones",
      "plantillas",
    ]);
    expect(newlyDisabled(base, formFromLists([], ["salas"]), formFromLists([], []))).toEqual([]);
  });
});
