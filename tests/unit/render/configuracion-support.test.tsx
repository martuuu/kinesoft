import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-F] Configuración del lado del consultorio: «Accesos de soporte», «Plan y uso», pestañas por URL y la pestaña
 * General cuando mira el soporte. Componentes REALES con props; se mockean el router de Next y las server actions
 * (red) que importa General.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
// PL-3a: «Plan y uso» monta el drawer de cambio de plan (server actions de cobro y de la 2FA: red).
vi.mock("@/lib/saas-billing", () => ({
  previewPlanChange: async () => ({ ok: false, error: "x" }),
  applyPlanChange: async () => ({ ok: false, error: "x" }),
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
// PL-F1b: `ConfiguracionClient` importa todos los paneles y, con ellos, server actions que tocan lib/session
// (`React.cache` solo existe en el runtime de RSC) y next/cache.
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
// PL-F1b: el menú de perfil monta el switch del propio turnero (server action: red).
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
// PL-F1b: la página entera (`ConfiguracionClient`) monta Mensajes, que trae las server actions de soporte (red).
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));

import { SupportAccessPanel, supportEndedLabel, supportWhen } from "@/components/configuracion/panels/support-access-panel";
import { PlanUsagePanel } from "@/components/configuracion/panels/plan-usage-panel";
import { GeneralPanel } from "@/components/configuracion/panels/general-panel";
import { TabsBar, initialConfigTab, parseConfigTab, visibleConfigTabs } from "@/components/configuracion/controls";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { ProfileMenu, SUPPORT_HELP_HREF } from "@/components/global/profile-menu";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { planUsageView } from "@/lib/tenant-plan-usage-logic";
import { modulesFor } from "@/lib/tenant-modules";
import type { SupportSessionRow } from "@/lib/support-session-internal";
import type { TenantSettings } from "@/lib/tenant-settings";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);

const OPEN: SupportSessionRow = {
  id: "ss-1",
  superadminEmail: "soporte@kinesoft.ar",
  reason: "Ayuda con las obras sociales",
  // 13:27 AR = 16:27 UTC
  startedAt: "2026-10-14T16:27:00.000Z",
  endedAt: null,
  endedReason: null,
  open: true,
};
const CLOSED: SupportSessionRow = {
  id: "ss-0",
  superadminEmail: "otro@kinesoft.ar",
  reason: "Revisar horarios del profesional",
  startedAt: "2026-10-10T12:00:00.000Z",
  endedAt: "2026-10-10T12:40:00.000Z",
  endedReason: "exit",
  open: false,
};

describe("[BO3-F] Accesos de soporte", () => {
  it("lista quién entró, cuándo (hora AR), el motivo y marca el que está en curso", () => {
    const html = renderToStaticMarkup(<SupportAccessPanel sessions={[OPEN, CLOSED]} />);
    expect(html).toContain("soporte@kinesoft.ar");
    expect(html).toContain("Ayuda con las obras sociales");
    expect(html).toContain("En curso");
    // Hora AR, no la del host (el test corre en TZ=UTC y en TZ=AR).
    expect(html).toContain("13:27");
    expect(html).not.toContain("16:27");
    expect(html).toContain("terminó el");
    expect(html).toContain("(salió de soporte)");
    // Solo el abierto lleva «En curso».
    expect(html.match(/En curso/g)).toHaveLength(1);
  });

  it("explica qué puede hacer soporte, aunque no haya accesos", () => {
    const html = renderToStaticMarkup(<SupportAccessPanel sessions={[]} />);
    expect(html).toContain("Qué puede hacer soporte");
    expect(html).toContain("sin historia clínica");
    expect(html).toContain("solo lectura");
    expect(html).toContain("Soporte todavía no entró a tu consultorio.");
  });

  it("cómo terminó y la hora, puros", () => {
    expect(supportEndedLabel("logout")).toBe("Cerró sesión");
    expect(supportEndedLabel("replaced")).toBe("Pasó a otro consultorio");
    expect(supportEndedLabel(null)).toBeNull();
    expect(supportWhen("2026-10-14T03:00:00.000Z")).toMatch(/14.*00:00$/);
  });
});

describe("[BO3-F → PL-1d] Plan y uso", () => {
  const c = (used: number, limit: number | null) => ({
    used,
    limit,
    remaining: limit == null ? null : Math.max(limit - used, 0),
    full: limit != null && used >= limit,
  });
  const usage = planUsageView(
    {
      plan: "CONSULTORIO",
      planLabel: "Consultorio",
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      trialEndsAt: null,
      subscriptionStatusChangedAt: null,
      publicBookingEnabled: true,
      customLimits: false,
      seats: { total: c(3, 5), professional: c(2, 4), staff: c(1, 1) },
      pendingInvites: { professional: 0, staff: 0 },
      nonSeatMembers: 1,
    },
    new Date("2026-10-14T13:00:00Z")
  );

  // PL-3a: el plan se cambia desde acá (drawer con step-up); el «escribinos» quedó para Libre («Consultanos»).
  const overview = {
    plan: "CONSULTORIO" as const,
    planLabel: "Consultorio",
    effectivePriceCents: 2500000,
    customPriceCents: null,
    subscriptionStatus: "ACTIVE" as const,
  };

  it("plan SaaS, estado al día, cupos «Total 3 de 5», turnero y botón «Cambiar de plan» (PL-3a)", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <PlanUsagePanel usage={usage} overview={overview} modules={KINE} choices={[]} />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(html).toContain("Consultorio");
    expect(html).toContain("Al día");
    expect(html).toContain("Usuarios del plan");
    expect(html).toContain('data-seats="Total 3 de 5"');
    expect(html).toContain("$ 25.000 por mes");
    // PL-D3: la Secretaria ocupa lugar; ya no se dice lo contrario.
    expect(html).not.toMatch(/no ocupan lugar/);
    expect(html).toContain("Activos");
    expect(html).toMatch(/<button[^>]*data-plan-change[^>]*>Cambiar de plan</);
    expect(html).not.toContain("mailto:");
  });
});

describe("[BO3-F] pestañas", () => {
  // PL-2d: la pestaña pasó a llamarse «Soporte» (Mensajes + Accesos de soporte); la key sigue siendo `soporte`.
  // PL-3a: por CAPACIDAD, no por rol. Plan y uso + Facturación = `account.billing`; Soporte = `tenant.admin || billing`.
  it("Plan y uso y Facturación con «Planes y pagos»; Soporte con Configuración o Planes y pagos", () => {
    const t = (a: { tenantAdmin: boolean; billing: boolean; team: boolean }) =>
      tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} access={{ ...a, canExport: false }} modules={KINE} />));
    const owner = t({ tenantAdmin: true, billing: true, team: true });
    expect(owner).toEqual(expect.arrayContaining(["Plan y uso", "Facturación", "Soporte"]));
    // ADMIN con «Configuración» y sin «Planes y pagos»: Soporte sí, Plan y uso / Facturación no.
    const admin = t({ tenantAdmin: true, billing: false, team: true });
    expect(admin).toContain("Soporte");
    expect(admin).not.toContain("Plan y uso");
    expect(admin).not.toContain("Facturación");
    // Delegado con «Planes y pagos» (`grantBilling`) y sin Configuración: solo lo de la cuenta.
    const billingOnly = t({ tenantAdmin: false, billing: true, team: false });
    expect(billingOnly).toEqual(["Plan y uso", "Facturación", "Soporte"]);
    // Sin ninguna de las dos: solo Soporte (PL-F1b).
    expect(t({ tenantAdmin: false, billing: false, team: false })).toEqual(["Soporte"]);
  });

  it("?tab= abre la pestaña (el mail de soporte usa ?tab=soporte); lo desconocido cae en General", () => {
    expect(parseConfigTab("soporte")).toBe("soporte");
    expect(parseConfigTab(["plan", "x"])).toBe("plan");
    expect(parseConfigTab("facturacion")).toBe("facturacion");
    expect(parseConfigTab("hackeo")).toBe("general");
    expect(parseConfigTab(undefined)).toBe("general");
  });
});

// PL-F1b (decisión de Martin, 16-oct, literal: «profesionales también, porque pueden necesitar ayuda con algo»):
// Configuración se abre para cualquier miembro; sin permisos, ve solo «Soporte» (Mensajes + Accesos de soporte).
describe("[PL-F1b] Soporte para cualquier miembro", () => {
  const NONE = { tenantAdmin: false, billing: false, team: false, canExport: false };

  it("[PL-F1b] un Profesional, Secretario/a o Facturación sin delegaciones ve solo «Soporte» y entra directo ahí", () => {
    expect(tabs(renderToStaticMarkup(<TabsBar tab="soporte" setTab={() => {}} access={NONE} modules={KINE} />))).toEqual(["Soporte"]);
    for (const role of ["PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      expect(tabs(renderToStaticMarkup(<TabsBar tab="soporte" setTab={() => {}} role={role} modules={KINE} />))).toEqual(["Soporte"]);
    }
    const v = visibleConfigTabs(NONE, KINE);
    expect(initialConfigTab(undefined, v)).toBe("soporte");
    expect(initialConfigTab("general", v)).toBe("soporte");
  });

  function page(role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT", access: typeof NONE) {
    return renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <TweaksProvider>
            <ConfiguracionClient
              role={role}
              access={{ tenantAdmin: access.tenantAdmin, billing: access.billing, team: access.team }}
              modules={KINE}
              tenant={null}
              insurers={[]}
              services={[]}
              team={[]}
              pending={[]}
              practitioners={[]}
              customConditions={[]}
              locations={[]}
              rooms={[]}
              scheduleSummary={[]}
              planUsage={null}
              supportSessions={[OPEN]}
              initialTab="soporte"
            />
          </TweaksProvider>
        </ConfirmProvider>
      </ToastProvider>
    );
  }

  it("[PL-F1b] el Profesional y la Secretaria ven Mensajes y los Accesos de soporte, sin acción para terminarlos", () => {
    for (const role of ["PRACTITIONER", "ASSISTANT"] as const) {
      const html = page(role, NONE);
      expect(tabs(html)).toEqual(["Soporte"]);
      expect(html).toContain("Mensajes con soporte");
      expect(html).toContain("soporte@kinesoft.ar");
      expect(html).toContain("Ayuda con las obras sociales");
      expect(html).not.toMatch(/Terminar/);
    }
  });

  it("[PL-F1b] el menú de perfil lleva a «Ayuda y soporte» (`/configuracion?tab=soporte`) a cualquiera", () => {
    expect(SUPPORT_HELP_HREF).toBe("/configuracion?tab=soporte");
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE} vertical="KINESIOLOGY">
        <ProfileMenu name="Kine Tres" preferences={DEFAULT_PREFERENCES} defaultOpen />
      </TenantModulesProvider>
    );
    expect(html).toMatch(/<a href="\/configuracion\?tab=soporte" role="menuitem"[^>]*>.*Ayuda y soporte<\/a>/);
  });

  it("el Titular ve lo mismo en Soporte (y el resto de sus pestañas)", () => {
    const html = page("OWNER", { tenantAdmin: true, billing: true, team: true, canExport: true });
    expect(tabs(html)).toContain("General");
    expect(html).toContain("soporte@kinesoft.ar");
  });
});

const TENANT: TenantSettings = {
  id: "t1",
  name: "Centro Movare",
  slug: "movare",
  legalName: null,
  taxId: null,
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  agendaSlotMinutes: 60,
  publicBookingEnabled: false,
  vertical: "KINESIOLOGY",
  plan: "PRO",
  updatedAt: "2026-10-14T12:00:00.000Z",
} as unknown as TenantSettings;

function general(support: boolean) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TweaksProvider>
          <GeneralPanel tenant={TENANT} role="ADMIN" support={support} />
        </TweaksProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("[BO3-F] General cuando mira el soporte", () => {
  it("no puede cambiar la vista compartida de la HC y no ve las preferencias personales", () => {
    const html = general(true);
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-label="Vista compartida del consultorio"[^>]*disabled/);
    expect(html).toContain("data-support-note");
    expect(html).not.toContain("Mi vista de agenda");
    // Lo de Configuración sí lo puede tocar (server: allowlist `withSupportWritable`).
    expect(html).toContain("Guardar cambios");
    expect(html).not.toMatch(/<select[^>]*disabled/);
  });

  it("sin soporte, un ADMIN ve todo igual que antes", () => {
    const html = general(false);
    expect(html).not.toMatch(/aria-label="Vista compartida del consultorio"[^>]*disabled/);
    expect(html).not.toContain("data-support-note");
    expect(html).toContain("Mi vista de agenda");
  });

  it("[PL-Z A1] el hint del turnero dice que también depende del switch de cada profesional", () => {
    const html = general(false).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain(
      "Tus pacientes reservan solos desde un link público. Solo se ofrecen los servicios marcados como públicos y los profesionales que tengan prendido «Aparece en el turnero online» (Configuración → Profesionales)."
    );
  });
});
