import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [AS-1g] Configuración por capability (T3d-1g, plan §23.3 C-AS1): lo delicado (`tenant.sensitive`) se ESCONDE a quien
 * no lo tiene, en vez de mostrarse deshabilitado. La Secretaria con «Configuración» (`tenant.admin` sin
 * `tenant.sensitive`, corte de staff) maneja lo operativo: servicios, obras sociales, horarios, sedes y salas. No ve el
 * turnero, «quién ve la HC», los datos del consultorio, Usuarios ni Directorio. Un Profesional con «Configuración» sí
 * (decisiones 3 y 4 del 19-oct). Terminar un acceso de soporte (#27) también es `tenant.sensitive`.
 *
 * Componentes REALES (`ConfiguracionClient` y sus paneles); se mockean `next/dynamic` (resuelto en `beforeAll`), el
 * router, `next/cache` y las server actions (red).
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
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/directory-settings", () => ({
  setDirectoryListed: async () => ({ ok: true, data: { listed: true } }),
  setPublicDescription: async () => ({ ok: true, data: { description: null } }),
  setPractitionerSpecialties: async () => ({ ok: true, data: { specialtyIds: [] } }),
}));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
// Server action (red). El click (confirm → action → toast/refresh) no se ejercita: el repo no tiene DOM en los tests de
// render; la action tiene su propia integración (T3c-1s).
vi.mock("@/lib/support-session-tenant", () => ({ endSupportAccessForTenant: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/saas-billing", () => ({
  previewPlanChange: async () => ({ ok: false, error: "x" }),
  applyPlanChange: async () => ({ ok: false, error: "x" }),
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));

import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { SupportAccessPanel, supportEndedLabel } from "@/components/configuracion/panels/support-access-panel";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import type { Role } from "@prisma/client";
import type { ConfiguracionDirectoryData } from "@/lib/configuracion-page-loader";
import type { TeamMemberRow } from "@/lib/invitations-types";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";
import type { SupportSessionRow } from "@/lib/support-session-internal";
import type { TenantSettings } from "@/lib/tenant-settings";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const TENANT = {
  id: "t1",
  name: "Centro Movare",
  slug: "movare",
  legalName: null,
  taxId: null,
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  agendaSlotMinutes: 60,
  publicBookingEnabled: true,
  vertical: "KINESIOLOGY",
  saasPlan: "CONSULTORIO",
  updatedAt: "2026-10-14T12:00:00.000Z",
} as unknown as TenantSettings;

const DIR: ConfiguracionDirectoryData = {
  mode: "preview",
  slug: "movare",
  listed: true,
  description: null,
  hidden: null,
  turneroOn: true,
  practitioners: [{ practitionerId: "p1", name: "Ana Pérez", inTurnero: true, status: "published" }],
  specialtyCatalog: [],
  specialtiesByPractitioner: {},
};

const SUMMARY: PractitionerScheduleSummaryRow[] = [
  { practitionerId: "p1", name: "Ana Pérez", summary: "Lun 9–13", isFallback: false, rangeCount: 1, locationIds: [] },
];
const TEAM = [
  {
    membershipId: "m1",
    userId: "u1",
    fullName: "Ana Pérez",
    email: "ana@test.local",
    role: "PRACTITIONER",
    specialty: null,
    joinedAt: new Date("2026-10-01T12:00:00Z"),
    clinical: true,
    grantSettings: false,
    grantBilling: false,
    disabledReason: null,
    isYou: false,
    disabledAt: null,
    hasAgenda: true,
    practitionerId: "p1",
    publicBookingEnabled: true,
    lastPasswordResetEmail: null,
  },
] as TeamMemberRow[];

const OPEN: SupportSessionRow = {
  id: "ss-1",
  superadminEmail: "soporte@kinesoft.ar",
  reason: "Ayuda con las obras sociales",
  startedAt: "2026-10-14T16:27:00.000Z",
  endedAt: null,
  endedReason: null,
  open: true,
};
const CLOSED: SupportSessionRow = {
  id: "ss-0",
  superadminEmail: "otro@kinesoft.ar",
  reason: "Revisar horarios",
  startedAt: "2026-10-10T12:00:00.000Z",
  endedAt: "2026-10-10T12:40:00.000Z",
  endedReason: "tenant",
  open: false,
};

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

/**
 * Lo que la página (`app/(app)/configuracion/page.tsx`) le pasa a cada uno: el loader ya manda `team`/`directory` en
 * null sin `tenant.sensitive`, pero acá se pasan IGUAL a la Secretaria para probar que la UI no depende solo de eso.
 */
function page(role: Role, sensitive: boolean, initialTab: string, extra: { support?: boolean } = {}) {
  return wrap(
    <ConfiguracionClient
      role={role}
      support={extra.support}
      access={{ tenantAdmin: true, billing: false, team: true, sensitive }}
      modules={KINE}
      tenant={TENANT}
      insurers={[]}
      services={[]}
      team={TEAM}
      pending={[]}
      practitioners={[]}
      customConditions={[]}
      locations={[]}
      rooms={[]}
      scheduleSummary={SUMMARY}
      planUsage={null}
      supportSessions={[OPEN, CLOSED]}
      directory={DIR}
      initialTab={initialTab}
    />
  );
}

describe("[AS-1g] Secretaria con «Configuración»: lo operativo sí, lo delicado oculto", () => {
  it("[AS-1g] ve General, Sedes, Profesionales, Servicios y Obras sociales; no ve Usuarios ni Directorio", () => {
    const t = tabs(page("ASSISTANT", false, "general"));
    expect(t).toEqual(expect.arrayContaining(["General", "Sedes", "Profesionales", "Servicios", "Obras sociales"]));
    expect(t).not.toContain("Usuarios");
    expect(t).not.toContain("Directorio");
  });

  it("[AS-1g] General: horario sí; turnero, «quién ve la HC» y datos del consultorio no (ocultos, con la línea)", () => {
    const html = page("ASSISTANT", false, "general");
    expect(html).toContain("Horario del consultorio");
    expect(html).toContain("Guardar horario");
    expect(html).not.toMatch(/<select[^>]*disabled/);
    expect(html).not.toContain("Funciones del consultorio");
    expect(html).not.toContain("Turnos online");
    expect(html).not.toContain("Vista compartida del consultorio");
    expect(html).not.toContain("Datos del consultorio");
    expect(html).not.toContain("Nombre del consultorio");
    expect(text(html)).toContain("Algunas opciones las maneja el titular o el administrador.");
  });

  it("[AS-1g] Profesionales: horarios del profesional sí; el switch del turnero de un profesional ajeno no", () => {
    const html = page("ASSISTANT", false, "profesionales");
    expect(html).toContain("Ana Pérez");
    expect(tabs(html)).toContain("Horarios");
    expect(html).not.toContain("Aparece en el turnero online");
  });

  it("[AS-1g] Soporte: ve los accesos pero no «Terminar acceso»", () => {
    const html = page("ASSISTANT", false, "soporte");
    expect(html).toContain("soporte@kinesoft.ar");
    expect(html).not.toContain("Terminar acceso");
  });
});

describe("[AS-1g] Profesional con «Configuración» y Titular: lo delicado sí", () => {
  it("[AS-1g] el Profesional con «Configuración» ve Usuarios, Directorio y lo delicado de General", () => {
    const t = tabs(page("PRACTITIONER", true, "general"));
    expect(t).toEqual(expect.arrayContaining(["General", "Usuarios", "Directorio"]));
    const html = page("PRACTITIONER", true, "general");
    expect(html).toContain("Funciones del consultorio");
    expect(html).toContain("Turnos online");
    expect(html).toContain("Vista compartida del consultorio");
    expect(html).not.toMatch(/aria-label="Vista compartida del consultorio"[^>]*disabled/);
    expect(html).toContain("Datos del consultorio");
    expect(text(html)).not.toContain("Algunas opciones las maneja el titular o el administrador.");
  });

  it("[AS-1g] con `tenant.sensitive` el switch del turnero de cada profesional aparece en su ficha", () => {
    expect(page("PRACTITIONER", true, "profesionales")).toContain("Aparece en el turnero online");
  });

  it("[AS-1g] el Titular ve «Terminar acceso» solo en el acceso en curso", () => {
    const html = page("OWNER", true, "soporte");
    expect(html.match(/>Terminar acceso</g)).toHaveLength(1);
    // El cerrado dice cómo terminó.
    expect(html).toContain("(lo terminó el consultorio)");
  });

  it("[AS-1g] el soporte (que tiene `tenant.sensitive`) no se termina a sí mismo desde el consultorio", () => {
    expect(page("ADMIN", true, "soporte", { support: true })).not.toContain("Terminar acceso");
  });
});

describe("[AS-1g] Accesos de soporte", () => {
  it("[AS-1g] «Lo terminó el consultorio» y el copy de cómo termina un acceso", () => {
    expect(supportEndedLabel("tenant")).toBe("Lo terminó el consultorio");
    const html = text(renderToStaticMarkup(<SupportAccessPanel sessions={[]} />));
    // T3-Z M4: sin `canEnd` no promete un botón que no tiene.
    expect(html).toContain("y termina cuando soporte sale, cierra sesión o lo termina el titular o el administrador.");
    expect(html).not.toContain("lo terminás desde acá");
    const owner = text(renderToStaticMarkup(<SupportAccessPanel sessions={[]} canEnd />));
    expect(owner).toContain("y termina cuando soporte sale, cierra sesión o lo terminás desde acá.");
  });

  it("[AS-1g] sin `canEnd` no hay botón (y el panel se arma sin providers, como antes)", () => {
    const html = renderToStaticMarkup(<SupportAccessPanel sessions={[OPEN]} />);
    expect(html).not.toContain("Terminar acceso");
  });
});
