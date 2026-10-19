/**
 * [FC-3e] Inicio de la HC (FC-3e1, brief T4 §24.7 «Inicio de la HC», FC-UI-D9/D10).
 *
 * Render estático (`renderToStaticMarkup`) de la vista real `EvolucionesView` con la `clinicalHome` del loader, más las
 * funciones puras que deciden la primera carga, la barra mobile y la descarga de la HC completa. Se mockean solo las
 * server actions (red). Lo que no se puede ver en un render estático (que un efecto no lea) se afirma con
 * `firstLoadState`, que es exactamente lo que la vista usa para decidir si lee al montar.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
  voidClinicalNote: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/diagnoses", () => ({
  searchDiagnoses: async () => null,
  getDiagnosisPickerHome: async () => null,
  toggleDiagnosisFavorite: async () => ({ ok: false, error: "x" }),
  createTenantDiagnosis: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/patient-documents", () => ({}));
vi.mock("@/lib/patients", () => ({}));
const read = vi.hoisted(() => ({
  getPatientTimeline: vi.fn(async () => null),
  getBookingClinicalNote: vi.fn(async () => null),
  getClinicalNoteHistory: vi.fn(async () => null),
  getPatientClinicalSummary: vi.fn(async () => null),
}));
vi.mock("@/lib/clinical-notes-read", () => read);

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import {
  COMPOSER_INLINE_MIN_PX,
  EvolucionesView,
  deepLinkFixedBooking,
  firstLoadState,
  pageHasNotes,
} from "@/components/patients/profile/views/evoluciones-view";
import { composerBarBooking } from "@/components/fichas/composer-bar";
import { filenameFromDisposition, hcRecordDownloadError, hcRecordPdfUrl } from "@/components/fichas/hc-header-actions";
import { HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";
import { modulesFor } from "@/lib/tenant-modules";
import type { ClinicalNoteDTO, ComposerBookingCandidate, PatientClinicalHome, TimelineItem } from "@/lib/clinical-notes-types";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={KINE}>
      <ToastProvider>
        <ConfirmProvider>{el}</ConfirmProvider>
      </ToastProvider>
    </TenantModulesProvider>
  );

const PID = "pat_000000abcdef";
const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR
const VIEWER = { tenantId: "t1", userId: "u1" };

function note(over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  return {
    id: "note-1",
    patientId: PID,
    bookingId: null,
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control de hombro",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-14T12:30:00.000Z",
    author: { userId: "u1", practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-14T13:00:00.000Z",
    updatedAt: "2026-10-14T13:00:00.000Z",
    voided: null,
    booking: null,
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    bodyDoc: null, diagnoses: [], authorLicense: null, importSource: null, lateEntry: false, sharedDocument: null,
    ...over,
  };
}
const noteItem = (n: ClinicalNoteDTO): TimelineItem => ({ type: "note", key: `n:${n.id}`, at: n.occurredAt, note: n, amendments: [], session: null });
const candidate = (over: Partial<ComposerBookingCandidate> = {}): ComposerBookingCandidate => ({
  id: "bk-today",
  scheduledFor: "2026-10-15T13:00:00.000Z", // 10:00 AR
  serviceName: "Sesión kinésica",
  status: "CONFIRMED",
  practitionerId: "pr-1",
  hasLiveNote: false,
  ...over,
});
function home(over: Partial<PatientClinicalHome> = {}): PatientClinicalHome {
  return {
    summary: { latest: null, liveCount: 1 },
    firstPage: { items: [noteItem(note())], nextCursor: null },
    composer: { candidates: [candidate()] },
    deepLink: null,
    ...over,
  };
}
const view = (props: Partial<Parameters<typeof EvolucionesView>[0]> = {}) =>
  render(
    <EvolucionesView
      patientId={PID}
      canWrite
      clinicalHome={home()}
      patientName="Lucía Gómez"
      viewerPractitionerId="pr-1"
      viewerScope={VIEWER}
      now={NOW}
      {...props}
    />
  );
function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

describe("[FC-3e] inicio de la HC: primera página desde props (sin fetch al montar)", () => {
  it("con la clinical home la lista sale pintada del SSR y la vista no lee al montar", () => {
    read.getPatientTimeline.mockClear();
    const html = view();
    expect(html).toContain("Control de hombro");
    expect(html).not.toContain("Cargando fichas…");
    expect(firstLoadState({ clinicalHome: home() })).toMatchObject({ status: "ready", fetchOnMount: false });
    expect(read.getPatientTimeline).not.toHaveBeenCalled();
  });

  it("home null = rechazo genérico sin leer; sin home (caller viejo) cae a la lectura de EV2", () => {
    expect(firstLoadState({ clinicalHome: null })).toEqual({ status: "forbidden", page: null, fetchOnMount: false });
    expect(view({ clinicalHome: null })).toContain("No tenés acceso");
    expect(firstLoadState({})).toMatchObject({ status: "loading", fetchOnMount: true });
    expect(firstLoadState({ clinicalHome: home({ firstPage: null }) })).toMatchObject({ fetchOnMount: true });
  });

  it("«Cargar más» con el cursor de la primera página; vacía: lo dice", () => {
    const more = view({ clinicalHome: home({ firstPage: { items: [noteItem(note())], nextCursor: "c2" } }) });
    expect(buttons(more)).toContain(HC_HOME_COPY.loadMore);
    const empty = view({ clinicalHome: home({ firstPage: { items: [], nextCursor: null } }) });
    expect(empty).toContain(HC_HOME_COPY.empty);
    expect(empty).toContain(HC_HOME_COPY.emptyHint);
    expect(pageHasNotes({ items: [], nextCursor: null })).toBe(false);
    expect(pageHasNotes({ items: [], nextCursor: "c" })).toBe(true);
  });
});

describe("[FC-3e] composer solo con canWrite; barra mobile", () => {
  it(`composer inline y barra en el SSR; el CSS muestra el inline desde ${COMPOSER_INLINE_MIN_PX} px y la barra abajo`, () => {
    const html = view();
    expect(html).toMatch(/class="k-hc-composer-inline" data-hc-composer="inline"[\s\S]*?<form/);
    expect(html).toContain('class="k-hc-composer-bar" data-composer-bar=""');
    expect(html).toContain("@media (max-width: 639.98px) { .k-hc-composer-inline { display: none !important; } }");
    expect(html).toContain("@media (min-width: 640px) { .k-hc-composer-bar { display: none !important; } }");
    // El formulario inline es el estático (sin Drawer en el SSR: el Drawer va diferido y solo al abrirlo).
    expect(buttons(html)).toContain("Guardar ficha");
    expect(html).not.toContain('role="dialog"');
  });

  it("sin escritura: ni composer ni barra (la HC se lee igual)", () => {
    const html = view({ canWrite: false, clinicalHome: home({ composer: null }) });
    expect(html).not.toContain(`class="k-hc-composer-inline"`);
    expect(html).not.toContain("data-composer-bar");
    expect(buttons(html)).not.toContain("Guardar ficha");
    expect(html).toContain("Control de hombro");
  });

  it("la barra anuncia el turno fijo del deep link y nunca uno con ficha viva", () => {
    const fixed = deepLinkFixedBooking({ id: "bk-dl", scheduledFor: "2026-10-15T13:00:00.000Z", serviceName: "Osteopatía", status: "COMPLETED" });
    expect(composerBarBooking({ candidates: [candidate()], fixedBooking: fixed, viewerPractitionerId: "pr-1", now: NOW })?.id).toBe("bk-dl");
    expect(composerBarBooking({ candidates: [candidate({ hasLiveNote: true })], viewerPractitionerId: "pr-1", now: NOW })).toBeNull();
    expect(composerBarBooking({ candidates: [], viewerPractitionerId: null, now: NOW })).toBeNull();
    const bar = view();
    expect(bar).toMatch(/data-composer-bar=""[\s\S]*?Nueva ficha/);
  });
});

describe("[FC-3e] HC completa y menú «⋯»", () => {
  it("imprimir, descargar la HC completa y el menú, solo con fichas; el menú con escritura o carpeta", () => {
    const html = view();
    expect(html).toMatch(/href="\/pacientes\/pat_000000abcdef\/imprimir"[^>]*target="_blank"[^>]*>Imprimir historia clínica</);
    expect(buttons(html)).toContain(HC_HOME_COPY.downloadRecord);
    expect(html).toContain(`aria-label="${HC_HOME_COPY.moreActions}"`);
    expect(html).toContain('aria-haspopup="menu"');
    // Cerrado: los ítems (y sus chunks diferidos) no están.
    expect(html).not.toContain(HC_HOME_COPY.importWord);

    const empty = view({ clinicalHome: home({ firstPage: { items: [], nextCursor: null } }) });
    expect(empty).not.toContain(HC_HOME_COPY.print);
    expect(buttons(empty)).not.toContain(HC_HOME_COPY.downloadRecord);

    const ro = view({ canWrite: false, viewerScope: null, clinicalHome: home({ composer: null }) });
    expect(ro).not.toContain(`aria-label="${HC_HOME_COPY.moreActions}"`);
  });

  it("descarga: 413 con el copy de la ruta, 429 rate limit, 503 sin cuerpo y el resto → «No pudimos armar el archivo»", () => {
    expect(hcRecordPdfUrl("p 1")).toBe("/api/pacientes/p%201/historia-clinica/pdf");
    expect(hcRecordDownloadError(200, null)).toBeNull();
    expect(hcRecordDownloadError(413, HC_EXPORT_COPY.recordTooLarge)).toBe(HC_EXPORT_COPY.recordTooLarge);
    expect(hcRecordDownloadError(413, "")).toBe(HC_EXPORT_COPY.recordTooLarge);
    expect(hcRecordDownloadError(429, "x")).toBe(HC_EXPORT_COPY.rateLimited);
    expect(hcRecordDownloadError(503, null)).toBe(HC_EXPORT_COPY.renderFailed);
    expect(hcRecordDownloadError(404, "Not found")).toBe(HC_EXPORT_COPY.renderFailed);
  });

  it("nombre del archivo: filename* (UTF-8) primero, después el ASCII, si no el fallback", () => {
    const h = `attachment; filename="Gomez Lucia HC.pdf"; filename*=UTF-8''G%C3%B3mez%20Luc%C3%ADa%20HC.pdf`;
    expect(filenameFromDisposition(h, "x.pdf")).toBe("Gómez Lucía HC.pdf");
    expect(filenameFromDisposition(`attachment; filename="a.pdf"`, "x.pdf")).toBe("a.pdf");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`, "x.pdf")).toBe("x.pdf");
    expect(filenameFromDisposition(null, "x.pdf")).toBe("x.pdf");
  });
});
