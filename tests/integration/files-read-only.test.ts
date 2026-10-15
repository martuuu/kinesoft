/**
 * BO-Z (A1) · `lib/files.ts` en solo lectura.
 *
 * El bug: `deletePatientFile` borraba el objeto de Storage (service role, fuera de la tx) y después la tx del
 * `deleteMany` fallaba por read-only → la fila quedaba apuntando a un estudio ya borrado (pérdida de HC). Con
 * `uploadPatientFile` pasaba lo simétrico: subía al bucket y recién la tx fallaba. Ahora las dos cortan con
 * `writableError` antes de tocar Storage.
 *
 * Red mockeada (C14): solo el admin client de Supabase; se ejecutan los símbolos reales de `lib/files.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { addPatient, createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";

const RUN = process.env.INTEGRATION === "1";

const supa = vi.hoisted(() => ({ calls: [] as { op: string; args: unknown[] }[] }));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async (key: string) => {
          supa.calls.push({ op: "upload", args: [key] });
          return { data: { path: key }, error: null };
        },
        createSignedUrl: async (key: string) => {
          supa.calls.push({ op: "sign", args: [key] });
          return { data: { signedUrl: `https://signed.test/${key}` }, error: null };
        },
        remove: async (keys: string[]) => {
          supa.calls.push({ op: "remove", args: [keys] });
          return { data: [], error: null };
        },
      }),
    },
  }),
}));

function pdfForm(name: string) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" }));
  fd.set("category", "REPORT");
  return fd;
}

describe.skipIf(!RUN)("[BO-Z] A1 · archivos del paciente en solo lectura", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let patientId: string;
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    patientId = await addPatient(db, A);
    // Suscripción cancelada → `read_only` con el modo efectivo `enforce`.
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
  });

  afterAll(async () => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    await A?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    supa.calls = [];
  });

  it("[BO-Z] enforce + read_only: deletePatientFile devuelve el copy SIN borrar el objeto de Storage ni la fila", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    asUser(A.userId);
    const f = await db.patientFile.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        name: "rx.pdf",
        mime: "application/pdf",
        sizeBytes: 4,
        storageKey: `${A.tenantId}/${patientId}/${uniqueSuffix()}.pdf`,
        category: "REPORT",
      },
    });
    const r = await (await import("@/lib/files")).deletePatientFile(f.id);
    expect(r).toEqual({ ok: false, error: READ_ONLY_MESSAGE });
    expect(supa.calls).toEqual([]);
    expect(await db.patientFile.count({ where: { id: f.id } })).toBe(1);
  });

  it("[BO-Z] enforce + read_only: uploadPatientFile devuelve el copy SIN subir nada al bucket", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    asUser(A.userId);
    const r = await (await import("@/lib/files")).uploadPatientFile(patientId, pdfForm("ro.pdf"));
    expect(r).toEqual({ ok: false, error: READ_ONLY_MESSAGE });
    expect(supa.calls).toEqual([]);
    expect(await db.patientFile.count({ where: { patientId, name: "ro.pdf" } })).toBe(0);
  });

  it("banner (default): el mismo consultorio sigue pudiendo subir (el corte es solo con enforce)", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    asUser(A.userId);
    const r = await (await import("@/lib/files")).uploadPatientFile(patientId, pdfForm("ok.pdf"));
    expect(r).toMatchObject({ ok: true });
    expect(supa.calls.map((c) => c.op)).toEqual(["upload"]);
  });
});
