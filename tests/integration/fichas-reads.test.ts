/**
 * FC · lecturas de fichas (C-FC3 «Lecturas», brief T4 Anexo B; tests del Anexo C «FC-2b»).
 *
 * FC-1b1: el DTO trae `bodyDoc`, `diagnoses`, `authorLicense`, `importSource` y `lateEntry` en las tres lecturas.
 * FC-2b: `sharedDocument` (LEFT JOIN LATERAL del documento vivo, «stale» por la huella de la fuente) y
 * `getPatientClinicalHome` (la tx 3 del perfil: resumen + primera página + compositor + deep link).
 *
 * Símbolos reales contra Postgres en los dos roles; se mockea solo la sesión/cookies/`next/cache` (integration-setup).
 * La nota se siembra con el owner (los campos nuevos los escribe FC-2a).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  getBookingClinicalNote,
  getPatientClinicalHome,
  getPatientClinicalSummary,
  getPatientTimeline,
} from "@/lib/clinical-notes-read";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { sha256Hex } from "@/lib/hc-print-internal";
import { hcSourceVersion } from "@/lib/hc-print-model";
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
const H = 60 * 60 * 1000;

const BODY_DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Dolor lumbar", marks: [{ type: "bold" }] }] }] };
const DIAGNOSES: DiagnosisSnapshot[] = [
  { v: 1, source: "text", refId: null, code: null, title: "Lumbalgia mecánica", uri: null, release: null },
];

describe.skipIf(!RUN)("[FC-2b] lecturas de fichas", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    await db.$disconnect();
  });

  /** Paciente + ficha con formato, diagnóstico, matrícula e importación (cargada 3 días después: carga tardía). */
  async function seeded(opts: { withBooking?: boolean } = {}) {
    const pid = await addPatient(db, A, { assignedPractitionerId: A.practitionerId });
    const occurredAt = new Date(Date.now() - 4 * 24 * H);
    const createdAt = new Date(Date.now() - 1 * 24 * H);
    const bookingId = opts.withBooking
      ? (
          await db.booking.create({
            data: {
              tenantId: A.tenantId,
              patientId: pid,
              practitionerId: A.practitionerId,
              serviceId: A.serviceId,
              scheduledFor: occurredAt,
              durationMin: 45,
              status: "COMPLETED",
              idempotencyKey: randomUUID(),
            },
            select: { id: true },
          })
        ).id
      : null;
    const id = `fc-1b1-${uniqueSuffix()}`;
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: A.tenantId,
        patientId: pid,
        bookingId,
        body: "Dolor lumbar",
        bodyDoc: BODY_DOC,
        diagnoses: DIAGNOSES,
        authorLicense: "MN 1234",
        ...(bookingId
          ? {}
          : { importSource: { v: 1, kind: "docx", fileName: "hc.docx", fileSize: 10, fileLastModified: null, batchId: randomUUID(), part: 2, parts: 3, importedAt: createdAt.toISOString() } }),
        occurredAt,
        authorUserId: A.userId,
        authorPractitionerId: A.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
        createdAt,
      },
    });
    return { pid, id, bookingId };
  }

  // ── Ya verdes (proyección de FC-1b1) ────────────────────────────────────────────────────────────────────────

  it("[FC-1b] la timeline (SQL crudo) trae bodyDoc, diagnoses, authorLicense, importSource y lateEntry", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    const page = await getPatientTimeline({ patientId: pid });
    const item = page?.items.find((i) => i.type === "note" && i.note.id === id);
    expect(item?.type).toBe("note");
    if (item?.type !== "note") return;
    expect(item.note).toMatchObject({
      bodyDoc: BODY_DOC,
      diagnoses: DIAGNOSES,
      authorLicense: "MN 1234",
      importSource: { kind: "docx", fileName: "hc.docx", part: 2, parts: 3 },
      lateEntry: true,
    });
    // Lo interno del import (tamaño, lote) no viaja al cliente.
    expect(item.note.importSource).not.toHaveProperty("batchId");
    expect(item.note.importSource).not.toHaveProperty("fileSize");
  });

  it("[FC-1b] drawer del turno y resumen (CLINICAL_NOTE_SELECT) traen los mismos campos", async () => {
    const { pid, id, bookingId } = await seeded({ withBooking: true });
    asUser(A.userId);
    const view = await getBookingClinicalNote(bookingId!);
    expect(view?.note).toMatchObject({ id, bodyDoc: BODY_DOC, diagnoses: DIAGNOSES, authorLicense: "MN 1234", importSource: null, lateEntry: true });
    const summary = await getPatientClinicalSummary(pid);
    expect(summary?.latest).toMatchObject({ id, bodyDoc: BODY_DOC, diagnoses: DIAGNOSES });
  });

  // ── FC-2b: documento compartido (LEFT JOIN LATERAL) y la lectura «clinical home» ─────────────────────────────

  /**
   * Documento compartido como lo deja FC-2d: `sourceDigest` = sha256(hcSourceVersion(raíz, TODAS sus enmiendas)) en
   * el momento de compartir. Se calcula con los MISMOS puros que usa la lectura (si cambian, cambian los dos).
   */
  async function share(noteId: string, pid: string, digest?: string) {
    const root = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId }, select: { revision: true, occurredAt: true } });
    const amends = await db.clinicalNote.findMany({
      where: { tenantId: A.tenantId, amendsNoteId: noteId },
      select: { id: true, revision: true, voidedAt: true },
    });
    const sourceDigest =
      digest ?? sha256Hex(hcSourceVersion(root, amends.map((a) => ({ id: a.id, revision: a.revision, voided: a.voidedAt !== null }))));
    const id = `fc-2b-doc-${uniqueSuffix()}`;
    const SHA = "a".repeat(64);
    await db.$executeRaw`
      INSERT INTO "PatientDocument" (id, "tenantId", "patientId", "noteId", "noteRevision", "sourceDigest", title,
        "occurredAt", snapshot, "snapshotSha256", "pdfStorageKey", "pdfSha256", "pdfSizeBytes", "sharedByUserId",
        "sharedByPractitionerId", "sharedAt", "idempotencyKey")
      VALUES (${id}, ${A.tenantId}, ${pid}, ${noteId}, ${root.revision}, ${sourceDigest}, 'Ficha',
        ${root.occurredAt.toISOString()}::timestamp, '{"v":1}'::jsonb, ${SHA}, ${`stub:${id}`}, ${SHA}, 100,
        ${A.userId}, ${A.practitionerId}, now() AT TIME ZONE 'UTC', ${randomUUID()})`;
    return id;
  }

  async function amend(rootId: string, pid: string) {
    const id = `fc-2b-am-${uniqueSuffix()}`;
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: A.tenantId,
        patientId: pid,
        amendsNoteId: rootId,
        body: "Enmienda: además, cervicalgia",
        occurredAt: new Date(),
        authorUserId: A.userId,
        authorPractitionerId: A.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
      },
    });
    return id;
  }

  async function timelineNote(pid: string, id: string) {
    const page = await getPatientTimeline({ patientId: pid });
    const item = page?.items.find((i) => i.type === "note" && i.note.id === id);
    if (item?.type !== "note") throw new Error("la ficha no está en la timeline");
    return item;
  }

  it("[FC-2b] `sharedDocument` none → live → stale", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    // Sin documento compartido: «none» (no null; null queda para las enmiendas).
    expect((await timelineNote(pid, id)).note.sharedDocument).toEqual({ status: "none" });

    const docId = await share(id, pid);
    const live = await timelineNote(pid, id);
    expect(live.note.sharedDocument).toMatchObject({ status: "live", documentId: docId });
    expect(live.note.sharedDocument?.status !== "none" && Date.parse(live.note.sharedDocument!.sharedAt)).toBeGreaterThan(0);

    // Enmendar cambia la huella de la fuente: lo compartido quedó viejo («Compartida · desactualizada»).
    const amId = await amend(id, pid);
    const stale = await timelineNote(pid, id);
    expect(stale.note.sharedDocument).toMatchObject({ status: "stale", documentId: docId });
    // La enmienda no lleva documento propio: null (no aplica), nunca «none».
    expect(stale.amendments.find((a) => a.id === amId)?.sharedDocument).toBeNull();

    // Mismo estado en el drawer del turno, en el resumen y en el inicio de la HC (misma proyección, mismo LATERAL).
    expect((await getPatientClinicalSummary(pid))?.latest?.sharedDocument).toMatchObject({ status: "stale", documentId: docId });
    const home = await getPatientClinicalHome(pid, { timeline: true });
    expect(home?.summary.latest?.sharedDocument).toMatchObject({ status: "stale" });
    const homeItem = home?.firstPage?.items.find((i) => i.type === "note" && i.note.id === id);
    expect(homeItem?.type === "note" && homeItem.note.sharedDocument).toMatchObject({ status: "stale", documentId: docId });
  });

  it("[FC-2b] la huella compara el sha256 exacto: un `sourceDigest` ajeno es «stale»; volver a compartir → «live»", async () => {
    const { pid, id, bookingId } = await seeded({ withBooking: true });
    asUser(A.userId);
    await share(id, pid, "b".repeat(64));
    expect((await timelineNote(pid, id)).note.sharedDocument).toMatchObject({ status: "stale" });
    // Volver a compartir: se revoca el vivo y nace otro con la huella actual (lo que hace FC-2d).
    await db.$executeRaw`
      UPDATE "PatientDocument" SET "revokedAt" = now() AT TIME ZONE 'UTC', "revokedByUserId" = ${A.userId},
        "revokeReason" = 'REPLACED' WHERE "noteId" = ${id} AND "revokedAt" IS NULL`;
    const again = await share(id, pid);
    expect((await timelineNote(pid, id)).note.sharedDocument).toEqual(expect.objectContaining({ status: "live", documentId: again }));
    const view = await getBookingClinicalNote(bookingId!);
    expect(view?.note?.sharedDocument).toMatchObject({ status: "live", documentId: again });
  });

  it("[FC-2b] anular la raíz revoca su documento (trigger) → la anulada se ve «none»", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    await share(id, pid);
    await db.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${A.userId},
        "voidReason" = 'Paciente equivocado' WHERE id = ${id}`;
    expect((await timelineNote(pid, id)).note.sharedDocument).toEqual({ status: "none" });
  });

  it("[FC-2b] getPatientClinicalHome: resumen + primera página + compositor + deep link", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    const home = await getPatientClinicalHome(pid, { timeline: true });
    expect(home?.summary.liveCount).toBe(1);
    expect(home?.summary.latest?.id).toBe(id);
    expect(home?.firstPage?.items.some((i) => i.type === "note" && i.note.id === id)).toBe(true);
    expect(home?.composer).not.toBeNull();
    expect(home?.deepLink).toBeNull();
    // Igual que los lectores sueltos (la página no puede mostrar otra cosa que lo que trae «Cargar más»).
    expect(home?.summary).toEqual(await getPatientClinicalSummary(pid));
    // `timeline: false` no arma la página.
    expect((await getPatientClinicalHome(pid, { timeline: false }))?.firstPage).toBeNull();
  });

  it("[FC-2b] primera página: 10 ítems como mucho y tope de 60k caracteres (con cursor para seguir)", async () => {
    const pid = await addPatient(db, A, { assignedPractitionerId: A.practitionerId });
    const base = Date.now() - 30 * 24 * H;
    // 14 fichas de 9.000 caracteres: 10 serían 90k → la página corta antes (6 = 54k; la 7ª pasaría los 60k).
    for (let i = 0; i < 14; i++) {
      await db.clinicalNote.create({
        data: {
          tenantId: A.tenantId,
          patientId: pid,
          body: `${i} `.padEnd(9_000, "x"),
          occurredAt: new Date(base + i * H),
          authorUserId: A.userId,
          authorPractitionerId: A.practitionerId,
          authorName: "Kine Sembrado",
          idempotencyKey: randomUUID(),
        },
      });
    }
    asUser(A.userId);
    const home = await getPatientClinicalHome(pid, { timeline: true });
    const items = home!.firstPage!.items;
    expect(items).toHaveLength(6);
    expect(home!.firstPage!.nextCursor).not.toBeNull();
    // La página siguiente arranca justo después (sin repetidos ni huecos).
    const next = await getPatientTimeline({ patientId: pid, cursor: home!.firstPage!.nextCursor, limit: 50 });
    const keys = [...items, ...next!.items].map((i) => i.key);
    expect(new Set(keys).size).toBe(14);
    // Fichas chicas: 10 justas aunque haya más.
    const small = await addPatient(db, A, { assignedPractitionerId: A.practitionerId });
    for (let i = 0; i < 12; i++) {
      await db.clinicalNote.create({
        data: {
          tenantId: A.tenantId,
          patientId: small,
          body: `chica ${i}`,
          occurredAt: new Date(base + i * H),
          authorUserId: A.userId,
          authorPractitionerId: A.practitionerId,
          authorName: "Kine Sembrado",
          idempotencyKey: randomUUID(),
        },
      });
    }
    const h2 = await getPatientClinicalHome(small, { timeline: true });
    expect(h2!.firstPage!.items).toHaveLength(10);
    expect(h2!.firstPage!.nextCursor).not.toBeNull();
  });

  it("[FC-2b] compositor: turnos del paciente sin cancelados/ausentes ni futuros lejanos, con `hasLiveNote`; deep link solo de ESTE paciente", async () => {
    const pid = await addPatient(db, A, { assignedPractitionerId: A.practitionerId });
    const other = await addPatient(db, A, { assignedPractitionerId: A.practitionerId });
    const mk = async (patientId: string, at: Date, status: "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW") =>
      (
        await db.booking.create({
          data: { tenantId: A.tenantId, patientId, practitionerId: A.practitionerId, serviceId: A.serviceId, scheduledFor: at, durationMin: 45, status, idempotencyKey: randomUUID() },
          select: { id: true },
        })
      ).id;
    const today = await mk(pid, new Date(Date.now() - 1 * H), "CONFIRMED");
    const withNote = await mk(pid, new Date(Date.now() - 48 * H), "COMPLETED");
    const cancelled = await mk(pid, new Date(Date.now() - 2 * H), "CANCELLED");
    const noShow = await mk(pid, new Date(Date.now() - 3 * H), "NO_SHOW");
    const farFuture = await mk(pid, new Date(Date.now() + 3 * 24 * H), "CONFIRMED");
    const foreign = await mk(other, new Date(Date.now() - 1 * H), "CONFIRMED");
    await db.clinicalNote.create({
      data: {
        tenantId: A.tenantId,
        patientId: pid,
        bookingId: withNote,
        body: "Con ficha",
        occurredAt: new Date(Date.now() - 48 * H),
        authorUserId: A.userId,
        authorPractitionerId: A.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
      },
    });
    asUser(A.userId);
    const home = await getPatientClinicalHome(pid, { timeline: true, noteBookingId: withNote });
    const ids = home!.composer!.candidates.map((c) => c.id);
    expect(ids).toEqual([today, withNote]);
    expect(ids).not.toEqual(expect.arrayContaining([cancelled, noShow, farFuture, foreign]));
    expect(home!.composer!.candidates[0]).toMatchObject({ id: today, status: "CONFIRMED", practitionerId: A.practitionerId, hasLiveNote: false, serviceName: expect.any(String) });
    expect(home!.composer!.candidates[1]).toMatchObject({ id: withNote, hasLiveNote: true });
    // Deep link = la misma vista que el drawer del turno.
    expect(home!.deepLink).toEqual(await getBookingClinicalNote(withNote));
    expect(home!.deepLink?.note?.body).toBe("Con ficha");
    // Turno de otro paciente o basura: sin deep link (no revela nada), el resto igual.
    const h2 = await getPatientClinicalHome(pid, { noteBookingId: foreign });
    expect(h2?.deepLink).toBeNull();
    expect(h2?.summary.liveCount).toBe(1);
    expect((await getPatientClinicalHome(pid, { noteBookingId: "x'; drop" }))?.deepLink).toBeNull();
  });

  it("[FC-2b] sin acceso clínico (Secretaria), paciente ajeno o id basura → null", async () => {
    const { pid } = await seeded();
    const secretaria = await addPractitioner(db, A, "ASSISTANT");
    asUser(secretaria.userId);
    expect(await getPatientClinicalHome(pid, { timeline: true })).toBeNull();
    asUser(A.userId);
    expect(await getPatientClinicalHome("no/valido")).toBeNull();
    const B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const bp = await addPatient(db, B);
      expect(await getPatientClinicalHome(bp, { timeline: true })).toBeNull();
    } finally {
      await B.cleanup();
    }
  });
});
