/**
 * [WA-S6] Hallazgo 1 de WA-P3: Meta exige `example.header_handle` (Resumable Upload API) para dar de alta una plantilla
 * con header DOCUMENT (`cs_documento_v1`). Sin el handle, en sandbox/live esa plantilla quedaba NOT_SUBMITTED y
 * compartir la ficha por WhatsApp no salía nunca (`template_pending`).
 *
 * Símbolos reales: `uploadHeaderSample` / `documentHeaderSamplePdf` / `createTemplate` de `lib/whatsapp/graph.ts` contra
 * el `fakeGraphHandle` real (que ahora EXIGE el handle, como Meta). Lo único reemplazado es la red (`installFakeGraph`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_WA, fakeGraphSignup, installFakeGraph, type InstalledFakeGraph } from "@/tests/helpers/whatsapp-fake";
import { createTemplate, documentHeaderSamplePdf, exchangeCode, subscribeApp, templateCreateComponents, uploadHeaderSample } from "@/lib/whatsapp/graph";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";

let fake: InstalledFakeGraph;
beforeEach(() => {
  fake = installFakeGraph();
});
afterEach(() => fake.uninstall());

async function account() {
  const a = fakeGraphSignup();
  const tok = ((await exchangeCode(a.code)) as { data: { accessToken: string } }).data.accessToken;
  await subscribeApp(tok, a.wabaId);
  return { ...a, tok };
}

const DOC = TEMPLATE_SPECS.DOCUMENT_SHARED;
const create = (tok: string, wabaId: string, headerHandle?: string) =>
  createTemplate(tok, wabaId, { name: DOC.name, language: DOC.language, category: DOC.category, components: templateCreateComponents(DOC, { headerHandle }) });

describe("[WA-S6] header_handle de cs_documento_v1", () => {
  it("[WA-S6] el PDF de ejemplo es un PDF de verdad y no lleva datos de nadie", () => {
    const pdf = documentHeaderSamplePdf();
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // xref con offsets exactos: cada `n 0 obj` está donde la tabla dice.
    const xref = text.slice(text.indexOf("xref"));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(Number(/startxref\n(\d+)/.exec(text)![1])).toBe(text.indexOf("xref"));
  });

  it("[WA-S6] subida reanudable: sesión en /{app_id}/uploads + bytes con `OAuth` y `file_offset: 0` → handle", async () => {
    const a = await account();
    const r = await uploadHeaderSample(a.tok, FAKE_WA.WHATSAPP_APP_ID, { bytes: documentHeaderSamplePdf(), mimeType: "application/pdf", filename: "ejemplo.pdf" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.handle).toMatch(/^[0-9]:[A-Za-z0-9_-]+$/);
    // Dos llamadas: la sesión y los bytes. Ninguna lleva el token en la URL.
    const uploads = fake.calls.filter((u) => u.includes("/uploads") || u.includes("upload:"));
    expect(uploads).toHaveLength(2);
    expect(uploads.join(" ")).not.toContain(a.tok);
  });

  it("[WA-S6] el simulador exige el handle para el header DOCUMENT (como Meta); con el handle subido, PENDING", async () => {
    const a = await account();
    expect(await create(a.tok, a.wabaId)).toMatchObject({ ok: false, code: 100 });
    expect(await create(a.tok, a.wabaId, "4:inventado")).toMatchObject({ ok: false, code: 100 });
    const up = await uploadHeaderSample(a.tok, FAKE_WA.WHATSAPP_APP_ID, { bytes: documentHeaderSamplePdf(), mimeType: "application/pdf", filename: "ejemplo.pdf" });
    if (!up.ok) throw new Error("upload");
    const c = await create(a.tok, a.wabaId, up.data.handle);
    expect(c.ok && c.data.status).toBe("PENDING");
  });

  it("[WA-S6] subida con otro app id, sin token o con un id de sesión roto → error, nunca tira", async () => {
    const a = await account();
    const f = { bytes: documentHeaderSamplePdf(), mimeType: "application/pdf", filename: "ejemplo.pdf" };
    expect(await uploadHeaderSample(a.tok, "otra-app", f)).toMatchObject({ ok: false });
    expect(await uploadHeaderSample("token-invalido", FAKE_WA.WHATSAPP_APP_ID, f)).toMatchObject({ ok: false, code: 190 });
    expect(await uploadHeaderSample(a.tok, "", f)).toMatchObject({ ok: false });
  });
});
