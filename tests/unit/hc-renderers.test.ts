/**
 * [FC-2e] Renderers de la HC (C-FC5): PDF (react-pdf + Noto Sans), Word (docx) y assets (logo y firma con falla blanda).
 *
 * Símbolos reales, sin mocks del render: se arma el `HcPrintableV1` con `buildHcPrintableContent` + `finalizeHcPrintable`
 * y se afirma lo que ve una persona, con el TEXTO EXTRAÍDO del PDF (`tests/helpers/pdf-text.ts`: CMaps ToUnicode) y
 * del `word/document.xml`. Lo único fake es la red de Storage (`storageDownload`), igual que en el resto del repo.
 * Reemplaza al spike de FC-1c (`hc-spike-render.test.ts`, que se borra con el spike en FC-2g): mismas aserciones de
 * fuentes (Noto Sans y Noto Sans Math embebidas, sin Helvetica) y tope, ahora sobre `renderHcPdf` / `renderHcDocx`.
 */
import { deflateSync, inflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageResult } from "@/lib/storage-internal";

const storage = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), calls: [] as string[], throwOn: null as string | null }));
vi.mock("@/lib/storage-internal", async (orig) => {
  const real = await orig<typeof import("@/lib/storage-internal")>();
  return {
    ...real,
    storageDownload: async (bucket: string, key: string, maxBytes: number): Promise<StorageResult<Uint8Array>> => {
      storage.calls.push(`${bucket}:${key}`);
      if (storage.throwOn === key) throw new Error("red caída (test)");
      const b = storage.objects.get(key);
      if (!b) return { ok: false, reason: "storage", message: "not found" };
      if (b.byteLength > maxBytes) return { ok: false, reason: "storage", message: "too big" };
      return { ok: true, data: b };
    },
  };
});
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { loadHcAssets } from "@/lib/hc-assets-internal";
import { renderHcDocx } from "@/lib/hc-docx-internal";
import { HC_PDF_MAX_BYTES, renderHcPdf } from "@/lib/hc-pdf/render-internal";
import { finalizeHcPrintable, hcAssetRequest } from "@/lib/hc-print-internal";
import { buildHcPrintableContent, type HcPrintSource, type HcPrintSourceEntry } from "@/lib/hc-print-model";
import { pdfPlainText } from "@/tests/helpers/pdf-text";

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** PNG RGB real de w×h (react-pdf lo decodifica: un PNG truchado haría fallar el render, no la prueba). */
function png(w: number, h: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc((w * 3 + 1) * h, 0x40);
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0; // filtro None
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]),
  );
}

const DOC = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evaluación" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Flexión ≤ 110°, progresión flexión → extensión; " },
        { type: "text", text: "β-bloqueantes", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        { type: "text", text: "Señor Muñoz: ¿cede?", marks: [{ type: "italic" }, { type: "underline" }] },
      ],
    },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Puente glúteo 3×12" }] }] }] },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Hielo si dolor ≥ 5/10" }] }] }],
    },
  ],
};

function entry(over: Partial<HcPrintSourceEntry> = {}): HcPrintSourceEntry {
  return {
    id: "n1",
    revision: 1,
    label: "Ficha",
    title: "Control de rodilla",
    occurredAt: new Date("2026-10-10T13:00:00.000Z"),
    createdAt: new Date("2026-10-10T14:00:00.000Z"),
    body: "",
    bodyDoc: DOC,
    diagnoses: [{ v: 1, source: "icd11", refId: "i1", code: "FA20.0", title: "Lumbalgia", uri: "http://id.who.int/icd/entity/1", release: "2026-01" }],
    authorName: "Ana Pérez",
    authorHonorific: "LIC",
    authorLicense: "MN 1234",
    authorPractitionerId: "prac_a",
    authorHasSignature: true,
    importSource: null,
    lateEntry: false,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

function source(n = 1): HcPrintSource {
  return {
    tenant: { name: "Consultorio Ñandú", addressLine: "Av. Siempreviva 742, Córdoba", phone: "351 555-0000", hasLogo: true },
    patient: { firstName: "Juan", lastName: "Gómez", documentId: "30111222", dateOfBirth: "1980-01-02" },
    entries: Array.from({ length: n }, (_, i) => ({
      root: entry({ id: `r${i}` }),
      amendments:
        i === 0
          ? [entry({ id: "am", label: "Enmienda", title: null, bodyDoc: null, body: "Corrijo: ROM 120°", authorName: "Beto Ruiz", authorHonorific: "DR", authorLicense: "MP 55", authorPractitionerId: "prac_b", diagnoses: [] })]
          : [],
    })),
    truncated: false,
    assetKeys: { logoKey: "t/logo/x.png", signatureKeys: { prac_a: "t/signature/prac_a/1.png", prac_b: "t/signature/prac_b/1.png" } },
  };
}

async function printable(src: HcPrintSource, purpose: "shared" | "download" = "download") {
  const built = buildHcPrintableContent(src, purpose);
  const { printable: doc } = finalizeHcPrintable(built.content, {
    generatedAt: "2026-10-18T15:00:00.000Z",
    purpose,
    generatedByName: "Ana Pérez",
    truncated: src.truncated,
  });
  const assets = await loadHcAssets(hcAssetRequest(src, built.signatureOwners));
  return { doc, assets, signatureOwners: built.signatureOwners };
}

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
    if (zip.subarray(p + 46, p + 46 + nlen).toString("utf8") === name) {
      const lnlen = zip.readUInt16LE(local + 26);
      const lelen = zip.readUInt16LE(local + 28);
      const data = zip.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

beforeEach(() => {
  storage.objects.clear();
  storage.calls.length = 0;
  storage.throwOn = null;
  storage.objects.set("t/logo/x.png", png(40, 20));
  storage.objects.set("t/signature/prac_a/1.png", png(30, 10));
  storage.objects.set("t/signature/prac_b/1.png", png(31, 11));
});

// ─── Assets ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("[FC-2e] loadHcAssets", () => {
  it("baja logo y la firma de CADA autor por imageRef, desde practice-assets", async () => {
    const { assets, signatureOwners } = await printable(source());
    expect(signatureOwners).toEqual({ s1: "prac_a", s2: "prac_b" });
    expect(assets.logo).toMatchObject({ mime: "image/png", width: 40, height: 20 });
    expect(assets.signatures.s1).toMatchObject({ width: 30, height: 10 });
    expect(assets.signatures.s2).toMatchObject({ width: 31, height: 11 });
    expect(storage.calls.every((c) => c.startsWith("practice-assets:"))).toBe(true);
  });

  it("falla blanda: no existe, tira, no es imagen o pasa el tope → queda afuera, nunca tira", async () => {
    storage.objects.delete("t/logo/x.png");
    storage.throwOn = "t/signature/prac_a/1.png";
    storage.objects.set("t/signature/prac_b/1.png", new TextEncoder().encode("<svg onload=alert(1)>"));
    const r = await loadHcAssets({
      logoKey: "t/logo/x.png",
      signatures: [
        { ref: "s1", key: "t/signature/prac_a/1.png" },
        { ref: "s2", key: "t/signature/prac_b/1.png" },
        { ref: "s3", key: null },
      ],
    });
    expect(r).toEqual({ logo: null, signatures: {} });
    // Firma de más de 2000 px (tope de FC-2f) → afuera.
    storage.objects.set("big", png(2100, 1));
    expect((await loadHcAssets({ logoKey: null, signatures: [{ ref: "s1", key: "big" }] })).signatures).toEqual({});
  });

  it("sin logo en el membrete no se pide el logo", async () => {
    const src = source();
    src.tenant.hasLogo = false;
    const { assets } = await printable(src);
    expect(assets.logo).toBeNull();
    expect(storage.calls).not.toContain("practice-assets:t/logo/x.png");
  });
});

// ─── PDF ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("[FC-2e] renderHcPdf", () => {
  it("PDF con membrete, texto con á ñ ≤ → β, firma «Lic. … · MN …» y atribución «CIE-11 © OMS»", async () => {
    const { doc, assets } = await printable(source());
    const pdf = await renderHcPdf(doc, assets);
    const buf = Buffer.from(pdf);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeLessThan(HC_PDF_MAX_BYTES);
    const text = pdfPlainText(pdf);
    for (const s of [
      "Consultorio Ñandú",
      "Av. Siempreviva 742, Córdoba · Tel. 351 555-0000",
      "Paciente: Juan Gómez · DNI 30111222 · Nacimiento 02/01/1980",
      "Ficha · Control de rodilla",
      "10/10/2026 10:00 · Versión original",
      "Evaluación",
      "Flexión ≤ 110°, progresión flexión → extensión;",
      "β-bloqueantes",
      "Señor Muñoz: ¿cede?",
      "Puente glúteo 3×12",
      "3.",
      "Hielo si dolor ≥ 5/10",
      "Principal: FA20.0 Lumbalgia (CIE-11 (OMS))",
      "Lic. Ana Pérez · MN 1234",
      "Dr. Beto Ruiz · MP 55",
      "Corrijo: ROM 120°",
      "CIE-11 © OMS",
      `Código de verificación ${doc.meta.verificationCode}`,
      "Página 1 de 1",
    ]) {
      expect(text, s).toContain(s);
    }
    const raw = buf.toString("latin1");
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSans-Regular/);
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSans-Bold/);
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSansMath-Regular/);
    expect(raw).not.toMatch(/\/BaseFont\s*\/Helvetica/);
    // Logo + 2 firmas embebidas como imágenes.
    expect(raw.match(/\/Subtype\s*\/Image/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("sin assets sale igual (falla blanda) y sin imágenes", async () => {
    storage.objects.clear();
    const { doc, assets } = await printable(source());
    const pdf = await renderHcPdf(doc, assets);
    expect(Buffer.from(pdf).toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
    expect(pdfPlainText(pdf)).toContain("Lic. Ana Pérez · MN 1234");
  }, 60_000);

  it("download muestra la anulada con su motivo; shared no; truncado lo avisa", async () => {
    const src = source();
    src.entries[0].amendments[0] = { ...src.entries[0].amendments[0], voidedAt: new Date("2026-10-11T10:00:00Z"), voidReason: "Paciente equivocado" };
    src.truncated = true;
    const dl = pdfPlainText(await renderHcPdf((await printable(src, "download")).doc, { logo: null, signatures: {} }));
    expect(dl).toContain("Anulada el 11/10/2026 07:00 · Motivo: Paciente equivocado");
    expect(dl).toContain("fichas más recientes");
    const sh = pdfPlainText(await renderHcPdf((await printable(src, "shared")).doc, { logo: null, signatures: {} }));
    expect(sh).not.toContain("Paciente equivocado");
    expect(sh).not.toContain("Corrijo");
  }, 60_000);

  it("renders seguidos y en paralelo no corrompen el texto del siguiente (caché de glifos de react-pdf)", async () => {
    // Regresión medida en FC-2e: tras un PDF con «Muñoz» en itálica, el SIGUIENTE salía con el ToUnicode roto
    // («docume to i cluye»): se veía bien pero no se podía copiar ni buscar.
    const a = await printable(source());
    const b = source();
    b.truncated = true;
    const bDoc = (await printable(b)).doc;
    const first = await renderHcPdf(a.doc, a.assets);
    const [second, third] = await Promise.all([renderHcPdf(bDoc, a.assets), renderHcPdf(a.doc, a.assets)]);
    for (const pdf of [first, third]) expect(pdfPlainText(pdf)).toContain("Señor Muñoz: ¿cede?");
    expect(pdfPlainText(second)).toContain("Este documento incluye las fichas más recientes; el resto sale en el export del consultorio.");
  }, 60_000);

  it("30 fichas con lista y caracteres especiales: varias páginas y bajo el tope", async () => {
    const { doc, assets } = await printable(source(30));
    const pdf = await renderHcPdf(doc, assets);
    expect(pdf.byteLength).toBeLessThan(HC_PDF_MAX_BYTES);
    const text = pdfPlainText(pdf);
    expect(text).toMatch(/Página 1 de [2-9]\d*/);
  }, 60_000);
});

// ─── Word ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("[FC-2e] renderHcDocx", () => {
  it("el docx contiene membrete, texto con formato, firma y atribución, y lo lee un lector de Word real", async () => {
    const { doc, assets } = await printable(source());
    const docx = Buffer.from(await renderHcDocx(doc, assets));
    expect(docx.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const xml = readZipEntry(docx, "word/document.xml")!;
    expect(xml).toContain("Lic. Ana Pérez · MN 1234");
    expect(xml).toContain("flexión → extensión");
    expect(xml).toContain("≤ 110°");
    expect(xml).toMatch(/<w:b\/>[\s\S]*?β-bloqueantes/);
    expect(xml).toContain('w:pStyle w:val="Heading2"');
    expect(xml).toMatch(/<w:numPr>/);
    expect(xml).toMatch(/<w:br\/>/);
    // Imágenes: logo + 2 firmas.
    expect(xml.match(/<pic:pic\b/g)?.length ?? 0).toBe(3);
    const numbering = readZipEntry(docx, "word/numbering.xml")!;
    expect(numbering).toMatch(/w:start w:val="3"/);
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: docx });
    for (const s of ["Consultorio Ñandú", "Paciente: Juan Gómez", "Señor Muñoz: ¿cede?", "Dr. Beto Ruiz · MP 55", "CIE-11 © OMS"]) {
      expect(value, s).toContain(s);
    }
  }, 30_000);
});
