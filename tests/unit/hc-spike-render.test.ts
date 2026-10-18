/**
 * [FC-1c] Spike de render (Anexo C, FC-1c): react-pdf y docx corren en Node con las fuentes del repo.
 *
 * Testea el símbolo real del spike (`app/api/hc-spike/spike-render.tsx`), sin mocks: si react-pdf no encuentra las
 * fuentes, si cae a Helvetica o si docx no arma un zip, falla acá antes del build. **Temporal**: se va con el spike
 * (FC-2g); FC-2e reapunta estas dos aserciones a `renderHcPdf` / `renderHcDocx` de C-FC5.
 */
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  SPIKE_PDF_MAX_BYTES,
  SPIKE_SIGNATURE,
  renderSpikeDocx,
  renderSpikePdf,
  spikeNotes,
} from "@/app/api/hc-spike/spike-render";

/** Lee una entrada de un zip (sin dependencias: directorio central → header local → inflate). */
function readZipEntry(zip: Buffer, name: string): string | null {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (entry === name) {
      const lnlen = zip.readUInt16LE(local + 26);
      const lelen = zip.readUInt16LE(local + 28);
      const data = zip.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

describe("[FC-1c] spike de render", () => {
  it("PDF de un fixture con `≤ ≥ → β` empieza con `%PDF-` y pesa menos que el tope", async () => {
    const pdf = Buffer.from(await renderSpikePdf(spikeNotes(30)));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeLessThan(SPIKE_PDF_MAX_BYTES);
    const raw = pdf.toString("latin1");
    // Las dos familias quedaron embebidas (subconjunto) y Helvetica no: si el fallback a Noto Sans Math no anduviera,
    // los ≤ → caerían a Helvetica, que react-pdf agrega al final de la pila.
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSans-Regular/);
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSans-Bold/);
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSansMath-Regular/);
    expect(raw).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  }, 60_000);

  it("el docx contiene el texto y «Lic. Ana Pérez · MN 1234»", async () => {
    const docx = Buffer.from(await renderSpikeDocx(spikeNotes(3)));
    expect(docx.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // zip
    const xml = readZipEntry(docx, "word/document.xml");
    expect(xml).not.toBeNull();
    expect(xml).toContain(SPIKE_SIGNATURE);
    expect(SPIKE_SIGNATURE).toBe("Lic. Ana Pérez · MN 1234");
    expect(xml).toContain("flexión → extensión");
    expect(xml).toContain("≤ 110°");
    // Y lo lee un lector de Word real (mammoth, el mismo del import de FC-3f): el zip abre y el texto vuelve.
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: docx });
    expect(value).toContain("Lic. Ana Pérez · MN 1234");
    expect(value).toContain("Historia clínica de Paciente Ñandú");
  }, 30_000);
});
