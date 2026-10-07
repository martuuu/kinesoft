// L9 (PD-10, S22h · ES3): archivar un paciente con planes vivos pregunta qué
// hacer con ellos — pausar (default, igual que el server) o cancelar los
// turnos futuros. Sin planes vivos (o sin el módulo) no se pregunta.
// Se renderiza el diálogo real; la action la llama el caller (no se mockea
// nada del componente).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArchivePatientDialog,
  ARCHIVE_PLANS_OPTIONS,
  archivePatientDialogCopy,
  shouldAskArchivePlans,
} from "@/components/patients/archive-patient-dialog";
import { DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION, PATIENT_ARCHIVE_PLANS_ACTIONS } from "@/lib/plans-lifecycle-state";

describe("[P3-S22h] L9: diálogo de archivar paciente", () => {
  it("[P3-S22h] pregunta solo con el módulo planes y planes vivos (o desconocidos)", () => {
    expect(shouldAskArchivePlans({ plansEnabled: true, livePlanCount: 2 })).toBe(true);
    expect(shouldAskArchivePlans({ plansEnabled: true, livePlanCount: 0 })).toBe(false);
    expect(shouldAskArchivePlans({ plansEnabled: false, livePlanCount: 2 })).toBe(false);
    // Bulk sin el dato: se pregunta.
    expect(shouldAskArchivePlans({ plansEnabled: true, livePlanCount: null })).toBe(true);
  });

  it("[P3-S22h] las opciones son exactamente las del server y la primera es su default (pausar)", () => {
    expect(ARCHIVE_PLANS_OPTIONS.map((o) => o.value).sort()).toEqual([...PATIENT_ARCHIVE_PLANS_ACTIONS].sort());
    expect(ARCHIVE_PLANS_OPTIONS[0].value).toBe(DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION);
    expect(DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION).toBe("pause");
  });

  it("[P3-S22h] copy: uno, varios y sin el dato", () => {
    const one = archivePatientDialogCopy({ patientName: "Lucía Gómez", livePlanCount: 1 });
    expect(one.title).toBe("Archivar paciente");
    expect(one.message).toContain("Lucía Gómez deja de aparecer");
    expect(one.message).toContain("Tiene 1 plan activo.");
    const bulk = archivePatientDialogCopy({ count: 3, livePlanCount: null });
    expect(bulk.title).toBe("Archivar 3 pacientes");
    expect(bulk.message).toContain("3 pacientes dejan de aparecer");
    expect(bulk.message).toContain("los podés desarchivar");
    expect(bulk.message).toContain("Si alguno tiene planes activos");
  });

  it("[P3-S22h] abierto: dos radios, 'Pausar' marcado por default", () => {
    const html = renderToStaticMarkup(
      <ArchivePatientDialog
        open
        onClose={() => {}}
        patientName="Lucía Gómez"
        livePlanCount={2}
        onConfirm={async () => ({ ok: true })}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Archivar paciente");
    expect(html.match(/type="radio"/g)?.length).toBe(2);
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    const radio = (v: string) => inputs.find((i) => i.includes(`value="${v}"`)) ?? "";
    expect(radio("pause")).toContain("checked");
    expect(radio("cancel")).not.toContain("checked");
    expect(html).toContain("Pausar los planes");
    expect(html).toContain("Cancelar los planes y sus turnos futuros");
    expect(html).toContain("Tiene 2 planes activos.");
  });

  it("[P3-S22h] cerrado no renderiza nada", () => {
    const html = renderToStaticMarkup(
      <ArchivePatientDialog open={false} onClose={() => {}} livePlanCount={1} onConfirm={async () => ({ ok: true })} />,
    );
    expect(html).toBe("");
  });
});
