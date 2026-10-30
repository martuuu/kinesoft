/**
 * [FC-3d] Shell del perfil (brief T4 §24.7 «Perfil (FC-3d)», Anexo C): «HC primera e inicial con `clinical.read`
 * (General y Kine); Resumen sin él; `?tab=hc`; `?turno=` sin tab; etiqueta; punto de borrador; Resumen dinámica y HC
 * estática».
 *
 * Por qué: la HC es lo que el profesional abre en cada atención y el composer tiene que estar a la vista sin un click.
 * Antes la ficha abría en Resumen y la HC era la segunda pestaña (diferida). Se renderiza el `PatientProfile` y la
 * `TabsBar` reales; se mockean solo la red (server actions) y el router. «Resumen dinámica y HC estática» lo fija el
 * grafo real de imports en `tests/unit/hc-first-load-guard.test.ts` (FC-3d dio vuelta el `it.fails` de Resumen). El
 * `?turno=` sin `tab` del lado del server (`profileNoteBookingId`) lo cubre `tests/integration/pf2-profile-budget`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/plans-read", () => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
const read = vi.hoisted(() => ({
  getPatientTimeline: vi.fn(),
  getBookingClinicalNote: vi.fn(),
  getPatientClinicalSummary: vi.fn(),
  getPatientClinicalHome: vi.fn(),
}));
vi.mock("@/lib/clinical-notes-read", () => read);
vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: vi.fn(),
  editClinicalNote: vi.fn(),
  amendClinicalNote: vi.fn(),
  voidClinicalNote: vi.fn(),
}));

import {
  ADMIN_PROFILE_TABS,
  PatientProfile,
  defaultProfileTab,
  profileTabsFor,
  resolveProfileTab,
} from "@/components/patients/patient-profile";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import { modulesFor } from "@/lib/tenant-modules";
import { parseProfilePlanParams } from "@/lib/plans-deeplink";
import { HC_TAB, normalizeProfileTab, profileTabHref } from "@/lib/plans-deeplink-params";
import type { Capability } from "@/lib/capabilities";
import type { PatientCore } from "@/lib/patients-types";
import type { PatientClinicalHome } from "@/lib/clinical-notes-types";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

const core = {
  id: "pat_000000abcdef",
  tenantId: "t1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: null,
  dateOfBirth: null,
  phone: null,
  email: null,
  notes: null,
  diagnosisTitle: null,
  assignedPractitionerId: null,
  coverages: [],
  emergency: [],
  archivedAt: null,
  portalUserId: null,
  userId: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-09-01T12:00:00Z"),
} as unknown as PatientCore;

const home: PatientClinicalHome = {
  summary: { latest: null, liveCount: 0 },
  firstPage: { items: [], nextCursor: null },
  composer: { candidates: [] },
  deepLink: null,
};

function profile(
  capabilities: Capability[],
  over: Partial<Parameters<typeof PatientProfile>[0]> = {},
  modules = KINE
): string {
  const el: ReactElement = (
    <TenantModulesProvider modules={modules}>
      <ToastProvider>
        <ConfirmProvider>
          <PatientProfile
            patientCore={core}
            recentBookings={[]}
            billableCount={0}
            capabilities={capabilities}
            role="PRACTITIONER"
            clinicalHome={capabilities.includes("clinical.read") ? home : null}
            {...over}
          />
        </ConfirmProvider>
      </ToastProvider>
    </TenantModulesProvider>
  );
  return renderToStaticMarkup(el);
}

const tabIds = (html: string) => [...html.matchAll(/data-profile-tab="([^"]+)"/g)].map((m) => m[1]);
const activeTab = (html: string) => html.match(/data-profile-tab="([^"]+)" aria-current="true"/)?.[1] ?? null;

describe("[FC-3d] HC primera e inicial", () => {
  for (const [name, modules] of [["General", GENERAL], ["Kine", KINE]] as const) {
    it(`[FC-3d] ${name} con clinical.read: «Historia clínica» primera y activa sin ?tab=`, () => {
      const tabs = profileTabsFor(modules, { clinicalRead: true });
      expect(tabs[0]).toBe(HC_TAB);
      expect(tabs[1]).toBe("resumen");
      expect(defaultProfileTab(tabs)).toBe(HC_TAB);
      expect(resolveProfileTab(null, tabs)).toBe(HC_TAB);

      const html = profile(["clinical.read"], {}, modules);
      expect(tabIds(html).slice(0, 2)).toEqual(["evoluciones", "resumen"]);
      expect(activeTab(html)).toBe("evoluciones");
    });

    it(`[FC-3d] ${name} sin clinical.read: no hay HC y la inicial es Resumen`, () => {
      const tabs = profileTabsFor(modules);
      expect(tabs).not.toContain(HC_TAB);
      expect(resolveProfileTab(null, tabs)).toBe("resumen");
      // `?tab=hc` sin acceso cae a Resumen (no abre una pestaña oculta).
      expect(resolveProfileTab("hc", tabs)).toBe("resumen");

      const html = profile(["account.owner", "tenant.admin"] as Capability[], { initialTab: "hc" }, modules);
      expect(tabIds(html)).not.toContain("evoluciones");
      expect(activeTab(html)).toBe("resumen");
    });
  }

  it("[FC-3d] una pestaña pedida que no existe cae a la HC (la inicial del viewer), no a Resumen", () => {
    const tabs = profileTabsFor(GENERAL, { clinicalRead: true });
    expect(resolveProfileTab("planes", tabs)).toBe(HC_TAB);
    expect(resolveProfileTab("<script>", tabs)).toBe(HC_TAB);
    // Resumen sigue a un click (y por URL).
    expect(resolveProfileTab("resumen", tabs)).toBe("resumen");
    expect(activeTab(profile(["clinical.read"], { initialTab: "resumen" }))).toBe("resumen");
  });
});

describe("[FC-3d] ?tab=hc y ?turno= sin tab", () => {
  it("[FC-3d] ?tab=hc es alias de la HC (clave `evoluciones`); `evol` (la EVA, CF-L1) ya no es pestaña", () => {
    expect(normalizeProfileTab("hc")).toBe("evoluciones");
    // `evol` no es alias de nada: pasa crudo y `resolveProfileTab` lo manda a la inicial (CF, §28: la EVA salió).
    expect(normalizeProfileTab("evol")).toBe("evol");
    expect(resolveProfileTab("evol", profileTabsFor(KINE, { clinicalRead: true }))).toBe(HC_TAB);
    expect(parseProfilePlanParams({ tab: "hc", turno: "bk_1" })).toEqual({ tab: "evoluciones", intent: { kind: "none" } });
    const tabs = profileTabsFor(KINE, { clinicalRead: true });
    expect(resolveProfileTab("hc", tabs)).toBe(HC_TAB);
    expect(activeTab(profile(["clinical.read"], { initialTab: "hc" }))).toBe("evoluciones");
  });

  it("[FC-3d] ?turno= sin tab abre la HC con el deep link (no es una intención de Planes)", () => {
    expect(parseProfilePlanParams({ turno: "bk_1" })).toEqual({ tab: null, intent: { kind: "none" } });
    const html = profile(["clinical.read"], {
      initialTab: null,
      noteBookingId: "bk_1",
      noteBooking: { id: "bk_1", scheduledFor: "2026-09-01T13:00:00.000Z", status: "COMPLETED", serviceName: "Kine" },
    });
    expect(activeTab(html)).toBe("evoluciones");
  });
});

describe("[FC-3d] etiqueta y punto de borrador", () => {
  it("[FC-3d] la etiqueta de la pestaña es la del copy de la HC («Historia clínica»)", () => {
    const html = renderToStaticMarkup(
      <TabsBar active="evoluciones" onChange={() => {}} counts={{ evoluciones: 4 }} only={["evoluciones", "resumen"]} />
    );
    expect(html).toMatch(new RegExp(`data-profile-tab="evoluciones" aria-current="true"[^>]*>${HC_HOME_COPY.tabLabel}<span[^>]*>4<`));
  });

  it("[FC-3d] el punto se pinta con su texto para lector de pantalla solo en la pestaña marcada", () => {
    const html = renderToStaticMarkup(
      <TabsBar
        active="resumen"
        onChange={() => {}}
        counts={{}}
        only={["evoluciones", "resumen"]}
        marks={{ evoluciones: HC_HOME_COPY.draftDot }}
      />
    );
    expect(html).toContain('data-tab-mark="evoluciones"');
    expect(html).not.toContain('data-tab-mark="resumen"');
    expect(html).toContain(`<span class="k-sr-only">${HC_HOME_COPY.draftDot}</span>`);
    // El texto queda adentro del botón: es parte de su nombre accesible.
    expect(html).toMatch(/data-profile-tab="evoluciones"[^>]*>Historia clínica<span data-tab-mark="evoluciones"[\s\S]*?Hay una ficha sin guardar<\/span><\/span><\/button>/);
  });

  it("[FC-3d] sin borrador no hay punto (el shell arranca limpio)", () => {
    const html = profile(["clinical.read"]);
    expect(html).not.toContain("data-tab-mark");
    expect(html).not.toContain(HC_HOME_COPY.draftDot);
  });
});

describe("[FC-3d] URL sincronizada (replaceState)", () => {
  it("[FC-3d] profileTabHref escribe ?tab= salvo la inicial y conserva el resto", () => {
    expect(profileTabHref("/pacientes/p1", "planes", HC_TAB)).toBe("/pacientes/p1?tab=planes");
    expect(profileTabHref("/pacientes/p1?tab=planes", HC_TAB, HC_TAB)).toBe("/pacientes/p1");
    expect(profileTabHref("/pacientes/p1?tab=evoluciones", "resumen", "resumen")).toBe("/pacientes/p1");
    expect(profileTabHref("/pacientes/p1", "resumen", HC_TAB)).toBe("/pacientes/p1?tab=resumen");
    expect(profileTabHref("https://k.app/pacientes/p1?x=1#a", "fact", HC_TAB)).toBe("https://k.app/pacientes/p1?x=1&tab=fact#a");
  });

  it("[FC-3d] `turno` es de la HC: se va al cambiar a otra pestaña y queda si se vuelve a la HC", () => {
    expect(profileTabHref("/pacientes/p1?turno=bk_1", "turnos", HC_TAB)).toBe("/pacientes/p1?tab=turnos");
    expect(profileTabHref("/pacientes/p1?turno=bk_1", HC_TAB, HC_TAB)).toBe("/pacientes/p1?turno=bk_1");
  });
});

describe("[FC-3d] el perfil admin no cambia", () => {
  it("[FC-3d] Datos, Turnos y Facturación, en ese orden y sin HC", () => {
    expect(ADMIN_PROFILE_TABS).toEqual(["resumen", "turnos", "fact"]);
    const html = renderToStaticMarkup(
      <TabsBar active="resumen" onChange={() => {}} counts={{}} only={ADMIN_PROFILE_TABS} labels={{ resumen: "Datos" }} />
    );
    expect(tabIds(html)).toEqual(["resumen", "turnos", "fact"]);
    expect(html).not.toContain("Historia clínica");
  });
});
