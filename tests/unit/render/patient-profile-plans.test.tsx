// Perfil del paciente con planes: hero y vistas (P0-S02u-perfil → S22h, ES3).
//
// Historia de los bugs que cubre:
//   - P0-S02u-perfil (`hero-plan-activo-falso`, parte de perfil de
//     `varios-planes-activos-take1`): el hero decía "Plan activo" con planes
//     terminados; Resumen mostraba un plan terminado como vigente; con dos
//     ACTIVE se veía uno solo; el badge de Sesiones no coincidía con la vista.
//   - S22h: el hero pasa a un chip POR PLAN VIVO con su disciplina (el plan de
//     la obra social sigue aparte, en "Cobertura"); Sesiones y Resumen usan el
//     ORDINAL y `totalLive`, nunca `index` crudo (`dashboard-session-index-crudo`).
//
// Se renderizan los componentes reales (`PatientHero`, `SesionesView`,
// `ResumenView`) con `renderToStaticMarkup`. Se mockean solo el router y
// `next/cache`; las server actions no se invocan en un render estático.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
// `next/link` se marca (sigue siendo un <a> con su href) para poder afirmar
// que la navegación interna va por el router de Next y no por un <a> pelado
// que recarga la página entera (P3.Z F3b).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a data-next-link="" href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// Los módulos de server actions (`lib/session`, `lib/authz`…) envuelven
// resolvers con `React.cache`, que solo existe en RSC: identidad en el test.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import { PatientHero, PatientAdminHero, heroPlanChipText } from "@/components/patients/profile/hero";
import {
  SesionesView,
  sesionesViewGroups,
  sesionesViewRowCount,
  sessionStateLabel,
} from "@/components/patients/profile/views/sesiones-view";
import { ResumenView, resumenPlanSummary } from "@/components/patients/profile/views/resumen-view";
import { pickProfilePlans } from "@/components/patients/patient-profile";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import { heroPlanChips, NO_PLAN_PERMISSIONS, type PlanPermissions } from "@/components/planes/plan-editor-types";
import type { PlanDTO, PlanSessionDTO } from "@/lib/plans-read-types";
import type { PatientCore, PatientAdminCore } from "@/lib/patients-types";
import type { PatientWithRelations } from "@/components/patients/profile/types";

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

const patient = { ...core, bookings: [], evaScores: [] } as PatientWithRelations;

const FULL: PlanPermissions = { manage: true, schedule: true, authorize: true, restore: true, templates: true };
const SECRETARIA: PlanPermissions = { ...NO_PLAN_PERMISSIONS, schedule: true, authorize: true };

let seq = 0;
type SessionSpec = Partial<PlanSessionDTO> & { index: number };

function plan(p: Partial<PlanDTO> & { sessionsSpec?: SessionSpec[] }): PlanDTO {
  const id = p.id ?? `prog_${++seq}`;
  const sessions: PlanSessionDTO[] = (p.sessionsSpec ?? []).map((s, i) => ({
    id: `${id}_s${s.index}`,
    ordinal: i + 1,
    state: "unbooked",
    sinTurno: true,
    scheduledFor: new Date(`2026-10-${String(6 + i).padStart(2, "0")}T12:00:00Z`),
    completedAt: null,
    archivedAt: null,
    booking: null,
    title: null,
    notes: null,
    priceCents: null,
    exerciseCount: 0,
    ...s,
  }));
  const live = sessions.filter((s) => s.archivedAt == null);
  return {
    id,
    patientId: core.id,
    level: "full",
    discipline: "KINESIOLOGY",
    status: "ACTIVE",
    archivedAt: null,
    linked: true,
    title: "Lumbalgia",
    practitionerId: null,
    practitionerName: null,
    serviceId: null,
    serviceName: null,
    locationId: null,
    totalLive: live.length,
    done: live.filter((s) => s.state === "done").length,
    sinTurno: live.filter((s) => s.sinTurno).length,
    nextSession: null,
    updatedAt: new Date("2026-09-01T12:00:00Z"),
    createdAt: new Date("2026-09-01T12:00:00Z"),
    notes: null,
    pricingMode: null,
    balance: {} as PlanDTO["balance"],
    sessions,
    ...p,
  } as PlanDTO;
}

function renderHero(plans: PlanDTO[], opts: { plansEnabled?: boolean; onOpenPlan?: (id: string) => void } = {}) {
  return renderToStaticMarkup(
    <ConfirmProvider>
      <PatientHero
        patient={patient}
        age={40}
        coverageLabel="OSDE 210"
        plans={heroPlanChips(plans)}
        plansEnabled={opts.plansEnabled ?? true}
        onOpenPlan={opts.onOpenPlan}
        insurers={[]}
        practitioners={[]}
        canReassign={false}
      />
    </ConfirmProvider>,
  );
}

const noop = () => {};

describe("[P3-S22h] hero: chips por disciplina", () => {
  it("[P3-S22h] un chip por plan vivo (ACTIVE antes que PAUSED), sin terminados ni archivados ni título", () => {
    const html = renderHero([
      plan({ discipline: "OSTEOPATHY", status: "PAUSED", done: 1, totalLive: 6, title: "Cervical" }),
      plan({ discipline: "KINESIOLOGY", status: "ACTIVE", done: 3, totalLive: 10, title: "Lumbalgia" }),
      plan({ discipline: "KINESIOLOGY", status: "COMPLETED", title: "Terminado" }),
      plan({ discipline: "KINESIOLOGY", status: "ACTIVE", archivedAt: new Date(), title: "Archivado" }),
    ]);
    expect(html.match(/data-testid="hero-plan-chip"/g)?.length).toBe(2);
    // ACTIVE primero.
    expect(html.indexOf('data-status="ACTIVE"')).toBeLessThan(html.indexOf('data-status="PAUSED"'));
    expect(html).toContain("3/10");
    expect(html).toContain("1/6");
    expect(html).toContain("Pausado");
    expect(html).toContain('aria-label="Plan de Kinesiología: 3 de 10 sesiones realizadas"');
    expect(html).toContain('aria-label="Plan de Osteopatía: 1 de 6 sesiones realizadas, pausado"');
    // PHI (PD-11): el título del plan nunca sale en el hero.
    for (const t of ["Lumbalgia", "Cervical", "Terminado", "Archivado"]) expect(html).not.toContain(t);
    expect(html).not.toContain("Plan activo");
  });

  it("[P3-S22h] el plan de la obra social sigue aparte, en Cobertura", () => {
    const html = renderHero([plan({ status: "ACTIVE" })]);
    expect(html).toContain("Cobertura");
    expect(html).toContain("OSDE 210");
  });

  it("[P0-S02u-perfil] con solo planes terminados el hero no dice 'Plan activo'", () => {
    const html = renderHero([plan({ status: "COMPLETED" }), plan({ status: "CANCELLED" })]);
    expect(html).not.toContain("Plan activo");
    expect(html).not.toContain('data-testid="hero-plan-chip"');
    expect(html).toContain("Sin plan activo");
  });

  it("[P3-S22h] sin el módulo planes (consultorio General) no hay chips ni 'Sin plan activo'", () => {
    const html = renderHero([plan({ status: "ACTIVE" })], { plansEnabled: false });
    expect(html).not.toContain("hero-plan-chip");
    expect(html).not.toContain("Sin plan activo");
  });

  it("[P3-S22h] con onOpenPlan el chip es un botón que lleva al plan", () => {
    const html = renderHero([plan({ status: "ACTIVE", done: 0, totalLive: 1 })], { onOpenPlan: noop });
    expect(html).toMatch(/<button[^>]*aria-label="Plan de Kinesiología: 0 de 1 sesión realizada\. Ver el plan"/);
  });

  it("[P3-S22h] legacy sin disciplina: 'Plan'", () => {
    expect(heroPlanChipText({ programId: "p", discipline: null, status: "ACTIVE", done: 2, totalLive: 8 })).toEqual({
      progress: "2/8",
      ariaLabel: "Plan: 2 de 8 sesiones realizadas",
    });
  });

  it("[P0-S07u] el hero administrativo (Secretaria) sigue sin plan ni campos clínicos", () => {
    const admin = {
      id: "pat_1",
      firstName: "Lucía",
      lastName: "Gómez",
      documentId: null,
      dateOfBirth: null,
      phone: null,
      email: null,
      coverage: null,
      assignedPractitionerName: null,
    } as unknown as PatientAdminCore;
    const html = renderToStaticMarkup(<PatientAdminHero patient={admin} canBook />);
    expect(html).toContain("Ficha administrativa");
    expect(html).not.toContain("hero-plan-chip");
    expect(html).not.toContain("Plan");
  });
});

describe("[P3-S22h] Sesiones: ordinal y totalLive, nunca index", () => {
  const p = plan({
    sessionsSpec: [
      // `index` desordenado a propósito: el ordinal (por fecha) manda.
      { index: 7, state: "done", sinTurno: false, completedAt: new Date("2026-10-01T12:00:00Z") },
      { index: 2, state: "booked", sinTurno: false },
      { index: 5, state: "unbooked", sinTurno: true },
      { index: 9, state: "archived", ordinal: null, archivedAt: new Date(), sinTurno: false },
    ],
  });

  it("[P3-S22h] lista solo las vivas, con 'Sesión n de N' (N = vivas) y sin el index", () => {
    const html = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[p]} permissions={FULL} onOpenEditor={noop} />,
    );
    expect(html.match(/data-testid="sesion-row"/g)?.length).toBe(3);
    expect(html).toContain("Sesión 1 de 3");
    expect(html).toContain("Sesión 3 de 3");
    expect(html).not.toContain("de 4");
    expect(html).not.toMatch(/>0?7</);
    expect(html.indexOf("Sesión 1 de 3")).toBeLessThan(html.indexOf("Sesión 2 de 3"));
    expect(html).toContain("Realizada");
    expect(html).toContain("Con turno");
    expect(html).toContain("Sin turno");
    // Disciplina en el encabezado del grupo.
    expect(html).toContain("Kinesiología");
  });

  it("[P3-Z-F3b] 'Abrir →' navega con next/link (sin recargar la página)", () => {
    const html = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[p]} permissions={FULL} onOpenEditor={noop} />,
    );
    const opens = [...html.matchAll(/<a([^>]*)aria-label="Abrir Sesión/g)];
    expect(opens.length).toBe(3);
    for (const m of opens) expect(m[1]).toContain("data-next-link");
  });

  it("[P3-S22h] 'Agendar' solo con plans.schedule, en una sesión sin turno de un plan ACTIVE", () => {
    const withSchedule = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[p]} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(withSchedule.match(/>Agendar</g)?.length).toBe(1);
    const without = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[p]} permissions={NO_PLAN_PERMISSIONS} onOpenEditor={noop} />,
    );
    expect(without).not.toContain(">Agendar<");
    const paused = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[{ ...p, status: "PAUSED" }]} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(paused).not.toContain(">Agendar<");
  });

  it("[P3-S22h] proyección admin (título null): chip de disciplina, sin título", () => {
    const html = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[{ ...p, title: null, level: "admin" }]} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(html).not.toContain("Lumbalgia");
    expect(html).toContain('aria-label="Sesiones del plan de Kinesiología"');
  });

  it("[P3-S22h] sin sesiones: 'Crear plan' solo con plans.manage", () => {
    const withManage = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[]} permissions={FULL} onOpenEditor={noop} />,
    );
    expect(withManage).toContain("todavía no tiene sesiones");
    expect(withManage).toContain("Crear plan");
    const withoutManage = renderToStaticMarkup(
      <SesionesView patient={patient} plans={[]} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(withoutManage).not.toContain("Crear plan");
  });

  it("[P0-S02u-perfil] el badge de Sesiones (shell) cuenta lo mismo que lista la vista", () => {
    const plans = [
      p,
      plan({ status: "COMPLETED", sessionsSpec: [{ index: 1, state: "done" }, { index: 2, state: "done" }] }),
      plan({ archivedAt: new Date(), sessionsSpec: [{ index: 1 }] }),
    ];
    const html = renderToStaticMarkup(
      <SesionesView patient={patient} plans={plans} permissions={FULL} onOpenEditor={noop} />,
    );
    const rows = html.match(/data-testid="sesion-row"/g)?.length ?? 0;
    expect(rows).toBe(5);
    expect(sesionesViewRowCount(plans)).toBe(rows);
    expect(pickProfilePlans(plans).sessionCount).toBe(rows);
    // Grupos: el ACTIVE antes que el terminado; el archivado no aparece.
    expect(sesionesViewGroups(plans).map((g) => g.plan.status)).toEqual(["ACTIVE", "COMPLETED"]);
  });

  it("[P3-S22h] legacy (unbooked sin sinTurno) se ve 'Programada', no 'Sin turno'", () => {
    expect(sessionStateLabel({ state: "unbooked", sinTurno: false }).label).toBe("Programada");
    expect(sessionStateLabel({ state: "overdue", sinTurno: false }).label).toBe("Vencida sin cerrar");
  });
});

describe("[P3-S22h] Resumen", () => {
  it("[P3-S22h] progreso con totalLive y próxima sesión con ordinal, en hora AR", () => {
    const p = plan({
      done: 3,
      totalLive: 10,
      nextSession: { sessionId: "s4", ordinal: 4, at: new Date("2026-10-06T12:00:00Z") },
    });
    const s = resumenPlanSummary(p);
    expect(s.progress).toBe("3 de 10 realizadas");
    expect(s.percent).toBe(30);
    expect(s.next).toMatch(/^Sesión 4 de 10 · /);
    expect(s.next).toContain("09:00"); // 12:00Z = 09:00 AR, en cualquier TZ del host
    const html = renderToStaticMarkup(
      <ResumenView patient={patient} plan={p} diagnosisName={null} permissions={FULL} onOpenEditor={noop} onOpenPlan={noop} />,
    );
    expect(html).toContain("3 de 10 realizadas");
    expect(html).toContain("Próxima: Sesión 4 de 10");
    expect(html).toContain("Ver plan");
    expect(html).not.toContain("Crear plan");
  });

  it("[P0-S02u-perfil] un plan terminado se muestra con su estado y ofrece crear (con plans.manage)", () => {
    const p = plan({ status: "COMPLETED" });
    const html = renderToStaticMarkup(
      <ResumenView patient={patient} plan={p} diagnosisName={null} permissions={FULL} onOpenEditor={noop} />,
    );
    expect(html).toContain("Finalizado");
    expect(html).toContain("No tiene un plan activo.");
    expect(html).toContain("Crear plan");
    const sec = renderToStaticMarkup(
      <ResumenView patient={patient} plan={p} diagnosisName={null} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(sec).not.toContain("Crear plan");
  });

  it("[P0-S02u-perfil] '+N' cuando hay otros ACTIVE", () => {
    const html = renderToStaticMarkup(
      <ResumenView patient={patient} plan={plan({})} otherActiveCount={1} diagnosisName={null} permissions={FULL} onOpenEditor={noop} />,
    );
    expect(html).toContain("1 plan activo más");
  });

  it("[P3-S22h] 'Agendar sesiones sin turno' solo con plans.schedule y sesiones sin turno", () => {
    const p = plan({ sessionsSpec: [{ index: 1 }] });
    const yes = renderToStaticMarkup(
      <ResumenView patient={patient} plan={p} diagnosisName={null} permissions={SECRETARIA} onOpenEditor={noop} />,
    );
    expect(yes).toContain("Agendar sesiones sin turno");
    const no = renderToStaticMarkup(
      <ResumenView patient={patient} plan={p} diagnosisName={null} permissions={NO_PLAN_PERMISSIONS} onOpenEditor={noop} />,
    );
    expect(no).not.toContain("Agendar sesiones sin turno");
  });

  it("[P3-Z-F3b] consultorio General: sin card de Plan, sin Diagnóstico ni EVA; las notas siguen", () => {
    const general = Array.from(modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false }));
    // Precondición del fixture: General no trae ninguno de los tres módulos.
    expect(general).not.toContain("planes");
    expect(general).not.toContain("diagnostico");
    const render = (p: PlanDTO | null) =>
      renderToStaticMarkup(
        <TenantModulesProvider modules={general}>
          <ResumenView patient={patient} plan={p} diagnosisName="Lumbalgia secreta" permissions={FULL} onOpenEditor={noop} />
        </TenantModulesProvider>,
      );
    for (const html of [render(plan({ title: "Título secreto" })), render(null)]) {
      expect(html).not.toContain("Plan de tratamiento");
      expect(html).not.toContain("Crear plan");
      expect(html).not.toContain("Título secreto");
      expect(html).not.toContain("Diagnóstico principal");
      expect(html).not.toContain("Lumbalgia secreta");
      expect(html).not.toContain("EVA");
      expect(html).toContain("Notas generales");
    }
    // Kine PRO (control): las mismas props sí muestran Plan y Diagnóstico.
    const pro = renderToStaticMarkup(
      <TenantModulesProvider modules={Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }))}>
        <ResumenView patient={patient} plan={null} diagnosisName="Lumbalgia secreta" permissions={FULL} onOpenEditor={noop} />
      </TenantModulesProvider>,
    );
    expect(pro).toContain("Plan de tratamiento");
    expect(pro).toContain("Diagnóstico principal");
  });

  it("[P0-S02u-perfil] pickProfilePlans: focus = el ACTIVE más reciente por createdAt", () => {
    const viejo = plan({ createdAt: new Date("2026-01-01T12:00:00Z") });
    const nuevo = plan({ createdAt: new Date("2026-06-01T12:00:00Z") });
    const terminado = plan({ status: "COMPLETED", createdAt: new Date("2026-09-20T12:00:00Z") });
    const pick = pickProfilePlans([viejo, terminado, nuevo]);
    expect(pick.focusPlan?.id).toBe(nuevo.id);
    expect(pick.otherActiveCount).toBe(1);
  });
});
