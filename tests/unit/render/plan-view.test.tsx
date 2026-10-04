/**
 * P0-S02u-plan · Tab plan legacy (PLANES.md §8, P0.1).
 *
 * Render estático (`renderToStaticMarkup`, entorno node): alcanza para ver el
 * estado inicial de los formularios, que es donde vivía el bug. Se mockean
 * solo las server actions (red) y `next/navigation`; los componentes son los
 * reales.
 *
 * Reloj: 2026-10-06T01:30Z = **lunes 05/10 22:30 AR**. El default viejo
 * (`new Date().toISOString().slice(0,10)`) proponía el 06 — "mañana" para el
 * kinesiólogo — en cualquier host, porque `toISOString` es siempre UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/programs", () => ({
  createProgram: async () => ({ ok: true, data: undefined }),
  updateProgram: async () => ({ ok: true, data: undefined }),
  setProgramStatus: async () => ({ ok: true, data: undefined }),
  deleteProgram: async () => ({ ok: true, data: undefined }),
  deleteSession: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/sessions", () => ({
  addCustomSession: async () => ({ ok: true, data: undefined }),
  rescheduleSession: async () => ({ ok: true, data: {} }),
}));
vi.mock("@/lib/plan-templates", () => ({
  listPlanTemplates: async () => [],
  applyPlanTemplate: async () => ({ ok: true, data: undefined }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { CreateProgramModal, PlanView } from "@/components/patients/profile/views/plan-view";
import { PlanTemplateApplyModal } from "@/components/patients/plan-template-apply";
import type { PatientWithRelations } from "@/components/patients/profile/types";

const NOW_2230_AR = new Date("2026-10-06T01:30:00.000Z");
const TODAY_AR = "2026-10-05";

const render = (el: ReactElement) => renderToStaticMarkup(<ConfirmProvider>{el}</ConfirmProvider>);
const noop = () => {};

function patientWith(programs: unknown[]): PatientWithRelations {
  return {
    id: "pat-1",
    fullName: "Ana Paciente",
    programs,
    bookings: [],
    evaScores: [],
  } as unknown as PatientWithRelations;
}

const PROGRAM = {
  id: "prog-1",
  title: "Plan lumbar",
  status: "ACTIVE",
  totalSessions: 8,
  frequency: 2,
  startDate: new Date("2026-09-01T03:00:00.000Z"),
  sessions: [],
};

/** Botón "Aplicar plantilla" del header, como string del `<button …>`. */
function applyTemplateButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:(?!<\/button>).)*Aplicar plantilla(?:(?!<\/button>).)*<\/button>/);
  expect(m, "no se encontró el botón Aplicar plantilla").not.toBeNull();
  return m![0];
}

describe("[P0-S02u-plan] tab plan legacy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_2230_AR);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[P0-S02u-plan] CreateProgramModal a las 22:30 AR propone hoy AR como inicio, no mañana", () => {
    const html = render(<CreateProgramModal patientId="pat-1" onClose={noop} onCreated={noop} />);
    expect(html).toMatch(new RegExp(`name="startDate"[^>]*value="${TODAY_AR}"|value="${TODAY_AR}"[^>]*name="startDate"`));
    expect(html).not.toContain('value="2026-10-06"');
  });

  it("[P0-S02u-plan] Aplicar plantilla a las 22:30 AR propone hoy AR como primera sesión", () => {
    const html = render(<PlanTemplateApplyModal patientId="pat-1" onClose={noop} />);
    expect(html).toContain(`value="${TODAY_AR}"`);
    expect(html).not.toContain('value="2026-10-06"');
  });

  it("CreateProgramModal: topes PLAN_MAX_SESSIONS (60) y frecuencia 1..7", () => {
    const html = render(<CreateProgramModal patientId="pat-1" onClose={noop} onCreated={noop} />);
    const sessions = html.match(/<input[^>]*name="totalSessions"[^>]*>/)?.[0] ?? "";
    const freq = html.match(/<input[^>]*name="frequency"[^>]*>/)?.[0] ?? "";
    expect(sessions).toContain('max="60"');
    expect(freq).toContain('max="7"');
  });

  it("sin canUseTemplates: 'Aplicar plantilla' deshabilitado y con aviso visible", () => {
    for (const programs of [[], [PROGRAM]]) {
      const html = render(<PlanView patient={patientWith(programs)} canUseTemplates={false} />);
      expect(applyTemplateButton(html)).toMatch(/disabled=""/);
      expect(html).toContain("Las plantillas no están incluidas en tu plan");
    }
  });

  it("con canUseTemplates: 'Aplicar plantilla' habilitado y sin aviso", () => {
    const html = render(<PlanView patient={patientWith([PROGRAM])} canUseTemplates />);
    expect(applyTemplateButton(html)).not.toMatch(/disabled=""/);
    expect(html).not.toContain("Las plantillas no están incluidas en tu plan");
  });

  it("'Eliminar' del plan solo para admin (canDelete), falla cerrado si no viene", () => {
    const admin = render(<PlanView patient={patientWith([PROGRAM])} canUseTemplates canDelete />);
    const pro = render(<PlanView patient={patientWith([PROGRAM])} canUseTemplates canDelete={false} />);
    const missing = render(<PlanView patient={patientWith([PROGRAM])} canUseTemplates />);
    expect(admin).toContain(">Eliminar</button>");
    expect(pro).not.toContain(">Eliminar</button>");
    expect(missing).not.toContain(">Eliminar</button>");
  });
});
