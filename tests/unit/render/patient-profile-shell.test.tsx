// S22b (ES3) · Shell del perfil del paciente (`components/patients/patient-profile.tsx`).
//
// Lo que es del shell y no de las vistas hijas (hero, Resumen, Sesiones y
// PlanView los testean S22h/S22a en `patient-profile-plans.test.tsx` y
// `plan-view.test.tsx`):
//   - pestañas por módulo (`isProfileTabAllowed`, enmienda EV0 de S22b): un
//     consultorio General no ve Planes ni Sesiones (la pestaña EVA salió en CF, §28);
//   - `?tab=plan` es alias de `planes` (C10) y una pestaña oculta o
//     desconocida cae a Resumen;
//   - `pickProfilePlans` sobre `PlanDTO` (hereda P0-S02u-perfil:
//     `hero-plan-activo-falso`, `varios-planes-activos-take1`) sin archivados.
// Se renderiza el `PatientProfile` real; se mockean solo la red (server
// actions de Planes) y el router.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// `React.cache` solo existe en el runtime de RSC (lo usan lib/session, lib/authz).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
const net = vi.hoisted(() => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
vi.mock("@/lib/plans-read", () => net);

import {
  PatientProfile,
  isInsured,
  pickProfilePlans,
  profileTabsFor,
  resolveProfileTab,
} from "@/components/patients/patient-profile";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import type { PatientCore } from "@/lib/patients-types";
import type { PlanDTO, PlanSessionDTO } from "@/lib/plans-read-types";

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
  emergency: null,
  archivedAt: null,
  portalUserId: null,
  userId: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-09-01T12:00:00Z"),
} as unknown as PatientCore;

let seq = 0;
function plan(status: PlanDTO["status"], createdAt: string, sessions = 2, over: Partial<PlanDTO> = {}): PlanDTO {
  const id = `prog_${++seq}`;
  return {
    id,
    patientId: core.id,
    level: "full",
    discipline: "KINESIOLOGY",
    status,
    archivedAt: null,
    linked: true,
    title: `Plan ${id}`,
    practitionerId: null,
    practitionerName: null,
    serviceId: null,
    serviceName: null,
    locationId: null,
    totalLive: sessions,
    done: 0,
    sinTurno: 0,
    nextSession: null,
    updatedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    notes: null,
    pricingMode: null,
    balance: {} as PlanDTO["balance"],
    sessions: Array.from({ length: sessions }, (_, i) => ({
      id: `${id}_s${i + 1}`,
      index: i + 1,
      ordinal: i + 1,
      state: "unbooked",
      sinTurno: true,
      scheduledFor: new Date(createdAt),
      completedAt: null,
      archivedAt: null,
      booking: null,
      title: null,
      notes: null,
      priceCents: null,
      exerciseCount: 0,
    })) as PlanSessionDTO[],
    ...over,
  };
}

describe("[S22b] pickProfilePlans", () => {
  it("foco = el ACTIVE más reciente por createdAt, aunque haya terminados más nuevos o lleguen desordenados", () => {
    const viejo = plan("ACTIVE", "2026-01-01T12:00:00Z");
    const terminado = plan("COMPLETED", "2026-09-20T12:00:00Z");
    const nuevo = plan("ACTIVE", "2026-06-01T12:00:00Z");
    const pick = pickProfilePlans([viejo, terminado, nuevo]);
    expect(pick.focusPlan?.id).toBe(nuevo.id);
    expect(pick.otherActiveCount).toBe(1);
  });

  it("sin activos, el foco es el último plan (con su estado, nunca 'activo')", () => {
    const pick = pickProfilePlans([plan("CANCELLED", "2026-08-01T12:00:00Z"), plan("COMPLETED", "2026-09-01T12:00:00Z")]);
    expect(pick.focusPlan?.status).toBe("COMPLETED");
    expect(pick.otherActiveCount).toBe(0);
  });

  it("los archivados no cuentan: ni foco, ni badge de Planes, ni sesiones", () => {
    const archivado = plan("ACTIVE", "2026-09-30T12:00:00Z", 5, { archivedAt: new Date("2026-10-01T12:00:00Z") });
    const vivo = plan("PAUSED", "2026-05-01T12:00:00Z", 3);
    const pick = pickProfilePlans([archivado, vivo]);
    expect(pick.focusPlan?.id).toBe(vivo.id);
    expect(pick.livePlanCount).toBe(1);
    expect(pick.sessionCount).toBe(3);
  });

  it("el badge de Sesiones no cuenta sesiones archivadas", () => {
    const p = plan("ACTIVE", "2026-09-10T12:00:00Z", 4);
    p.sessions[3] = { ...p.sessions[3], state: "archived", ordinal: null, archivedAt: new Date() };
    expect(pickProfilePlans([p, plan("COMPLETED", "2026-05-10T12:00:00Z", 2)]).sessionCount).toBe(5);
  });

  it("sin planes: nada en foco", () => {
    expect(pickProfilePlans([])).toEqual({ focusPlan: null, otherActiveCount: 0, sessionCount: 0, livePlanCount: 0 });
  });
});

describe("[S22b] pestañas por módulo y deep-link", () => {
  it("General: sin Sesiones ni Planes; Kinesiología: todas (sin clinical.read, sin Evoluciones)", () => {
    expect(profileTabsFor(GENERAL)).toEqual(["resumen", "turnos", "archivos", "antec", "fact", "actividad"]);
    expect(profileTabsFor(KINE)).toEqual([
      "resumen", "turnos", "sesiones", "planes", "archivos", "antec", "fact", "actividad",
    ]);
  });

  // EV2-3a (EV2-D20): Evoluciones es del núcleo (todas las verticales) pero exige `clinical.read` del miembro.
  // FC-3d (§24.7): la HC va primera.
  it("[EV2-3a] Evoluciones: con clinical.read en General y Kine", () => {
    expect(profileTabsFor(GENERAL, { clinicalRead: true })).toEqual([
      "evoluciones", "resumen", "turnos", "archivos", "antec", "fact", "actividad",
    ]);
    expect(profileTabsFor(KINE, { clinicalRead: true })).toEqual([
      "evoluciones", "resumen", "turnos", "sesiones", "planes", "archivos", "antec", "fact", "actividad",
    ]);
    expect(resolveProfileTab("evoluciones", profileTabsFor(KINE))).toBe("resumen");
    expect(resolveProfileTab("evoluciones", profileTabsFor(KINE, { clinicalRead: true }))).toBe("evoluciones");
  });

  it("?tab=plan es alias de planes; una pestaña oculta o desconocida cae a Resumen", () => {
    expect(resolveProfileTab("plan", profileTabsFor(KINE))).toBe("planes");
    expect(resolveProfileTab("planes", profileTabsFor(KINE))).toBe("planes");
    expect(resolveProfileTab("planes", profileTabsFor(GENERAL))).toBe("resumen");
    expect(resolveProfileTab("evol", profileTabsFor(GENERAL))).toBe("resumen");
    expect(resolveProfileTab("fact", profileTabsFor(GENERAL))).toBe("fact");
    expect(resolveProfileTab("<script>", profileTabsFor(KINE))).toBe("resumen");
    expect(resolveProfileTab(null, profileTabsFor(KINE))).toBe("resumen");
  });
});

// CF (§28, decisión 4 de Martin): la EVA sale de toda la app. El perfil ya no tiene la pestaña `evol` («EVA») y una URL
// vieja `?tab=evol` (links guardados, historial) cae en la pestaña inicial del viewer, como cualquier pestaña desconocida.
describe("[CF-L1] perfil sin la pestaña EVA", () => {
  it("ninguna combinación de módulos ni de clinical.read ofrece `evol`", () => {
    for (const mods of [GENERAL, KINE]) {
      for (const clinicalRead of [false, true]) expect(profileTabsFor(mods, { clinicalRead })).not.toContain("evol");
    }
    expect(profileTabsFor(KINE)).toEqual(["resumen", "turnos", "sesiones", "planes", "archivos", "antec", "fact", "actividad"]);
  });

  it("?tab=evol cae a la pestaña por defecto (HC con clinical.read, Resumen sin)", () => {
    expect(resolveProfileTab("evol", profileTabsFor(KINE, { clinicalRead: true }))).toBe("evoluciones");
    expect(resolveProfileTab("evol", profileTabsFor(KINE))).toBe("resumen");
    expect(resolveProfileTab("evol", profileTabsFor(GENERAL, { clinicalRead: true }))).toBe("evoluciones");
  });

  it("el shell renderizado con ?tab=evol no muestra el botón «EVA» y abre la inicial", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <ToastProvider>
          <ConfirmProvider>
            <PatientProfile patientCore={core} recentBookings={[]} billableCount={0} initialTab="evol" />
          </ConfirmProvider>
        </ToastProvider>
      </TenantModulesProvider>,
    );
    expect(tabLabels(html)).not.toContain("EVA");
    expect(html).not.toContain('data-profile-tab="evol"');
    expect(html).toMatch(/data-profile-tab="resumen" aria-current="true"/);
  });
});

/** Etiquetas de los botones de pestaña (`data-profile-tab`, P3.Z F3b). */
function tabLabels(html: string) {
  return [...html.matchAll(/<button type="button" data-profile-tab="[^"]+"[^>]*>([^<]+)/g)].map((m) => m[1].trim());
}

// P3.Z (F3b, a11y): la barra declaraba `role="tablist"`/`role="tab"` sin
// `aria-controls` ni flechas/Home/End, un patrón tabs a medias que un lector
// de pantalla anuncia pero el teclado no cumple. Se vuelve a lo más simple que
// queda correcto: botones dentro de un `<nav>` con `aria-current` en la activa.
describe("[P3-Z-F3b] TabsBar: botones con aria-current, sin tabs a medias", () => {
  it("nav con nombre, la activa con aria-current y sin roles de tabs", () => {
    const html = renderToStaticMarkup(
      <TabsBar active="turnos" onChange={() => {}} counts={{ turnos: 3 }} only={["resumen", "turnos"]} />,
    );
    expect(html).toMatch(/^<nav aria-label="Secciones del perfil del paciente"/);
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain("aria-selected");
    expect(html).toMatch(/data-profile-tab="turnos" aria-current="true"[^>]*>Turnos/);
    expect(html).not.toMatch(/data-profile-tab="resumen" aria-current/);
    expect(tabLabels(html)).toEqual(["Resumen", "Turnos"]);
  });
});

describe("[S22b] shell en un consultorio General", () => {
  it("no muestra Planes/Sesiones aunque el link pida ?tab=planes&nuevo=1", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={GENERAL}>
        <ToastProvider>
          <ConfirmProvider>
            <PatientProfile
              patientCore={core}
              recentBookings={[]}
              billableCount={0}
              capabilities={["plans.manage", "clinical.read"]}
              role="OWNER"
              // Aunque llegaran planes, sin el módulo el shell no los usa.
              initialPlans={[plan("ACTIVE", "2026-09-01T12:00:00Z")]}
              initialTab="planes"
              planIntent={{ kind: "new", fromBookingId: null, prefill: null, prefillInvalid: false }}
            />
          </ConfirmProvider>
        </ToastProvider>
      </TenantModulesProvider>,
    );
    // EV2-3a: con `clinical.read`, Evoluciones (núcleo) está también en General. FC-3d: primera.
    expect(tabLabels(html)).toEqual(["Historia clínica", "Resumen", "Turnos", "Archivos", "Antecedentes", "Facturación", "Actividad"]);
    // FC-3d: cayó a la inicial del viewer (la pestaña pedida no existe en General): con `clinical.read`, la HC.
    expect(html).toMatch(/data-profile-tab="evoluciones" aria-current="true"[^>]*>Historia clínica/);
    expect(net.getPatientPlans).not.toHaveBeenCalled();
  });

  it("Kinesiología: ?tab=plan abre Planes con el badge de planes vivos", () => {
    // Se renderiza con `initialTab` = Turnos para no depender de PlanView (S22a);
    // la pestaña Planes y su badge son del shell.
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <ToastProvider>
          <ConfirmProvider>
            <PatientProfile
              patientCore={core}
              recentBookings={[]}
              billableCount={0}
              initialPlans={[
                plan("ACTIVE", "2026-09-01T12:00:00Z"),
                plan("COMPLETED", "2026-08-01T12:00:00Z", 2, { archivedAt: new Date() }),
              ]}
              initialTab="turnos"
            />
          </ConfirmProvider>
        </ToastProvider>
      </TenantModulesProvider>,
    );
    expect(tabLabels(html)).toEqual([
      "Resumen", "Turnos", "Sesiones", "Planes", "Archivos", "Antecedentes", "Facturación", "Actividad",
    ]);
    expect(html).toMatch(/>Planes<span[^>]*>1</);
    // P0-S02u-perfil (badge = lo que lista la vista), leído del render del
    // shell: 2 sesiones vivas del ACTIVE; las del archivado no cuentan.
    expect(html).toMatch(/>Sesiones<span[^>]*>2</);
  });
});

describe("[P3-Z] isInsured: OS de verdad para el aviso de autorización de la PlanCard", () => {
  it("solo con cobertura del catálogo que no sea Particular", () => {
    expect(isInsured({ insurerId: "ins1", insurerRef: { isParticular: false } })).toBe(true);
    expect(isInsured({ insurerId: "part", insurerRef: { isParticular: true } })).toBe(false);
    // Nombre libre sin catálogo: cobra como particular (ver `Coverage`).
    expect(isInsured({ insurerId: null, insurerRef: null })).toBe(false);
    expect(isInsured(undefined)).toBe(false);
  });
});
