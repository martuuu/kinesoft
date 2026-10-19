/**
 * [FC-3f] `components/fichas/word-reader.ts`: la etapa de mammoth con un .docx REAL (armado acá con `docx`, la misma
 * librería que genera el Word de la ficha en el server) y el contador de imágenes.
 *
 * Lo que no se prueba acá: `generateJSON` necesita `window.DOMParser` y el unit corre en node sin DOM (el repo no
 * tiene jsdom y no se suman librerías). Ese tramo es el mismo `generateJSON` + `hcExtensions()` del editor y lo cubren
 * el E2E `ficha-import.spec.ts` (FC-E) y el QA manual 8; el resultado igual pasa por `validateHcDoc`, que sí está
 * probado (`hc-doc.test.ts`, `word-import-logic.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { docxToHtml, readWordDocx } from "@/components/fichas/word-reader";

// PNG 1×1 transparente.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);

async function makeDocx(): Promise<ArrayBuffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Motivo de consulta", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: "Dolor lumbar ", bold: true }), new TextRun({ text: "de 3 semanas", underline: {} })] }),
          new Paragraph({ children: [new ImageRun({ type: "png", data: PNG, transformation: { width: 10, height: 10 } })] }),
          new Paragraph({ children: [new TextRun("Antes "), new ImageRun({ type: "png", data: PNG, transformation: { width: 10, height: 10 } }), new TextRun(" después")] }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("[FC-3f] word-reader (mammoth diferido)", () => {
  it("un .docx real → HTML con títulos, negrita y subrayado, sin imágenes, y las cuenta", async () => {
    const { html, images } = await docxToHtml(await makeDocx());
    expect(images).toBe(2);
    expect(html).toContain("<h1>Motivo de consulta</h1>");
    expect(html).toContain("<strong>Dolor lumbar </strong>");
    expect(html).toContain("<u>de 3 semanas</u>");
    expect(html).toContain("Antes");
    // Ni el src ni los bytes de la imagen quedan en el HTML (no se arma un data: URI de cada foto).
    expect(html).not.toMatch(/<img|base64/);
  });

  it("bytes que no son un .docx → unreadable (no revienta)", async () => {
    const junk = new TextEncoder().encode("PK\u0003\u0004 esto no es un zip").buffer as ArrayBuffer;
    expect(await readWordDocx(junk)).toEqual({ ok: false, reason: "unreadable" });
  });
});
