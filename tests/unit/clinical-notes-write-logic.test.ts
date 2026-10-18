/**
 * FC-2a · puros de la escritura de fichas (`lib/clinical-notes-logic.ts`, C-FC3 «Reglas del server» 1, 4 y 6). La
 * integración (tests/integration/fichas-writes.test.ts) cubre el efecto en la base; acá, las decisiones sin Prisma.
 */
import { describe, it, expect } from "vitest";
import { importSourceRecord, noteAuditFacts, noteBodyFields } from "@/lib/clinical-notes-logic";
import { hcDocToPlainText, validateHcDoc, type HcDoc } from "@/lib/hc-doc";

const doc = (...texts: string[]): HcDoc => {
  const r = validateHcDoc({ type: "doc", content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

describe("[FC-2a] noteBodyFields (regla 1)", () => {
  it("con bodyDoc: guarda el doc y deriva body con la función inyectada (no con el plainText del parse)", () => {
    const d = doc("Dolor lumbar", "Mejora");
    expect(noteBodyFields({ bodyDoc: { doc: d } }, hcDocToPlainText)).toEqual({ body: "Dolor lumbar\n\nMejora", bodyDoc: d });
    expect(noteBodyFields({ bodyDoc: { doc: d } }, () => "derivado")).toEqual({ body: "derivado", bodyDoc: d });
  });

  it("con body plano: limpia bodyDoc (null)", () => {
    expect(noteBodyFields({ body: "Texto" }, hcDocToPlainText)).toEqual({ body: "Texto", bodyDoc: null });
  });

  it("sin ninguno: undefined (la edición no toca el contenido)", () => {
    expect(noteBodyFields({}, hcDocToPlainText)).toBeUndefined();
  });

  it("si vinieran los dos (el zod lo impide), gana el doc: body nunca queda desacoplado del doc guardado", () => {
    const d = doc("Del doc");
    expect(noteBodyFields({ body: "otro", bodyDoc: { doc: d } }, hcDocToPlainText)).toEqual({ body: "Del doc", bodyDoc: d });
  });
});

describe("[FC-2a] importSourceRecord (regla 4)", () => {
  it("{v:1, ...input, importedAt} con el instante del server en ISO, sin campos extra", () => {
    const now = new Date("2026-10-19T03:00:00.000Z");
    const input = {
      kind: "docx" as const,
      fileName: "hc.docx",
      fileSize: 2048,
      fileLastModified: null,
      batchId: "4b2b4f3e-6a51-4b1a-9d39-0c4f1f0b7a11",
      part: 1,
      parts: 2,
      extra: "no viaja",
    };
    expect(importSourceRecord(input, now)).toEqual({
      v: 1,
      kind: "docx",
      fileName: "hc.docx",
      fileSize: 2048,
      fileLastModified: null,
      batchId: input.batchId,
      part: 1,
      parts: 2,
      importedAt: "2026-10-19T03:00:00.000Z",
    });
  });
});

describe("[FC-2a] noteAuditFacts (regla 6)", () => {
  it("solo conteos y banderas, nunca texto", () => {
    expect(noteAuditFacts({ diagnoses: [{ title: "Lumbalgia" }, { title: "x" }], activeDiagnosis: true, imported: false })).toEqual({
      diagnosesCount: 2,
      activeDiagnosis: true,
      imported: false,
    });
    expect(noteAuditFacts({ diagnoses: undefined, activeDiagnosis: false, imported: true })).toEqual({
      diagnosesCount: 0,
      activeDiagnosis: false,
      imported: true,
    });
  });
});
