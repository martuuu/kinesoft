/**
 * T4-Y (T5a, decisión de Martin 22-oct: «Estaría bueno que se le avise al paciente que la ficha fue modificada y que
 * debe solicitarla nuevamente») · al anular una ficha compartida (la raíz, que revoca por el trigger de M14, o una
 * enmienda, que revoca la raíz en la action, T4Z-M1) se le manda al paciente el mail `portal_document_revoked`.
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- patient-documents` = kinesoft_app con
 * RLS; `:owner` = BYPASSRLS como prod): `voidClinicalNote`, el trigger de M14, `deliverPatientDocumentRevoked` y
 * `sendEmail` hasta la red. Se mockea solo el despacho del mail (`__setEmailTransportForTests`): la plantilla, el
 * destinatario y el log siguen siendo reales. El documento compartido se siembra directo (como `insertLiveDoc` del test
 * de compartir): acá no importa el PDF sino qué pasa al anular.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { voidClinicalNote } from "@/lib/clinical-notes";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals, rateLimit } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
/** Centinela clínico: si aparece en el mail, se filtró contenido de la HC (título, cuerpo o motivo de anulación). */
const SENTINEL = "CENTINELA-LUMBALGIA-7731";
const SHA = "a".repeat(64);

type Member = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("[T4-Y] aviso al paciente cuando anular revoca un documento compartido", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let P1: Member;
  let tenantName = "";
  let mails: SendEmailInput[] = [];
  let transport: (i: SendEmailInput) => Promise<SendEmailResult> = async () => ({ ok: true, transport: "resend", providerId: "fake" });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P1 = await addPractitioner(db, A);
    tenantName = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } })).name;
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      await A?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mails = [];
    transport = async () => ({ ok: true, transport: "resend", providerId: "fake" });
    __setEmailTransportForTests(async (i) => {
      mails.push(i);
      return transport(i);
    });
  });

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  const patient = () => addPatient(db, A, { assignedPractitionerId: P1.practitionerId });

  /** Cuenta del portal vinculada (`Patient.userId`), con el email que la vinculó. */
  async function linkPortal(patientId: string): Promise<string> {
    const userId = `test-portal-${uniqueSuffix()}`;
    const email = `${userId}@paciente.test`;
    await db.userProfile.create({ data: { id: userId, email, fullName: "Paciente Portal" } });
    await db.patient.update({ where: { id: patientId }, data: { userId } });
    return email;
  }

  async function seedNote(patientId: string, amendsNoteId: string | null = null): Promise<string> {
    const id = `t4y-${uniqueSuffix()}`;
    const now = new Date();
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: A.tenantId,
        patientId,
        amendsNoteId,
        kind: "FIRST_VISIT",
        title: amendsNoteId ? null : `Ingreso ${SENTINEL}`,
        body: `Dolor lumbar 6/10 ${SENTINEL}`,
        occurredAt: now,
        authorUserId: P1.userId,
        authorPractitionerId: P1.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
        createdAt: now,
      },
    });
    return id;
  }

  async function liveDoc(patientId: string, noteId: string): Promise<string> {
    const id = `t4y-doc-${uniqueSuffix()}`;
    await db.patientDocument.create({
      data: {
        id,
        tenantId: A.tenantId,
        patientId,
        noteId,
        noteRevision: 1,
        sourceDigest: SHA,
        title: `Ingreso ${SENTINEL}`,
        occurredAt: new Date(),
        snapshot: { v: 1 },
        snapshotSha256: SHA,
        pdfStorageKey: `stub:${id}`,
        pdfSha256: SHA,
        pdfSizeBytes: 100,
        sharedByUserId: P1.userId,
        sharedByPractitionerId: P1.practitionerId,
        sharedAt: new Date(),
        idempotencyKey: randomUUID(),
      },
    });
    return id;
  }

  function voidAs(noteId: string, reason = `Paciente equivocado ${SENTINEL}`) {
    asUser(P1.userId);
    return voidClinicalNote({ noteId, expectedRevision: 1, reason });
  }

  function expectRevokedMail(m: SendEmailInput, email: string, documentId: string) {
    expect(m).toMatchObject({ kind: "portal_document_revoked", to: email, tenantId: A.tenantId, entity: "PatientDocument", entityId: documentId });
    for (const part of [m.subject, m.html, m.text]) {
      expect(part).not.toContain(SENTINEL);
      expect(part).not.toContain("Dolor");
      expect(part).not.toContain("Ingreso");
      expect(part).not.toContain("equivocado");
    }
    expect(m.subject).toBe(`${tenantName} actualizó un documento de tu portal`);
    expect(m.text).toContain(`Un documento que ${tenantName} había compartido con vos ya no está disponible porque fue modificado.`);
    expect(m.text).toContain("Si lo necesitás, pedíselo nuevamente al consultorio.");
    expect(m.text).toContain(`/portal/c/${A.slug}/documentos`);
  }

  // ── Casos ───────────────────────────────────────────────────────────────────────────────────────────────────

  it("[T4-Y] anular una RAÍZ compartida (revoca el trigger) → mail al portal vinculado, sin datos clínicos", async () => {
    const pid = await patient();
    const email = await linkPortal(pid);
    const root = await seedNote(pid);
    const doc = await liveDoc(pid, root);
    const v = await voidAs(root);
    expect(v.ok).toBe(true);
    expect(await db.patientDocument.findUniqueOrThrow({ where: { id: doc } })).toMatchObject({ revokeReason: "NOTE_VOIDED" });
    expect(mails).toHaveLength(1);
    expectRevokedMail(mails[0], email, doc);
    // El doble click (idempotente, no revoca nada nuevo) no vuelve a avisar.
    expect((await voidAs(root)).ok).toBe(true);
    expect(mails).toHaveLength(1);
  });

  it("[T4-Y] anular una ENMIENDA con la raíz compartida (T4Z-M1) → mail al portal vinculado", async () => {
    const pid = await patient();
    const email = await linkPortal(pid);
    const root = await seedNote(pid);
    const amend = await seedNote(pid, root);
    const doc = await liveDoc(pid, root);
    expect((await voidAs(amend)).ok).toBe(true);
    expect(await db.patientDocument.findUniqueOrThrow({ where: { id: doc } })).toMatchObject({ revokeReason: "NOTE_VOIDED" });
    expect(mails).toHaveLength(1);
    expectRevokedMail(mails[0], email, doc);
  });

  it("[T4-Y] sin documento compartido vivo → no se manda nada", async () => {
    const pid = await patient();
    await linkPortal(pid);
    const root = await seedNote(pid);
    expect((await voidAs(root)).ok).toBe(true);
    // Enmienda de una raíz sin compartir: tampoco.
    const root2 = await seedNote(pid);
    const amend = await seedNote(pid, root2);
    expect((await voidAs(amend)).ok).toBe(true);
    expect(mails).toEqual([]);
  });

  it("[T4-Y] sin portal vinculado → se revoca igual y no se manda (nunca a `Patient.email`)", async () => {
    const pid = await patient();
    await db.patient.update({ where: { id: pid }, data: { email: `cargado-${uniqueSuffix()}@paciente.test` } });
    const root = await seedNote(pid);
    const doc = await liveDoc(pid, root);
    expect((await voidAs(root)).ok).toBe(true);
    expect(await db.patientDocument.findUniqueOrThrow({ where: { id: doc } })).toMatchObject({ revokeReason: "NOTE_VOIDED" });
    expect(mails).toEqual([]);
  });

  it("[T4-Y] Resend caído (falla o tira) → la anulación igual queda ok y revocada", async () => {
    for (const broken of [
      async (): Promise<SendEmailResult> => ({ ok: false, transport: "resend", skipped: false, reason: "provider_error", status: 500 }),
      async (): Promise<SendEmailResult> => {
        throw new Error("ECONNRESET");
      },
    ]) {
      transport = broken;
      const pid = await patient();
      await linkPortal(pid);
      const root = await seedNote(pid);
      const doc = await liveDoc(pid, root);
      const v = await voidAs(root);
      expect(v.ok).toBe(true);
      expect(await db.clinicalNote.count({ where: { id: root, voidedAt: { not: null } } })).toBe(1);
      expect(await db.patientDocument.count({ where: { id: doc, revokedAt: { not: null } } })).toBe(1);
    }
    expect(mails).toHaveLength(2);
  });

  it("[T4-Y] respeta el tope de avisos por paciente (el mismo de compartir): pasado el tope, se anula igual y sin mail", async () => {
    const pid = await patient();
    await linkPortal(pid);
    for (let i = 0; i < 3; i++) await rateLimit(`patient-document:notify:patient:${pid}`, { limit: 3, windowMs: 60 * 60_000 });
    const root = await seedNote(pid);
    const doc = await liveDoc(pid, root);
    expect((await voidAs(root)).ok).toBe(true);
    expect(await db.patientDocument.count({ where: { id: doc, revokedAt: { not: null } } })).toBe(1);
    expect(mails).toEqual([]);
  });

  it("[T4-Y] cuenta del portal deshabilitada (BO0) → no se manda", async () => {
    const pid = await patient();
    await linkPortal(pid);
    const { userId } = await db.patient.findUniqueOrThrow({ where: { id: pid }, select: { userId: true } });
    await db.userProfile.update({ where: { id: userId! }, data: { disabledAt: new Date() } });
    const root = await seedNote(pid);
    await liveDoc(pid, root);
    expect((await voidAs(root)).ok).toBe(true);
    expect(mails).toEqual([]);
  });
});
