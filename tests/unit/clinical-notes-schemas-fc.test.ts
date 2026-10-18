/**
 * FC-1b1 · zod de las fichas (C-FC3, brief T4 Anexo B): `bodyDoc`, diagnósticos por referencia, importación y las tres
 * refines en el orden del contrato. Símbolos reales (`lib/clinical-notes-schemas.ts`), sin mocks: es lógica pura.
 * Lo que hace el server con cada campo (derivar `body`, re-leer diagnósticos, diagnóstico activo) es de FC-2a
 * (`tests/integration/fichas-writes.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AmendClinicalNoteSchema,
  BodyDocSchema,
  CreateClinicalNoteSchema,
  DiagnosesSchema,
  DiagnosisRefSchema,
  EditClinicalNoteSchema,
  ImportSourceSchema,
} from "@/lib/clinical-notes-schemas";
import { CLINICAL_NOTE_COPY } from "@/lib/clinical-notes-types";
import { DIAGNOSIS_COPY } from "@/lib/diagnoses-types";
import { HC_DOC_ERROR_COPY } from "@/lib/hc-doc";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const base = () => ({ patientId: "pat_1", idempotencyKey: randomUUID() });
const importSource = (over: Record<string, unknown> = {}) => ({
  kind: "docx",
  fileName: "informe.docx",
  fileSize: 12_345,
  fileLastModified: "2026-10-01T10:00:00.000Z",
  batchId: randomUUID(),
  part: 1,
  parts: 2,
  ...over,
});
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;

describe("[FC-1b] schemas", () => {
  it("[FC-1b] bodyDoc se re-arma con validateHcDoc y da el texto plano", () => {
    const r = BodyDocSchema.safeParse({
      type: "doc",
      content: [{ type: "paragraph", attrs: { style: "color:red" }, content: [{ type: "text", text: "Dolor lumbar", marks: [{ type: "link" }] }] }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // attrs y marcas fuera de la allow-list se descartan: nunca se guarda lo que mandó el cliente tal cual.
    expect(r.data.doc).toEqual(doc("Dolor lumbar"));
    expect(r.data.plainText).toBe("Dolor lumbar");
  });

  it("[FC-1b] bodyDoc inválido o vacío → copy de HC_DOC_ERROR_COPY", () => {
    expect(firstError(BodyDocSchema.safeParse({ type: "nope" }))).toBe(HC_DOC_ERROR_COPY["not-doc"]);
    expect(firstError(BodyDocSchema.safeParse({ type: "doc", content: [] }))).toBe(HC_DOC_ERROR_COPY.empty);
    expect(firstError(BodyDocSchema.safeParse(doc("x".repeat(20_001))))).toBe(HC_DOC_ERROR_COPY["too-long"]);
  });

  it("[FC-1b] uno de body/bodyDoc: crear y enmendar exigen exactamente uno", () => {
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "Texto" }).success).toBe(true);
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), bodyDoc: doc("Texto") }).success).toBe(true);
    const both = CreateClinicalNoteSchema.safeParse({ ...base(), body: "Texto", bodyDoc: doc("Texto") });
    expect(firstError(both)).toBe(CLINICAL_NOTE_COPY.bodyAndDoc);
    expect(firstError(CreateClinicalNoteSchema.safeParse(base()))).toBe(CLINICAL_NOTE_COPY.bodyAndDoc);

    const amend = { noteId: "note_1", idempotencyKey: randomUUID() };
    expect(AmendClinicalNoteSchema.safeParse({ ...amend, bodyDoc: doc("Agrego") }).success).toBe(true);
    expect(firstError(AmendClinicalNoteSchema.safeParse({ ...amend, body: "a", bodyDoc: doc("a") }))).toBe(CLINICAL_NOTE_COPY.bodyAndDoc);
    expect(firstError(AmendClinicalNoteSchema.safeParse(amend))).toBe(CLINICAL_NOTE_COPY.bodyAndDoc);
  });

  it("[FC-1b] uno de body/bodyDoc: editar acepta ninguno (solo título) pero no los dos", () => {
    const edit = { noteId: "note_1", expectedRevision: 1 };
    expect(EditClinicalNoteSchema.safeParse({ ...edit, title: "Nuevo" }).success).toBe(true);
    expect(EditClinicalNoteSchema.safeParse({ ...edit, bodyDoc: doc("Texto") }).success).toBe(true);
    expect(firstError(EditClinicalNoteSchema.safeParse({ ...edit, body: "a", bodyDoc: doc("a") }))).toBe(CLINICAL_NOTE_COPY.bodyAndDoc);
    // Cambiar solo los diagnósticos es un cambio; `null` y `[]` los borran.
    expect(EditClinicalNoteSchema.safeParse({ ...edit, diagnoses: null }).success).toBe(true);
    expect(EditClinicalNoteSchema.safeParse({ ...edit, diagnoses: [] }).success).toBe(true);
    expect(firstError(EditClinicalNoteSchema.safeParse(edit))).toBe("No hay cambios para guardar.");
  });

  it("[FC-1b] importada sin turno", () => {
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "Viejo", importSource: importSource() }).success).toBe(true);
    const withBooking = CreateClinicalNoteSchema.safeParse({ ...base(), body: "Viejo", bookingId: "bk_1", importSource: importSource() });
    expect(firstError(withBooking)).toBe(CLINICAL_NOTE_COPY.importWithBooking);
    // `importSource: null` es «no importada»: con turno va.
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "Hoy", bookingId: "bk_1", importSource: null }).success).toBe(true);
  });

  it("[FC-1b] importSource: nombre 1..200, ≤10 MB, batchId uuid, part ≤ parts ≤ 50", () => {
    expect(ImportSourceSchema.safeParse(importSource()).success).toBe(true);
    expect(ImportSourceSchema.safeParse(importSource({ fileLastModified: null })).success).toBe(true);
    for (const bad of [
      { fileName: "" },
      { fileName: "a".repeat(201) },
      { fileSize: 10 * 1024 * 1024 + 1 },
      { fileSize: 1.5 },
      { batchId: "no-uuid" },
      { part: 3, parts: 2 },
      { part: 0 },
      { parts: 51, part: 1 },
      { kind: "pdf" },
      { fileLastModified: "2026-10-01" },
    ]) {
      expect(ImportSourceSchema.safeParse(importSource(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ImportSourceSchema.safeParse({ ...importSource(), extra: 1 }).success).toBe(false);
  });

  it("[FC-1b] activo exige diagnóstico", () => {
    const text = { kind: "text", text: "Lumbalgia mecánica" };
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", diagnoses: [text], setActiveDiagnosis: true }).success).toBe(true);
    expect(firstError(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", setActiveDiagnosis: true }))).toBe(
      DIAGNOSIS_COPY.activeNeedsPrincipal
    );
    expect(firstError(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", diagnoses: [], setActiveDiagnosis: true }))).toBe(
      DIAGNOSIS_COPY.activeNeedsPrincipal
    );
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", setActiveDiagnosis: false }).success).toBe(true);
    const edit = { noteId: "note_1", expectedRevision: 1 };
    expect(firstError(EditClinicalNoteSchema.safeParse({ ...edit, diagnoses: null, setActiveDiagnosis: true }))).toBe(
      DIAGNOSIS_COPY.activeNeedsPrincipal
    );
    const amend = { noteId: "note_1", idempotencyKey: randomUUID(), body: "x" };
    expect(firstError(AmendClinicalNoteSchema.safeParse({ ...amend, setActiveDiagnosis: true }))).toBe(DIAGNOSIS_COPY.activeNeedsPrincipal);
  });

  it("[FC-1b] refines en el orden del contrato: body/bodyDoc → importada con turno → activo", () => {
    const all = CreateClinicalNoteSchema.safeParse({
      ...base(),
      bookingId: "bk_1",
      importSource: importSource(),
      setActiveDiagnosis: true,
    });
    expect(all.success).toBe(false);
    expect(all.error?.issues.map((i) => i.message)).toEqual([
      CLINICAL_NOTE_COPY.bodyAndDoc,
      CLINICAL_NOTE_COPY.importWithBooking,
      DIAGNOSIS_COPY.activeNeedsPrincipal,
    ]);
  });

  it("[FC-1b] ≤5 diagnósticos, refs por discriminatedUnion y texto 2..120", () => {
    const refs = [
      { kind: "icd11", id: "dc_1" },
      { kind: "tenant", id: "td_1" },
      { kind: "kine", id: "cond_1" },
      { kind: "text", text: "  Cervicalgia  " },
      { kind: "text", text: "Esguince" },
    ];
    const ok = DiagnosesSchema.safeParse(refs);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data[3]).toEqual({ kind: "text", text: "Cervicalgia" });
    expect(firstError(DiagnosesSchema.safeParse([...refs, { kind: "text", text: "Sexto" }]))).toBe(DIAGNOSIS_COPY.tooMany);
    expect(firstError(DiagnosisRefSchema.safeParse({ kind: "text", text: " a " }))).toBe(DIAGNOSIS_COPY.textLength);
    expect(firstError(DiagnosisRefSchema.safeParse({ kind: "text", text: "a".repeat(121) }))).toBe(DIAGNOSIS_COPY.textLength);
    expect(DiagnosisRefSchema.safeParse({ kind: "cie10", id: "x" }).success).toBe(false);
    expect(DiagnosisRefSchema.safeParse({ kind: "icd11", id: "../etc" }).success).toBe(false);
    // Refs y nada más: el título y el código los re-lee el server (FC-D27, licencia OMS).
    expect(DiagnosisRefSchema.safeParse({ kind: "icd11", id: "dc_1", title: "Inventado" }).success).toBe(false);
    expect(DiagnosisRefSchema.safeParse({ kind: "text", id: "dc_1", text: "Lumbalgia" }).success).toBe(false);
  });

  it("[FC-1b] .strict(): campos desconocidos se rechazan en crear, editar y enmendar", () => {
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", authorLicense: "MN 1" }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base(), body: "x", diagnosisSnapshots: [] }).success).toBe(false);
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, body: "x", importSource: importSource() }).success).toBe(false);
    expect(AmendClinicalNoteSchema.safeParse({ noteId: "n", idempotencyKey: randomUUID(), body: "x", importSource: importSource() }).success).toBe(
      false
    );
    expect(AmendClinicalNoteSchema.safeParse({ noteId: "n", idempotencyKey: randomUUID(), body: "x", bookingId: "bk" }).success).toBe(false);
  });

  it("[FC-1b] lo de EV2 (solo body) sigue igual", () => {
    const r = CreateClinicalNoteSchema.safeParse({ ...base(), body: "  Texto  ", bookingId: "", occurredAt: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.body).toBe("Texto");
      expect(r.data.bookingId).toBeNull();
      expect(r.data.bodyDoc).toBeUndefined();
    }
    expect(firstError(CreateClinicalNoteSchema.safeParse({ ...base(), body: "   " }))).toBe("Escribí la ficha.");
  });
});
