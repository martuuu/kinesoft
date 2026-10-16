// S32a (ES4 · P4.1A): archivar desde el listado de Pacientes pasa por la
// pregunta L9 (PD-10) igual que el perfil (S22h). Antes el «⋯» de la fila y la
// barra masiva llamaban a `setPatientArchived` / `bulkArchivePatients` sin
// `plansAction`: el server aplicaba su default (`pause`) sin preguntar y el
// consultorio no podía elegir cancelar los turnos futuros
// (AUDIT `archivar-paciente-lista-sin-L9`).
//
// Render real con `react-dom/server` (sin jsdom, como el resto de render/):
// se mockean SOLO las server actions y el toast; los handlers que llaman a la
// action son los símbolos que usa el componente.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { setPatientArchived, bulkArchivePatients } = vi.hoisted(() => ({
  setPatientArchived: vi.fn(),
  bulkArchivePatients: vi.fn(),
}));
vi.mock("@/lib/patients", () => ({ setPatientArchived, bulkArchivePatients }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import {
  PatientRowActions,
  archiveRowWithPlans,
  rowArchiveStep,
} from "@/components/patients/patient-row-actions";
import {
  BulkActionBar,
  BulkSelectProvider,
  bulkArchiveStep,
  bulkArchiveWithPlans,
} from "@/components/patients/bulk-select";
import { archivePatientDialogCopy } from "@/components/patients/archive-patient-dialog";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false });
const KINE_PRO = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });

beforeEach(() => {
  setPatientArchived.mockReset();
  bulkArchivePatients.mockReset();
});

describe("[ES4-S32a] fila: «Archivar paciente» pregunta L9", () => {
  it("[ES4-S32a] con el módulo planes archivar abre el diálogo (planes vivos desconocidos → se pregunta)", () => {
    expect(rowArchiveStep({ archived: false, plansEnabled: true, livePlanCount: null })).toBe("ask-plans");
    expect(rowArchiveStep({ archived: false, plansEnabled: true, livePlanCount: 2 })).toBe("ask-plans");
    // Dato conocido en 0 o sin módulo (General): sigue directo como antes.
    expect(rowArchiveStep({ archived: false, plansEnabled: true, livePlanCount: 0 })).toBe("direct");
    expect(rowArchiveStep({ archived: false, plansEnabled: false, livePlanCount: null })).toBe("direct");
    // Reactivar nunca pregunta por planes.
    expect(rowArchiveStep({ archived: true, plansEnabled: true, livePlanCount: null })).toBe("direct");
  });

  it("[ES4-S32a] la confirmación del diálogo llega a `setPatientArchived` con la elección", async () => {
    setPatientArchived.mockResolvedValueOnce({ ok: true });
    await expect(archiveRowWithPlans("p1", "cancel")).resolves.toEqual({ ok: true });
    expect(setPatientArchived).toHaveBeenCalledWith({ id: "p1", archived: true, plansAction: "cancel" });

    setPatientArchived.mockResolvedValueOnce({ ok: false, error: "Sin acceso" });
    await expect(archiveRowWithPlans("p1", "pause")).resolves.toEqual({ ok: false, error: "Sin acceso" });
    expect(setPatientArchived).toHaveBeenLastCalledWith({ id: "p1", archived: true, plansAction: "pause" });
  });

  it("[ES4-S32a] los módulos de prueba son los esperados", () => {
    expect(KINE_PRO.has("planes")).toBe(true);
    expect(GENERAL.has("planes")).toBe(false);
  });

  it("[ES4-S32a] la fila renderiza con y sin el módulo planes (el diálogo cerrado no pinta nada)", () => {
    for (const modules of [KINE_PRO, GENERAL]) {
      const html = renderToStaticMarkup(
        <TenantModulesProvider modules={Array.from(modules)}>
          <PatientRowActions patientId="p1" archived={false} patientName="Lucía Gómez" />
        </TenantModulesProvider>,
      );
      expect(html).toContain('aria-label="Acciones"');
      expect(html).not.toContain('role="dialog"');
    }
  });
});

describe("[ES4-S32a] barra masiva: «Archivar» pregunta L9", () => {
  it("[ES4-S32a] en bulk `livePlanCount` es null: con planes siempre se pregunta, sin módulo va directo", () => {
    expect(bulkArchiveStep({ archived: true, plansEnabled: true })).toBe("ask-plans");
    expect(bulkArchiveStep({ archived: true, plansEnabled: false })).toBe("direct");
    // Restaurar no toca planes.
    expect(bulkArchiveStep({ archived: false, plansEnabled: true })).toBe("direct");
    // El copy del diálogo en bulk lo dice en condicional.
    const copy = archivePatientDialogCopy({ count: 3, livePlanCount: null });
    expect(copy.title).toBe("Archivar 3 pacientes");
    expect(copy.message).toContain("Si alguno tiene planes activos");
  });

  it("[ES4-S32a] la confirmación llega a `bulkArchivePatients` con ids y elección", async () => {
    bulkArchivePatients.mockResolvedValueOnce({ ok: true, data: { updated: 2 } });
    await expect(bulkArchiveWithPlans(["a", "b"], "pause")).resolves.toEqual({ ok: true });
    expect(bulkArchivePatients).toHaveBeenCalledWith({ ids: ["a", "b"], archived: true, plansAction: "pause" });

    bulkArchivePatients.mockResolvedValueOnce({ ok: false, error: "Todo o nada" });
    await expect(bulkArchiveWithPlans(["a"], "cancel")).resolves.toEqual({ ok: false, error: "Todo o nada" });
    expect(bulkArchivePatients).toHaveBeenLastCalledWith({ ids: ["a"], archived: true, plansAction: "cancel" });
  });

  it("[ES4-S32a] sin selección la barra no se pinta", () => {
    const html = renderToStaticMarkup(
      <BulkSelectProvider>
        <BulkActionBar />
      </BulkSelectProvider>,
    );
    expect(html).toBe("");
  });
});
