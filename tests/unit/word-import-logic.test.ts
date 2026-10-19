/**
 * [FC-3f] Importar Word: lógica pura del drawer (`components/fichas/word-import-logic.ts`, §24.7 «Importar Word»).
 *
 * Fechas: corre en TZ=UTC (`npm test`) y en TZ=America/Argentina/Buenos_Aires; los asserts son los mismos porque todo
 * pasa por `lib/datetime-ar.ts` (el día AR de `lastModified` y las 12:00 AR no dependen del reloj del host).
 */
import { describe, expect, it } from "vitest";
import {
  WORD_IMPORT_MAX_BYTES,
  WORD_IMPORT_MAX_FILES,
  buildImportInputs,
  dateFromFileName,
  dateFromLastModified,
  fileLastModifiedIso,
  hasDocxMagic,
  importDateIssue,
  importFileName,
  importOccurredAt,
  limitWordFiles,
  normalizeImportedHtml,
  precheckWordFile,
  prepareImportedDoc,
  resolveImportDate,
} from "@/components/fichas/word-import-logic";
import { HC_DOC_MAX_CHARS, hcDocToPlainText, type HcDoc } from "@/lib/hc-doc";
import { CreateClinicalNoteSchema } from "@/lib/clinical-notes-schemas";

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("[FC-3f] fecha desde el nombre del archivo (5 formatos)", () => {
  it.each([
    ["1 · AAAA-MM-DD", "Evolución 2024-03-15.docx", "2024-03-15"],
    ["1 · AAAA_MM_DD", "pérez_2024_03_15.docx", "2024-03-15"],
    ["2 · AAAAMMDD", "informe 20240315.docx", "2024-03-15"],
    ["3 · DD-MM-AAAA", "Gómez 15-03-2024.docx", "2024-03-15"],
    ["3 · DD.MM.AAAA", "ficha 5.3.2024.docx", "2024-03-05"],
    ["4 · DD-MM-AA", "Gómez 15-03-24.docx", "2024-03-15"],
    ["5 · DD de mes de AAAA", "Consulta 15 de marzo de 2024.docx", "2024-03-15"],
    ["5 · DD mes AAAA abreviado", "consulta 1 sept 2023.docx", "2023-09-01"],
    ["5 · DD-mes-AAAA", "control 2-Ago-2023.docx", "2023-08-02"],
  ])("%s", (_label, name, expected) => {
    expect(dateFromFileName(name)).toBe(expected);
  });

  it("fechas imposibles o números que no son fecha → null (un DNI no se lee como fecha)", () => {
    expect(dateFromFileName("Pérez 30-02-2024.docx")).toBeNull();
    expect(dateFromFileName("Pérez 20123456.docx")).toBeNull();
    expect(dateFromFileName("Pérez DNI 301234567.docx")).toBeNull();
    expect(dateFromFileName("informe.docx")).toBeNull();
    expect(dateFromFileName("15 de marzi de 2024.docx")).toBeNull();
  });
});

describe("[FC-3f] fecha desde lastModified como día AR (UTC)", () => {
  it("01:30 UTC del 16 es todavía el 15 en Argentina", () => {
    expect(dateFromLastModified(Date.UTC(2024, 2, 16, 1, 30))).toBe("2024-03-15");
    expect(dateFromLastModified(Date.UTC(2024, 2, 16, 3, 0))).toBe("2024-03-16");
  });

  it("lastModified ausente o 0 → null", () => {
    expect(dateFromLastModified(0)).toBeNull();
    expect(dateFromLastModified(Number.NaN)).toBeNull();
  });

  it("el nombre manda sobre lastModified, y se dice de dónde salió", () => {
    const lm = Date.UTC(2025, 0, 10, 15);
    expect(resolveImportDate({ name: "ficha 2024-03-15.docx", lastModified: lm })).toEqual({ date: "2024-03-15", source: "name" });
    expect(resolveImportDate({ name: "ficha.docx", lastModified: lm })).toEqual({ date: "2025-01-10", source: "modified" });
    expect(resolveImportDate({ name: "ficha.docx", lastModified: 0 })).toBeNull();
  });

  it("fileLastModified viaja como ISO (o null)", () => {
    expect(fileLastModifiedIso(Date.UTC(2024, 2, 16, 1, 30))).toBe("2024-03-16T01:30:00.000Z");
    expect(fileLastModifiedIso(0)).toBeNull();
  });
});

describe("[FC-3f] occurredAt a las 12:00 AR", () => {
  it("el día elegido a las 12:00 de Argentina (15:00 UTC), en cualquier TZ del host", () => {
    expect(importOccurredAt("2024-03-15")).toBe("2024-03-15T15:00:00.000Z");
    expect(importOccurredAt("2024-12-31")).toBe("2024-12-31T15:00:00.000Z");
  });

  it("una fecha futura (día AR) o inválida se marca", () => {
    const now = new Date("2024-03-16T02:00:00Z"); // 23:00 AR del 15
    expect(importDateIssue("2024-03-15", now)).toBeNull();
    expect(importDateIssue("2024-03-16", now)).toBe("future");
    expect(importDateIssue("2024-02-30", now)).toBe("invalid");
    expect(importDateIssue("", now)).toBe("invalid");
    expect(importDateIssue("1899-12-31", now)).toBe("invalid");
  });
});

describe("[FC-3f] magic bytes, 10 MB, 50 archivos, .doc", () => {
  it("PK\\x03\\x04 al principio", () => {
    expect(hasDocxMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    // Un .doc viejo (OLE) renombrado a .docx.
    expect(hasDocxMagic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
    expect(hasDocxMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });

  it("precheck: .doc con aviso propio, otra extensión, vacío y más de 10 MB", () => {
    expect(WORD_IMPORT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(precheckWordFile({ name: "viejo.DOC", size: 100 })).toBe("doc");
    expect(precheckWordFile({ name: "notas.pdf", size: 100 })).toBe("not-docx");
    expect(precheckWordFile({ name: "docx", size: 100 })).toBe("not-docx");
    expect(precheckWordFile({ name: "vacío.docx", size: 0 })).toBe("not-docx");
    expect(precheckWordFile({ name: "grande.docx", size: WORD_IMPORT_MAX_BYTES + 1 })).toBe("too-big");
    expect(precheckWordFile({ name: "justo.Docx", size: WORD_IMPORT_MAX_BYTES })).toBeNull();
  });

  it("hasta 50 archivos: el resto se descarta y se cuenta", () => {
    expect(WORD_IMPORT_MAX_FILES).toBe(50);
    const files = Array.from({ length: 53 }, (_, i) => i);
    expect(limitWordFiles(files)).toEqual({ accepted: files.slice(0, 50), dropped: 3 });
    expect(limitWordFiles([1, 2], 49)).toEqual({ accepted: [1], dropped: 1 });
    expect(limitWordFiles([1], 50)).toEqual({ accepted: [], dropped: 1 });
  });

  it("nombre del archivo ≤200 conservando la extensión", () => {
    expect(importFileName("  ficha.docx ")).toBe("ficha.docx");
    const long = importFileName(`${"a".repeat(300)}.docx`);
    expect(long.length).toBe(200);
    expect(long.endsWith(".docx")).toBe(true);
  });
});

describe("[FC-3f] HTML de mammoth → solo lo que el schema entiende", () => {
  it("h1 → h2 y h4-h6 → h3 (el schema solo tiene H2/H3); las imágenes se sacan", () => {
    expect(normalizeImportedHtml('<h1>Motivo</h1><h4 id="x">Sub</h4><p>a<img src="data:x" />b</p>')).toBe(
      '<h2>Motivo</h2><h3 id="x">Sub</h3><p>ab</p>'
    );
  });
});

describe("[FC-3f] dividir", () => {
  it("≤20.000 caracteres → una sola ficha", () => {
    const r = prepareImportedDoc({ type: "doc", content: [para("Hola"), para("Chau")] });
    expect(r.ok && r.parts.length).toBe(1);
  });

  it("más de 20.000 → N fichas de ≤20.000 que conservan todo el texto", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => para(`${i} `.padEnd(1500, "x")));
    const r = prepareImportedDoc({ type: "doc", content: blocks });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts.length).toBe(3);
    for (const part of r.parts) expect(hcDocToPlainText(part).length).toBeLessThanOrEqual(HC_DOC_MAX_CHARS);
    expect(r.parts.map(hcDocToPlainText).join("\n\n")).toBe(blocks.map((b) => b.content[0].text).join("\n\n"));
    expect(r.chars).toBe(30 * 1500 + 29 * 2);
  });

  it("un doc enorme (más de 256 KB de JSON) se valida por tramos y se divide igual", () => {
    const blocks = Array.from({ length: 400 }, (_, i) => para(`${i} `.padEnd(1000, "y")));
    const r = prepareImportedDoc({ type: "doc", content: blocks });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parts.length).toBe(22); // 19 bloques de 1000 (+2 de separador) por ficha
  });

  it("vacío (solo imágenes) → empty; más de 50 fichas → too-many-parts", () => {
    expect(prepareImportedDoc({ type: "doc", content: [{ type: "paragraph" }] })).toEqual({ ok: false, reason: "empty" });
    const huge = Array.from({ length: 1100 }, () => para("z".repeat(1000)));
    expect(prepareImportedDoc({ type: "doc", content: huge })).toEqual({ ok: false, reason: "too-many-parts" });
  });
});

describe("[FC-3f] el input de la action sin bytes", () => {
  const parts: HcDoc[] = [
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Uno" }] }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Dos" }] }] },
  ];
  const batchId = "6f1c2b9e-0d7a-4c1e-9a55-2b8f0c3d4e5f";
  const keys = ["1b4e28ba-2fa1-41d2-883f-0016d3cca427", "2c5f39cb-3ab2-42e3-994a-1127e4ddb538"];
  const inputs = buildImportInputs({
    patientId: "pat_1",
    file: { name: "informe 2024-03-15.docx", size: 12345, lastModified: Date.UTC(2024, 2, 16, 1, 30) },
    dateKey: "2024-03-15",
    batchId,
    parts,
    keys,
  });

  it("una action por parte, cada una con su clave, sin turno, a las 12:00 AR", () => {
    expect(inputs).toEqual([
      {
        patientId: "pat_1",
        bookingId: null,
        bodyDoc: parts[0],
        occurredAt: "2024-03-15T15:00:00.000Z",
        idempotencyKey: keys[0],
        importSource: {
          kind: "docx",
          fileName: "informe 2024-03-15.docx",
          fileSize: 12345,
          fileLastModified: "2024-03-16T01:30:00.000Z",
          batchId,
          part: 1,
          parts: 2,
        },
      },
      expect.objectContaining({ bodyDoc: parts[1], idempotencyKey: keys[1], importSource: expect.objectContaining({ part: 2, parts: 2 }) }),
    ]);
  });

  it("es JSON plano: ni ArrayBuffer, ni Blob, ni File (el .docx nunca viaja)", () => {
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      expect(v instanceof ArrayBuffer || ArrayBuffer.isView(v)).toBe(false);
      expect(typeof Blob !== "undefined" && v instanceof Blob).toBe(false);
      Object.values(v).forEach(walk);
    };
    walk(inputs);
    expect(JSON.parse(JSON.stringify(inputs))).toEqual(inputs);
  });

  it("pasa el zod real de createClinicalNote", () => {
    for (const input of inputs) expect(CreateClinicalNoteSchema.safeParse(input).success).toBe(true);
  });
});
