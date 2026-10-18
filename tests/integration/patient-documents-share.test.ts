/**
 * FC-2d (T4, C-FC6, brief §24.5 y Anexo C «FC-2d») · compartir una ficha con el paciente y dejar de compartirla.
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- patient-documents` = kinesoft_app con
 * RLS; `:owner` = BYPASSRLS como prod): `shareClinicalNoteWithPatient`, `revokePatientDocument`, el gate de
 * evoluciones, el loader y el armado del contenido imprimible (FC-2e), el trigger de M14 y `sendEmail` hasta la red.
 *
 * Se mockea solo lo externo:
 *   - Storage (`lib/storage-internal`): un bucket en memoria que registra subidas y borrados. Es la red de Supabase;
 *     en la integración el admin client ya es null, así que sin este fake no se podría afirmar la clave ni el borrado.
 *   - El render del PDF (`renderHcPdf`) y la carga de logo/firmas (`loadHcAssets`): el render lo prueba FC-2e (y la
 *     corrida cruzada del integrador); acá importa qué recibe, qué se hace con sus bytes y poder fallar o tardar. El
 *     fake del render es además el «gancho» entre la tx1 y la tx2 (editar o anular la ficha en el medio).
 *   - El despacho del mail (`__setEmailTransportForTests`): la plantilla, el destinatario y el log siguen siendo reales.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { Prisma, PrismaClient } from "@prisma/client";
import { revokePatientDocument, shareClinicalNoteWithPatient } from "@/lib/patient-documents";
import { voidClinicalNote } from "@/lib/clinical-notes";
import { PATIENT_DOCUMENT_COPY } from "@/lib/patient-documents-types";
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const fx = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, Uint8Array>(),
  uploads: [] as { bucket: string; key: string; contentType: string }[],
  removed: [] as { bucket: string; key: string }[],
  uploadFails: false,
  renders: 0,
  lastDoc: null as unknown,
  renderHook: null as null | (() => Promise<void>),
  renderBytes: null as null | (() => Uint8Array),
  renderThrows: false,
  assetCalls: [] as unknown[],
}));

vi.mock("@/lib/storage-internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage-internal")>();
  return {
    ...real,
    isStorageConfigured: () => fx.configured,
    storageUpload: async (bucket: string, key: string, body: Uint8Array, contentType: string) => {
      if (!fx.configured) return { ok: false, reason: "unconfigured", message: "Storage no configurado." };
      if (fx.uploadFails) return { ok: false, reason: "storage", message: "caído" };
      // upsert: false como el real: una clave repetida es error.
      if (fx.objects.has(`${bucket}:${key}`)) return { ok: false, reason: "storage", message: "Duplicate" };
      fx.objects.set(`${bucket}:${key}`, body);
      fx.uploads.push({ bucket, key, contentType });
      return { ok: true, data: undefined };
    },
    storageRemove: async (bucket: string, keys: string[]) => {
      for (const key of keys) {
        fx.objects.delete(`${bucket}:${key}`);
        fx.removed.push({ bucket, key });
      }
      return { ok: true, data: undefined };
    },
    storageDownload: async (bucket: string, key: string) => {
      const b = fx.objects.get(`${bucket}:${key}`);
      return b ? { ok: true, data: b } : { ok: false, reason: "storage", message: "Object not found" };
    },
  };
});

vi.mock("@/lib/hc-pdf/render-internal", () => ({
  HC_PDF_MAX_BYTES: 4 * 1024 * 1024,
  renderHcPdf: async (doc: unknown) => {
    fx.renders++;
    fx.lastDoc = doc;
    if (fx.renderHook) await fx.renderHook();
    if (fx.renderThrows) throw new Error("react-pdf explotó");
    if (fx.renderBytes) return fx.renderBytes();
    return new TextEncoder().encode(`%PDF-1.7 fake ${randomUUID()}`);
  },
}));

vi.mock("@/lib/hc-assets-internal", () => ({
  loadHcAssets: async (p: unknown) => {
    fx.assetCalls.push(p);
    return { logo: null, signatures: {} };
  },
}));

// La sesión de soporte se abre con la action real; el step-up de 2FA se da por hecho (se prueba en two-factor.test.ts).
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const C = PATIENT_DOCUMENT_COPY;
/** Centinela clínico: si aparece en un mail o en un audit, se filtró contenido de la HC. */
const SENTINEL = "CENTINELA-LUMBALGIA-7731";

type Member = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("[FC-2d] compartir con el paciente", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let RO: EphemeralTenant;
  let S: EphemeralTenant;
  let P1: Member; // dueño del paciente (asignado), autor de las fichas
  let P2: Member; // profesional con share: también comparte (FC-D8)
  let P3: Member; // profesional básico: sin asignación ni share
  let ADM: Member;
  let SEC: { userId: string };
  let FAC: { userId: string };
  let tenantName = "";
  let mails: SendEmailInput[] = [];
  let transport: (i: SendEmailInput) => Promise<SendEmailResult> = async () => ({ ok: true, transport: "resend", providerId: "fake" });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    RO = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    S = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    P1 = await addPractitioner(db, A);
    P2 = await addPractitioner(db, A);
    P3 = await addPractitioner(db, A);
    ADM = await addPractitioner(db, A, "ADMIN");
    await db.membership.update({ where: { userId_tenantId: { userId: ADM.userId, tenantId: A.tenantId } }, data: { clinical: true } });
    SEC = await staff("ASSISTANT");
    FAC = await staff("BILLING");
    tenantName = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } })).name;
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      for (const t of [A, B, RO, S]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    fx.configured = true;
    fx.uploads = [];
    fx.removed = [];
    fx.uploadFails = false;
    fx.renders = 0;
    fx.lastDoc = null;
    fx.renderHook = null;
    fx.renderBytes = null;
    fx.renderThrows = false;
    fx.assetCalls = [];
    mails = [];
    transport = async () => ({ ok: true, transport: "resend", providerId: "fake" });
    __setEmailTransportForTests(async (i) => {
      mails.push(i);
      return transport(i);
    });
    revalidatePathSpy.mockClear();
  });

  afterEach(() => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    cookies().delete(SUPPORT_COOKIE);
  });

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  async function staff(role: "ASSISTANT" | "BILLING") {
    const userId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({ data: { userId, tenantId: A.tenantId, role, acceptedAt: new Date() } });
    return { userId };
  }

  /** Paciente de A asignado a P1 y compartido con P2. */
  async function patient(t: EphemeralTenant = A): Promise<string> {
    if (t !== A) return addPatient(db, t);
    const id = await addPatient(db, A, { assignedPractitionerId: P1.practitionerId });
    await db.patientShare.create({ data: { tenantId: A.tenantId, patientId: id, practitionerId: P2.practitionerId, sharedById: P1.userId } });
    return id;
  }

  /** Cuenta del portal vinculada (`Patient.userId`), con el email que la vinculó. */
  async function linkPortal(patientId: string): Promise<string> {
    const userId = `test-portal-${uniqueSuffix()}`;
    const email = `${userId}@paciente.test`;
    await db.userProfile.create({ data: { id: userId, email, fullName: "Paciente Portal" } });
    await db.patient.update({ where: { id: patientId }, data: { userId } });
    return email;
  }

  async function seedNote(
    t: EphemeralTenant,
    patientId: string,
    author: { userId: string; practitionerId: string },
    opts: { amendsNoteId?: string | null; voided?: boolean } = {},
  ): Promise<string> {
    const id = `fc2d-${uniqueSuffix()}`;
    const now = new Date();
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: t.tenantId,
        patientId,
        amendsNoteId: opts.amendsNoteId ?? null,
        kind: "FIRST_VISIT",
        title: opts.amendsNoteId ? null : `Ingreso ${SENTINEL}`,
        body: `Dolor lumbar 6/10 ${SENTINEL}`,
        occurredAt: now,
        authorUserId: author.userId,
        authorPractitionerId: author.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
        createdAt: now,
      },
    });
    if (opts.voided) {
      await db.clinicalNote.update({
        where: { id },
        data: { voidedAt: new Date(), voidedByUserId: author.userId, voidReason: "Paciente equivocado" },
      });
    }
    return id;
  }

  const docsOf = (noteId: string) => db.patientDocument.findMany({ where: { noteId }, orderBy: { createdAt: "asc" } });
  const sharesOf = (patientId: string) =>
    db.auditEvent.findMany({ where: { entity: "Patient", entityId: patientId, action: { startsWith: "patientDocument." } }, orderBy: { createdAt: "asc" } });

  function shareAs(user: string, noteId: string, over: Partial<{ idempotencyKey: string; notify: boolean }> = {}) {
    asUser(user);
    return shareClinicalNoteWithPatient({ noteId, idempotencyKey: over.idempotencyKey ?? randomUUID(), notify: over.notify ?? true });
  }

  /** Rechazo sin efectos: copy exacto, sin render, sin subida, sin documento ni audit. */
  async function expectRejectedClean(r: { ok: boolean; error?: string }, error: string, noteId: string, patientId: string) {
    expect(r).toMatchObject({ ok: false, error });
    expect(fx.renders).toBe(0);
    expect(fx.uploads).toEqual([]);
    expect(await docsOf(noteId)).toHaveLength(0);
    expect(await sharesOf(patientId)).toHaveLength(0);
    expect(mails).toEqual([]);
  }

  /** pid de la sesión bloqueada por `pid` (barrera determinista, sin sleeps a ciegas). */
  async function blockedBy(pid: number, timeoutMs = 15_000): Promise<number> {
    const t0 = Date.now();
    for (;;) {
      const rows = await db.$queryRaw<{ pid: number }[]>`
        SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))`;
      if (rows.length > 0) return rows[0].pid;
      if (Date.now() - t0 > timeoutMs) throw new Error(`nadie quedó bloqueado por ${pid}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Tx del owner que toma algo y lo retiene hasta `release()`. */
  function hold(take: (tx: Prisma.TransactionClient) => Promise<unknown>, client: PrismaClient) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: (pid: number) => void;
    const readyP = new Promise<number>((r) => (ready = r));
    const done = client.$transaction(
      async (tx) => {
        await take(tx);
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready(pid);
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return { ready: readyP, release, done };
  }

  const SHA = "a".repeat(64);
  /** Documento vivo sembrado por el owner (como si otro lo hubiera compartido antes). */
  function insertLiveDoc(tx: Prisma.TransactionClient | PrismaClient, t: EphemeralTenant, patientId: string, noteId: string, by: Member, key = randomUUID()) {
    const id = `fc2d-doc-${uniqueSuffix()}`;
    return tx.patientDocument
      .create({
        data: {
          id,
          tenantId: t.tenantId,
          patientId,
          noteId,
          noteRevision: 1,
          sourceDigest: SHA,
          title: "Ficha",
          occurredAt: new Date(),
          snapshot: { v: 1 },
          snapshotSha256: SHA,
          pdfStorageKey: `stub:${id}`,
          pdfSha256: SHA,
          pdfSizeBytes: 100,
          sharedByUserId: by.userId,
          sharedByPractitionerId: by.practitionerId,
          sharedAt: new Date(),
          idempotencyKey: key,
        },
      })
      .then(() => id);
  }

  // ── Camino feliz ────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] snapshot desde la base, clave `{tenant}/{patient}/{doc}.pdf`, audit en la tx", async () => {
    const pid = await patient();
    const email = await linkPortal(pid);
    const noteId = await seedNote(A, pid, P1);
    const amendId = await seedNote(A, pid, P1, { amendsNoteId: noteId });
    const r = await shareAs(P1.userId, noteId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ replayed: false, replacedDocumentId: null, patientPortal: "linked", delivery: { channel: "email", status: "sent" } });

    const [doc] = await docsOf(noteId);
    expect(doc).toMatchObject({
      id: r.data.document.id,
      tenantId: A.tenantId,
      patientId: pid,
      kind: "FICHA",
      noteId,
      noteRevision: 1,
      title: `Ingreso ${SENTINEL}`,
      snapshotVersion: 1,
      sharedByUserId: P1.userId,
      sharedByPractitionerId: P1.practitionerId,
      revokedAt: null,
      pdfStorageKey: `${A.tenantId}/${pid}/${doc.id}.pdf`,
    });
    // La clave es la DERIVADA (la que el portal re-deriva) y el PDF subido es el que quedó en la fila.
    expect(fx.uploads).toEqual([{ bucket: "patient-documents", key: `${A.tenantId}/${pid}/${doc.id}.pdf`, contentType: "application/pdf" }]);
    const bytes = fx.objects.get(`patient-documents:${doc.pdfStorageKey}`)!;
    const { createHash } = await import("node:crypto");
    expect(doc.pdfSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(doc.pdfSizeBytes).toBe(bytes.byteLength);
    expect(fx.removed).toEqual([]);

    // Snapshot = lo que se renderizó, armado desde la base (el cliente solo mandó el id): el cuerpo de la ficha y de
    // su enmienda, sin ids de nota ni claves de Storage.
    expect(doc.snapshot).toEqual(JSON.parse(JSON.stringify(fx.lastDoc)));
    const snap = JSON.stringify(doc.snapshot);
    expect(snap).toContain(`Dolor lumbar 6/10 ${SENTINEL}`);
    expect((doc.snapshot as { content: { fichas: { amendments: unknown[] }[] } }).content.fichas[0].amendments).toHaveLength(1);
    expect((doc.snapshot as { meta: { purpose: string } }).meta.purpose).toBe("shared");
    for (const forbidden of [noteId, amendId, "EVOLUTION", "FIRST_VISIT", "authorPractitionerId", "stub:", doc.pdfStorageKey]) {
      expect(snap).not.toContain(forbidden);
    }
    expect(r.data.document).toEqual({
      id: doc.id,
      noteId,
      noteRevision: 1,
      title: doc.title,
      sharedAt: doc.sharedAt.toISOString(),
      verificationCode: (doc.snapshot as { meta: { verificationCode: string } }).meta.verificationCode,
    });

    // sourceDigest = sha256(hcSourceVersion(raíz, TODAS sus enmiendas)) — lo que compara FC-2b.
    const { hcSourceVersion } = await import("@/lib/hc-print-model");
    const { sha256Hex } = await import("@/lib/hc-print-internal");
    expect(doc.sourceDigest).toBe(sha256Hex(hcSourceVersion({ revision: 1 }, [{ id: amendId, revision: 1, voided: false }])));

    const audits = await sharesOf(pid);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A.tenantId, actorId: P1.userId, action: "patientDocument.share", entity: "Patient", entityId: pid });
    expect(audits[0].payload).toMatchObject({ documentId: doc.id, noteId, noteRevision: 1, replacedDocumentId: null });
    expect(JSON.stringify(audits[0].payload)).not.toContain(SENTINEL);

    // Mail al email de la cuenta vinculada, sin centinela clínico, con el CTA a Documentos.
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: "portal_document", to: email, tenantId: A.tenantId, entity: "PatientDocument", entityId: doc.id });
    for (const part of [mails[0].subject, mails[0].html, mails[0].text]) {
      expect(part).not.toContain(SENTINEL);
      expect(part).not.toContain("Dolor");
      expect(part).not.toContain("Ingreso");
    }
    expect(mails[0].subject).toBe(`Tenés un documento nuevo de ${tenantName}`);
    expect(mails[0].text).toContain(`/portal/c/${A.slug}/documentos`);

    expect(revalidatePathSpy).toHaveBeenCalledWith(`/pacientes/${pid}`);
  });

  it("[FC-2d] lo comparte un profesional con share (FC-D8: cualquiera con escritura clínica)", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    const r = await shareAs(P2.userId, noteId, { notify: false });
    expect(r).toMatchObject({ ok: true, data: { patientPortal: "not-linked", delivery: null } });
    const [doc] = await docsOf(noteId);
    expect(doc).toMatchObject({ sharedByUserId: P2.userId, sharedByPractitionerId: P2.practitionerId });
    expect(mails).toEqual([]);
  });

  // ── Replay y reemplazo ──────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] replay: la misma clave devuelve el mismo documento sin render, sin subir ni mandar otro mail", async () => {
    const pid = await patient();
    await linkPortal(pid);
    const noteId = await seedNote(A, pid, P1);
    const key = randomUUID();
    const first = await shareAs(P1.userId, noteId, { idempotencyKey: key });
    expect(first.ok).toBe(true);
    fx.renders = 0;
    fx.uploads = [];
    mails = [];
    const again = await shareAs(P1.userId, noteId, { idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, data: { replayed: true, delivery: null, patientPortal: "linked" } });
    if (!first.ok || !again.ok) return;
    expect(again.data.document).toEqual(first.data.document);
    expect(fx.renders).toBe(0);
    expect(fx.uploads).toEqual([]);
    expect(mails).toEqual([]);
    expect(await docsOf(noteId)).toHaveLength(1);
    expect(await sharesOf(pid)).toHaveLength(1);

    // La misma clave de otra persona (o para otra ficha) → keyReused.
    const other = await seedNote(A, pid, P1);
    expect(await shareAs(P1.userId, other, { idempotencyKey: key })).toEqual({ ok: false, error: C.keyReused });
    expect(await shareAs(P2.userId, noteId, { idempotencyKey: key })).toEqual({ ok: false, error: C.keyReused });
  });

  it("[FC-2d] reemplazo (uno solo vivo): el viejo queda REPLACED con la misma hora y el PDF viejo NO se borra; mail de «actualizó»", async () => {
    const pid = await patient();
    await linkPortal(pid);
    const noteId = await seedNote(A, pid, P1);
    const first = await shareAs(P1.userId, noteId);
    const second = await shareAs(P2.userId, noteId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.replacedDocumentId).toBe(first.data.document.id);

    const docs = await docsOf(noteId);
    expect(docs).toHaveLength(2);
    const [old, cur] = docs;
    expect(old).toMatchObject({ id: first.data.document.id, revokeReason: "REPLACED", revokedByUserId: P2.userId });
    expect(old.revokedAt!.getTime()).toBe(cur.sharedAt.getTime());
    expect(cur).toMatchObject({ id: second.data.document.id, revokedAt: null });
    expect(await db.patientDocument.count({ where: { noteId, revokedAt: null } })).toBe(1);
    // Los PDF reemplazados son copia de HC: no se borran.
    expect(fx.removed).toEqual([]);
    expect(fx.objects.has(`patient-documents:${old.pdfStorageKey}`)).toBe(true);
    expect(mails.map((m) => m.subject)).toEqual([`Tenés un documento nuevo de ${tenantName}`, `${tenantName} actualizó un documento en tu portal`]);
    const audits = await sharesOf(pid);
    expect(audits.map((a) => (a.payload as { replacedDocumentId: string | null }).replacedDocumentId)).toEqual([null, first.data.document.id]);

    // El replay del segundo envío sigue diciendo qué reemplazó.
    asUser(P2.userId);
    const replay = await shareClinicalNoteWithPatient({ noteId, idempotencyKey: (await db.patientDocument.findUniqueOrThrow({ where: { id: cur.id } })).idempotencyKey, notify: true });
    expect(replay).toMatchObject({ ok: true, data: { replayed: true, replacedDocumentId: first.data.document.id } });
  });

  // ── Rechazos sin subir ──────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] anulada o enmienda → rechazo sin subir", async () => {
    const pid = await patient();
    const voided = await seedNote(A, pid, P1, { voided: true });
    await expectRejectedClean(await shareAs(P1.userId, voided), C.voided, voided, pid);
    const root = await seedNote(A, pid, P1);
    const amend = await seedNote(A, pid, P1, { amendsNoteId: root });
    await expectRejectedClean(await shareAs(P1.userId, amend), C.notRoot, amend, pid);
  });

  it("[FC-2d] BASIC/ASSISTANT/BILLING/soporte/ADMIN → forbidden sin subir", async () => {
    for (const m of [P3, SEC, FAC, ADM]) {
      const pid = await patient();
      const noteId = await seedNote(A, pid, P1);
      await expectRejectedClean(await shareAs(m.userId, noteId), C.forbidden, noteId, pid);
    }
    // Soporte: sesión real de soporte (solo lectura y SUPPORT_CAPS, sin clínico).
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    __rateLimitInternals.reset();
    asUser(S.userId);
    const s = await startSupport(A.tenantId, "Ayuda con fichas del consultorio");
    if (!s.ok) throw new Error(s.error);
    mails = [];
    const r = await shareClinicalNoteWithPatient({ noteId, idempotencyKey: randomUUID(), notify: true });
    await expectRejectedClean(r, C.forbidden, noteId, pid);
    // Y tampoco revoca.
    const docId = await insertLiveDoc(db, A, pid, noteId, P1);
    expect(await revokePatientDocument({ documentId: docId })).toEqual({ ok: false, error: C.forbidden });
    await db.supportSession.update({ where: { id: s.data.sessionId }, data: { endedAt: new Date(), endedReason: "test" } });
    // Revocar como ASSISTANT tampoco.
    asUser(SEC.userId);
    expect(await revokePatientDocument({ documentId: docId })).toEqual({ ok: false, error: C.forbidden });
    expect(await db.patientDocument.count({ where: { id: docId, revokedAt: null } })).toBe(1);
  });

  it("[FC-2d] solo lectura → rechazo antes de Storage", async () => {
    const pid = await patient(RO);
    const noteId = await seedNote(RO, pid, { userId: RO.userId, practitionerId: RO.practitionerId });
    await db.tenant.update({ where: { id: RO.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    await expectRejectedClean(await shareAs(RO.userId, noteId), READ_ONLY_MESSAGE, noteId, pid);
  });

  it("[FC-2d] ficha de otro consultorio → notFound, sin subir", async () => {
    const pidB = await patient(B);
    const noteB = await seedNote(B, pidB, { userId: B.userId, practitionerId: B.practitionerId });
    await expectRejectedClean(await shareAs(P1.userId, noteB), C.notFound, noteB, pidB);
  });

  // ── Fallas del armado ───────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] render que falla → pdfFailed; PDF > 4 MB → tooLarge; Storage caído → storageFailed; nada queda", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    fx.renderThrows = true;
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.pdfFailed });
    fx.renderThrows = false;
    fx.renderBytes = () => new Uint8Array(4 * 1024 * 1024 + 1);
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.tooLarge });
    fx.renderBytes = null;
    fx.uploadFails = true;
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.storageFailed });
    expect(fx.uploads).toEqual([]);
    expect(await docsOf(noteId)).toHaveLength(0);
    expect(await sharesOf(pid)).toHaveLength(0);
  });

  it("[FC-2d] cambió entre armado y escritura → rechazo y objeto borrado", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    // Mientras se renderiza, otra sesión edita la ficha (el trigger sube la revisión).
    fx.renderHook = async () => {
      await db.clinicalNote.update({ where: { id: noteId }, data: { body: "Editada en el medio" } });
    };
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.changed });
    expect(fx.uploads).toHaveLength(1);
    expect(fx.removed).toEqual([{ bucket: "patient-documents", key: fx.uploads[0].key }]);
    expect(fx.objects.has(`patient-documents:${fx.uploads[0].key}`)).toBe(false);
    expect(await docsOf(noteId)).toHaveLength(0);

    // Una enmienda nueva en el medio también es «cambió».
    fx.uploads = [];
    fx.removed = [];
    fx.renderHook = async () => {
      await seedNote(A, pid, P1, { amendsNoteId: noteId });
    };
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.changed });
    expect(fx.removed.map((x) => x.key)).toEqual(fx.uploads.map((x) => x.key));

    // Anulada en el medio → voided y objeto borrado.
    fx.uploads = [];
    fx.removed = [];
    fx.renderHook = async () => {
      await db.clinicalNote.update({ where: { id: noteId }, data: { voidedAt: new Date(), voidedByUserId: P1.userId, voidReason: "Paciente equivocado" } });
    };
    expect(await shareAs(P1.userId, noteId)).toEqual({ ok: false, error: C.voided });
    expect(fx.removed.map((x) => x.key)).toEqual(fx.uploads.map((x) => x.key));
    expect(await docsOf(noteId)).toHaveLength(0);
    expect(await sharesOf(pid)).toHaveLength(0);
  });

  it("[FC-2d] 23505 → objeto borrado (doble envío concurrente → replay; otro compartió recién → raced)", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);

    // (a) Doble envío: la otra instancia con la MISMA clave terminó mientras esta renderizaba → 23505 de la clave → replay.
    const key = randomUUID();
    let twin = "";
    fx.renderHook = async () => {
      twin = await insertLiveDoc(db, A, pid, noteId, P1, key);
    };
    const a = await shareAs(P1.userId, noteId, { idempotencyKey: key });
    expect(a).toMatchObject({ ok: true, data: { replayed: true, document: { id: twin } } });
    expect(fx.uploads).toHaveLength(1);
    expect(fx.removed.map((x) => x.key)).toEqual([fx.uploads[0].key]);
    expect((await docsOf(noteId)).map((d) => [d.id, d.revokedAt])).toEqual([[twin, null]]);

    // (b) Otra persona comparte en paralelo: su INSERT queda sin commitear cuando el nuestro llega al parcial
    // «uno vivo por ficha» → esperamos su commit → 23505 → raced, y nuestro objeto se borra.
    fx.renderHook = null;
    fx.uploads = [];
    fx.removed = [];
    const c2 = ownerClient();
    try {
      let otherDoc = "";
      const h = hold(async (tx) => {
        // Primero revoca el vivo (como haría su compartir), después inserta el suyo.
        await tx.patientDocument.updateMany({
          where: { noteId, revokedAt: null },
          data: { revokedAt: new Date(), revokedByUserId: P2.userId, revokeReason: "REPLACED" },
        });
        otherDoc = await insertLiveDoc(tx, A, pid, noteId, P2);
      }, c2);
      const holder = await h.ready;
      const p = shareAs(P1.userId, noteId);
      await blockedBy(holder);
      h.release();
      await h.done;
      expect(await p).toEqual({ ok: false, error: C.raced });
      expect(fx.removed.map((x) => x.key)).toEqual(fx.uploads.map((x) => x.key));
      expect(fx.uploads).toHaveLength(1);
      const live = await db.patientDocument.findMany({ where: { noteId, revokedAt: null }, select: { id: true } });
      expect(live).toEqual([{ id: otherDoc }]);
    } finally {
      await c2.$disconnect();
    }
  });

  // ── Mail ────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] mail sin centinela; sin portal → `no-portal-user`; Resend caído → compartido igual", async () => {
    // Sin portal: compartido y la UI ofrecerá invitar; el mail NO va a `Patient.email`.
    const pid = await patient();
    await db.patient.update({ where: { id: pid }, data: { email: `familiar-${uniqueSuffix()}@test.local` } });
    const noteId = await seedNote(A, pid, P1);
    const r1 = await shareAs(P1.userId, noteId);
    expect(r1).toMatchObject({ ok: true, data: { patientPortal: "not-linked", delivery: { channel: "email", status: "no-portal-user" } } });
    expect(mails).toEqual([]);

    // Resend caído (500): se comparte igual y el resultado dice `failed`.
    const pid2 = await patient();
    await linkPortal(pid2);
    const note2 = await seedNote(A, pid2, P1);
    transport = async () => ({ ok: false, transport: "resend", skipped: false, reason: "provider_error", status: 500 });
    const r2 = await shareAs(P1.userId, note2);
    expect(r2).toMatchObject({ ok: true, data: { patientPortal: "linked", delivery: { channel: "email", status: "failed" } } });
    expect(await db.patientDocument.count({ where: { noteId: note2, revokedAt: null } })).toBe(1);
    for (const m of mails) for (const part of [m.subject, m.html, m.text]) expect(part).not.toContain(SENTINEL);

    // El transporte que TIRA tampoco rompe la action.
    const note3 = await seedNote(A, pid2, P1);
    transport = async () => {
      throw new Error("red caída");
    };
    expect(await shareAs(P1.userId, note3)).toMatchObject({ ok: true, data: { delivery: { status: "failed" } } });
    expect(await db.patientDocument.count({ where: { noteId: note3, revokedAt: null } })).toBe(1);
  });

  it("[FC-2d] aviso lento: a los 5 s responde `failed` y la action no queda colgada", async () => {
    const pid = await patient();
    await linkPortal(pid);
    const noteId = await seedNote(A, pid, P1);
    transport = () => new Promise(() => {}); // Resend que nunca responde
    const t0 = Date.now();
    const r = await shareAs(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { delivery: { channel: "email", status: "failed" } } });
    expect(Date.now() - t0).toBeLessThan(9_000);
    expect(await db.patientDocument.count({ where: { noteId, revokedAt: null } })).toBe(1);
  }, 20_000);

  it("[FC-2d] sin Storage configurado (dev): `stub:<id>` sin subir nada", async () => {
    fx.configured = false;
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    const r = await shareAs(P1.userId, noteId, { notify: false });
    expect(r.ok).toBe(true);
    const [doc] = await docsOf(noteId);
    expect(doc.pdfStorageKey).toBe(`stub:${doc.id}`);
    expect(fx.uploads).toEqual([]);
  });

  // ── Revocar ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2d] revocar MANUAL idempotente", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    const s = await shareAs(P1.userId, noteId, { notify: false });
    if (!s.ok) throw new Error(s.error);
    const id = s.data.document.id;

    asUser(P2.userId);
    const r1 = await revokePatientDocument({ documentId: id });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const row = await db.patientDocument.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ revokeReason: "MANUAL", revokedByUserId: P2.userId });
    expect(r1.data).toEqual({ documentId: id, revokedAt: row.revokedAt!.toISOString() });

    // Segunda vez (doble click u otra persona): ok con la misma fecha, sin audit nuevo.
    asUser(P1.userId);
    expect(await revokePatientDocument({ documentId: id })).toEqual({ ok: true, data: r1.data });
    const revokes = (await sharesOf(pid)).filter((a) => a.action === "patientDocument.revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toMatchObject({ actorId: P2.userId, entity: "Patient", entityId: pid });
    expect(revokes[0].payload).toMatchObject({ documentId: id, reason: "MANUAL" });
    expect(fx.removed).toEqual([]); // revocar no borra el PDF

    // De otro consultorio / inexistente → docNotFound; profesional básico → forbidden.
    asUser(B.userId);
    expect(await revokePatientDocument({ documentId: id })).toEqual({ ok: false, error: C.docNotFound });
    const s2 = await shareAs(P1.userId, await seedNote(A, pid, P1), { notify: false });
    if (!s2.ok) throw new Error(s2.error);
    asUser(P3.userId);
    expect(await revokePatientDocument({ documentId: s2.data.document.id })).toEqual({ ok: false, error: C.forbidden });
    expect(await db.patientDocument.count({ where: { id: s2.data.document.id, revokedAt: null } })).toBe(1);
  });

  // ── Concurrencia: compartir ∥ anular ────────────────────────────────────────────────────────────────────────

  it("[FC-2d] compartir ∥ anular con dos conexiones: sin deadlock (nota → documentos) y nunca una anulada con documento vivo", async () => {
    const pid = await patient();
    const noteId = await seedNote(A, pid, P1);
    const live = await insertLiveDoc(db, A, pid, noteId, P1);
    const c3 = ownerClient();
    try {
      // Un tercero retiene el documento vivo: compartir (ya con la NOTA en FOR SHARE) queda esperando para revocarlo.
      const h = hold((tx) => tx.$queryRaw`SELECT 1 FROM "PatientDocument" WHERE id = ${live} FOR UPDATE`, c3);
      const holder = await h.ready;
      asUser(P1.userId);
      const shareP = shareClinicalNoteWithPatient({ noteId, idempotencyKey: randomUUID(), notify: false });
      const sharer = await blockedBy(holder);
      // Anular (mismo autor, misma sesión de test) choca con el FOR SHARE de compartir sobre la nota y espera.
      // Si compartir hubiera tocado documentos antes que la nota, acá se armaba el ciclo y Postgres tiraba 40P01.
      const voidP = voidClinicalNote({ noteId, expectedRevision: 1, reason: "Paciente equivocado" });
      await blockedBy(sharer);
      h.release();
      await h.done;
      const [shared, voided] = await Promise.all([shareP, voidP]);
      expect(shared).toMatchObject({ ok: true, data: { replacedDocumentId: live } });
      expect(voided.ok).toBe(true);
      if (!shared.ok) return;
      const docs = await db.$queryRaw<{ id: string; reason: string | null }[]>`
        SELECT id, "revokeReason"::text AS reason FROM "PatientDocument" WHERE "noteId" = ${noteId}`;
      expect(Object.fromEntries(docs.map((d) => [d.id, d.reason]))).toEqual({ [live]: "REPLACED", [shared.data.document.id]: "NOTE_VOIDED" });
    } finally {
      await c3.$disconnect();
    }
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "PatientDocument" d JOIN "ClinicalNote" c ON c.id = d."noteId"
      WHERE d."tenantId" = ${A.tenantId} AND d."revokedAt" IS NULL AND c."voidedAt" IS NOT NULL`;
    expect(n).toBe(0);
  }, 30_000);
});
