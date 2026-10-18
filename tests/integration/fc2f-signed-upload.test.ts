/**
 * T4 FC-2f · subida firmada de archivos del paciente (C-FC10; brief §24.8, Anexo C «FC-2f»).
 *
 * Red mockeada (C14): solo el admin client de Supabase y el fetch de la URL firmada (`tests/helpers/storage-fake.ts`).
 * Corren de verdad `requestPatientFileUpload`, `confirmPatientFileUpload` y `uploadPatientFile` de `lib/files.ts`, el
 * token, el sniff y `lib/storage-internal.ts`, contra Postgres con el `getActor()` real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { addPatient, addPractitioner, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { storageFake } from "@/tests/helpers/storage-fake";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});

const RUN = process.env.INTEGRATION === "1";
const BUCKET = "patient-files";
const enc = (s: string) => new TextEncoder().encode(s);
const pdfBytes = (n = 2048) => {
  const b = new Uint8Array(n).fill(0x20);
  b.set(enc("%PDF-1.7\n"));
  return b;
};

describe.skipIf(!RUN)("[FC-2f] subida firmada de archivos del paciente", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let patA: string;
  let patB: string;
  let otherUser: { userId: string; practitionerId: string };
  const prevSwitch = process.env.PATIENT_FILES_SIGNED_UPLOAD;

  const files = () => import("@/lib/files");

  async function request(over: Partial<{ patientId: string; fileName: string; mime: string; sizeBytes: number }> = {}) {
    const { requestPatientFileUpload } = await files();
    return requestPatientFileUpload({
      patientId: patA,
      fileName: "Resonancia rodilla.pdf",
      mime: "application/pdf",
      sizeBytes: 2048,
      category: "REPORT",
      ...over,
    });
  }

  async function signed(over: Parameters<typeof request>[0] = {}) {
    const r = await request(over);
    if (!r.ok || r.data.mode !== "signed") throw new Error(`ticket inesperado: ${JSON.stringify(r)}`);
    return r.data;
  }

  const pendingKeys = () => storageFake.keys(BUCKET).filter((k) => k.startsWith("pending/"));

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    patA = await addPatient(db, A);
    patB = await addPatient(db, B);
    otherUser = await addPractitioner(db, A, "OWNER");
    storageFake.installFetch();
  });

  afterAll(async () => {
    storageFake.uninstallFetch();
    if (prevSwitch === undefined) delete process.env.PATIENT_FILES_SIGNED_UPLOAD;
    else process.env.PATIENT_FILES_SIGNED_UPLOAD = prevSwitch;
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    storageFake.reset();
    delete process.env.PATIENT_FILES_SIGNED_UPLOAD;
  });

  it("[FC-2f] tope y MIME se chequean ANTES de firmar (sin tocar Storage)", async () => {
    asUser(A.userId);
    expect(await request({ sizeBytes: 25 * 1024 * 1024 + 1 })).toEqual({ ok: false, error: "El archivo no puede superar 25 MB." });
    expect(await request({ mime: "text/html" })).toEqual({ ok: false, error: "Tipo de archivo no permitido." });
    expect(await request({ mime: "image/svg+xml" })).toEqual({ ok: false, error: "Tipo de archivo no permitido." });
    expect(await request({ sizeBytes: 0 })).toMatchObject({ ok: false });
    expect(await request({ patientId: patB })).toEqual({ ok: false, error: "Paciente no encontrado." });
    expect(storageFake.calls).toEqual([]);
  });

  it("[FC-2f] firma un PUT a pending/{tenant}/{fileId} y devuelve token + vencimiento de 15 min", async () => {
    asUser(A.userId);
    const before = Date.now();
    const t = await signed();
    expect(storageFake.calls).toHaveLength(1);
    const [call] = storageFake.calls;
    expect(call.op).toBe("createSignedUploadUrl");
    expect(call.bucket).toBe(BUCKET);
    expect(call.args[0]).toMatch(new RegExp(`^pending/${A.tenantId}/[0-9a-f]{24}$`));
    const exp = Date.parse(t.expiresAt);
    expect(exp - before).toBeGreaterThanOrEqual(900_000 - 1000);
    expect(exp - before).toBeLessThanOrEqual(900_000 + 5000);
    expect(t.confirmToken.length).toBeLessThanOrEqual(2048);
  });

  it("[FC-2f] interruptor PATIENT_FILES_SIGNED_UPLOAD=0 → { mode: \"stub\" } (vuelta al camino ≤4 MB)", async () => {
    asUser(A.userId);
    process.env.PATIENT_FILES_SIGNED_UPLOAD = "0";
    expect(await request()).toEqual({ ok: true, data: { mode: "stub" } });
    expect(storageFake.calls).toEqual([]);
  });

  it("[FC-2f] confirm OK: move a la clave final + fila con el id del token; doble confirm → replay", async () => {
    asUser(A.userId);
    const t = await signed({ sizeBytes: 4096 });
    storageFake.clientPut(t.uploadUrl, pdfBytes(4096), "application/pdf");
    const { confirmPatientFileUpload } = await files();
    const r = await confirmPatientFileUpload({ confirmToken: t.confirmToken, description: "  RM de rodilla  " });
    expect(r).toMatchObject({ ok: true, data: { replayed: false } });
    const id = (r as { data: { id: string } }).data.id;
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    const row = await db.patientFile.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      tenantId: A.tenantId,
      patientId: patA,
      uploaderId: A.userId,
      name: "Resonancia rodilla.pdf",
      mime: "application/pdf",
      sizeBytes: 4096,
      category: "REPORT",
      description: "RM de rodilla",
      storageKey: `${A.tenantId}/${patA}/${id}.pdf`,
    });
    expect(pendingKeys()).toEqual([]);
    expect(storageFake.get(BUCKET, row.storageKey)?.bytes.length).toBe(4096);
    // La cabeza se leyó con Range 0-63 y nada más.
    const fetched = storageFake.calls.find((c) => c.op === "fetch");
    expect(new Headers(fetched?.args[1] as HeadersInit).get("range")).toBe("bytes=0-63");

    storageFake.calls = [];
    const again = await confirmPatientFileUpload({ confirmToken: t.confirmToken });
    expect(again).toEqual({ ok: true, data: { id, replayed: true } });
    expect(storageFake.calls).toEqual([]);
    expect(await db.patientFile.count({ where: { id } })).toBe(1);
  });

  it.each([
    ["tamaño distinto al declarado", pdfBytes(1000), "application/pdf", "El archivo que llegó no coincide con el que elegiste. Volvé a subirlo."],
    ["vacío", new Uint8Array(0), "application/pdf", "El archivo llegó vacío. Volvé a subirlo."],
    ["magic bytes de HTML con type PDF", (() => { const b = new Uint8Array(2048).fill(0x20); b.set(enc("<!doctype html><script>")); return b; })(), "application/pdf", "El archivo no es lo que dice ser."],
    ["Content-Type del PUT distinto al token", pdfBytes(2048), "text/html", "El archivo que llegó no coincide con el que elegiste. Volvé a subirlo."],
  ])("[FC-2f] %s → objeto borrado y sin fila", async (_n, body, contentType, error) => {
    asUser(A.userId);
    const t = await signed({ sizeBytes: 2048 });
    storageFake.clientPut(t.uploadUrl, body, contentType);
    const { confirmPatientFileUpload } = await files();
    const before = await db.patientFile.count({ where: { patientId: patA } });
    expect(await confirmPatientFileUpload({ confirmToken: t.confirmToken })).toEqual({ ok: false, error });
    expect(storageFake.keys(BUCKET)).toEqual([]);
    expect(await db.patientFile.count({ where: { patientId: patA } })).toBe(before);
  });

  it("[FC-2f] el move falla → objeto pendiente borrado y sin fila", async () => {
    asUser(A.userId);
    const t = await signed();
    storageFake.clientPut(t.uploadUrl, pdfBytes(), "application/pdf");
    storageFake.failOps.add("move");
    const { confirmPatientFileUpload } = await files();
    const before = await db.patientFile.count({ where: { patientId: patA } });
    expect(await confirmPatientFileUpload({ confirmToken: t.confirmToken })).toEqual({
      ok: false,
      error: "No pudimos guardar el archivo. Probá de nuevo.",
    });
    expect(storageFake.keys(BUCKET)).toEqual([]);
    expect(await db.patientFile.count({ where: { patientId: patA } })).toBe(before);
  });

  it("[FC-2f] confirm sin haber subido nada → «no encontramos», sin fila", async () => {
    asUser(A.userId);
    const t = await signed();
    const { confirmPatientFileUpload } = await files();
    expect(await confirmPatientFileUpload({ confirmToken: t.confirmToken })).toEqual({
      ok: false,
      error: "No encontramos el archivo subido. Volvé a subirlo.",
    });
  });

  it("[FC-2f] token adulterado, vencido, de otro usuario o de otro consultorio → rechazo SIN Storage", async () => {
    asUser(A.userId);
    const t = await signed();
    storageFake.clientPut(t.uploadUrl, pdfBytes(), "application/pdf");
    const { confirmPatientFileUpload } = await files();
    const { makePatientFileUploadToken, readPatientFileUploadToken } = await import("@/lib/patient-file-upload-token");
    const claims = readPatientFileUploadToken(t.confirmToken)!;
    const { exp: _exp, ...base } = claims;
    void _exp;
    const expired = makePatientFileUploadToken(base, Date.now() - 16 * 60_000);
    const [payload, mac] = t.confirmToken.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), s: 1 }),
    ).toString("base64url");
    const otherTenant = makePatientFileUploadToken({ ...base, tenantId: B.tenantId, patientId: patB });
    storageFake.calls = [];

    const EXPIRED = { ok: false, error: "La subida venció o no es válida. Volvé a subir el archivo." };
    expect(await confirmPatientFileUpload({ confirmToken: `${forgedPayload}.${mac}` })).toEqual(EXPIRED);
    expect(await confirmPatientFileUpload({ confirmToken: expired })).toEqual(EXPIRED);
    expect(await confirmPatientFileUpload({ confirmToken: otherTenant })).toEqual(EXPIRED);
    expect(await confirmPatientFileUpload({ confirmToken: "" })).toEqual(EXPIRED);
    asUser(otherUser.userId);
    expect(await confirmPatientFileUpload({ confirmToken: t.confirmToken })).toEqual(EXPIRED);
    // Un usuario de B con un token emitido para B (mismo usuario, mismo tenant) pero el id de A como paciente: el
    // gate de acceso lo frena (tampoco hay fila) — el token por sí solo no abre pacientes ajenos.
    asUser(B.userId);
    const crossPatient = makePatientFileUploadToken({ ...base, tenantId: B.tenantId, userId: B.userId });
    expect(await confirmPatientFileUpload({ confirmToken: crossPatient })).toEqual({ ok: false, error: "Paciente no encontrado." });
    expect(storageFake.calls.filter((c) => c.op !== "remove")).toEqual([]);
    // El objeto de A sigue ahí (lo pendiente de B es otra clave): nadie borró a ciegas.
    expect(pendingKeys()).toHaveLength(1);
  });

  it("[FC-2f] un token de invitación al portal no valida como token de subida", async () => {
    asUser(A.userId);
    const { makePortalInviteToken } = await import("@/lib/portal-invite-token");
    const invite = makePortalInviteToken({ patientId: patA, tenantId: A.tenantId, email: "x@y.com" });
    const { confirmPatientFileUpload } = await files();
    expect(await confirmPatientFileUpload({ confirmToken: invite })).toEqual({
      ok: false,
      error: "La subida venció o no es válida. Volvé a subir el archivo.",
    });
    expect(storageFake.calls).toEqual([]);
  });

  it("[FC-2f] camino viejo (≤4 MB): un HTML con type PDF se rechaza ANTES de subir", async () => {
    asUser(A.userId);
    const fd = new FormData();
    fd.set("file", new File([enc("<html><script>alert(1)</script></html>")], "estudio.pdf", { type: "application/pdf" }));
    fd.set("category", "REPORT");
    const { uploadPatientFile } = await files();
    expect(await uploadPatientFile(patA, fd)).toEqual({ ok: false, error: "El archivo no es lo que dice ser." });
    expect(storageFake.calls).toEqual([]);
    const ok = new FormData();
    ok.set("file", new File([pdfBytes(100)], "ok.pdf", { type: "application/pdf" }));
    expect(await uploadPatientFile(patA, ok)).toMatchObject({ ok: true });
    expect(storageFake.calls.map((c) => c.op)).toEqual(["upload"]);
  });

  it("[FC-2f] sweep de pending/: borra lo de más de 24 h y deja lo reciente", async () => {
    const { storageSweepPending } = await import("@/lib/storage-internal");
    storageFake.put(BUCKET, `pending/${A.tenantId}/aaaaaaaaaaaaaaaaaaaaaaaa`, pdfBytes(10), "application/pdf");
    storageFake.put(BUCKET, `pending/${A.tenantId}/bbbbbbbbbbbbbbbbbbbbbbbb`, pdfBytes(10), "application/pdf");
    storageFake.put(BUCKET, `${A.tenantId}/${patA}/final.pdf`, pdfBytes(10), "application/pdf");
    storageFake.get(BUCKET, `pending/${A.tenantId}/aaaaaaaaaaaaaaaaaaaaaaaa`)!.createdAt = new Date(Date.now() - 25 * 3600_000);
    const r = await storageSweepPending(BUCKET, 24 * 3600_000);
    expect(r).toEqual({ ok: true, data: { removed: 1, errors: 0 } });
    expect(storageFake.keys(BUCKET).sort()).toEqual(
      [`${A.tenantId}/${patA}/final.pdf`, `pending/${A.tenantId}/bbbbbbbbbbbbbbbbbbbbbbbb`].sort(),
    );
  });
});
