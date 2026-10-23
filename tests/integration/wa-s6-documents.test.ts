/**
 * T6 · [WA-S6] Compartir la ficha por WhatsApp (brief §26.5 «Compartir ficha»).
 *
 * Símbolos REALES contra Postgres en los dos roles (`npm run test:integration -- wa-s6` = kinesoft_app con RLS; `:owner`
 * = BYPASSRLS como prod): `shareClinicalNoteWithPatient`, la cola (`enqueue`/`dispatch`/`drainAll`), el preparador
 * `prepareWhatsAppDocument`, `loadPatientDocumentPdfForDelivery` (re-chequeo de SHA y de revocado), el gate de
 * evoluciones y el rate limit por paciente compartido con el mail.
 *
 * Se reemplaza solo lo externo:
 *   - la RED de Meta: el simulador (`installFakeGraph`), que verifica que el media sea un PDF por los magic bytes;
 *   - Storage (bucket en memoria, con un modo que cambia los bytes al bajar para simular un objeto adulterado);
 *   - el render del PDF y la carga de logo/firmas (los prueba FC-2e);
 *   - el transporte del mail;
 *   - `auditSecurityEvent` SOLO para inyectarle una falla (`fx.auditFails`); sin la falla es el real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { revokePatientDocument, shareClinicalNoteWithPatient } from "@/lib/patient-documents";
import { PATIENT_DOCUMENT_COPY } from "@/lib/patient-documents-types";
import { __setEmailTransportForTests, type SendEmailInput } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { drainAll, enqueue } from "@/lib/whatsapp/outbox-internal";
import { prepareWhatsAppDocument } from "@/lib/whatsapp/document-internal";
import { idemKey } from "@/lib/whatsapp/logic";
import { maskPhone, phoneHash } from "@/lib/whatsapp/crypto";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { fakeGraphMedia } from "@/lib/whatsapp/fake-graph";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, sweepOrphanTestTenants, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { connectFakeWhatsApp, fakeGraphMessages, installFakeGraph, type FakeWhatsAppAccount, type InstalledFakeGraph } from "@/tests/helpers/whatsapp-fake";

const fx = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  tamper: false,
  renderBytes: null as null | (() => Uint8Array),
  auditFails: false,
}));

vi.mock("@/lib/storage-internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage-internal")>();
  return {
    ...real,
    isStorageConfigured: () => true,
    storageUpload: async (bucket: string, key: string, body: Uint8Array) => {
      fx.objects.set(`${bucket}:${key}`, body);
      return { ok: true, data: undefined };
    },
    storageRemove: async (bucket: string, keys: string[]) => {
      for (const key of keys) fx.objects.delete(`${bucket}:${key}`);
      return { ok: true, data: undefined };
    },
    storageDownload: async (bucket: string, key: string) => {
      const b = fx.objects.get(`${bucket}:${key}`);
      if (!b) return { ok: false, reason: "storage", message: "Object not found" };
      // Objeto cambiado en el bucket: sigue siendo un PDF, pero no el que se compartió.
      return { ok: true, data: fx.tamper ? new Uint8Array([...b, 0x20]) : b };
    },
  };
});

vi.mock("@/lib/hc-pdf/render-internal", () => ({
  HC_PDF_MAX_BYTES: 4 * 1024 * 1024,
  renderHcPdf: async () => (fx.renderBytes ? fx.renderBytes() : new TextEncoder().encode(`%PDF-1.7 fake ${randomUUID()}`)),
}));

vi.mock("@/lib/hc-assets-internal", () => ({
  loadHcAssets: async () => ({ logo: null, signatures: {} }),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    auditSecurityEvent: async (p: Parameters<typeof real.auditSecurityEvent>[0]) => {
      if (fx.auditFails) throw new Error("audit caído");
      return real.auditSecurityEvent(p);
    },
  };
});

const RUN = process.env.INTEGRATION === "1";
const C = PATIENT_DOCUMENT_COPY;
/** Centinela clínico: no puede aparecer en el mail, en el audit ni en los parámetros que viajan a Meta. */
const SENTINEL = "CENTINELA-LUMBALGIA-4417";
const DOC_TPL = TEMPLATE_SPECS.DOCUMENT_SHARED.name;

function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

type Member = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("[WA-S6] compartir la ficha por WhatsApp", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let P1: Member;
  let SEC: { userId: string };
  let tenantName = "";
  let fake: InstalledFakeGraph;
  let acc: FakeWhatsAppAccount;
  let mails: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P1 = await addPractitioner(db, A);
    const userId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: "Secretaría" } });
    await db.membership.create({ data: { userId, tenantId: A.tenantId, role: "ASSISTANT", acceptedAt: new Date() } });
    SEC = { userId };
    tenantName = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } })).name;
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      await A?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    fx.tamper = false;
    fx.renderBytes = null;
    fx.auditFails = false;
    __rateLimitInternals.reset();
    mails = [];
    __setEmailTransportForTests(async (i) => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: "fake" };
    });
    fake = installFakeGraph();
    await db.whatsAppMessage.deleteMany({ where: { tenantId: A.tenantId } });
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: A.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: A.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: A.tenantId } });
    acc = await connectFakeWhatsApp(db, A);
    fake.calls.length = 0;
  });

  afterEach(() => {
    fake.uninstall();
  });

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  async function patient(o: { consent?: "GRANTED" | "REVOKED" | null; portal?: boolean } = {}): Promise<{ id: string; phone: string }> {
    const phone = uniquePhone();
    const id = await addPatient(db, A, { firstName: "Martina", phone, assignedPractitionerId: P1.practitionerId });
    const consent = o.consent === undefined ? "GRANTED" : o.consent;
    if (consent) {
      await db.patient.update({
        where: { id },
        data: { waConsent: consent, waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
      });
    }
    if (o.portal) {
      const userId = `test-portal-${uniqueSuffix()}`;
      await db.userProfile.create({ data: { id: userId, email: `${userId}@paciente.test`, fullName: "Paciente Portal" } });
      await db.patient.update({ where: { id }, data: { userId } });
    }
    return { id, phone };
  }

  async function seedNote(patientId: string): Promise<string> {
    const id = `wa6-${uniqueSuffix()}`;
    const now = new Date();
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: A.tenantId,
        patientId,
        kind: "FIRST_VISIT",
        title: `Ingreso ${SENTINEL}`,
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

  function share(user: string, noteId: string, o: { whatsapp?: boolean; notify?: boolean; key?: string } = {}) {
    asUser(user);
    return shareClinicalNoteWithPatient({
      noteId,
      idempotencyKey: o.key ?? randomUUID(),
      notify: o.notify ?? false,
      ...(o.whatsapp === false ? {} : { whatsapp: { attested: true as const } }),
    });
  }

  const messagesOf = (patientId: string) => db.whatsAppMessage.findMany({ where: { tenantId: A.tenantId, patientId }, orderBy: { createdAt: "asc" } });
  const waAudits = (patientId: string) => db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId: patientId, action: "patientDocument.whatsapp" } });
  const graphCalls = () => fake.calls.filter((u) => /\/(media|messages)$/.test(new URL(u).pathname));

  // ── Camino feliz ────────────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S6] el PDF compartido sale como MEDIA (el simulador verifica los magic bytes y el sha) con `cs_documento_v1`; audit antes de encolar; el mail sigue siendo solo aviso", async () => {
    const p = await patient({ portal: true });
    const noteId = await seedNote(p.id);
    const key = randomUUID();
    const r = await share(P1.userId, noteId, { notify: true, key });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.delivery).toEqual({ channel: "email", status: "sent" });
    expect(r.data.whatsappDelivery).toEqual({ channel: "whatsapp", status: "sent" });

    const docId = r.data.document.id;
    const doc = await db.patientDocument.findUniqueOrThrow({ where: { id: docId } });
    const [m] = await messagesOf(p.id);
    expect(m).toMatchObject({
      kind: "DOCUMENT_SHARED",
      trigger: "MANUAL",
      status: "SENT",
      documentId: docId,
      idempotencyKey: idemKey({ t: "doc", documentId: docId, key }),
      templateName: DOC_TPL,
      toHash: phoneHash(p.phone),
      toMasked: maskPhone(p.phone),
      createdByUserId: P1.userId,
    });

    const sent = fakeGraphMessages().filter((x) => x.templateName === DOC_TPL);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(p.phone.replace("+", ""));
    expect(sent[0].callbackData).toBe(m.id);
    expect(sent[0].bodyParams).toEqual(["Martina", tenantName.slice(0, 60)]);
    expect(JSON.stringify(sent[0])).not.toContain(SENTINEL);
    // Los bytes que recibió Meta son EXACTAMENTE los del documento (mismo sha256 que `pdfSha256`); nunca un link.
    const media = fakeGraphMedia(sent[0].documentMediaId!);
    expect(media).toMatchObject({ sha256: doc.pdfSha256, size: doc.pdfSizeBytes, mimeType: "application/pdf" });
    expect(fake.calls.some((u) => u.includes(docId))).toBe(false);

    const audits = await waAudits(p.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: P1.userId, entity: "Patient", entityId: p.id });
    expect(audits[0].payload).toMatchObject({ documentId: docId });
    expect(JSON.stringify(audits[0].payload)).not.toContain(p.phone.slice(-6));
    expect(JSON.stringify(audits[0].payload)).not.toContain(SENTINEL);

    // El mail: solo aviso, sin el PDF ni nada clínico.
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0])).not.toContain(SENTINEL);
    expect(mails[0]).not.toHaveProperty("attachments");
  });

  it("[WA-S6] replay de la misma clave: no audita ni manda otro WhatsApp", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    const key = randomUUID();
    expect(await share(P1.userId, noteId, { key })).toMatchObject({ ok: true, data: { whatsappDelivery: { status: "sent" } } });
    const again = await share(P1.userId, noteId, { key });
    expect(again).toMatchObject({ ok: true, data: { replayed: true, whatsappDelivery: null } });
    expect(await messagesOf(p.id)).toHaveLength(1);
    expect(await waAudits(p.id)).toHaveLength(1);
  });

  // ── Fallas cerradas ─────────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S6] audit que falla → no se encola: 0 llamadas a Graph (se comparte igual en el portal)", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    fx.auditFails = true;
    const r = await share(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "failed" } } });
    expect(fake.calls).toEqual([]);
    expect(await messagesOf(p.id)).toHaveLength(0);
    expect(await db.patientDocument.count({ where: { noteId, revokedAt: null } })).toBe(1);
  });

  it("[WA-S6] objeto con otro SHA en el bucket → SKIPPED (`document_changed`): ni media ni mensaje", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    fx.tamper = true;
    const r = await share(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "skipped" } } });
    const [m] = await messagesOf(p.id);
    expect(m).toMatchObject({ status: "SKIPPED", skipReason: "document_changed" });
    expect(graphCalls()).toEqual([]);
    expect(fakeGraphMessages()).toHaveLength(0);
  });

  it("[WA-S6] documento revocado entre el encolado y el drenado del cron → SKIPPED (`document_changed`), nada enviado", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    const r = await share(P1.userId, noteId, { whatsapp: false });
    if (!r.ok) throw new Error(r.error);
    const docId = r.data.document.id;
    // Encolado como lo haría compartir, pero sin despachar (p. ej. un timeout que lo dejó para el cron).
    const [id] = await enqueue([
      {
        tenantId: A.tenantId,
        accountId: acc.accountId,
        kind: "DOCUMENT_SHARED",
        trigger: "MANUAL",
        idempotencyKey: idemKey({ t: "doc", documentId: docId, key: randomUUID() }),
        patientId: p.id,
        documentId: docId,
        templateName: DOC_TPL,
        toHash: phoneHash(p.phone),
        toMasked: maskPhone(p.phone),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ]);
    asUser(P1.userId);
    expect((await revokePatientDocument({ documentId: docId })).ok).toBe(true);
    // Sin preparador el cron no toma DOCUMENT_SHARED; con el de WA-S6, sí (handoff a WA-S4).
    expect((await drainAll(5_000)).processed).toBe(0);
    const d = await drainAll(5_000, { prepareDocument: prepareWhatsAppDocument });
    expect(d).toMatchObject({ processed: 1, skipped: 1, sent: 0 });
    expect(await db.whatsAppMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SKIPPED", skipReason: "document_changed" });
    expect(graphCalls()).toEqual([]);
  });

  it("[WA-S6] un PDF que no es PDF lo rechaza el simulador (magic bytes): FAILED, sin mensaje", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    fx.renderBytes = () => new TextEncoder().encode(`<html>${randomUUID()}</html>`);
    const r = await share(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "failed" } } });
    const [m] = await messagesOf(p.id);
    expect(m).toMatchObject({ status: "FAILED" });
    expect(fakeGraphMessages()).toHaveLength(0);
  });

  // ── Permisos y consentimiento ───────────────────────────────────────────────────────────────────────────────

  it("[WA-S6] la Secretaría no comparte (FC-D8): rechazo sin audit, sin cola y sin Graph", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    const r = await share(SEC.userId, noteId);
    expect(r).toEqual({ ok: false, error: C.forbidden });
    expect(fake.calls).toEqual([]);
    expect(await messagesOf(p.id)).toHaveLength(0);
    expect(await waAudits(p.id)).toHaveLength(0);
  });

  it("[WA-S6] sin consentimiento (o revocado, o el número cambió) → no se encola ni se audita", async () => {
    for (const setup of [
      async () => patient({ consent: null }),
      async () => patient({ consent: "REVOKED" }),
      async () => {
        const x = await patient();
        await db.patient.update({ where: { id: x.id }, data: { phone: uniquePhone() } });
        return x;
      },
    ]) {
      const p = await setup();
      const noteId = await seedNote(p.id);
      const r = await share(P1.userId, noteId);
      expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "skipped" } } });
      expect(await messagesOf(p.id)).toHaveLength(0);
      expect(await waAudits(p.id)).toHaveLength(0);
    }
    expect(fake.calls).toEqual([]);
  });

  it("[WA-S6] sin la casilla «El paciente pidió recibirlo por WhatsApp» no sale nada por WhatsApp", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    const r = await share(P1.userId, noteId, { whatsapp: false });
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: null } });
    expect(await messagesOf(p.id)).toHaveLength(0);
    expect(fake.calls).toEqual([]);
  });

  it("[WA-S6] modo `off` → no se encola (y no se llama a Meta)", async () => {
    const p = await patient();
    const noteId = await seedNote(p.id);
    process.env.WHATSAPP_MODE = "off";
    const r = await share(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "skipped" } } });
    expect(await messagesOf(p.id)).toHaveLength(0);
    expect(await waAudits(p.id)).toHaveLength(0);
    expect(fake.calls).toEqual([]);
  });

  // ── Rate limit compartido con el mail ───────────────────────────────────────────────────────────────────────

  it("[WA-S6] el tope de avisos por paciente (3 / h) es el MISMO para mail y WhatsApp", async () => {
    const p = await patient({ portal: true });
    const noteId = await seedNote(p.id);
    for (let i = 0; i < 3; i++) {
      expect(await share(P1.userId, noteId, { notify: true, whatsapp: false })).toMatchObject({ ok: true, data: { delivery: { status: "sent" } } });
    }
    const r = await share(P1.userId, noteId);
    expect(r).toMatchObject({ ok: true, data: { whatsappDelivery: { channel: "whatsapp", status: "skipped" } } });
    expect(await messagesOf(p.id)).toHaveLength(0);
    expect(fake.calls).toEqual([]);

    // Al revés: un WhatsApp gasta cupo del mail.
    const q = await patient({ portal: true });
    const note2 = await seedNote(q.id);
    expect(await share(P1.userId, note2)).toMatchObject({ ok: true, data: { whatsappDelivery: { status: "sent" } } });
    for (let i = 0; i < 2; i++) expect(await share(P1.userId, note2, { notify: true, whatsapp: false })).toMatchObject({ ok: true, data: { delivery: { status: "sent" } } });
    expect(await share(P1.userId, note2, { notify: true, whatsapp: false })).toMatchObject({ ok: true, data: { delivery: { status: "skipped" } } });
  }, 30_000);
});
