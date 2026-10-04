/**
 * S02m · Storage por service role y firmador de media (fuga E0).
 *
 * Qué fija:
 *  - `lib/exercise-media.ts` ("use server" → cada export es una action por RPC)
 *    no exporta ningún firmador: `resolveMediaUrl` firmaba cualquier clave del
 *    bucket sin sesión.
 *  - `signExerciseMedia(mediaId)` firma la clave de la FILA (nunca una del
 *    cliente); id inexistente → null sin tocar Storage.
 *  - El admin client real falla cerrado sin la env, y sin él Storage devuelve
 *    `unconfigured` (no hay fallback al JWT del usuario).
 *  - Un `{ error }` de Supabase (supabase-js no tira) o un throw de red se
 *    propagan como error controlado, y `lib/files.ts` no borra la fila ni deja
 *    un objeto huérfano.
 *  - `lib/files.ts` usa el admin client con los gates de hoy intactos.
 *
 * Red mockeada (C14): se reemplaza `getSupabaseAdminClient` por un fake que
 * registra llamadas; se ejecutan los símbolos reales de `lib/**`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const supa = vi.hoisted(() => ({
  enabled: true,
  calls: [] as { op: "upload" | "sign" | "remove"; bucket: string; args: unknown[] }[],
  error: null as null | { message: string },
  throwOn: null as null | "upload" | "sign" | "remove",
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => {
    if (!supa.enabled) return null;
    return {
      storage: {
        from: (bucket: string) => {
          const run = async (op: "upload" | "sign" | "remove", args: unknown[], ok: unknown) => {
            supa.calls.push({ op, bucket, args });
            if (supa.throwOn === op) throw new Error("fetch failed");
            return supa.error ? { data: null, error: supa.error } : { data: ok, error: null };
          };
          return {
            upload: (key: string, _body: unknown, opts: unknown) => run("upload", [key, opts], { path: key }),
            createSignedUrl: (key: string, ttl: number) =>
              run("sign", [key, ttl], { signedUrl: `https://signed.test/${bucket}/${key}?ttl=${ttl}` }),
            remove: (keys: string[]) => run("remove", [keys], []),
          };
        },
      },
    };
  },
}));

function reset() {
  supa.enabled = true;
  supa.calls = [];
  supa.error = null;
  supa.throwOn = null;
}

function pdfForm(name: string) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" }));
  fd.set("category", "REPORT");
  return fd;
}

describe.skipIf(!RUN)("S02m · firmador de media", () => {
  let db: PrismaClient;
  let exerciseId: string;
  let tenantExerciseId: string;
  let T: EphemeralTenant;
  const media: Record<string, string> = {};

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    const s = uniqueSuffix();
    const ex = await db.exercise.create({
      data: { slug: `test-s02m-${s}`, name: "S02m global", tenantId: null },
    });
    exerciseId = ex.id;
    const tex = await db.exercise.create({
      data: { slug: `test-s02m-t-${s}`, name: "S02m del tenant", tenantId: T.tenantId },
    });
    tenantExerciseId = tex.id;
    const mk = async (k: string, data: { type: "VIDEO" | "YOUTUBE"; url: string; exerciseId?: string }) => {
      const r = await db.exerciseMedia.create({
        data: { exerciseId: data.exerciseId ?? exerciseId, type: data.type, url: data.url },
      });
      media[k] = r.id;
    };
    await mk("video", { type: "VIDEO", url: `exercises/${exerciseId}/abc.mp4` });
    await mk("stub", { type: "VIDEO", url: "stub:xyz" });
    await mk("yt", { type: "YOUTUBE", url: "https://youtu.be/dQw4w9WgXcQ" });
    await mk("tenant", { type: "VIDEO", url: `exercises/${tenantExerciseId}/t.mp4`, exerciseId: tenantExerciseId });
  });

  afterAll(async () => {
    if (exerciseId) await db?.exercise.deleteMany({ where: { id: { in: [exerciseId, tenantExerciseId] } } });
    await T?.cleanup();
    await db?.$disconnect();
  });

  afterEach(reset);

  it("lib/exercise-media.ts no exporta ningún firmador", async () => {
    const mod = await import("@/lib/exercise-media");
    const names = Object.keys(mod).sort();
    expect(names).not.toContain("resolveMediaUrl");
    // Lista cerrada: una export nueva en este "use server" es una action pública
    // y tiene que pasar por revisión (y por este test).
    expect(names).toEqual(["addExerciseMedia", "deleteExerciseMedia", "reorderExerciseMedia"]);
    expect(names.filter((n) => /sign|resolve|url/i.test(n))).toEqual([]);
  });

  it("signExerciseMedia de un id inexistente → null sin tocar Storage", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    expect(await signExerciseMedia("no-existe-" + uniqueSuffix())).toBeNull();
    expect(await signExerciseMedia("")).toBeNull();
    expect(supa.calls).toEqual([]);
  });

  it("firma la clave de la fila, en el bucket exercise-media, con TTL acotado", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    const url = await signExerciseMedia(media.video);
    expect(url).toBe(`https://signed.test/exercise-media/exercises/${exerciseId}/abc.mp4?ttl=3600`);
    expect(supa.calls).toEqual([
      { op: "sign", bucket: "exercise-media", args: [`exercises/${exerciseId}/abc.mp4`, 3600] },
    ]);
    supa.calls = [];
    await signExerciseMedia(media.video, { ttlSeconds: 600 });
    await signExerciseMedia(media.video, { ttlSeconds: 999_999 });
    expect(supa.calls.map((c) => c.args[1])).toEqual([600, 3600]);
  });

  it("YouTube → embed nocookie; stub de dev → null; ninguno toca Storage", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    expect(await signExerciseMedia(media.yt)).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(await signExerciseMedia(media.stub)).toBeNull();
    expect(supa.calls).toEqual([]);
  });

  it("media de un ejercicio de tenant (no global) → null: no se firma fuera del catálogo", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    expect(await signExerciseMedia(media.tenant)).toBeNull();
    expect(supa.calls).toEqual([]);
  });

  it("{ error } de Supabase o throw de red al firmar → null controlado", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    supa.error = { message: "Object not found" };
    expect(await signExerciseMedia(media.video)).toBeNull();
    supa.error = null;
    supa.throwOn = "sign";
    expect(await signExerciseMedia(media.video)).toBeNull();
  });

  it("sin admin client → null (no hay fallback al client del usuario)", async () => {
    const { signExerciseMedia } = await import("@/lib/exercise-media-internal");
    supa.enabled = false;
    expect(await signExerciseMedia(media.video)).toBeNull();
    expect(supa.calls).toEqual([]);
  });
});

describe.skipIf(!RUN)("S02m · lib/storage-internal", () => {
  afterEach(reset);

  it("sin admin client → unconfigured en upload, sign y remove", async () => {
    const s = await import("@/lib/storage-internal");
    supa.enabled = false;
    expect(s.isStorageConfigured()).toBe(false);
    expect(await s.storageUpload("patient-files", "k", new Uint8Array([1]), "application/pdf")).toMatchObject({
      ok: false,
      reason: "unconfigured",
    });
    expect(await s.storageSign("patient-files", "k", 600)).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(await s.storageRemove("patient-files", ["k"])).toMatchObject({ ok: false, reason: "unconfigured" });
  });

  it("{ error } de Supabase → { ok:false, reason:'storage' } en las tres operaciones", async () => {
    const s = await import("@/lib/storage-internal");
    supa.error = { message: "boom" };
    for (const r of [
      await s.storageUpload("patient-files", "k", new Uint8Array([1]), "application/pdf"),
      await s.storageSign("patient-files", "k", 600),
      await s.storageRemove("patient-files", ["k"]),
    ]) {
      expect(r).toEqual({ ok: false, reason: "storage", message: "boom" });
    }
  });

  it("upload nunca pisa (upsert:false)", async () => {
    const s = await import("@/lib/storage-internal");
    await s.storageUpload("exercise-media", "k", new Uint8Array([1]), "video/mp4");
    expect(supa.calls[0].args[1]).toEqual({ contentType: "video/mp4", upsert: false });
  });

  it("el admin client REAL falla cerrado sin la env", async () => {
    const { env } = await import("@/lib/env");
    const real = await vi.importActual<typeof import("@/lib/supabase/admin")>("@/lib/supabase/admin");
    const e = env as { NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
    const saved = { url: e.NEXT_PUBLIC_SUPABASE_URL, key: e.SUPABASE_SERVICE_ROLE_KEY };
    // Se vacía ANTES de la primera llamada (el módulo cachea el client): así
    // este test nunca construye un client con credenciales reales del `.env`.
    e.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    e.SUPABASE_SERVICE_ROLE_KEY = undefined;
    try {
      expect(real.getSupabaseAdminClient()).toBeNull();
    } finally {
      e.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      e.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });
});

describe.skipIf(!RUN)("S02m · lib/files.ts por service role, gates intactos", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let patientId: string;
  let otherUser: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    patientId = await addPatient(db, A);
    otherUser = (await addPractitioner(db, A)).userId; // básico: no asignado
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    reset();
    asUser(A.userId);
  });

  async function realFile(key?: string) {
    const f = await db.patientFile.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        name: "rx.pdf",
        mime: "application/pdf",
        sizeBytes: 4,
        storageKey: key ?? `${A.tenantId}/${patientId}/${uniqueSuffix()}.pdf`,
        category: "REPORT",
      },
    });
    return f;
  }

  it("getDownloadUrl firma con el admin client la clave de la fila (TTL 600)", async () => {
    asUser(A.userId);
    const f = await realFile();
    const r = await (await import("@/lib/files")).getDownloadUrl(f.id);
    expect(r).toEqual({ ok: true, data: { url: `https://signed.test/patient-files/${f.storageKey}?ttl=600` } });
    expect(supa.calls).toEqual([{ op: "sign", bucket: "patient-files", args: [f.storageKey, 600] }]);
  });

  it("acceso básico → rechazo sin tocar Storage (gate intacto)", async () => {
    const f = await realFile();
    asUser(otherUser);
    const files = await import("@/lib/files");
    expect(await files.getDownloadUrl(f.id)).toMatchObject({ ok: false });
    expect(await files.deletePatientFile(f.id)).toMatchObject({ ok: false });
    expect(await files.uploadPatientFile(patientId, pdfForm("colado.pdf"))).toMatchObject({ ok: false });
    expect(supa.calls).toEqual([]);
    expect(await db.patientFile.count({ where: { id: f.id } })).toBe(1);
  });

  it("{ error } al firmar → error controlado", async () => {
    asUser(A.userId);
    const f = await realFile();
    supa.error = { message: "Object not found" };
    expect(await (await import("@/lib/files")).getDownloadUrl(f.id)).toEqual({
      ok: false,
      error: "No pudimos generar el link.",
    });
  });

  it("{ error } al borrar → la fila queda (sin objeto huérfano)", async () => {
    asUser(A.userId);
    const f = await realFile();
    supa.error = { message: "boom" };
    const r = await (await import("@/lib/files")).deletePatientFile(f.id);
    expect(r).toMatchObject({ ok: false });
    expect(await db.patientFile.count({ where: { id: f.id } })).toBe(1);
    supa.error = null;
    expect(await (await import("@/lib/files")).deletePatientFile(f.id)).toEqual({ ok: true, data: undefined });
    expect(supa.calls.filter((c) => c.op === "remove").at(-1)).toEqual({
      op: "remove",
      bucket: "patient-files",
      args: [[f.storageKey]],
    });
    expect(await db.patientFile.count({ where: { id: f.id } })).toBe(0);
  });

  it("upload: { error } → no crea fila; ok → sube por admin bajo <tenant>/<paciente>/ y crea la fila", async () => {
    asUser(A.userId);
    const files = await import("@/lib/files");
    supa.error = { message: "boom" };
    expect(await files.uploadPatientFile(patientId, pdfForm("falla.pdf"))).toEqual({
      ok: false,
      error: "No pudimos subir el archivo.",
    });
    expect(await db.patientFile.count({ where: { patientId, name: "falla.pdf" } })).toBe(0);

    supa.error = null;
    supa.calls = [];
    const ok = await files.uploadPatientFile(patientId, pdfForm("ok.pdf"));
    expect(ok.ok).toBe(true);
    const row = await db.patientFile.findFirstOrThrow({ where: { patientId, name: "ok.pdf" } });
    expect(row.storageKey.startsWith(`${A.tenantId}/${patientId}/`)).toBe(true);
    expect(supa.calls).toEqual([
      { op: "upload", bucket: "patient-files", args: [row.storageKey, { contentType: "application/pdf", upsert: false }] },
    ]);
  });

  it("sin admin client → modo stub (no hay fallback al JWT del usuario)", async () => {
    asUser(A.userId);
    supa.enabled = false;
    const files = await import("@/lib/files");
    expect((await files.uploadPatientFile(patientId, pdfForm("stub.pdf"))).ok).toBe(true);
    const row = await db.patientFile.findFirstOrThrow({ where: { patientId, name: "stub.pdf" } });
    expect(row.storageKey.startsWith("stub:")).toBe(true);
    expect(await files.getDownloadUrl(row.id)).toEqual({ ok: false, error: "Storage no configurado en este entorno." });
  });
});
