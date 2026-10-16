import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PF1.1-config] Bundle y pulido de Configuración (brief PF §3, C-PF2/C-PF4/C-PF5).
 *  - Ningún panel entra estático en `configuracion-client.tsx` (cada pestaña es un chunk de `next/dynamic`).
 *  - Encabezado con `PageHeader`, pestañas en sentence case con teclado de tablist (una sola parada de Tab).
 *  - General: sin jerga de rol ni «Tweaks» (C3), datos en una columna < 640 (C4), selects con foco visible.
 *  - Servicios: la fila es un botón (antes `<li onClick>`, sin teclado) y el conteo en singular/plural (C6).
 * Componentes reales; se mockean solo las server actions (red), `next/navigation` y `next/dynamic`.
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
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
vi.mock("@/lib/services", () => ({
  createService: async () => ({ ok: true, data: undefined }),
  updateService: async () => ({ ok: true, data: undefined }),
  deleteService: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/saas-billing", () => ({
  getBillingOverview: async () => ({ ok: false, error: "x" }),
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));

import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { GeneralPanel } from "@/components/configuracion/panels/general-panel";
import { ServicesPanel } from "@/components/configuracion/panels/services-panel";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import type { TenantSettings } from "@/lib/tenant-settings";
import type { ServiceRow } from "@/lib/services-types";

beforeAll(async () => {
  await Promise.all(dynamicLoads);
});

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));

const TENANT = {
  id: "t1",
  name: "Consultorio Uno",
  slug: "uno",
  legalName: null,
  taxId: null,
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  agendaSlotMinutes: 60,
  publicBookingEnabled: false,
  vertical: "KINESIOLOGY",
  saasPlan: "CLINICA",
  updatedAt: "2026-10-14T12:00:00.000Z",
} as unknown as TenantSettings;

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={KINE} vertical="KINESIOLOGY">
          <TweaksProvider>{node}</TweaksProvider>
        </TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("[PF1.1-config · C-PF2] paneles fuera del JS inicial", () => {
  it("configuracion-client no importa ningún panel ni el StepUpProvider de forma estática (solo `import type`)", () => {
    const src = readFileSync("components/configuracion/configuracion-client.tsx", "utf8");
    const staticImports = src
      .split("\n")
      .filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l))
      .join("\n");
    expect(staticImports).not.toMatch(/\.\/panels\//);
    expect(staticImports).not.toMatch(/step-up-modal/);
    // Cada pestaña tiene su loader con `import()` literal.
    expect(src.match(/import\("\.\/panels\//g)?.length ?? 0).toBeGreaterThanOrEqual(11);
  });

  it("los drawers pesados (cambio de plan, comprobante, semana del profesional) tampoco van estáticos en su panel", () => {
    const check = (file: string, mod: string) => {
      const src = readFileSync(file, "utf8");
      const statics = src.split("\n").filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
      expect(statics.join("\n")).not.toContain(mod);
      expect(src).toContain(`import("./${mod}")`);
    };
    check("components/configuracion/panels/plan-usage-panel.tsx", "plan-change-drawer");
    check("components/configuracion/panels/billing-panel.tsx", "receipt-upload-drawer");
    check("components/configuracion/panels/practitioners/schedule-editor.tsx", "week-drawer");
  });
});

describe("[PF1.1-config · C-PF5] página y pestañas", () => {
  const page = () =>
    wrap(
      <ConfiguracionClient
        role="OWNER"
        access={{ tenantAdmin: true, billing: true, team: true }}
        modules={KINE}
        tenant={TENANT}
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
        supportSessions={null}
      />
    );

  it("un solo h1 (PageHeader), la pestaña inicial pintada y el tablist con nombre", () => {
    const html = page();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Configuración<\/h1>/);
    expect(html).toContain("Panel del consultorio");
    expect(html).toContain('aria-label="Secciones de Configuración"');
    // General se pinta en el primer render (SSR del dynamic): nada de esqueleto en la pestaña inicial.
    expect(html).toContain("Datos del consultorio");
  });

  it("sentence case y una sola parada de Tab (roving tabindex)", () => {
    const html = page();
    const tabs = Array.from(html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)</g), (m) => m[0]);
    expect(tabs.length).toBeGreaterThan(5);
    expect(html).toContain(">Obras sociales<");
    expect(html).not.toContain("Obras Sociales");
    expect(tabs.filter((t) => t.includes('tabindex="0"'))).toHaveLength(1);
    expect(tabs.find((t) => t.includes('aria-selected="true"'))).toContain('tabindex="0"');
  });
});

describe("[PF1.1-config · C3/C4] General", () => {
  const html = () => wrap(<GeneralPanel tenant={TENANT} role="OWNER" />);

  it("sin jerga de rol ni «Tweaks»", () => {
    const h = html();
    expect(h).not.toMatch(/OWNER|ADMIN/);
    expect(h).not.toContain("Tweaks");
    expect(h).toContain("El Titular y los administradores ven todo");
    expect(h).toContain("«Apariencia»");
  });

  it("razón social y CUIT en la grilla que baja a una columna < 640, y los selects sin foco apagado", () => {
    const h = html();
    expect(h).toMatch(/class="[^"]*twoCol[^"]*"/);
    expect(h).not.toMatch(/outline:\s*none/);
    expect(h.match(/<select[^>]*class="[^"]*select[^"]*"/g)?.length).toBe(3);
  });
});

describe("[PF1.1-config · C6] Servicios", () => {
  const svc = (over: Partial<ServiceRow>): ServiceRow => ({
    id: "s1",
    name: "Kinesiología",
    description: null,
    color: "#d2e2f4",
    durationMin: 45,
    priceCents: 1500000,
    practitionerId: null,
    practitionerName: null,
    maxConcurrent: null,
    bookingsCount: 1,
    practiceId: null,
    practiceName: null,
    discipline: null,
    suggestedDiscipline: null,
    ...over,
  });

  it("cada fila es un botón con nombre accesible (no un <li> clickeable) y el conteo concuerda en número", () => {
    const h = wrap(
      <ServicesPanel services={[svc({}), svc({ id: "s2", name: "Osteopatía", bookingsCount: 3 })]} practitioners={[]} />
    );
    expect(h).not.toMatch(/<li[^>]*onclick/i);
    expect(h).toMatch(/<button[^>]*aria-label="Editar Kinesiología"/);
    expect(h).toContain("1 turno<");
    expect(h).toContain("3 turnos<");
    expect(h).toContain("Todos los profesionales");
  });
});
