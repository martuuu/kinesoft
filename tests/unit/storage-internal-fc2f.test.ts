/**
 * T4 FC-2f · operaciones nuevas de `lib/storage-internal.ts` (C-FC10), símbolo real. Se mockea SOLO la red: el admin
 * client de Supabase (fake con lo que devuelve supabase-js) y `fetch` (la URL firmada de `storageReadHead`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminRef: { current: unknown } = { current: null };
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => adminRef.current }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  STORAGE_HEAD_BYTES,
  storageCreateSignedUpload,
  storageDownload,
  storageMove,
  storageReadHead,
  storageStat,
  storageSweepPending,
} from "@/lib/storage-internal";

function fakeApi(over: Record<string, unknown> = {}) {
  const api = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: "https://x.supabase.co/storage/v1/object/upload/sign/patient-files/pending/t/f?token=tok", token: "tok", path: "pending/t/f" },
      error: null,
    }),
    info: vi.fn().mockResolvedValue({ data: { size: 1234, contentType: "application/pdf" }, error: null }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: "https://signed.test/obj" }, error: null }),
    download: vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
    move: vi.fn().mockResolvedValue({ data: { message: "ok" }, error: null }),
    list: vi.fn(),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    ...over,
  };
  const from = vi.fn(() => api);
  adminRef.current = { storage: { from } };
  return { api, from };
}

beforeEach(() => {
  adminRef.current = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[FC-2f] storageCreateSignedUpload", () => {
  it("firma con upsert:false y devuelve signedUrl + token", async () => {
    const { api, from } = fakeApi();
    const r = await storageCreateSignedUpload("patient-files", "pending/t/f");
    expect(r).toEqual({
      ok: true,
      data: { signedUrl: "https://x.supabase.co/storage/v1/object/upload/sign/patient-files/pending/t/f?token=tok", token: "tok" },
    });
    expect(from).toHaveBeenCalledWith("patient-files");
    expect(api.createSignedUploadUrl).toHaveBeenCalledWith("pending/t/f", { upsert: false });
  });

  it("error o throw de red → storage", async () => {
    fakeApi({ createSignedUploadUrl: vi.fn().mockRejectedValue(new Error("fetch failed")) });
    expect(await storageCreateSignedUpload("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
  });
});

describe("[FC-2f] storageStat", () => {
  it("tamaño y content type", async () => {
    fakeApi();
    expect(await storageStat("patient-files", "k")).toEqual({ ok: true, data: { sizeBytes: 1234, contentType: "application/pdf" } });
  });

  it("no existe (404 / «Object not found») → data null; otro error → storage", async () => {
    fakeApi({ info: vi.fn().mockResolvedValue({ data: null, error: { message: "x", status: 404, statusCode: "404" } }) });
    expect(await storageStat("patient-files", "k")).toEqual({ ok: true, data: null });
    fakeApi({ info: vi.fn().mockResolvedValue({ data: null, error: { message: "Object not found", status: 400 } }) });
    expect(await storageStat("patient-files", "k")).toEqual({ ok: true, data: null });
    fakeApi({ info: vi.fn().mockResolvedValue({ data: null, error: { message: "boom", status: 500 } }) });
    expect(await storageStat("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
  });

  it("respuesta sin size → storage (no se confunde con 0 bytes)", async () => {
    fakeApi({ info: vi.fn().mockResolvedValue({ data: { contentType: "x" }, error: null }) });
    expect(await storageStat("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
  });
});

describe("[FC-2f] storageReadHead", () => {
  it("firma 60 s y pide Range 0-63; devuelve lo que llegó (206)", async () => {
    const { api } = fakeApi();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(64).fill(7), { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await storageReadHead("patient-files", "pending/t/f");
    expect(r.ok && r.data.length).toBe(STORAGE_HEAD_BYTES);
    expect(api.createSignedUrl).toHaveBeenCalledWith("pending/t/f", 60);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://signed.test/obj");
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-63");
  });

  it("server que ignora el Range (200 con 1 MB) → solo 64 bytes y corta el stream", async () => {
    fakeApi();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 100) return c.close();
        c.enqueue(new Uint8Array(10_000).fill(pulled));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const r = await storageReadHead("patient-files", "k");
    expect(r.ok && Array.from(r.data)).toEqual(new Array(64).fill(1));
    expect(pulled).toBeLessThan(5);
  });

  it("objeto más chico que 64 bytes → lo que hay; HTTP de error o firma caída → storage", async () => {
    fakeApi();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 206 })));
    expect(await storageReadHead("patient-files", "k")).toEqual({ ok: true, data: new Uint8Array([37, 80, 68, 70]) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    expect(await storageReadHead("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await storageReadHead("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
    fakeApi({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } }) });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await storageReadHead("patient-files", "k")).toMatchObject({ ok: false, reason: "storage" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("[FC-2f] storageDownload y storageMove", () => {
  it("download con tope: dentro → bytes; por encima → storage", async () => {
    fakeApi();
    expect(await storageDownload("practice-assets", "t/logo/n.png", 3)).toEqual({ ok: true, data: new Uint8Array([1, 2, 3]) });
    expect(await storageDownload("practice-assets", "t/logo/n.png", 2)).toMatchObject({ ok: false, reason: "storage" });
  });

  it("move pasa from/to; un { error } (destino existente, origen ausente) → storage", async () => {
    const { api } = fakeApi();
    expect(await storageMove("patient-files", "pending/t/f", "t/p/f.pdf")).toEqual({ ok: true, data: undefined });
    expect(api.move).toHaveBeenCalledWith("pending/t/f", "t/p/f.pdf");
    fakeApi({ move: vi.fn().mockResolvedValue({ data: null, error: { message: "The resource already exists" } }) });
    expect(await storageMove("patient-files", "a", "b")).toMatchObject({ ok: false, reason: "storage" });
  });
});

describe("[FC-2f] storageSweepPending (etapa del cron que conecta FC-2i)", () => {
  it("borra solo lo de pending/ con más de 24 h, por consultorio", async () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const old = new Date(now - 25 * 3600_000).toISOString();
    const fresh = new Date(now - 3600_000).toISOString();
    const list = vi.fn(async (prefix: string) => {
      if (prefix === "pending") return { data: [{ name: "tenA", id: null }, { name: "tenB", id: null }], error: null };
      if (prefix === "pending/tenA") {
        return { data: [{ name: "f1", id: "1", created_at: old }, { name: "f2", id: "2", created_at: fresh }], error: null };
      }
      if (prefix === "pending/tenB") return { data: null, error: { message: "boom" } };
      return { data: [], error: null };
    });
    const { api } = fakeApi({ list });
    const r = await storageSweepPending("patient-files", 24 * 3600_000, now);
    expect(r).toEqual({ ok: true, data: { removed: 1, errors: 1, truncated: false } });
    expect(api.remove).toHaveBeenCalledWith(["pending/tenA/f1"]);
  });

  it("[FC-2i] con el plazo vencido corta sin borrar y avisa `truncated` (presupuesto del cron diario)", async () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const old = new Date(now - 25 * 3600_000).toISOString();
    const list = vi.fn(async (prefix: string) => {
      if (prefix === "pending") return { data: [{ name: "tenA", id: null }], error: null };
      return { data: [{ name: "f1", id: "1", created_at: old }], error: null };
    });
    const { api } = fakeApi({ list });
    const r = await storageSweepPending("patient-files", 24 * 3600_000, now, Date.now() - 1);
    expect(r).toEqual({ ok: true, data: { removed: 0, errors: 0, truncated: true } });
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("sin admin client → unconfigured", async () => {
    expect(await storageSweepPending("patient-files", 1)).toMatchObject({ ok: false, reason: "unconfigured" });
  });
});
