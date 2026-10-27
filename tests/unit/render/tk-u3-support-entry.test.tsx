import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TK-U3] Entradas a tickets desde adentro de la app (PV §27): `/configuracion?tab=soporte&nuevo=<slug>` abre «Nuevo
 * mensaje» con borrador y origen; la banda de acceso y «Consultanos» del plan Libre llevan ahí en vez de un `mailto:`.
 * Componentes REALES con props; se mockean next/dynamic (resuelto en beforeAll), el router, next/cache y las server
 * actions (red). Sin DOM (vitest en node): el `source` que manda el Drawer se fija con `supportComposeInput` (lo que
 * llama `onSubmit`) y con el `data-ticket-source` del form que lo lleva.
 */
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  await Promise.all(dynamicLoads);
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/saas-billing", () => ({
  previewPlanChange: async () => ({ ok: false, error: "x" }),
  applyPlanChange: async () => ({ ok: false, error: "x" }),
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));

import { SupportMessagesPanel } from "@/components/configuracion/panels/support-messages-panel";
import {
  APP_TICKET_SOURCES,
  supportComposeHref,
  supportComposeInput,
  supportDraftFromNuevo,
} from "@/components/configuracion/panels/support-draft-logic";
import { libreDraft } from "@/components/configuracion/panels/plan-change-drawer";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { AccessBanner, accessBannerMotivo } from "@/components/layout/access-banner";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import type { SupportDraft } from "@/components/configuracion/panels/support-draft-logic";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] }));

function page(initialSupportDraft?: SupportDraft | null) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TweaksProvider>
          <ConfiguracionClient
            role="OWNER"
            access={{ tenantAdmin: false, billing: false, team: false, sensitive: false }}
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
            supportSessions={[]}
            initialTab="soporte"
            initialSupportDraft={initialSupportDraft}
          />
        </TweaksProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("[TK-U3] ?nuevo= → borrador y origen", () => {
  it("[TK-U3] plan → PLAN_CHANGE «Consulta por mi plan»; privacidad → PRIVACY; plan-libre → PLAN_CHANGE «Quiero el plan Libre»", () => {
    expect(supportDraftFromNuevo("plan")).toEqual({ subject: "Consulta por mi plan", body: "", source: "PLAN_CHANGE" });
    expect(supportDraftFromNuevo("privacidad")).toEqual({ subject: "Consulta sobre datos personales", body: "", source: "PRIVACY" });
    expect(supportDraftFromNuevo("plan-libre")).toEqual({ subject: "Quiero el plan Libre", body: "", source: "PLAN_CHANGE" });
    expect(supportDraftFromNuevo(["plan", "soporte"])?.source).toBe("PLAN_CHANGE");
  });

  it("[TK-U3] soporte, desconocido o un origen que el server no acepta desde la app → TENANT_SUPPORT con asunto vacío", () => {
    for (const slug of ["soporte", "desconocido", "suspendido", "contacto", "cuenta", "constructor"]) {
      expect(supportDraftFromNuevo(slug)).toEqual({ subject: "", body: "", source: "TENANT_SUPPORT" });
    }
    // TENANT_SUSPENDED es TENANT en el CHECK de M19 pero el zod de createSupportThread lo rechaza.
    expect(APP_TICKET_SOURCES).toEqual(["TENANT_SUPPORT", "PLAN_CHANGE", "PRIVACY"]);
  });

  it("[TK-U3] sin nuevo (o vacío) no hay borrador", () => {
    expect(supportDraftFromNuevo(undefined)).toBeNull();
    expect(supportDraftFromNuevo("")).toBeNull();
    expect(supportDraftFromNuevo("  ")).toBeNull();
  });

  it("[TK-U3] el Drawer manda el origen del borrador (y sin origen, la misma llamada de antes)", () => {
    expect(supportComposeInput("A", "B", "PLAN_CHANGE")).toEqual({ subject: "A", body: "B", source: "PLAN_CHANGE" });
    expect(supportComposeInput("A", "B", undefined)).toEqual({ subject: "A", body: "B" });
  });

  it("[TK-U3] ?nuevo=plan abre «Nuevo mensaje» con el asunto sugerido y origen PLAN_CHANGE", () => {
    const html = renderToStaticMarkup(<ToastProvider><ConfirmProvider><SupportMessagesPanel initialThreads={[]} draft={supportDraftFromNuevo("plan")} /></ConfirmProvider></ToastProvider>);
    expect(html).toContain("Nuevo mensaje a soporte");
    expect(html).toContain('value="Consulta por mi plan"');
    expect(html).toContain('data-ticket-source="PLAN_CHANGE"');
  });

  it("[TK-U3] ?nuevo=desconocido abre el Drawer vacío con TENANT_SUPPORT", () => {
    const html = renderToStaticMarkup(<ToastProvider><ConfirmProvider><SupportMessagesPanel initialThreads={[]} draft={supportDraftFromNuevo("desconocido")} /></ConfirmProvider></ToastProvider>);
    expect(html).toContain("Nuevo mensaje a soporte");
    expect(html).toContain('data-ticket-source="TENANT_SUPPORT"');
  });

  it("[TK-U3] la página entera: con borrador abre el Drawer en Soporte; sin nuevo, igual que hoy (cerrado)", () => {
    const withDraft = page(supportDraftFromNuevo("privacidad"));
    expect(withDraft).toContain("Mensajes con soporte");
    expect(withDraft).toContain('value="Consulta sobre datos personales"');
    expect(withDraft).toContain('data-ticket-source="PRIVACY"');
    const plain = page();
    expect(plain).toContain("Mensajes con soporte");
    expect(plain).not.toContain("Nuevo mensaje a soporte");
    expect(plain).not.toContain("data-ticket-source");
  });

  it("[TK-U3] soporte como superadmin: el borrador no abre nada", () => {
    const html = renderToStaticMarkup(<ToastProvider><ConfirmProvider><SupportMessagesPanel support draft={supportDraftFromNuevo("plan")} /></ConfirmProvider></ToastProvider>);
    expect(html).not.toContain("Nuevo mensaje a soporte");
  });

  it("[TK-U3] «Consultanos» del plan Libre entra como PLAN_CHANGE", () => {
    const d = libreDraft("Clínica", 9);
    expect(d.source).toBe("PLAN_CHANGE");
    expect(d.subject).toMatch(/plan Libre/);
  });

  it("[TK-U3] href de «Nuevo mensaje» por motivo", () => {
    expect(supportComposeHref("plan")).toBe("/configuracion?tab=soporte&nuevo=plan");
    expect(supportComposeHref("soporte")).toBe("/configuracion?tab=soporte&nuevo=soporte");
  });
});

describe("[TK-U3] banda de acceso sin mailto:", () => {
  it("[TK-U3] prueba vencida / impago → nuevo=plan; otro (cancelada) → nuevo=soporte", () => {
    expect(accessBannerMotivo("trial_grace")).toBe("plan");
    expect(accessBannerMotivo("trial_expired")).toBe("plan");
    expect(accessBannerMotivo("past_due_grace")).toBe("plan");
    expect(accessBannerMotivo("past_due")).toBe("plan");
    expect(accessBannerMotivo("cancelled")).toBe("soporte");
  });

  it("[TK-U3] titular en gracia: link a Configuración → Soporte con nuevo=plan, sin mailto", () => {
    const html = renderToStaticMarkup(
      <AccessBanner access={{ mode: "grace", reason: "trial_grace", daysLeft: 3 }} enforcement="banner" audience="admin" supportEmail="s@k.test" />
    );
    expect(html).not.toContain("mailto:");
    expect(html).toContain('href="/configuracion?tab=soporte&amp;nuevo=plan"');
    expect(html).toContain("para elegir un plan.");
  });

  it("[TK-U3] solo lectura (impago y cancelada): arranca oración y lleva al motivo que corresponde", () => {
    const pastDue = renderToStaticMarkup(
      <AccessBanner access={{ mode: "read_only", reason: "past_due", daysLeft: null }} enforcement="enforce" />
    );
    expect(pastDue).not.toContain("mailto:");
    expect(pastDue).toContain("no cargar ni modificar datos. <a");
    expect(pastDue).toContain('href="/configuracion?tab=soporte&amp;nuevo=plan"');
    const cancelled = renderToStaticMarkup(
      <AccessBanner access={{ mode: "read_only", reason: "cancelled", daysLeft: null }} enforcement="enforce" />
    );
    expect(cancelled).toContain('href="/configuracion?tab=soporte&amp;nuevo=soporte"');
  });

  it("[TK-U3] el resto del equipo sigue sin link («Avisale al titular»)", () => {
    const html = renderToStaticMarkup(
      <AccessBanner access={{ mode: "grace", reason: "trial_grace", daysLeft: 3 }} enforcement="banner" audience="member" />
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("Avisale al titular");
  });
});
