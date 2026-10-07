/**
 * [P3-S23] Puerta Diagnóstico → editor único de planes (C10).
 *
 * Sin jsdom: lo interactivo se cubre con los builders puros que usan las dos
 * pantallas para armar el pedido al editor (`buildDiagnosisEditorRequest` y
 * los ids de ejercicios), y las pantallas reales se renderizan con
 * `renderToStaticMarkup`. Se mockean solo la red (`listExercises` del picker)
 * y el router; nunca el componente bajo test.
 *
 * Re-afirma sobre la puerta nueva los contratos de P0-S02u-diag
 * (`diagnostico-dates.test.tsx`, que probaba el modal viejo):
 *  - sin paciente en la URL no se preselecciona nadie;
 *  - la fecha de inicio es hoy AR (ahora la pone el editor, la puerta no manda
 *    fecha), también a las 22:30 AR cuando la fecha UTC ya es mañana.
 * Correr con TZ=UTC y TZ=AR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/exercises", () => ({ listExercises: async () => [] }));

import { renderToStaticMarkup } from "react-dom/server";
import {
  DIAGNOSIS_DOOR_COPY,
  NO_DIAGNOSIS_DOOR,
  buildDiagnosisEditorRequest,
  desktopDiagnosisExerciseIds,
  wizardDiagnosisExerciseIds,
  type DiagnosisDoor,
} from "@/components/diagnostico/assign-plan-modal";
import { DiagnosticoScreen } from "@/components/screens/diagnostico-screen";
import { DiagnosticoWizard, WIZARD_STEPS } from "@/components/screens/diagnostico-wizard";
import { parseDiagnosisDeepLink, planDeepLinkHref } from "@/lib/plans-deeplink";
import { planEditorToday } from "@/lib/plan-editor-state";
import type { CatalogDTO, CaseSelection } from "@/lib/diagnosis-engine";

const selection: CaseSelection = { regions: ["knee-r"], symptoms: [], triggers: [], phase: null, intensity: 5 };

const catalog: CatalogDTO = {
  regions: [],
  conditions: [],
  symptoms: [{ slug: "dolor", label: "Dolor" }],
  triggers: [{ slug: "subir", label: "Subir escaleras" }],
  phases: [{ slug: "agudo", label: "Agudo" }],
};

const ex = (exerciseId: string, relation: "DIRECT" | "INDIRECT") => ({ exerciseId, relation });

describe("[P3-S23] buildDiagnosisEditorRequest (pedido al editor)", () => {
  it("abre el editor en create, Kine, con el caso y los ejercicios en el orden elegido (sin repetir)", () => {
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, exerciseIds: ["e2", "e1", "e2"] });
    expect(r).toEqual({
      mode: "create",
      discipline: "KINESIOLOGY",
      diagnosis: { conditionSlug: "lca", selection, exerciseIds: ["e2", "e1"] },
    });
  });

  it("sin paciente en la URL no preselecciona a nadie (el editor muestra el picker)", () => {
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, exerciseIds: ["e1"], patientId: null, bookingId: null });
    expect(r).not.toHaveProperty("patientId");
    expect(r).not.toHaveProperty("fromBookingId");
  });

  it("con el deep-link ?patientId=&bookingId= el editor arranca con ese paciente y ese turno", () => {
    const link = parseDiagnosisDeepLink(new URLSearchParams("patientId=pat_1&bookingId=bk_9"));
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, exerciseIds: ["e1"], ...link });
    expect(r.patientId).toBe("pat_1");
    expect(r.fromBookingId).toBe("bk_9");
  });

  it("un turno sin paciente no viaja (no dice para quién es el plan)", () => {
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, bookingId: "bk_9" });
    expect(r).not.toHaveProperty("fromBookingId");
  });

  it("sin ejercicios elegidos no manda la lista: el server sugiere los de la condición", () => {
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, exerciseIds: [] });
    expect(r.diagnosis).toEqual({ conditionSlug: "lca", selection });
  });

  it("no manda fecha ni cantidad: el editor arranca en hoy AR también a las 22:30 AR", () => {
    const r = buildDiagnosisEditorRequest({ conditionSlug: "lca", selection, exerciseIds: ["e1"] });
    expect(r).not.toHaveProperty("prefill");
    expect(planEditorToday(new Date("2026-10-04T01:30:00.000Z"))).toBe("2026-10-03");
  });

  it("el link armado por las otras puertas vuelve a parsear igual (C10)", () => {
    const href = planDeepLinkHref({ kind: "diagnosis", patientId: "pat_1", bookingId: "bk_9" });
    expect(href).toBe("/diagnostico?patientId=pat_1&bookingId=bk_9");
    const qs = new URLSearchParams(href!.split("?")[1]);
    expect(parseDiagnosisDeepLink(qs)).toEqual({ patientId: "pat_1", bookingId: "bk_9" });
  });
});

describe("[P3-S23] ejercicios que viajan al editor", () => {
  it("escritorio: los de la condición y después los extras, solo los marcados", () => {
    expect(
      desktopDiagnosisExerciseIds({
        conditionExerciseIds: ["c1", "c2", "c3"],
        extraExerciseIds: ["x1", "x2"],
        selectedExerciseIds: ["x2", "c3", "c1"],
      })
    ).toEqual(["c1", "c3", "x2"]);
  });

  it("wizard: los DIRECT de la condición; sin ninguno, que sugiera el server", () => {
    expect(wizardDiagnosisExerciseIds([ex("a", "DIRECT"), ex("b", "INDIRECT"), ex("c", "DIRECT")])).toEqual(["a", "c"]);
    expect(wizardDiagnosisExerciseIds([ex("b", "INDIRECT")])).toBeUndefined();
  });
});

describe("[P3-S23] pantallas", () => {
  const withPatient: DiagnosisDoor = {
    patient: { id: "pat_1", name: "Ana Pérez" },
    bookingId: "bk_9",
    patientNotFound: false,
    canAssign: true,
  };

  // P3.Z (F3b): se borró la aserción "sin aria-pressed en la lista de
  // pacientes": la pantalla ya no tiene esa lista, así que no podía fallar. La
  // no-preselección la cubre `buildDiagnosisEditorRequest` sin paciente (arriba).
  it("escritorio sin deep-link: sin banner", () => {
    const html = renderToStaticMarkup(<DiagnosticoScreen catalog={catalog} />);
    expect(html).not.toContain('data-testid="diagnosis-door-banner"');
    expect(html).toContain("Asignar diagnóstico y armar plan");
  });

  it("escritorio con deep-link: muestra para quién es y cómo cambiarlo", () => {
    const html = renderToStaticMarkup(<DiagnosticoScreen catalog={catalog} door={withPatient} />);
    expect(html).toContain("Diagnóstico para <strong");
    expect(html).toContain("Ana Pérez");
    expect(html).toContain(`href="/diagnostico"`);
  });

  it("sin plans.manage: avisa y el botón queda deshabilitado", () => {
    const door = { ...NO_DIAGNOSIS_DOOR, canAssign: false };
    const html = renderToStaticMarkup(<DiagnosticoScreen catalog={catalog} door={door} />);
    expect(html).toContain(DIAGNOSIS_DOOR_COPY.cannotAssign);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Asignar diagnóstico y armar plan/);
  });

  it("patientId que no resolvió: lo dice en vez de ignorarlo", () => {
    const door = { ...NO_DIAGNOSIS_DOOR, patientNotFound: true };
    const html = renderToStaticMarkup(<DiagnosticoScreen catalog={catalog} door={door} />);
    expect(html).toContain(DIAGNOSIS_DOOR_COPY.patientNotFound);
  });

  it("wizard: ya no tiene paso Paciente (lo elige el editor) y muestra el paciente del deep-link", () => {
    expect(WIZARD_STEPS).not.toContain("Paciente");
    const html = renderToStaticMarkup(<DiagnosticoWizard catalog={catalog} door={withPatient} />);
    expect(html).toContain(`Paso 1 de ${WIZARD_STEPS.length}`);
    expect(html).toContain("Ana Pérez");
  });
});

describe("[P3-S23] la UI de Diagnóstico ya no saltea el motor", () => {
  const root = join(__dirname, "..", "..", "..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  const files = [
    "components/diagnostico/assign-plan-modal.tsx",
    "components/screens/diagnostico-screen.tsx",
    "components/screens/diagnostico-wizard.tsx",
    "app/(app)/diagnostico/page.tsx",
  ];

  // Armado por partes: el gate de P3.Z.0 greppea el repo (un literal = falso hit).
  const LEGACY_DIAGNOSIS_DOOR = ["assignDiagnosis", "AndCreateProgram"].join("");

  it.each(files)("%s no llama al alta legacy de Diagnóstico ni pre-carga pacientes", (f) => {
    const code = src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(new RegExp(`\\b${LEGACY_DIAGNOSIS_DOOR}\\b`));
    expect(code).not.toMatch(/\bsearchPatientsForAssignment\b/);
  });

  it("el editor se carga lazy (next/dynamic), nunca con un import estático", () => {
    const code = src("components/diagnostico/assign-plan-modal.tsx");
    expect(code).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/planes\/plan-editor-drawer"\)/);
    expect(code).not.toMatch(/^import [^;]*from "@\/components\/planes\/plan-editor-drawer"/m);
    for (const f of files.slice(1)) expect(src(f)).not.toMatch(/plan-editor-drawer/);
  });
});
