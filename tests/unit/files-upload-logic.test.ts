/**
 * T4 FC-4b · subida firmada desde la pestaña Archivos (lib/files-upload-logic.ts, símbolo real; C-FC10, brief §24.8).
 * Las server actions y el PUT se inyectan como dobles (son la red); la máquina de estados, la validación previa y el
 * XHR (con un XMLHttpRequest falso) son los de prod.
 */
import { describe, it, expect, vi } from "vitest";
import {
  PATIENT_FILE_UPLOAD_MIMES,
  STUB_UPLOAD_MAX_BYTES,
  UPLOAD_COPY,
  putWithXhr,
  resolveUploadMime,
  runPatientFileUpload,
  uploadProgressPercent,
  validateUploadFile,
  type UploadDeps,
  type UploadState,
} from "@/lib/files-upload-logic";
import { PATIENT_FILE_MIME_FAMILIES } from "@/lib/file-sniff";
import { PATIENT_FILE_MAX_BYTES } from "@/lib/files-types";

const MB = 1024 * 1024;

function fakeFile(name: string, size: number, type: string): File {
  // `File` real de Node 20: el tamaño sale del contenido.
  return new File([new Uint8Array(size)], name, { type });
}

function deps(over: Partial<UploadDeps> = {}): UploadDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: vi.fn(async () => {
      calls.push("request");
      return {
        ok: true as const,
        data: { mode: "signed" as const, uploadUrl: "https://st.example/up?token=t", confirmToken: "tok", expiresAt: "x" },
      };
    }),
    put: vi.fn(async (_url, _file, _mime, onProgress) => {
      calls.push("put");
      onProgress(50, 100);
      onProgress(100, 100);
      return { ok: true as const };
    }),
    confirm: vi.fn(async () => {
      calls.push("confirm");
      return { ok: true as const, data: { id: "f1", replayed: false } };
    }),
    uploadStub: vi.fn(async () => {
      calls.push("stub");
      return { ok: true as const, data: { id: "s1" } };
    }),
    ...over,
  };
}

describe("[FC-4b] validación previa en el cliente", () => {
  it("[FC-4b] más de 25 MB se frena en el cliente", async () => {
    const big = { name: "estudio.pdf", size: PATIENT_FILE_MAX_BYTES + 1, type: "application/pdf" };
    expect(validateUploadFile(big)).toEqual({ ok: false, error: UPLOAD_COPY.tooBig });
    expect(validateUploadFile({ ...big, size: PATIENT_FILE_MAX_BYTES })).toEqual({ ok: true, mime: "application/pdf" });

    // Y no se llega a pedir la firma: ni una llamada a la red.
    const d = deps();
    const states: UploadState[] = [];
    const r = await runPatientFileUpload(
      d,
      { patientId: "p1", file: fakeFile("estudio.pdf", 26 * MB, "application/pdf"), category: "REPORT", description: "" },
      (s) => states.push(s),
    );
    expect(r).toEqual({ kind: "error", message: UPLOAD_COPY.tooBig });
    expect(d.calls).toEqual([]);
  });

  it("vacío, MIME fuera de la allow-list y nombre inválido", () => {
    expect(validateUploadFile({ name: "a.pdf", size: 0, type: "application/pdf" })).toEqual({ ok: false, error: UPLOAD_COPY.empty });
    expect(validateUploadFile({ name: "x.html", size: 10, type: "text/html" })).toEqual({ ok: false, error: UPLOAD_COPY.badType });
    expect(validateUploadFile({ name: "x.svg", size: 10, type: "image/svg+xml" })).toEqual({ ok: false, error: UPLOAD_COPY.badType });
    expect(validateUploadFile({ name: "   ", size: 10, type: "application/pdf" })).toEqual({ ok: false, error: UPLOAD_COPY.badName });
    expect(validateUploadFile({ name: "a".repeat(252) + ".pdf", size: 10, type: "application/pdf" })).toEqual({
      ok: false,
      error: UPLOAD_COPY.badName,
    });
  });

  it("la allow-list del cliente es exactamente la del server (claves de PATIENT_FILE_MIME_FAMILIES)", () => {
    expect([...PATIENT_FILE_UPLOAD_MIMES].sort()).toEqual(Object.keys(PATIENT_FILE_MIME_FAMILIES).sort());
  });

  it("sin `file.type` (HEIC en Windows, .doc en algunos navegadores) el MIME sale de la extensión", () => {
    expect(resolveUploadMime("IMG_0001.HEIC", "")).toBe("image/heic");
    expect(resolveUploadMime("informe.doc", "")).toBe("application/msword");
    expect(resolveUploadMime("raro.xyz", "")).toBeNull();
    // El tipo del navegador manda cuando viene (lo verifica igual el server por magic bytes).
    expect(resolveUploadMime("foto.jpg", "IMAGE/JPEG")).toBe("image/jpeg");
    expect(resolveUploadMime("x.pdf", "text/html")).toBe("text/html");
  });

  it("porcentaje de progreso acotado", () => {
    expect(uploadProgressPercent(0, 0)).toBe(0);
    expect(uploadProgressPercent(1, 3)).toBe(33);
    expect(uploadProgressPercent(5, 3)).toBe(100);
  });
});

describe("[FC-4b] máquina de estados", () => {
  it("[FC-4b] máquina de estados request → put → confirm", async () => {
    const d = deps();
    const states: UploadState[] = [];
    const file = fakeFile("rx.png", 1000, "image/png");
    const r = await runPatientFileUpload(d, { patientId: "p1", file, category: "IMAGE", description: " rodilla " }, (s) =>
      states.push(s),
    );
    expect(r).toEqual({ kind: "done", id: "f1" });
    expect(d.calls).toEqual(["request", "put", "confirm"]);
    expect(states.map((s) => s.phase)).toEqual(["requesting", "uploading", "uploading", "uploading", "confirming", "done"]);
    expect(states[2]).toEqual({ phase: "uploading", loaded: 50, total: 100 });
    expect(d.request).toHaveBeenCalledWith({ patientId: "p1", fileName: "rx.png", mime: "image/png", sizeBytes: 1000, category: "IMAGE" });
    // El PUT va con el MIME declarado (si no coincide, confirm rechaza).
    expect((d.put as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://st.example/up?token=t");
    expect((d.put as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("image/png");
    expect(d.confirm).toHaveBeenCalledWith({ confirmToken: "tok", description: "rodilla" });
    expect(d.uploadStub).not.toHaveBeenCalled();
  });

  it("`{mode:\"stub\"}` cae a uploadPatientFile (≤4 MB) con el FormData de siempre", async () => {
    const d = deps({
      request: vi.fn(async () => ({ ok: true as const, data: { mode: "stub" as const } })),
    });
    const states: UploadState[] = [];
    const file = fakeFile("a.pdf", 10, "application/pdf");
    const r = await runPatientFileUpload(d, { patientId: "p1", file, category: "REPORT", description: "d" }, (s) =>
      states.push(s),
    );
    expect(r).toEqual({ kind: "done", id: "s1" });
    expect(d.put).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    const fd = (d.uploadStub as ReturnType<typeof vi.fn>).mock.calls[0][0] as FormData;
    expect(fd.get("category")).toBe("REPORT");
    expect(fd.get("description")).toBe("d");
    expect((fd.get("file") as File).name).toBe("a.pdf");
    expect(states.map((s) => s.phase)).toEqual(["requesting", "uploading", "done"]);

    // Más de 4 MB en modo stub: el body de la action corta en 4,5 MB; se avisa sin mandar nada.
    const d2 = deps({ request: vi.fn(async () => ({ ok: true as const, data: { mode: "stub" as const } })) });
    const r2 = await runPatientFileUpload(
      d2,
      { patientId: "p1", file: fakeFile("b.pdf", STUB_UPLOAD_MAX_BYTES + 1, "application/pdf"), category: "REPORT", description: "" },
      () => {},
    );
    expect(r2).toEqual({ kind: "error", message: UPLOAD_COPY.stubTooBig });
    expect(d2.uploadStub).not.toHaveBeenCalled();
  });

  it("errores del server pasan con su copy; un PUT fallido no confirma", async () => {
    const d = deps({ request: vi.fn(async () => ({ ok: false as const, error: "No tenés acceso completo a este paciente." })) });
    const file = fakeFile("a.pdf", 10, "application/pdf");
    expect(await runPatientFileUpload(d, { patientId: "p1", file, category: "REPORT", description: "" }, () => {})).toEqual({
      kind: "error",
      message: "No tenés acceso completo a este paciente.",
    });

    const d2 = deps({ put: vi.fn(async () => ({ ok: false as const, error: UPLOAD_COPY.putFailed })) });
    expect(await runPatientFileUpload(d2, { patientId: "p1", file, category: "REPORT", description: "" }, () => {})).toEqual({
      kind: "error",
      message: UPLOAD_COPY.putFailed,
    });
    expect(d2.confirm).not.toHaveBeenCalled();

    const d3 = deps({
      confirm: vi.fn(async () => ({ ok: false as const, error: "El archivo no es lo que dice ser." })),
    });
    expect(await runPatientFileUpload(d3, { patientId: "p1", file, category: "REPORT", description: "" }, () => {})).toEqual({
      kind: "error",
      message: "El archivo no es lo que dice ser.",
    });

    // Una action que tira (red caída) no deja la UI colgada en «Subiendo…».
    const d4 = deps({ request: vi.fn(async () => Promise.reject(new Error("net"))) });
    expect(await runPatientFileUpload(d4, { patientId: "p1", file, category: "REPORT", description: "" }, () => {})).toEqual({
      kind: "error",
      message: UPLOAD_COPY.network,
    });
  });

  it("cancelar antes del PUT no sube; durante el PUT aborta y no confirma", async () => {
    const file = fakeFile("a.pdf", 10, "application/pdf");
    const ac = new AbortController();
    const d = deps({
      request: vi.fn(async () => {
        ac.abort();
        return { ok: true as const, data: { mode: "signed" as const, uploadUrl: "u", confirmToken: "t", expiresAt: "x" } };
      }),
    });
    expect(
      await runPatientFileUpload(d, { patientId: "p1", file, category: "REPORT", description: "" }, () => {}, ac.signal),
    ).toEqual({ kind: "cancelled" });
    expect(d.put).not.toHaveBeenCalled();

    const ac2 = new AbortController();
    const d2 = deps({
      put: vi.fn(async (_u, _f, _m, _p, signal?: AbortSignal) => {
        ac2.abort();
        expect(signal?.aborted).toBe(true);
        return { ok: false as const, error: UPLOAD_COPY.cancelled, aborted: true };
      }),
    });
    expect(
      await runPatientFileUpload(d2, { patientId: "p1", file, category: "REPORT", description: "" }, () => {}, ac2.signal),
    ).toEqual({ kind: "cancelled" });
    expect(d2.confirm).not.toHaveBeenCalled();
  });
});

describe("[FC-4b] putWithXhr", () => {
  type Listener = (e: { loaded: number; total: number; lengthComputable: boolean }) => void;
  class FakeXhr {
    static last: FakeXhr;
    method = "";
    url = "";
    headers: Record<string, string> = {};
    body: unknown;
    status = 0;
    upload = { onprogress: null as Listener | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;
    constructor() {
      FakeXhr.last = this;
    }
    open(m: string, u: string) {
      this.method = m;
      this.url = u;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(b: unknown) {
      this.body = b;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  it("PUT con Content-Type = MIME declarado, progreso y 200", async () => {
    const file = fakeFile("a.pdf", 10, "application/pdf");
    const seen: number[] = [];
    const p = putWithXhr("https://st/u", file, "application/pdf", (l) => seen.push(l), undefined, FakeXhr as never);
    const x = FakeXhr.last;
    expect(x.method).toBe("PUT");
    expect(x.url).toBe("https://st/u");
    expect(x.headers["Content-Type"]).toBe("application/pdf");
    expect(x.body).toBe(file);
    x.upload.onprogress?.({ loaded: 4, total: 10, lengthComputable: true });
    x.status = 200;
    x.onload?.();
    expect(await p).toEqual({ ok: true });
    expect(seen).toEqual([4]);
  });

  it("status ≥ 400, error de red y abort", async () => {
    const file = fakeFile("a.pdf", 10, "application/pdf");
    const p1 = putWithXhr("u", file, "application/pdf", () => {}, undefined, FakeXhr as never);
    FakeXhr.last.status = 413;
    FakeXhr.last.onload?.();
    expect(await p1).toEqual({ ok: false, error: UPLOAD_COPY.tooBig });

    const p2 = putWithXhr("u", file, "application/pdf", () => {}, undefined, FakeXhr as never);
    FakeXhr.last.status = 400;
    FakeXhr.last.onload?.();
    expect(await p2).toEqual({ ok: false, error: UPLOAD_COPY.putFailed });

    const p3 = putWithXhr("u", file, "application/pdf", () => {}, undefined, FakeXhr as never);
    FakeXhr.last.onerror?.();
    expect(await p3).toEqual({ ok: false, error: UPLOAD_COPY.network });

    const ac = new AbortController();
    const p4 = putWithXhr("u", file, "application/pdf", () => {}, ac.signal, FakeXhr as never);
    const x4 = FakeXhr.last;
    ac.abort();
    expect(x4.aborted).toBe(true);
    expect(await p4).toEqual({ ok: false, error: UPLOAD_COPY.cancelled, aborted: true });

    // Señal ya abortada: ni se abre.
    const ac5 = new AbortController();
    ac5.abort();
    expect(await putWithXhr("u", file, "application/pdf", () => {}, ac5.signal, FakeXhr as never)).toEqual({
      ok: false,
      error: UPLOAD_COPY.cancelled,
      aborted: true,
    });
  });
});

describe("[FC-4b] la vista no suma supabase-js al bundle", () => {
  it("archivos-view y la lógica no importan @supabase/*", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["components/patients/archivos-view.tsx", "lib/files-upload-logic.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/from\s+["']@supabase\//);
      expect(src).not.toMatch(/@\/lib\/supabase/);
    }
    const view = readFileSync("components/patients/archivos-view.tsx", "utf8");
    expect(view).toContain('role="progressbar"');
    expect(view).toContain("aria-valuenow");
  });
});
