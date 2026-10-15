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

import { SupportAccessPanel, supportEndedLabel, supportWhen } from "@/components/configuracion/panels/support-access-panel";
import { PlanUsagePanel } from "@/components/configuracion/panels/plan-usage-panel";
import { GeneralPanel } from "@/components/configuracion/panels/general-panel";
import { TabsBar, parseConfigTab } from "@/components/configuracion/controls";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { planUsageView } from "@/lib/tenant-plan-usage-logic";
import { seatUsage } from "@/lib/plan-catalog";
import { modulesFor } from "@/lib/tenant-modules";
import type { SupportSessionRow } from "@/lib/support-session-internal";
import type { TenantSettings } from "@/lib/tenant-settings";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: false }));
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

describe("[BO3-F] Plan y uso", () => {
  const usage = planUsageView(
    {
      plan: "STARTER",
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      trialEndsAt: null,
      subscriptionStatusChangedAt: null,
      publicBookingEnabled: true,
      seatLimitOverride: null,
      seats: seatUsage({ clinicalMembers: 2, pendingClinicalInvites: 0 }, 3),
      pendingClinicalInvites: 0,
      nonSeatMembers: 1,
    },
    new Date("2026-10-14T13:00:00Z")
  );

  it("plan, suscripción, cupos, Secretaria/Facturación, turnero y «escribinos»", () => {
    const html = renderToStaticMarkup(<PlanUsagePanel usage={usage} />);
    expect(html).toContain("Base");
    expect(html).toContain("Activa");
    expect(html).toContain('data-seats="2 de 3"');
    expect(html).toContain("La Secretaria y Facturación no ocupan lugar.");
    expect(html).toContain("1 en el equipo");
    expect(html).toContain("Activos");
    expect(html).toContain("Para cambiar de plan o ampliar el cupo, escribinos");
    // Sin billing: nada de botones de pago.
    expect(html).not.toMatch(/<button/);
  });
});

describe("[BO3-F] pestañas", () => {
  it("Plan y uso y Accesos de soporte solo para OWNER/ADMIN", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const t = tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role={role} modules={KINE} />));
      expect(t).toContain("Plan y uso");
      expect(t).toContain("Accesos de soporte");
    }
    for (const role of ["PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      const t = tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role={role} modules={KINE} />));
      expect(t).not.toContain("Plan y uso");
      expect(t).not.toContain("Accesos de soporte");
    }
  });

  it("?tab= abre la pestaña (el mail de soporte usa ?tab=soporte); lo desconocido cae en General", () => {
    expect(parseConfigTab("soporte")).toBe("soporte");
    expect(parseConfigTab(["plan", "x"])).toBe("plan");
    expect(parseConfigTab("hackeo")).toBe("general");
    expect(parseConfigTab(undefined)).toBe("general");
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
});
