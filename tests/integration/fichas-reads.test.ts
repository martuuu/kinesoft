/**
 * FC · lecturas de fichas (C-FC3 «Lecturas», brief T4 Anexo B; tests del Anexo C «FC-2b»).
 *
 * FC-1b1: el DTO ya trae `bodyDoc`, `diagnoses`, `authorLicense`, `importSource` y `lateEntry` en las tres lecturas
 * (timeline por SQL crudo, drawer del turno y resumen por `CLINICAL_NOTE_SELECT`): esos `it` pasan. `sharedDocument`
 * (LEFT JOIN LATERAL del documento vivo) y `getPatientClinicalHome` son de FC-2b: `it.fails("[FC-2b] …")`, rojos a
 * propósito hasta que FC-2b los dé vuelta.
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
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
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

  // ── Rojos esperados: los da vuelta FC-2b ────────────────────────────────────────────────────────────────────

  it.fails("[FC-2b] `sharedDocument` none → live → stale", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    const page = await getPatientTimeline({ patientId: pid });
    const item = page?.items.find((i) => i.type === "note" && i.note.id === id);
    // Sin documento compartido: «none» (no null; null queda para las enmiendas). live/stale los suma FC-2b con
    // un PatientDocument sembrado (y su `sourceDigest` contra `hcSourceVersion`).
    expect(item?.type === "note" && item.note.sharedDocument).toEqual({ status: "none" });
  });

  it.fails("[FC-2b] getPatientClinicalHome: resumen + primera página + compositor + deep link", async () => {
    const { pid, id } = await seeded();
    asUser(A.userId);
    const home = await getPatientClinicalHome(pid, { timeline: true });
    expect(home?.summary.liveCount).toBe(1);
    expect(home?.summary.latest?.id).toBe(id);
    expect(home?.firstPage?.items.some((i) => i.type === "note" && i.note.id === id)).toBe(true);
    expect(home?.composer).not.toBeNull();
    expect(home?.deepLink).toBeNull();
  });
});
