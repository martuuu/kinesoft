/**
 * [EV2-Z] Impresión de la HC: render estático de la vista real (`print-view.tsx`), sin base ni sesión (la lectura,
 * el gate y el audit los cubre `tests/integration/clinical-record-print.test.ts`). Fechas afirmadas en hora AR: corre
 * igual con TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClinicalRecordPrintView,
  PRINT_CSS,
  printFooter,
  voidedLine,
} from "@/app/(app)/pacientes/[id]/imprimir/print-view";
import type { ClinicalRecordPrint } from "@/lib/clinical-notes-print-internal";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const AUTHOR = "user-author";

function note(over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  return {
    id: "n1",
    patientId: "p1",
    bookingId: "bk1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-14T12:30:00.000Z",
    author: { userId: AUTHOR, practitionerId: "pr1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-14T13:00:00.000Z",
    updatedAt: "2026-10-14T13:00:00.000Z",
    voided: null,
    booking: { id: "bk1", scheduledFor: "2026-10-14T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    ...over,
  };
}

const record = (over: Partial<ClinicalRecordPrint> = {}): ClinicalRecordPrint => ({
  patient: { firstName: "Ana", lastName: "García", documentId: "30123456", dateOfBirth: "1990-05-02" },
  tenantName: "Consultorio Sur",
  printedAt: "2026-10-15T14:00:00.000Z",
  printedBy: "Lic. Pérez",
  notes: [note()],
  truncated: false,
  ...over,
});

const render = (r: ClinicalRecordPrint) =>
  renderToStaticMarkup(<ClinicalRecordPrintView record={r} backHref="/pacientes/p1?tab=evoluciones" />);

describe("[EV2-Z] impresión de la historia clínica", () => {
  it("anulada sin tachar, con fecha, quién (autor) y motivo", () => {
    const n = note({ voided: { at: "2026-10-14T15:00:00.000Z", byUserId: AUTHOR, reason: "Paciente equivocado" } });
    const html = render(record({ notes: [n] }));
    expect(html).toContain("Anulada el 14/10/2026, 12:00 por Lic. Pérez · Motivo: Paciente equivocado");
    expect(PRINT_CSS).not.toContain("line-through");
    // El texto de la anulada se sigue imprimiendo entero.
    expect(html).toContain("Mejoró la movilidad.");
  });

  it("anulada por otro que no es el autor = el/la Titular", () => {
    const n = note({ voided: { at: "2026-10-14T15:00:00.000Z", byUserId: "user-owner", reason: "Duplicada" } });
    expect(voidedLine(n)).toBe("Anulada el 14/10/2026, 12:00 por el/la Titular · Motivo: Duplicada");
    expect(voidedLine(note())).toBeNull();
  });

  it("«Turno: {servicio}»", () => {
    const html = render(record());
    expect(html).toContain("Turno: Sesión kinésica");
    expect(html).not.toContain("Turno ·");
  });

  it("aviso de corte: pedile la exportación al/la Titular", () => {
    const html = render(record({ truncated: true }));
    expect(html).toMatch(/Se imprimen las \d+ evoluciones más recientes\. Para la historia completa, pedile la exportación al\/la Titular\./);
    expect(render(record())).not.toContain("Se imprimen las");
  });

  it("pie de cada hoja con «Apellido, Nombre · DNI» (sin documento, solo el nombre)", () => {
    expect(render(record())).toMatch(/class="k-print-footer"[^>]*>García, Ana · DNI 30123456</);
    expect(printFooter({ firstName: "Ana", lastName: "García", documentId: null, dateOfBirth: null })).toBe("García, Ana");
    expect(PRINT_CSS).toMatch(/@media print[\s\S]*\.k-print-footer \{ display: block; position: fixed; bottom: 0;/);
  });

  it("«Cerrar» en vez de «Volver al perfil»", () => {
    const html = render(record());
    expect(html).toMatch(/<button[^>]*>Cerrar<\/button>/);
    expect(html).not.toContain("Volver al perfil");
  });

  it("en papel: el shell sale con display:none y la raíz va static (no el truco de visibility)", () => {
    const print = PRINT_CSS.slice(PRINT_CSS.indexOf("@media print"));
    expect(print).toContain("body *:not(:has(.k-print-root)):not(.k-print-root):not(.k-print-root *) { display: none !important; }");
    expect(print).toMatch(/body \*:has\(\.k-print-root\) \{[^}]*position: static !important/);
    expect(print).toMatch(/\.k-print-root \{ position: static;/);
    expect(print).not.toContain("visibility");
    expect(print).not.toContain("position: absolute");
  });
});
