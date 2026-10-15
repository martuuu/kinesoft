/**
 * [S21t] Plantillas UI: render estático (`renderToStaticMarkup`) del listado
 * y del form reales + la lógica pura del borrador (alta, patch con CAS,
 * dirty, validación). Se mockean solo las server actions (red) y
 * `next/navigation`; nunca el componente bajo test.
 */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: 0 }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/bookings", () => ({ listServices: async () => [] }));
vi.mock("@/lib/exercises", () => ({ listExercises: async () => [] }));
vi.mock("@/lib/plan-templates", () => ({
  listPlanTemplates: async () => {
    calls.list++;
    return [];
  },
  getPlanTemplate: async () => ({ ok: false, error: "x" }),
  createPlanTemplate: async () => ({ ok: false, error: "x" }),
  updatePlanTemplate: async () => ({ ok: false, error: "x" }),
  setPlanTemplateArchived: async () => ({ ok: true, data: undefined }),
  deletePlanTemplate: async () => ({ ok: true, data: undefined }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import {
  TEMPLATE_LIST_COPY,
  TemplateList,
  templatePricingText,
  templateRowFacts,
  visibleTemplates,
} from "@/components/planes/templates/template-list";
import {
  TEMPLATE_COPY,
  TemplateDrawer,
  TemplateForm,
  emptyTemplateDraft,
  isTemplateDraftDirty,
  templateDraftFromDetail,
  templateDraftToCreate,
  templateServerErrors,
  templateUpdatePatch,
  templateWithDiscipline,
  templateWithPriceMode,
  validateTemplateDraft,
  type TemplateDraft,
} from "@/components/planes/templates/template-drawer";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { PlanTemplateCreateSchema, PlanTemplateUpdateSchema, type PlanTemplateDetail, type PlanTemplateRow } from "@/lib/plan-templates-types";
import type { PlanEditorService } from "@/lib/plan-editor-state";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

const SERVICES: PlanEditorService[] = [
  { id: "svc-k", name: "Sesión kinésica", discipline: "KINESIOLOGY", durationMin: 45, priceCents: 1_500_000 },
  { id: "svc-o", name: "Sesión osteopática", discipline: "OSTEOPATHY", durationMin: 60, priceCents: 2_000_000 },
  { id: "svc-n", name: "Consulta general", discipline: null, durationMin: 30, priceCents: 0 },
];

const UPDATED = new Date("2026-10-05T15:00:00.000Z");

function row(over: Partial<PlanTemplateRow> = {}): PlanTemplateRow {
  return {
    id: "tpl-1",
    name: "Lumbalgia aguda",
    description: null,
    totalSessions: 10,
    frequency: 2,
    exerciseCount: 3,
    discipline: "KINESIOLOGY",
    serviceId: "svc-k",
    serviceName: "Sesión kinésica",
    durationMin: null,
    schedule: { v: 1, frequency: "weekly", everyNWeeks: 1, slots: [{ dow: 1, startMin: 540 }, { dow: 4, startMin: 540 }] },
    pricing: { mode: "PER_SESSION", pricePerSessionCents: 1_500_000 },
    hasNotes: false,
    authorId: "pr-1",
    authorName: "Lic. Pérez",
    canEdit: true,
    archivedAt: null,
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...over,
  };
}

function detail(over: Partial<PlanTemplateDetail> = {}): PlanTemplateDetail {
  return {
    ...row(),
    notes: "Progresar carga",
    exercises: [
      { id: "ex-1", name: "Puente", assignable: true },
      { id: "ex-2", name: "Plancha", assignable: true },
    ],
    ...over,
  };
}

describe("[S21t] TemplateList — gate de módulo (EV0: has('plantillas'))", () => {
  it("sin `plantillas` (Individual): se ve deshabilitado con el aviso y no consulta el server", () => {
    calls.list = 0;
    const html = render(<TemplateList canManage templatesEnabled={false} />);
    expect(html).toContain(MODULE_DENIED_COPY.plantillas);
    // PL-1a: el copy sale de MODULE_DENIED_COPY (plan nuevo).
    expect(TEMPLATE_LIST_COPY.disabled).toBe("Las plantillas de plan están disponibles desde el plan Consultorio.");
    expect(html).toContain('data-state="disabled"');
    expect(html).toContain('aria-disabled="true"');
    // El botón de alta aparece apagado: nunca abre el drawer.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Nueva plantilla<\/button>/);
    expect(html).not.toContain("template-row");
    expect(calls.list).toBe(0);
  });

  it("con el módulo y sin filas iniciales: estado de carga", () => {
    const html = render(<TemplateList canManage templatesEnabled />);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("Cargando plantillas");
    expect(html).not.toContain(MODULE_DENIED_COPY.plantillas);
  });
});

describe("[S21t] TemplateList — filas y permisos", () => {
  it("fila editable: nombre, disciplina, datos y acciones Editar/Archivar/Borrar", () => {
    const html = render(<TemplateList canManage templatesEnabled initialTemplates={[row()]} />);
    expect(html).toContain('data-state="ready"');
    expect(html).toContain("Lumbalgia aguda");
    expect(html).toContain('aria-label="Kinesiología"');
    expect(html).toContain(">Editar<");
    expect(html).toContain(">Archivar<");
    expect(html).toContain(">Borrar<");
    expect(html).toContain(">Nueva plantilla<");
    expect(html).toContain("Creada por Lic. Pérez");
  });

  it("fila ajena (canEdit false): solo Ver; sin plans.manage no hay alta", () => {
    const html = render(<TemplateList canManage={false} templatesEnabled initialTemplates={[row({ canEdit: false })]} />);
    expect(html).toContain(">Ver<");
    expect(html).not.toContain(">Editar<");
    expect(html).not.toContain(">Archivar<");
    expect(html).not.toContain(">Borrar<");
    expect(html).not.toContain("Nueva plantilla");
  });

  it("archivadas ocultas por defecto, con el toggle para quien gestiona", () => {
    const rows = [row(), row({ id: "tpl-2", name: "Vieja", archivedAt: UPDATED })];
    const html = render(<TemplateList canManage templatesEnabled initialTemplates={rows} />);
    expect(html).not.toContain("Vieja");
    expect(html).toContain("Ver archivadas (1)");
    expect(visibleTemplates(rows, true).map((r) => r.id)).toEqual(["tpl-1", "tpl-2"]);
    expect(visibleTemplates(rows, false).map((r) => r.id)).toEqual(["tpl-1"]);
  });

  it("vacío: copy según permiso", () => {
    expect(render(<TemplateList canManage templatesEnabled initialTemplates={[]} />)).toContain(TEMPLATE_LIST_COPY.emptyManage);
    expect(render(<TemplateList canManage={false} templatesEnabled initialTemplates={[]} />)).toContain(TEMPLATE_LIST_COPY.empty);
  });

  it("datos de la fila: sesiones · horario · servicio · precio · ejercicios (montos con formatARS)", () => {
    const facts = templateRowFacts(row());
    expect(facts[0]).toBe("10 sesiones");
    expect(facts[1]).toMatch(/lun y jue 09:00/);
    expect(facts).toContain("Sesión kinésica");
    expect(facts.some((f) => /15\.000.*por sesión/.test(f))).toBe(true);
    expect(facts).toContain("3 ejercicios");
    expect(templatePricingText(null)).toBe("Sin precio · sigue la cobertura");
    expect(templatePricingText({ mode: "PACKAGE", totalPriceCents: 12_000_000 })).toMatch(/^Paquete \$\s?120\.000$/);
    expect(templateRowFacts(row({ schedule: null, exerciseCount: 0, totalSessions: 1 }))).not.toContain("0 ejercicios");
    expect(templateRowFacts(row({ totalSessions: 1 }))[0]).toBe("1 sesión");
  });
});

describe("[S21t] borrador de plantilla (puro)", () => {
  it("alta: arma un input que pasa el zod del server; sin días = schedule null", () => {
    const d: TemplateDraft = { ...emptyTemplateDraft("KINESIOLOGY"), name: "  Rodilla  ", serviceId: "svc-k" };
    const input = templateDraftToCreate(d);
    expect(input).toMatchObject({ name: "Rodilla", discipline: "KINESIOLOGY", schedule: null, pricing: null, description: null, notes: null, exerciseIds: [] });
    expect(PlanTemplateCreateSchema.safeParse(input).success).toBe(true);
  });

  it("validación: nombre, cantidad, duración y precio faltante", () => {
    const e = validateTemplateDraft({ ...emptyTemplateDraft(), totalSessions: 0, durationMin: 5, priceMode: "PER_SESSION", priceCents: null });
    expect(e.name).toBe(TEMPLATE_COPY.noName);
    expect(e.totalSessions).toBeTruthy();
    expect(e.durationMin).toBeTruthy();
    expect(e.pricing).toBe(TEMPLATE_COPY.noPrice);
    expect(validateTemplateDraft({ ...emptyTemplateDraft(), name: "x" }, { priceInvalid: true }).pricing).toBe(TEMPLATE_COPY.priceInvalid);
    expect(validateTemplateDraft({ ...emptyTemplateDraft(), name: "x" })).toEqual({});
  });

  it("edición: patch solo con lo que cambió + CAS; sin cambios = null", () => {
    const base = templateDraftFromDetail(detail());
    expect(templateUpdatePatch(base, base, { id: "tpl-1", updatedAt: UPDATED })).toBeNull();
    const patch = templateUpdatePatch(base, { ...base, name: "Lumbalgia crónica" }, { id: "tpl-1", updatedAt: UPDATED });
    expect(patch).toEqual({ id: "tpl-1", expectedUpdatedAt: UPDATED.toISOString(), name: "Lumbalgia crónica" });
    expect(PlanTemplateUpdateSchema.safeParse(patch).success).toBe(true);
    // Pasar a "Sin precio" limpia el precio en el server (pricing: null), no lo omite.
    const noPrice = templateUpdatePatch(base, templateWithPriceMode(base, "NONE", SERVICES), { id: "tpl-1", updatedAt: UPDATED });
    expect(noPrice).toMatchObject({ pricing: null });
    expect(noPrice).not.toHaveProperty("name");
  });

  it("ejercicios no asignables: se marcan y se sacan al guardar aunque no se toque nada más", () => {
    const base = templateDraftFromDetail(detail({ exercises: [{ id: "ex-1", name: "Puente", assignable: true }, { id: "ex-9", name: "Ejercicio no disponible", assignable: false }] }));
    const patch = templateUpdatePatch(base, base, { id: "tpl-1", updatedAt: UPDATED });
    expect(patch).toEqual({ id: "tpl-1", expectedUpdatedAt: UPDATED.toISOString(), exerciseIds: ["ex-1"] });
    const html = render(<TemplateForm draft={base} onChange={noop} services={SERVICES} errors={{}} />);
    expect(html).toContain('data-assignable="false"');
    expect(html).toContain(TEMPLATE_COPY.exerciseUnavailable);
  });

  it("dirty-guard: compara contra el borrador con el que se abrió", () => {
    const base = templateDraftFromDetail(detail());
    expect(isTemplateDraftDirty(base, { ...base })).toBe(false);
    expect(isTemplateDraftDirty(base, { ...base, notes: "otra" })).toBe(true);
    expect(isTemplateDraftDirty(null, base)).toBe(false);
  });

  it("cambiar la disciplina limpia un servicio de la otra; 'Por sesión' propone el precio del servicio", () => {
    const d = { ...emptyTemplateDraft("KINESIOLOGY"), serviceId: "svc-k" };
    expect(templateWithDiscipline(d, "OSTEOPATHY", SERVICES).serviceId).toBeNull();
    expect(templateWithDiscipline({ ...d, serviceId: "svc-n" }, "OSTEOPATHY", SERVICES).serviceId).toBe("svc-n");
    expect(templateWithPriceMode(d, "PER_SESSION", SERVICES)).toMatchObject({ priceMode: "PER_SESSION", priceCents: 1_500_000 });
  });

  it("fieldErrors del server → campos del form (exerciseIds → ejercicios)", () => {
    expect(templateServerErrors({ name: ["Poné un nombre"], exerciseIds: ["Hay ejercicios repetidos"], otro: ["x"] })).toEqual({
      name: "Poné un nombre",
      exercises: "Hay ejercicios repetidos",
    });
  });
});

describe("[S21t] TemplateForm (render)", () => {
  it("campos en orden con MoneyInput y el editor de horario", () => {
    const html = render(
      <TemplateForm draft={{ ...emptyTemplateDraft("KINESIOLOGY"), priceMode: "PACKAGE", priceCents: 12_000_000 }} onChange={noop} services={SERVICES} errors={{}} onAddExercises={noop} />
    );
    const order = ["Nombre", "Descripción", "Disciplina", "Servicio", "Cantidad de sesiones", "Duración", "Precio total del paquete", "Ejercicios", "Notas"];
    let last = -1;
    for (const label of order) {
      const i = html.indexOf(label, last + 1);
      expect(i, `falta o fuera de orden: ${label}`).toBeGreaterThan(last);
      last = i;
    }
    expect(html).toContain(TEMPLATE_COPY.scheduleHint);
    // Servicios: los de la disciplina + los sin disciplina; nunca los de la otra.
    expect(html).toContain("Sesión kinésica");
    expect(html).toContain("Consulta general");
    expect(html).not.toContain("Sesión osteopática");
    expect(html).toContain("Sumar ejercicios");
  });

  it("solo lectura: todo deshabilitado y sin 'Quitar' / 'Sumar ejercicios'", () => {
    const html = render(<TemplateForm draft={templateDraftFromDetail(detail())} onChange={noop} services={SERVICES} errors={{}} disabled onAddExercises={noop} />);
    expect(html).not.toContain("Quitar");
    expect(html).not.toContain("Sumar ejercicios");
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});

describe("[S21t] TemplateDrawer (render)", () => {
  it("alta: drawer con título, form con la disciplina inicial y 'Crear plantilla'", () => {
    const html = render(<TemplateDrawer open templateId={null} discipline="OSTEOPATHY" onClose={noop} onSaved={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain(TEMPLATE_COPY.titleCreate);
    expect(html).toMatch(/<option value="OSTEOPATHY"[^>]*selected=""/);
    expect(html).toContain(">Crear plantilla<");
    expect(html).toContain(">Cancelar<");
  });

  it("edición: arranca cargando (no muestra un form vacío que se pueda guardar)", () => {
    const html = render(<TemplateDrawer open templateId="tpl-1" onClose={noop} onSaved={noop} />);
    expect(html).toContain("Cargando plantilla");
    expect(html).not.toContain(">Guardar<");
  });

  it("cerrado: no renderiza nada", () => {
    expect(render(<TemplateDrawer open={false} templateId={null} onClose={noop} onSaved={noop} />)).not.toContain('role="dialog"');
  });
});
