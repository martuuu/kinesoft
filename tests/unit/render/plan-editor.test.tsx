/**
 * [S18] Editor único de planes: render estático (`renderToStaticMarkup`) del
 * form real y del drawer real. Se mockean solo las server actions (red) y
 * `next/navigation`; nunca el componente bajo test. La lógica (borrador →
 * input, resoluciones, stale) está en `tests/unit/plan-editor-state.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/bookings", () => ({ listServices: async () => [], listPractitioners: async () => [] }));
vi.mock("@/lib/locations", () => ({ listLocations: async () => [] }));
vi.mock("@/lib/plans", () => ({ previewPlan: async () => ({ ok: false, error: "x" }), createPlan: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/plans-move", () => ({ previewReplanPlan: async () => ({ ok: false, error: "x" }), replanPlan: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/plans-adopt", () => ({
  previewGeneratePlanBookings: async () => ({ ok: false, error: "x" }),
  generatePlanBookings: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/plans-read", () => ({ getPlanDetail: async () => ({ ok: false, error: "x" }), getPatientPlans: async () => ({ ok: true, data: [] }) }));
vi.mock("@/lib/diagnosis", () => ({
  getDiagnosisPlanPrefill: async () => ({ ok: false, error: "x" }),
  createPlanFromDiagnosis: async () => ({ ok: false, error: "x" }),
  searchPatientsForAssignment: async () => [],
}));
vi.mock("@/lib/plan-templates", () => ({ getTemplatePrefill: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/patient-search", () => ({ searchPatientsForBooking: async () => [] }));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { PlanForm, type PlanFormProps } from "@/components/planes/plan-form";
import { PlanEditorDrawer, PLAN_EDITOR_WIDTH } from "@/components/planes/plan-editor-drawer";
import { PLAN_EDITOR_COPY, emptyDraft, type PlanEditorDraft, type PlanEditorOptions } from "@/lib/plan-editor-state";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

const OPTIONS: PlanEditorOptions = {
  services: [
    { id: "svc-k", name: "Sesión kinésica", discipline: "KINESIOLOGY", durationMin: 45, priceCents: 1_500_000 },
    { id: "svc-o", name: "Sesión osteopática", discipline: "OSTEOPATHY", durationMin: 60, priceCents: 2_000_000 },
    { id: "svc-n", name: "Consulta general", discipline: null, durationMin: 30, priceCents: 0 },
  ],
  practitioners: [{ id: "pr-1", name: "Lic. Pérez" }],
  locations: [{ id: "loc-1", name: "Centro", isPrimary: true }],
};

function form(over: Partial<PlanFormProps> = {}, draft: Partial<PlanEditorDraft> = {}): string {
  return render(
    <PlanForm
      mode="create"
      draft={{ ...emptyDraft({ today: "2026-10-05", patientId: "pat-1" }), ...draft }}
      onChange={noop}
      options={OPTIONS}
      errors={{}}
      needsPatient={false}
      showAuthorization
      {...over}
    />
  );
}

const before = (html: string, a: string, b: string) => {
  const ia = html.indexOf(a);
  const ib = html.indexOf(b);
  expect(ia, `falta "${a}"`).toBeGreaterThanOrEqual(0);
  expect(ib, `falta "${b}"`).toBeGreaterThanOrEqual(0);
  expect(ia, `"${a}" va antes que "${b}"`).toBeLessThan(ib);
};

describe("[S18] PlanForm (C13: orden del editor)", () => {
  it("disciplina → servicio → profesional → sede → inicio/cantidad → horario → precio → título → notas", () => {
    const html = form();
    before(html, ">Disciplina<", ">Servicio<");
    before(html, ">Servicio<", "Profesional responsable");
    before(html, "Profesional responsable", ">Sede<");
    before(html, ">Sede<", ">Inicio<");
    before(html, ">Inicio<", "Cantidad de sesiones");
    before(html, "Cantidad de sesiones", ">Horario<");
    before(html, ">Horario<", ">Precio<");
    before(html, ">Precio<", ">Título<");
    before(html, ">Título<", ">Notas<");
  });

  it("el paciente va primero y solo si falta", () => {
    expect(form()).not.toContain(">Paciente<");
    before(form({ needsPatient: true }), "Paciente", ">Disciplina<");
  });

  it("disciplina: segmentado Kinesiología / Osteopatía con radios", () => {
    const html = form();
    expect(html).toMatch(/<input type="radio" name="plan-discipline"[^>]*value="KINESIOLOGY"/);
    expect(html).toMatch(/<input type="radio" name="plan-discipline"[^>]*value="OSTEOPATHY"/);
    expect(html).toContain("Kinesiología");
    expect(html).toContain("Osteopatía");
  });

  it("sin disciplina el servicio está deshabilitado; con Kine ofrece Kine + sin disciplina (nunca Osteo) y el hint C13", () => {
    expect(form()).toMatch(/<select[^>]*disabled[^>]*>(?:(?!<\/select>).)*Elegí primero la disciplina/);
    const html = form({}, { discipline: "KINESIOLOGY" });
    expect(html).toContain("Sesión kinésica");
    expect(html).toContain("Consulta general");
    expect(html).not.toContain("Sesión osteopática");
    expect(html).toContain(PLAN_EDITOR_COPY.serviceHint);
  });

  it("precio: las tres opciones literales de C13; el monto aparece solo con precio", () => {
    const html = form();
    expect(html).toContain("Sin precio · sigue la cobertura");
    expect(html).toContain("Por sesión");
    expect(html).toContain("Paquete");
    expect(html).not.toContain("Precio total del paquete");
    expect(form({}, { priceMode: "PACKAGE", priceCents: 12_000_000 })).toContain("Precio total del paquete");
    expect(form({}, { priceMode: "PER_SESSION", priceCents: 1_500_000 })).toContain("Precio por sesión");
  });

  it("autorización de la OS: solo con permiso; fechas con <input type=date>", () => {
    expect(form({ showAuthorization: false })).not.toContain("Autorización de la obra social");
    const off = form();
    expect(off).toContain("Autorización de la obra social");
    expect(off).not.toContain("Sesiones autorizadas");
    const on = form({}, { authorization: { enabled: true, code: "", authorizedSessions: 10, startsOnDayKey: "2026-10-05", expiresOnDayKey: "" } });
    expect(on).toContain("Sesiones autorizadas");
    expect(on).toContain(">Vence<");
    expect(on).toMatch(/type="date"[^>]*value="2026-10-05"/);
  });

  it("título: el placeholder es el título por defecto del motor", () => {
    expect(form({}, { discipline: "OSTEOPATHY", totalSessions: 6 })).toContain('placeholder="Osteopatía · 6 sesiones"');
  });

  it("desde un turno: checkbox 'cuenta como la sesión 1'", () => {
    expect(form()).not.toContain("cuenta como la sesión 1");
    expect(form({}, { fromBookingId: "bk1", countBookingAsSession1: true })).toContain("cuenta como la sesión 1");
  });

  it("replan: sin disciplina, cantidad, precio, autorización ni título (diálogos propios, C10)", () => {
    const html = form({ mode: "replan" }, { discipline: "KINESIOLOGY", serviceId: "svc-k" });
    expect(html).not.toContain(">Disciplina<");
    expect(html).not.toContain("Cantidad de sesiones");
    expect(html).not.toContain(">Precio<");
    expect(html).not.toContain("Autorización de la obra social");
    expect(html).not.toContain(">Título<");
    expect(html).toContain(">Horario<");
    expect(html).toContain(">Desde<");
  });

  it("errores de campo visibles", () => {
    const html = form({ errors: { serviceId: "Elegí el servicio", discipline: "Elegí la disciplina" } });
    expect(html).toContain("Elegí el servicio");
    expect(html).toContain("Elegí la disciplina");
  });
});

describe("[S18] PlanEditorDrawer", () => {
  it("abre un diálogo de 600 px con el título del modo y carga", () => {
    expect(PLAN_EDITOR_WIDTH).toBe(600);
    const html = render(<PlanEditorDrawer open mode="create" patientId="pat-1" onClose={noop} onSaved={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("width:600px");
    expect(html).toContain("Nuevo plan");
    expect(html).toContain("Cargando…");
  });

  it("modos generate / replan con su título; cerrado no renderiza nada", () => {
    expect(render(<PlanEditorDrawer open mode="generate" programId="pg" onClose={noop} onSaved={noop} />)).toContain("Agendar sesiones del plan");
    expect(render(<PlanEditorDrawer open mode="replan" programId="pg" replanFromSessionId="s1" onClose={noop} onSaved={noop} />)).toContain(
      "Editar el plan desde esta sesión"
    );
    expect(render(<PlanEditorDrawer open={false} mode="create" onClose={noop} onSaved={noop} />)).not.toContain('role="dialog"');
  });
});
