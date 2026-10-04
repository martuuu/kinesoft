/**
 * P0-S02u-diag — fechas, paciente y días en las puertas de Diagnóstico.
 *
 * Sin jsdom (los render tests corren en node con `renderToStaticMarkup`), así
 * que lo interactivo se cubre con los builders puros exportados por los mismos
 * componentes (`buildAssignInput`, `buildWizardAssignInput`): son los que arman
 * el payload que viaja a `assignDiagnosisAndCreateProgram`.
 *
 * El reloj se fija a 01:30Z = 22:30 AR del día anterior: es la franja donde la
 * fecha UTC del host (bug viejo) ya es "mañana". Correr con TZ=UTC y TZ=AR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/diagnosis", () => ({
  assignDiagnosisAndCreateProgram: vi.fn(),
  searchPatientsForAssignment: vi.fn(async () => []),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));

import { renderToStaticMarkup } from "react-dom/server";
import { AssignPlanModal, buildAssignInput } from "@/components/diagnostico/assign-plan-modal";
import { buildWizardAssignInput } from "@/components/screens/diagnostico-wizard";
import type { CatalogDTO, CaseSelection } from "@/lib/diagnosis-engine";

const NIGHT_AR = new Date("2026-10-04T01:30:00.000Z"); // 2026-10-03 22:30 AR

const selection: CaseSelection = {
  regions: ["knee-r"],
  symptoms: [],
  triggers: [],
  phase: null,
  intensity: 5,
};

const condition = {
  slug: "lca",
  name: "Lesión de LCA",
  isCustom: false,
  cie10: null,
  recoveryWeeksMin: null,
  recoveryWeeksMax: null,
} as unknown as CatalogDTO["conditions"][number];

const patients = [
  { id: "p1", name: "Ana Pérez", hc: "HC-1", info: "30 años" },
  { id: "p2", name: "Beto Gómez", hc: "HC-2", info: "45 años" },
];

function renderModal() {
  return renderToStaticMarkup(
    <AssignPlanModal
      condition={condition}
      ranking={[]}
      selectedExercises={[]}
      selectedExerciseIds={["e1"]}
      selection={selection}
      initialPatients={patients}
      onClose={() => {}}
    />
  );
}

describe("[P0-S02u-diag] AssignPlanModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NIGHT_AR);
  });
  afterEach(() => vi.useRealTimers());

  it("la primera sesión arranca en hoy AR, no en la fecha UTC del host", () => {
    const html = renderModal();
    expect(html).toMatch(/<input type="date"[^>]*value="2026-10-03"/);
    expect(html).not.toMatch(/<input type="date"[^>]*value="2026-10-04"/);
  });

  it("no preselecciona paciente y el botón Asignar arranca deshabilitado", () => {
    const html = renderModal();
    const patientButtons = html.match(/<button[^>]*aria-pressed="(true|false)"[^>]*>(?:(?!<\/button>).)*?HC-\d/g) ?? [];
    expect(patientButtons).toHaveLength(2);
    for (const b of patientButtons) expect(b).toContain('aria-pressed="false"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Asignar a paciente/);
  });

  it("el tope de sesiones es PLAN_MAX_SESSIONS (60), no 48", () => {
    const html = renderModal();
    expect(html).toMatch(/type="number"[^>]*max="60"/);
  });
});

describe("[P0-S02u-diag] buildAssignInput (payload del modal)", () => {
  const base = {
    patientId: "p1",
    conditionSlug: "lca",
    conditionName: "Lesión de LCA",
    selection,
    ranking: [],
    orderedIds: ["e2", "e1"],
    selectedExerciseIds: ["e1", "e2"],
    totalSessions: 10,
    startDate: "2026-10-05",
  };

  it("los días elegidos viajan al server como daysOfWeek (0=Lun), ordenados y sin repetir", () => {
    const input = buildAssignInput({ ...base, dows: [3, 0, 3] });
    expect(input.daysOfWeek).toEqual([0, 3]);
    expect(input.frequency).toBe(2);
    expect(input.startDate).toBe("2026-10-05");
    expect(input.exerciseIds).toEqual(["e2", "e1"]);
    expect(input.programTitle).toBe("Plan Lesión de LCA");
  });

  it("1 día y 60 sesiones se manda tal cual: el server responde el error de tope y el modal lo muestra", () => {
    const input = buildAssignInput({ ...base, dows: [1], totalSessions: 60 });
    expect(input.daysOfWeek).toEqual([1]);
    expect(input.frequency).toBe(1);
    expect(input.totalSessions).toBe(60);
  });

  it("sin orden manual usa los ejercicios seleccionados", () => {
    const input = buildAssignInput({ ...base, orderedIds: [], dows: [0] });
    expect(input.exerciseIds).toEqual(["e1", "e2"]);
  });
});

describe("[P0-S02u-diag] buildWizardAssignInput (wizard mobile)", () => {
  it("startDate = hoy AR a las 22:30 AR (la fecha UTC ya es mañana)", () => {
    const input = buildWizardAssignInput({
      patientId: "p1",
      conditionSlug: "lca",
      conditionName: "Lesión de LCA",
      selection,
      ranking: [],
      exerciseIds: ["e1"],
      now: NIGHT_AR,
    });
    expect(input.startDate).toBe("2026-10-03");
    expect(input.totalSessions).toBe(8);
    expect(input.frequency).toBe(2);
    expect(input.daysOfWeek).toBeUndefined();
  });

  it("a las 09:00 AR es el mismo día", () => {
    const input = buildWizardAssignInput({
      patientId: "p1",
      conditionSlug: "lca",
      conditionName: "x",
      selection,
      ranking: [],
      exerciseIds: ["e1"],
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    expect(input.startDate).toBe("2026-10-04");
  });
});
