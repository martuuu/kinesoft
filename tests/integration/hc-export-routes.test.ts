/**
 * [FC-2g] (T4, C-FC7, §24.6, Anexo C «FC-2e/2g») · Rutas de descarga del equipo:
 *   `GET /api/pacientes/[id]/fichas/[noteId]/[pdf|docx]` y `GET /api/pacientes/[id]/historia-clinica/pdf`.
 *
 * Corre los handlers REALES (sesión → soporte → rate limit → gate `canRead` → filas → loader de FC-2e → render real de
 * react-pdf/docx → audit) contra Postgres, con los dos roles (`npm run test:integration -- hc-export-routes` =
 * kinesoft_app con RLS; `:owner` = BYPASSRLS como prod, donde lo ajeno tiene que seguir afuera por el `tenantId` a mano).
 *
 * Se reemplaza solo lo que hace falta para poder fallar, y por defecto delega en el real:
 *   - `auditSecurityEvent`: para probar «audit caído → 503 sin bytes»;
 *   - `renderHcPdf`: para capturar el documento armado y, en los casos de tope (> 4 MB) y de 300 fichas, devolver
 *     bytes sintéticos sin pagar 7 s de render (el render en sí lo prueba FC-2e en `hc-renderers`).
 * Storage no está configurado en la integración (admin client null): los assets caen en la falla blanda.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { GET as getFicha } from "@/app/api/pacientes/[id]/fichas/[noteId]/[format]/route";
import { GET as getRecord } from "@/app/api/pacientes/[id]/historia-clinica/[format]/route";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";
import type { HcPrintableV1 } from "@/lib/hc-print-types";
import { startSupport } from "@/lib/platform-support";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { pdfPlainText } from "@/tests/helpers/pdf-text";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// El 401 real: en dev/test `.env.local` habilita el actor demo y `tryGetActor()` caería al consultorio demo (404) en
// vez de devolver null. `DEMO_ALLOWED` se lee al cargar `lib/session`: se apaga ANTES de los imports y solo en este
// archivo (mismo molde que `realtime-local-route.test.ts`). Así el «sin sesión» es el de prod.
const demo = vi.hoisted(() => {
  const prev = process.env.KINESOFT_ALLOW_DEMO_ACTOR;
  process.env.KINESOFT_ALLOW_DEMO_ACTOR = "0";
  return { prev };
});

const fx = vi.hoisted(() => ({
  auditFails: false,
  lastDoc: null as unknown,
  fakeBytes: null as null | (() => Uint8Array),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    auditSecurityEvent: async (p: Parameters<typeof real.auditSecurityEvent>[0]) => {
      if (fx.auditFails) throw new Error("audit caído (test)");
      return real.auditSecurityEvent(p);
    },
  };
});

vi.mock("@/lib/hc-pdf/render-internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/hc-pdf/render-internal")>();
  return {
    ...real,
    renderHcPdf: async (...args: Parameters<typeof real.renderHcPdf>) => {
      fx.lastDoc = args[0];
      return fx.fakeBytes ? fx.fakeBytes() : real.renderHcPdf(...args);
    },
  };
});

// Entrar «como soporte» pide el step-up del superadmin (2FA); acá solo importa la sesión de soporte resultante.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const SENTINEL = "Lumbalgia-FC2g";
const ACTIONS = ["clinicalNote.download", "clinicalRecord.download"];

describe.skipIf(!RUN)("[FC-2g] rutas de descarga del equipo", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let Other: EphemeralTenant;
  let S: EphemeralTenant;
  let pro: { userId: string; practitionerId: string };
  let basic: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let patientId: string;
  let siblingPatientId: string;
  let emptyPatientId: string;
  let otherPatientId: string;
  let root: string;
  let amendment: string;
  let voidedAmendment: string;
  let siblingNote: string;
  let otherNote: string;

  const ficha = (pid: string, nid: string, format: string) =>
    getFicha(new Request(`http://localhost:3000/api/pacientes/${pid}/fichas/${nid}/${format}`), {
      params: { id: pid, noteId: nid, format },
    });
  const record = (pid: string, format = "pdf") =>
    getRecord(new Request(`http://localhost:3000/api/pacientes/${pid}/historia-clinica/${format}`), { params: { id: pid, format } });
  const events = () =>
    db.auditEvent.findMany({
      where: { action: { in: ACTIONS }, tenantId: { in: [K.tenantId, Other.tenantId, S.tenantId] } },
      select: { action: true, actorId: true, tenantId: true, entity: true, entityId: true, payload: true, userAgent: true },
    });

  async function seedNote(
    t: EphemeralTenant,
    pid: string,
    author: { userId: string; practitionerId: string },
    o: { amendsNoteId?: string; body: string; title?: string | null; occurredAt?: Date; voided?: boolean },
  ): Promise<string> {
    const id = `fc2g-${uniqueSuffix()}`;
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: t.tenantId,
        patientId: pid,
        amendsNoteId: o.amendsNoteId ?? null,
        kind: o.amendsNoteId ? "EVOLUTION" : "FIRST_VISIT",
        title: o.title ?? null,
        body: o.body,
        occurredAt: o.occurredAt ?? new Date("2026-10-10T13:00:00Z"),
        authorUserId: author.userId,
        authorPractitionerId: author.practitionerId,
        authorName: "Kine FC-2g",
        idempotencyKey: randomUUID(),
      },
    });
    if (o.voided) {
      await db.clinicalNote.update({
        where: { id },
        data: { voidedAt: new Date(), voidedByUserId: author.userId, voidReason: "Cargada en el paciente equivocado" },
      });
    }
    return id;
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    pro = await addPractitioner(db, K, "PRACTITIONER");
    basic = await addPractitioner(db, K, "PRACTITIONER");
    assistant = await addPractitioner(db, K, "ASSISTANT");

    patientId = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId, firstName: "Juana", lastName: "Gómez" });
    root = await seedNote(K, patientId, pro, { body: `Dolor lumbar 6/10 ${SENTINEL}`, title: "Ingreso" });
    amendment = await seedNote(K, patientId, pro, { amendsNoteId: root, body: "Corrijo: EVA 5/10", occurredAt: new Date("2026-10-11T13:00:00Z") });
    voidedAmendment = await seedNote(K, patientId, pro, {
      amendsNoteId: root,
      body: "Enmienda equivocada",
      occurredAt: new Date("2026-10-12T13:00:00Z"),
      voided: true,
    });
    siblingPatientId = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });
    siblingNote = await seedNote(K, siblingPatientId, pro, { body: "De otro paciente FC-2g" });
    emptyPatientId = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId, firstName: "Sin", lastName: "Fichas" });
    otherPatientId = await addPatient(db, Other);
    otherNote = await seedNote(Other, otherPatientId, { userId: Other.userId, practitionerId: Other.practitionerId }, { body: "Ajena FC-2g" });
  }, 60_000);

  afterAll(async () => {
    if (demo.prev === undefined) delete process.env.KINESOFT_ALLOW_DEMO_ACTOR;
    else process.env.KINESOFT_ALLOW_DEMO_ACTOR = demo.prev;
    cookies().delete(SUPPORT_COOKIE);
    if (db) {
      await db.supportSession.updateMany({ where: { superadminId: S?.userId, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
      await db.auditEvent.deleteMany({ where: { action: { in: ACTIONS }, tenantId: { in: [K?.tenantId, Other?.tenantId, S?.tenantId].filter(Boolean) as string[] } } });
      for (const t of [K, Other, S]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    fx.auditFails = false;
    fx.lastDoc = null;
    fx.fakeBytes = null;
    __rateLimitInternals.reset();
    cookies().delete(SUPPORT_COOKIE);
    await db.auditEvent.deleteMany({ where: { action: { in: ACTIONS }, tenantId: { in: [K.tenantId, Other.tenantId, S.tenantId] } } });
  });

  afterEach(() => {
    asAnonymous();
  });

  function expectDownloadHeaders(res: Response, contentType: string, ext: string) {
    expect(res.headers.get("content-type")).toBe(contentType);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toMatch(new RegExp(`^Gómez Juana .*\\.${ext}$`));
  }

  it("PDF de la ficha: 200 con no-store, nosniff y attachment; raíz + enmiendas (la anulada marcada); audit { noteId, format }", async () => {
    asUser(pro.userId);
    const res = await ficha(patientId, root, "pdf");
    expect(res.status).toBe(200);
    expectDownloadHeaders(res, "application/pdf", "pdf");
    expect(decodeURIComponent(res.headers.get("content-disposition")!.split("UTF-8''")[1])).toBe(
      `Gómez Juana 2026-10-10 Ingreso [${root.slice(-6)}].pdf`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    const text = pdfPlainText(bytes);
    expect(text).toContain(SENTINEL);
    expect(text).toContain("Corrijo: EVA 5/10");
    expect(text).toContain("Enmienda equivocada");
    expect(text).not.toContain("De otro paciente FC-2g");
    const doc = fx.lastDoc as HcPrintableV1;
    expect(doc.meta.purpose).toBe("download");
    expect(doc.content.fichas).toHaveLength(1);
    expect(doc.content.fichas[0].amendments).toHaveLength(2);
    expect(doc.content.fichas[0].amendments[1].marks.voided).toMatchObject({ reason: "Cargada en el paciente equivocado" });

    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      action: "clinicalNote.download",
      actorId: pro.userId,
      tenantId: K.tenantId,
      entity: "Patient",
      entityId: patientId,
      payload: { noteId: root, format: "pdf" },
      userAgent: "vitest",
    });
    // Sin PHI en el evento.
    expect(JSON.stringify(ev[0].payload)).not.toContain(SENTINEL);
    void voidedAmendment; // sembrada para la marca de anulada de arriba
  });

  it("Word de la ficha: 200 con el MIME de .docx (zip) y audit { noteId, format: docx }", async () => {
    asUser(pro.userId);
    const res = await ficha(patientId, root, "docx");
    expect(res.status).toBe(200);
    expectDownloadHeaders(res, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: "clinicalNote.download", payload: { noteId: root, format: "docx" } });
  });

  it("audit caído → 503 sin bytes (ficha y HC completa) y sin evento", async () => {
    asUser(pro.userId);
    fx.auditFails = true;
    for (const res of [await ficha(patientId, root, "pdf"), await ficha(patientId, root, "docx"), await record(patientId)]) {
      expect(res.status).toBe(503);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await events()).toHaveLength(0);
  });

  it("ajeno, otra ficha en la URL, enmienda u otro consultorio → 404 sin evento", async () => {
    asUser(pro.userId);
    const cases: [string, string, string][] = [
      [patientId, siblingNote, "pdf"], // ficha de otro paciente con el id de este
      [siblingPatientId, root, "pdf"], // al revés
      [patientId, amendment, "pdf"], // una enmienda no es «la ficha»
      [patientId, otherNote, "pdf"], // nota de otro consultorio
      [otherPatientId, otherNote, "docx"], // paciente y nota de otro consultorio
      [patientId, "no-existe-fc2g", "pdf"],
      [patientId, root, "PDF"], // formato inválido
      [patientId, root, "html"],
      [patientId, "../x", "pdf"],
    ];
    for (const [pid, nid, f] of cases) {
      const res = await ficha(pid, nid, f);
      expect(res.status, `${pid}/${nid}/${f}`).toBe(404);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    expect((await record(otherPatientId)).status).toBe(404);
    expect((await record(patientId, "docx")).status).toBe(404); // la HC completa es solo PDF (FC-D31)
    expect(await events()).toHaveLength(0);
  });

  it("Secretaria y profesional sin acceso → 404; sin sesión 401; soporte 403; nada auditado", async () => {
    for (const who of [assistant.userId, basic.userId]) {
      asUser(who);
      expect((await ficha(patientId, root, "pdf")).status).toBe(404);
      expect((await record(patientId)).status).toBe(404);
    }
    asAnonymous();
    expect((await ficha(patientId, root, "pdf")).status).toBe(401);
    expect((await record(patientId)).status).toBe(401);

    asUser(S.userId);
    const s = await startSupport(K.tenantId, "Ayuda con descargas FC-2g");
    if (!s.ok) throw new Error(s.error);
    try {
      expect((await ficha(patientId, root, "pdf")).status).toBe(403);
      expect((await ficha(patientId, root, "docx")).status).toBe(403);
      expect((await record(patientId)).status).toBe(403);
    } finally {
      await db.supportSession.update({ where: { id: s.data.sessionId }, data: { endedAt: new Date(), endedReason: "test" } });
      cookies().delete(SUPPORT_COOKIE);
    }
    expect(await events()).toHaveLength(0);
  });

  it("HC completa: 200 PDF con todas las fichas del paciente y audit { format, count, truncated: false }", async () => {
    asUser(K.userId); // Titular clínico: también descarga
    const res = await record(patientId);
    expect(res.status).toBe(200);
    expectDownloadHeaders(res, "application/pdf", "pdf");
    expect(decodeURIComponent(res.headers.get("content-disposition")!.split("UTF-8''")[1])).toBe(
      `Gómez Juana Historia clínica [${patientId.slice(-6)}].pdf`,
    );
    const text = pdfPlainText(new Uint8Array(await res.arrayBuffer()));
    expect(text).toContain(SENTINEL);
    expect(text).not.toContain("De otro paciente FC-2g");
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      action: "clinicalRecord.download",
      actorId: K.userId,
      entity: "Patient",
      entityId: patientId,
      payload: { format: "pdf", count: 1, truncated: false },
    });
  });

  it("HC completa sin fichas: igual sale el PDF (membrete y paciente) y se audita count 0", async () => {
    asUser(pro.userId);
    fx.fakeBytes = () => new TextEncoder().encode("%PDF-1.7 fake");
    const res = await record(emptyPatientId);
    expect(res.status).toBe(200);
    expect((fx.lastDoc as HcPrintableV1).content.fichas).toEqual([]);
    expect((await events())[0]).toMatchObject({ payload: { format: "pdf", count: 0, truncated: false } });
  });

  it("HC completa con tope: las 300 más recientes y `truncated` en el audit y en el documento", async () => {
    const pid = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });
    const base = Date.UTC(2025, 0, 1, 13);
    await db.clinicalNote.createMany({
      data: Array.from({ length: 301 }, (_, i) => ({
        id: `fc2g-bulk-${uniqueSuffix()}-${i}`,
        tenantId: K.tenantId,
        patientId: pid,
        kind: "EVOLUTION" as const,
        body: `Sesión ${i}`,
        occurredAt: new Date(base + i * 86_400_000),
        authorUserId: pro.userId,
        authorPractitionerId: pro.practitionerId,
        authorName: "Kine FC-2g",
        idempotencyKey: randomUUID(),
      })),
    });
    asUser(pro.userId);
    fx.fakeBytes = () => new TextEncoder().encode("%PDF-1.7 fake");
    const res = await record(pid);
    expect(res.status).toBe(200);
    const doc = fx.lastDoc as HcPrintableV1;
    expect(doc.meta.truncated).toBe(true);
    expect(doc.content.fichas).toHaveLength(300);
    // Se cortó la MÁS VIEJA (Sesión 0): quedan 1..300, en orden cronológico.
    expect(doc.content.fichas[0].main.occurredAt).toBe(new Date(base + 86_400_000).toISOString());
    expect(doc.content.fichas[299].main.occurredAt).toBe(new Date(base + 300 * 86_400_000).toISOString());
    expect((await events())[0]).toMatchObject({ action: "clinicalRecord.download", payload: { format: "pdf", count: 300, truncated: true } });
  });

  it("PDF de más de 4 MB → 413 con «Usá Imprimir historia clínica» y sin audit", async () => {
    asUser(pro.userId);
    fx.fakeBytes = () => new Uint8Array(4 * 1024 * 1024 + 1);
    const res = await record(patientId);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe(HC_EXPORT_COPY.recordTooLarge);
    expect(HC_EXPORT_COPY.recordTooLarge).toContain("Usá Imprimir historia clínica");
    const r2 = await ficha(patientId, root, "pdf");
    expect(r2.status).toBe(413);
    expect(r2.headers.get("content-disposition")).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  it("rate limit por usuario: la 6.ª HC completa en 10 min → 429 con Retry-After", async () => {
    asUser(pro.userId);
    fx.fakeBytes = () => new TextEncoder().encode("%PDF-1.7 fake");
    for (let i = 0; i < 5; i++) expect((await record(patientId)).status).toBe(200);
    const res = await record(patientId);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await events()).toHaveLength(5);
  });
});
