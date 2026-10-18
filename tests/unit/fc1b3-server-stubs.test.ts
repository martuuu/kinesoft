import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FC-1b3: firmas server publicadas para T4c. Lo que ya está implementado se testea en verde; los stubs que tiran
// llevan su `it.fails` para que la sesión dueña los dé vuelta (FC-2c, FC-2e, FC-2f, FC-3c).

// Se mockea SOLO el borde de red (el admin client de Supabase), nunca el módulo bajo test.
const adminRef: { current: unknown } = { current: null };
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => adminRef.current }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const SERVER_ONLY = [
  "lib/diagnoses-internal.ts",
  "lib/hc-print-internal.ts",
  "lib/hc-pdf/render-internal.tsx",
  "lib/hc-assets-internal.ts",
  "lib/storage-internal.ts",
];
const NEUTRAL = [
  "lib/hc-print-model.ts",
  "lib/hc-print-internal.ts",
  "lib/hc-pdf/render-internal.tsx",
  "lib/hc-assets-internal.ts",
  "lib/hc-composer-logic.ts",
];

describe("[FC-1b] módulos server de FC-1b3", () => {
  it.each(SERVER_ONLY)("%s importa server-only", (p) => {
    expect(read(p)).toMatch(/^import "server-only";/m);
  });

  it.each(NEUTRAL)("%s es neutral (no nombra el modelo de notas, ni en comentarios)", (p) => {
    expect(read(p)).not.toMatch(/clinicalNote|ClinicalNote|clinical-notes/);
  });

  it("los puros no arrastran server-only, Prisma runtime ni I/O", () => {
    for (const p of ["lib/hc-print-model.ts", "lib/diagnoses-logic.ts", "lib/hc-composer-logic.ts"]) {
      const src = read(p);
      expect(src).not.toMatch(/^import "server-only"/m);
      expect(src).not.toMatch(/^import (?!type )[^;]*from "@prisma\/client"/m);
      expect(src).not.toMatch(/from "node:|from "@\/lib\/(prisma|rls|session)"/);
    }
  });
});

describe("[FC-1b] storage-internal: buckets nuevos y firmas de C-FC10", () => {
  beforeEach(() => {
    adminRef.current = null;
  });

  it("sin admin client → unconfigured (nunca tira)", async () => {
    const s = await import("@/lib/storage-internal");
    const results = await Promise.all([
      s.storageCreateSignedUpload("patient-files", "t/p/f.pdf"),
      s.storageStat("patient-documents", "t/p/d.pdf"),
      s.storageReadHead("patient-files", "t/p/f.pdf"),
      s.storageDownload("practice-assets", "t/logo/n.png", 1024),
      s.storageMove("patient-files", "pending/a", "t/p/a"),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(s.STORAGE_HEAD_BYTES).toBe(64);
  });

  // FC-2f implementó las firmas: el «no implementado» de FC-1b3 pasa a ser «un { error } de Supabase → storage, sin
  // tirar» (el detalle de cada operación está en tests/unit/storage-internal-fc2f.test.ts).
  it("[FC-2f] con admin client, un { error } de supabase-js en las firmas nuevas → reason storage, nunca tira", async () => {
    const err = { error: { message: "boom" }, data: null };
    const api = {
      createSignedUploadUrl: vi.fn().mockResolvedValue(err),
      info: vi.fn().mockResolvedValue(err),
      createSignedUrl: vi.fn().mockResolvedValue(err),
      download: vi.fn().mockResolvedValue(err),
      move: vi.fn().mockResolvedValue(err),
    };
    adminRef.current = { storage: { from: () => api } };
    const s = await import("@/lib/storage-internal");
    const results = await Promise.all([
      s.storageCreateSignedUpload("patient-files", "pending/t/f"),
      s.storageStat("patient-files", "pending/t/f"),
      s.storageReadHead("patient-files", "pending/t/f"),
      s.storageDownload("patient-documents", "t/p/d.pdf", 10),
      s.storageMove("patient-files", "pending/t/f", "t/p/f.pdf"),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, reason: "storage" });
  });

  it("las operaciones existentes aceptan los buckets nuevos", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ upload }));
    adminRef.current = { storage: { from } };
    const s = await import("@/lib/storage-internal");
    const r = await s.storageUpload("patient-documents", "t/p/d.pdf", new Uint8Array([1]), "application/pdf");
    expect(r).toEqual({ ok: true, data: undefined });
    expect(from).toHaveBeenCalledWith("patient-documents");
    expect(upload).toHaveBeenCalledWith("t/p/d.pdf", expect.any(Uint8Array), { contentType: "application/pdf", upsert: false });
  });

  it("[FC-2f] storageDownload baja el objeto con tope de bytes", async () => {
    const download = vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    adminRef.current = { storage: { from: () => ({ download }) } };
    const s = await import("@/lib/storage-internal");
    const r = await s.storageDownload("patient-documents", "t/p/d.pdf", 10);
    expect(r.ok).toBe(true);
  });
});

describe("[FC-1b] hc-print-internal", () => {
  it("sha256Hex es el sha256 en hex del texto UTF-8", async () => {
    const { sha256Hex } = await import("@/lib/hc-print-internal");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("á")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("v1|r1")).toBe(sha256Hex("v1|r1"));
  });

  it("[FC-2e] finalizeHcPrintable: verificationCode = código del sha256 de canonicalJson(content)", async () => {
    const { finalizeHcPrintable, sha256Hex } = await import("@/lib/hc-print-internal");
    const { canonicalJson, verificationCodeFromSha256 } = await import("@/lib/hc-print-model");
    const content = {
      letterhead: { tenantName: "C", addressLine: null, phone: null, hasLogo: false },
      patient: { fullName: "J", documentId: null, dateOfBirth: null },
      fichas: [],
      icdAttribution: null,
    };
    const { printable, sha256 } = finalizeHcPrintable(content, {
      generatedAt: "2026-10-18T00:00:00.000Z",
      purpose: "download",
      generatedByName: "Ana",
      truncated: false,
    });
    expect(sha256).toBe(sha256Hex(canonicalJson(content)));
    expect(printable.meta.verificationCode).toBe(verificationCodeFromSha256(sha256));
  });
});

describe("[FC-1b] renderers y assets (FC-2e)", () => {
  it("HC_PDF_MAX_BYTES = 4 MB", async () => {
    const { HC_PDF_MAX_BYTES } = await import("@/lib/hc-pdf/render-internal");
    expect(HC_PDF_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it("[FC-2e] loadHcAssets falla blanda: sin claves → sin assets, nunca tira", async () => {
    const { loadHcAssets } = await import("@/lib/hc-assets-internal");
    await expect(loadHcAssets({ logoKey: null, signatures: [{ ref: "s1", key: null }] })).resolves.toEqual({
      logo: null,
      signatures: {},
    });
  });
});

describe("[FC-1b] composer (stub de FC-3c)", () => {
  it.fails("[FC-3c] pickDefaultComposerBooking: sin turno hoy → null", async () => {
    const { pickDefaultComposerBooking } = await import("@/lib/hc-composer-logic");
    expect(pickDefaultComposerBooking({ candidates: [], ownPractitionerId: null, now: new Date() })).toBeNull();
  });
});

describe("[FC-1b] diagnoses-internal (implementado por FC-2c)", () => {
  it("[FC-2c] resolveDiagnosesInTx: sin refs → ok sin snapshots", async () => {
    const { resolveDiagnosesInTx } = await import("@/lib/diagnoses-internal");
    const r = await resolveDiagnosesInTx({} as never, {} as never, []);
    expect(r).toEqual({ ok: true, snapshots: [] });
  });
});
