/**
 * [FC-3e] Impresión de la HC con fichas con formato (FC-3e1): el cuerpo sale de `bodyDoc` por `HcBody`/`HcDocView`,
 * con los diagnósticos congelados (el primero = principal), la matrícula congelada del autor y la atribución de la
 * CIE-11. Render estático de la vista real (`print-view.tsx`), sin base ni sesión.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClinicalRecordPrintView,
  PRINT_CSS,
  authorWithLicense,
  diagnosisLine,
} from "@/app/(app)/pacientes/[id]/imprimir/print-view";
import type { ClinicalRecordPrint } from "@/lib/clinical-notes-print-internal";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { HcDoc } from "@/lib/hc-doc";

function note(over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  return {
    id: "n1",
    patientId: "p1",
    bookingId: null,
    amendsNoteId: null,
    kind: "FIRST_VISIT",
    title: null,
    body: "Motivo de consulta\nDolor lumbar.",
    occurredAt: "2026-10-14T12:30:00.000Z",
    author: { userId: "u1", practitionerId: "pr1", name: "Lic. Pérez" },
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
const record = (notes: ClinicalNoteDTO[]): ClinicalRecordPrint => ({
  patient: { firstName: "Ana", lastName: "García", documentId: null, dateOfBirth: null },
  tenantName: "Consultorio Sur",
  printedAt: "2026-10-15T14:00:00.000Z",
  printedBy: "Lic. Pérez",
  notes,
  truncated: false,
});
const render = (r: ClinicalRecordPrint) => renderToStaticMarkup(<ClinicalRecordPrintView record={r} backHref="/pacientes/p1" />);

const DOC: HcDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Motivo de consulta" }] },
    { type: "paragraph", content: [{ type: "text", text: "Dolor ", marks: [] }, { type: "text", text: "lumbar", marks: [{ type: "bold" }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "≤ 3 sesiones" }] }] }] },
  ],
} as unknown as HcDoc;
const ICD: DiagnosisSnapshot = { v: 1, source: "icd11", refId: "icd-1", code: "ME84.2", title: "Lumbalgia", uri: null, release: "2026-01" };
const TEXT: DiagnosisSnapshot = { v: 1, source: "text", refId: null, code: null, title: "Contractura paravertebral", uri: null, release: null };

describe("[FC-3e] impresión de la HC con bodyDoc, diagnósticos y matrícula", () => {
  it("bodyDoc se pinta con HcDocView: títulos un nivel abajo del h1, negrita y listas; no el texto plano derivado", () => {
    const html = render(record([note({ bodyDoc: DOC })]));
    expect(html).toMatch(/<h3[^>]*>Motivo de consulta<\/h3>/);
    expect(html).toMatch(/<strong>lumbar<\/strong>/);
    expect(html).toMatch(/<ul[^>]*><li[^>]*>[\s\S]*≤ 3 sesiones/);
    expect(html).not.toContain("Motivo de consulta\nDolor lumbar.");
    expect(html).toContain("k-print-body");
  });

  it("ficha vieja sin doc: el texto plano con sus saltos (pre-wrap inline, no depende del CSS)", () => {
    const html = render(record([note()]));
    expect(html).toMatch(/style="white-space:pre-wrap"[^>]*>Motivo de consulta\nDolor lumbar\.</);
    expect(PRINT_CSS).not.toMatch(/\.k-print-body \{[^}]*pre-wrap/);
  });

  it("diagnósticos con el principal primero, matrícula del autor y atribución CIE-11 una sola vez", () => {
    const html = render(record([note({ diagnoses: [ICD, TEXT], authorLicense: "MN 1234" }), note({ id: "n2", diagnoses: [ICD] })]));
    expect(html).toContain("ME84.2 Lumbalgia (principal)");
    expect(html).toContain("<li>Contractura paravertebral</li>");
    expect(html).toContain("Lic. Pérez · MN 1234");
    expect(html.match(/CIE-11 © OMS · CC BY-ND 3.0 IGO/g)).toHaveLength(1);
    expect(authorWithLicense({ author: { userId: "u", practitionerId: "p", name: "Lic. X" }, authorLicense: null })).toBe("Lic. X");
    expect(diagnosisLine(TEXT)).toBe("Contractura paravertebral");
  });

  it("sin códigos de la OMS no hay atribución; importada y carga tardía se marcan", () => {
    const html = render(
      record([
        note({
          diagnoses: [TEXT],
          lateEntry: true,
          importSource: { kind: "docx", fileName: "a.docx", importedAt: "2026-10-15T10:00:00.000Z", part: 1, parts: 1 },
        }),
      ])
    );
    expect(html).not.toContain("CIE-11 © OMS");
    expect(html).toContain("Importada");
    expect(html).toContain("Carga tardía");
  });
});
