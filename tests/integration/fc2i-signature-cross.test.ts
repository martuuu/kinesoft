/**
 * T4 FC-2i · corrida cruzada real (brief §24.10: «el integrador FC-2i corre la integración real cruzada»; Anexo C
 * «FC-2f»: «el PDF de una ficha de B lleva la firma de B»).
 *
 * FC-2d probó compartir con el render y los assets falsos, y FC-2f la subida de la firma con Storage falso: acá corre
 * TODO junto y de verdad — `uploadOwnSignature` (dos profesionales), `createClinicalNote` (el autor es B),
 * `shareClinicalNoteWithPatient` (comparte el Titular A), el loader de la HC, `loadHcAssets` y `renderHcPdf` (react-pdf).
 * Red mockeada (C14): solo el admin client de Supabase (`tests/helpers/storage-fake.ts`). El render se envuelve sin
 * reemplazarlo (pasa los mismos argumentos al real) para afirmar qué firma recibió cada entrada.
 *
 * Por qué importa (FC-D26): la firma de una ficha es la de SU autor, nunca la de quien la comparte o la descarga. Un
 * bug que mapee la firma por el actor (o por la primera del consultorio) imprimiría la firma de A en la ficha de B.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import { addPatient, addPractitioner, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { storageFake } from "@/tests/helpers/storage-fake";
import type { HcPrintableV1 } from "@/lib/hc-print-types";
import type { HcRenderAssets } from "@/lib/hc-assets-internal";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});

const spy = vi.hoisted(() => ({ calls: [] as { doc: unknown; assets: unknown }[] }));
vi.mock("@/lib/hc-pdf/render-internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/hc-pdf/render-internal")>();
  return {
    ...real,
    renderHcPdf: async (...args: Parameters<typeof real.renderHcPdf>) => {
      spy.calls.push({ doc: args[0], assets: args[1] });
      return real.renderHcPdf(...args);
    },
  };
});

const RUN = process.env.INTEGRATION === "1";

// ── PNG real (decodificable por react-pdf): el de `tests/helpers/image-bytes.ts` es solo cabecera ──────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** PNG RGB 8 bits de `w`×`h` de un color. */
function realPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + 3 * w) + 1 + 3 * x);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const form = (bytes: Uint8Array) => {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], "firma.png", { type: "image/png" }));
  return fd;
};

describe.skipIf(!RUN)("[FC-2i] corrida cruzada: firma del autor en el PDF compartido", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let B: { userId: string; practitionerId: string };
  let patientId: string;
  const sigA = realPng(5, 2, [255, 0, 0]);
  const sigB = realPng(7, 3, [0, 0, 255]);

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db);
    B = await addPractitioner(db, K, "PRACTITIONER");
    patientId = await addPatient(db, K, { assignedPractitionerId: B.practitionerId });
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    storageFake.reset();
    spy.calls.length = 0;
  });

  it("[FC-2f] el PDF de una ficha de B lleva la firma de B", async () => {
    const assets = await import("@/lib/practice-assets");
    const { createClinicalNote } = await import("@/lib/clinical-notes");
    const { shareClinicalNoteWithPatient } = await import("@/lib/patient-documents");

    // Las dos firmas, cada una subida por su dueño con la action real.
    asUser(K.userId);
    expect(await assets.uploadOwnSignature(form(sigA))).toMatchObject({ ok: true });
    expect(await assets.updateOwnSignatureInfo({ honorific: "LIC", licenseNumber: "MN 1111" })).toMatchObject({ ok: true });
    asUser(B.userId);
    expect(await assets.uploadOwnSignature(form(sigB))).toMatchObject({ ok: true });
    expect(await assets.updateOwnSignatureInfo({ honorific: "KLGA", licenseNumber: "MN 2222" })).toMatchObject({ ok: true });

    // B firma la ficha; la comparte el Titular A.
    const note = await createClinicalNote({ patientId, body: "Ficha de B · FC-2i", idempotencyKey: randomUUID() });
    if (!note.ok) throw new Error(note.error);
    asUser(K.userId);
    const shared = await shareClinicalNoteWithPatient({ noteId: note.data.note.id, idempotencyKey: randomUUID(), notify: false });
    expect(shared, JSON.stringify(shared)).toMatchObject({ ok: true });

    // Lo que recibió el render REAL: la entrada de B apunta a un imageRef cuya imagen son los bytes de B (no los de A).
    expect(spy.calls).toHaveLength(1);
    const doc = spy.calls[0].doc as HcPrintableV1;
    const rendered = spy.calls[0].assets as HcRenderAssets;
    const entry = doc.content.fichas[0].main;
    expect(entry.signature.line).toContain("MN 2222");
    expect(entry.signature.line).not.toContain("MN 1111");
    expect(entry.signature.imageRef).toBeTruthy();
    const img = rendered.signatures[entry.signature.imageRef!];
    expect(img).toMatchObject({ mime: "image/png", width: 7, height: 3 });
    expect(Buffer.from(img.bytes).equals(Buffer.from(sigB))).toBe(true);
    // Solo la firma de las entradas impresas: la de A (que compartió) no viaja.
    for (const a of Object.values(rendered.signatures)) expect(Buffer.from(a.bytes).equals(Buffer.from(sigA))).toBe(false);

    // Y el PDF guardado (el que baja el paciente) es un PDF real con la imagen de 7×3 embebida, no la de 5×2.
    const doc0 = await db.patientDocument.findFirstOrThrow({ where: { noteId: note.data.note.id } });
    const key = `${K.tenantId}/${patientId}/${doc0.id}.pdf`;
    const pdf = storageFake.get("patient-documents", key);
    expect(pdf, `falta ${key}`).toBeTruthy();
    const text = Buffer.from(pdf!.bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toMatch(/\/Width 7\b/);
    expect(text).not.toMatch(/\/Width 5\b/);
  }, 60_000);
});
