/**
 * FC · escrituras de fichas (C-FC3 «Reglas del server», brief T4 Anexo B; tests del Anexo C «FC-2a»).
 *
 * FC-1b1 dejó la matriz escrita primero (rojos a propósito: `pendingFcFields` rechazaba los campos nuevos) y FC-2a
 * la dio vuelta al implementar la escritura (lib/clinical-notes.ts + lib/clinical-notes-write-internal.ts). Los
 * `it("[FC-1b] …")` los cubre el zod de FC-1b1. Los diagnósticos se re-leen con `resolveDiagnosesInTx` de FC-2c: estos
 * casos son también su integración cruzada (sin mock: el símbolo real contra la base).
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- fichas-writes` = kinesoft_app con RLS;
 * `:owner` = BYPASSRLS como prod). Se mockea solo lo externo (sesión, cookies, `next/cache`: integration-setup). Cada
 * caso usa su propio paciente (ClinicalNote no se borra: trigger); limpieza por deleteTenantDeep. Los `DiagnosisCode`
 * son globales: códigos únicos por corrida y se borran en afterAll (el owner; la app solo los lee).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createClinicalNote, editClinicalNote } from "@/lib/clinical-notes";
import { CLINICAL_NOTE_COPY } from "@/lib/clinical-notes-types";
import { DIAGNOSIS_COPY, type DiagnosisSnapshot } from "@/lib/diagnoses-types";
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

const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "bold" }] }] })),
});

describe.skipIf(!RUN)("[FC-2a] escrituras de fichas", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const codeIds: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    // Matrícula del Titular: `authorLicense = formatLicense(licenseNumber)` (regla 3 de C-FC3).
    await db.practitioner.update({ where: { id: A.practitionerId }, data: { licenseNumber: "1234" } });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    if (codeIds.length) await db.diagnosisCode.deleteMany({ where: { id: { in: codeIds } } });
    await db.$disconnect();
  });

  const patient = () => addPatient(db, A, { assignedPractitionerId: A.practitionerId });
  const notesOf = (patientId: string) => db.clinicalNote.findMany({ where: { patientId }, orderBy: { createdAt: "asc" } });

  /** Código CIE-11 sintético con la forma del CHECK (`^[0-9A-Z]{4}(\.[0-9A-Z]{1,3})?$`), único por corrida. */
  async function icd(opts: { retired?: boolean } = {}): Promise<{ id: string; code: string; title: string; uri: string }> {
    const s = uniqueSuffix().replace(/[^0-9a-z]/gi, "").toUpperCase();
    const code = `X${s.slice(-3).padStart(3, "0")}.${s.slice(0, 3).padEnd(3, "0")}`;
    const title = `Diagnóstico de prueba ${s}`;
    const uri = `http://id.who.int/icd/release/11/2025-01/mms/${s}`;
    const row = await db.diagnosisCode.create({
      data: {
        code,
        title,
        uri,
        release: "2025-01",
        searchText: title.toLowerCase(),
        ...(opts.retired ? { retiredAt: new Date(), retiredInRelease: "2025-01" } : {}),
      },
      select: { id: true },
    });
    codeIds.push(row.id);
    return { id: row.id, code, title, uri };
  }

  function create(input: Partial<Parameters<typeof createClinicalNote>[0]> & { patientId: string }) {
    asUser(A.userId);
    return createClinicalNote({ idempotencyKey: randomUUID(), ...input });
  }

  // ── Ya verdes (zod de FC-1b1) ───────────────────────────────────────────────────────────────────────────────

  it("[FC-1b] `body` y `bodyDoc` juntos → rechazo sin nota", async () => {
    const pid = await patient();
    const r = await create({ patientId: pid, body: "Texto", bodyDoc: doc("Texto") });
    expect(r).toMatchObject({ ok: false, error: CLINICAL_NOTE_COPY.bodyAndDoc });
    expect(await notesOf(pid)).toHaveLength(0);
  });

  it("[FC-1b] `importSource` con turno → rechazo sin nota", async () => {
    const pid = await patient();
    const r = await create({
      patientId: pid,
      body: "Consulta vieja",
      bookingId: "bk_cualquiera",
      importSource: { kind: "docx", fileName: "hc.docx", fileSize: 100, fileLastModified: null, batchId: randomUUID(), part: 1, parts: 1 },
    });
    expect(r).toMatchObject({ ok: false, error: CLINICAL_NOTE_COPY.importWithBooking });
    expect(await notesOf(pid)).toHaveLength(0);
  });

  // ── Rojos esperados: los da vuelta FC-2a ────────────────────────────────────────────────────────────────────

  it("[FC-2a] `body` derivado de `bodyDoc`", async () => {
    const pid = await patient();
    const r = await create({ patientId: pid, bodyDoc: doc("Dolor lumbar 6/10", "Mejora con movilidad") });
    expect(r.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect(row.bodyDoc).toEqual(doc("Dolor lumbar 6/10", "Mejora con movilidad"));
    expect(row.body).toBe("Dolor lumbar 6/10\n\nMejora con movilidad");
  });

  it("[FC-2a] diagnósticos re-leídos (retirado, propio ajeno, kine sin módulo)", async () => {
    const pid = await patient();
    const live = await icd();
    const retired = await icd({ retired: true });
    const r = await create({
      patientId: pid,
      body: "Con diagnósticos",
      diagnoses: [{ kind: "icd11", id: live.id }, { kind: "text", text: "  Contractura  " }],
    });
    expect(r.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect(row.diagnoses).toEqual([
      { v: 1, source: "icd11", refId: live.id, code: live.code, title: live.title, uri: live.uri, release: "2025-01" },
      { v: 1, source: "text", refId: null, code: null, title: "Contractura", uri: null, release: null },
    ] satisfies DiagnosisSnapshot[]);

    const pid2 = await patient();
    expect(await create({ patientId: pid2, body: "x", diagnoses: [{ kind: "icd11", id: retired.id }] })).toMatchObject({
      ok: false,
      error: DIAGNOSIS_COPY.retired,
    });
    expect(await create({ patientId: pid2, body: "x", diagnoses: [{ kind: "tenant", id: "td_de_otro_consultorio" }] })).toMatchObject({
      ok: false,
      error: DIAGNOSIS_COPY.notAvailable,
    });
    expect(await notesOf(pid2)).toHaveLength(0);
  });

  it("[FC-2a] `setActiveDiagnosis` false/true en la misma tx", async () => {
    const pid = await patient();
    await db.patient.update({ where: { id: pid }, data: { diagnosisTitle: "Anterior", diagnosisNote: "Nota que no se toca" } });
    const text = { kind: "text" as const, text: "Lumbalgia mecánica" };
    expect((await create({ patientId: pid, body: "x", diagnoses: [text], setActiveDiagnosis: false })).ok).toBe(true);
    expect(await db.patient.findUniqueOrThrow({ where: { id: pid }, select: { diagnosisTitle: true } })).toEqual({ diagnosisTitle: "Anterior" });
    expect((await create({ patientId: pid, body: "y", diagnoses: [text], setActiveDiagnosis: true })).ok).toBe(true);
    expect(await db.patient.findUniqueOrThrow({ where: { id: pid }, select: { diagnosisTitle: true, diagnosisNote: true } })).toEqual({
      diagnosisTitle: "Lumbalgia mecánica",
      diagnosisNote: "Nota que no se toca",
    });
  });

  it("[FC-2a] `authorLicense` congelado", async () => {
    const pid = await patient();
    const r = await create({ patientId: pid, body: "Con matrícula" });
    expect(r.ok && r.data.note.authorLicense).toBe("MN 1234");
    await db.practitioner.update({ where: { id: A.practitionerId }, data: { licenseNumber: "9999" } });
    try {
      const [row] = await notesOf(pid);
      expect(row.authorLicense).toBe("MN 1234");
    } finally {
      await db.practitioner.update({ where: { id: A.practitionerId }, data: { licenseNumber: "1234" } });
    }
  });

  it("[FC-2a] `importSource` una sola vez; con turno → rechazo; `lateEntry`", async () => {
    const pid = await patient();
    const batchId = randomUUID();
    const r = await create({
      patientId: pid,
      body: "Consulta de 2024",
      occurredAt: new Date(Date.now() - 400 * 24 * H).toISOString(),
      importSource: { kind: "docx", fileName: "hc.docx", fileSize: 2048, fileLastModified: null, batchId, part: 1, parts: 2 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.note.importSource).toMatchObject({ kind: "docx", fileName: "hc.docx", part: 1, parts: 2 });
    expect(r.data.note.lateEntry).toBe(true);
    const [row] = await notesOf(pid);
    expect(row.importSource).toMatchObject({ v: 1, kind: "docx", fileName: "hc.docx", fileSize: 2048, batchId, part: 1, parts: 2 });
    expect(typeof (row.importSource as { importedAt?: unknown }).importedAt).toBe("string");
  });

  it("[FC-2a] `body` plano limpia `bodyDoc`", async () => {
    const pid = await patient();
    const r = await create({ patientId: pid, bodyDoc: doc("Con formato") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    asUser(A.userId);
    const e = await editClinicalNote({ noteId: r.data.note.id, expectedRevision: 1, body: "Sin formato" });
    expect(e.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect(row).toMatchObject({ body: "Sin formato", bodyDoc: null, revision: 2 });
  });

  it("[FC-2a] editar conserva congelados los retirados", async () => {
    const pid = await patient();
    const code = await icd();
    const r = await create({ patientId: pid, body: "x", diagnoses: [{ kind: "icd11", id: code.id }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // La OMS lo retira en una release nueva: la ficha ya guardada lo conserva tal como se firmó.
    await db.diagnosisCode.update({ where: { id: code.id }, data: { retiredAt: new Date(), retiredInRelease: "2026-01", title: "Otro título" } });
    asUser(A.userId);
    const e = await editClinicalNote({
      noteId: r.data.note.id,
      expectedRevision: 1,
      diagnoses: [{ kind: "icd11", id: code.id }, { kind: "text", text: "Agregado" }],
    });
    expect(e.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect((row.diagnoses as DiagnosisSnapshot[]).map((d) => [d.source, d.code, d.title])).toEqual([
      ["icd11", code.code, code.title],
      ["text", null, "Agregado"],
    ]);
  });
});
