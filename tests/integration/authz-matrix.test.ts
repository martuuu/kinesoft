/**
 * Matriz de autorización cross-tenant (A1.1, 2026-09-29) — esqueleto
 * table-driven que A2/A3 y el Bloque B amplían fila por fila.
 *
 * Por qué importa: en prod la conexión tiene BYPASSRLS, así que el
 * `where: { tenantId }` a mano es la ÚNICA barrera, y los chequeos de FK
 * saltean RLS (un id ajeno se persiste aun con el rol app). Cada fila llama a
 * la action REAL como actor del tenant A con ids del tenant B y afirma que
 * rechaza SIN escribir. Lo que hoy falla va con `it.fails("[sesión] …")`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  updateBooking,
  deleteBooking,
  setBookingStatus,
} from "@/lib/bookings";
import {
  setPatientCoverage,
  updatePatient,
  setPatientDiagnosis,
  createProgram,
  recordEvaScore,
  updateProgram,
  setProgramStatus,
  deleteProgram,
  deleteSession,
  setPatientArchived,
  bulkArchivePatients,
  getPatientActivity,
} from "@/lib/patients";
import { exportPatientsCsv as exportPatientsCsvFor } from "@/lib/patients-export-internal";
import { getActor } from "@/lib/session";
import { listPatientFiles, uploadPatientFile, deletePatientFile, getDownloadUrl } from "@/lib/files";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

/** Revisión A2: el export es server-only con firma `(actor, opts)`; la ruta le pasa su actor. */
const exportPatientsCsv = async (opts?: Parameters<typeof exportPatientsCsvFor>[1]) =>
  exportPatientsCsvFor(await getActor(), opts);

const RUN = process.env.INTEGRATION === "1";

type Ctx = {
  A: EphemeralTenant;
  B: EphemeralTenant;
  patA: string;
  patB: string;
  bookingB: string;
  fileB: string;
  programB: string;
  sessionB: string;
};
type Row = {
  name: string;
  /** Sesión que la tiene que dar vuelta; ausente = hoy ya rechaza. */
  failsUntil?: string;
  act: (c: Ctx) => Promise<{ ok: boolean }>;
  /** Cuenta filas que NO deberían haber cambiado/aparecido. */
  untouched: (c: Ctx, db: PrismaClient) => Promise<unknown>;
};

const when = (d: string) => new Date(localToARIso(`${d}T10:00:00`)).toISOString();

/** FormData con un PDF chico (el gate tiene que cortar antes del storage). */
function pdfForm(name: string): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" }));
  fd.set("category", "REPORT");
  return fd;
}

/**
 * Fixture de HC de un paciente: un plan con una sesión, un archivo (stub, sin
 * storage) y un evento de audit sobre el paciente. Se crea con el owner client.
 */
async function seedHc(db: PrismaClient, t: EphemeralTenant, patientId: string) {
  const program = await db.treatmentProgram.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      title: "Lumbalgia crónica",
      totalSessions: 4,
      startDate: new Date(when("2027-08-01")),
      sessions: {
        create: [
          { practitionerId: t.practitionerId, index: 1, scheduledFor: new Date(when("2027-08-01")) },
          { practitionerId: t.practitionerId, index: 2, scheduledFor: new Date(when("2027-08-04")) },
        ],
      },
    },
    include: { sessions: true },
  });
  const file = await db.patientFile.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      name: "resonancia.pdf",
      mime: "application/pdf",
      sizeBytes: 4,
      storageKey: `stub:${randomUUID()}`,
      category: "REPORT",
    },
  });
  await db.auditEvent.create({
    data: { tenantId: t.tenantId, action: "patient.update", entity: "Patient", entityId: patientId },
  });
  return { programId: program.id, sessionId: program.sessions[0].id, fileId: file.id };
}

const ROWS: Row[] = [
  {
    name: "createBooking con paciente de B",
    act: (c) =>
      createBooking({ patientId: c.patB, serviceId: c.A.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-01"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { patientId: c.patB, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBookingsBatch con paciente de B",
    act: (c) =>
      createBookingsBatch({ patientId: c.patB, serviceId: c.A.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-02"), count: 1, idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { patientId: c.patB, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBooking con profesional de B",
    act: (c) =>
      createBooking({ patientId: c.patA, serviceId: c.A.serviceId, practitionerId: c.B.practitionerId, scheduledFor: when("2027-09-03"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { practitionerId: c.B.practitionerId, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBooking con servicio de B",
    act: (c) =>
      createBooking({ patientId: c.patA, serviceId: c.B.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-04"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { serviceId: c.B.serviceId, tenantId: c.A.tenantId } }),
  },
  {
    name: "updateBooking de un turno de B",
    act: (c) => updateBooking({ id: c.bookingB, notes: "pisado por A" }),
    untouched: (c, db) => db.booking.count({ where: { id: c.bookingB, notes: "pisado por A" } }),
  },
  {
    name: "setBookingStatus de un turno de B",
    act: (c) => setBookingStatus(c.bookingB, "CANCELLED"),
    untouched: (c, db) => db.booking.count({ where: { id: c.bookingB, status: "CANCELLED" } }),
  },
  {
    name: "deleteBooking de un turno de B",
    act: (c) => deleteBooking(c.bookingB),
    untouched: async (c, db) => ((await db.booking.count({ where: { id: c.bookingB } })) === 1 ? 0 : 1),
  },
  {
    name: "updatePatient de un paciente de B",
    act: (c) => updatePatient({ id: c.patB, notes: "pisado por A" }),
    untouched: (c, db) => db.patient.count({ where: { id: c.patB, notes: "pisado por A" } }),
  },
  {
    name: "setPatientCoverage de un paciente de B",
    act: (c) => setPatientCoverage({ patientId: c.patB, insurerName: "Colada" }),
    untouched: (c, db) => db.coverage.count({ where: { patientId: c.patB, insurer: "Colada" } }),
  },
  // ── A2b-S-vis: archivos y mutaciones de HC ──
  {
    name: "uploadPatientFile a un paciente de B",
    act: (c) => uploadPatientFile(c.patB, pdfForm("colado-a.pdf")),
    untouched: (c, db) => db.patientFile.count({ where: { patientId: c.patB, name: "colado-a.pdf" } }),
  },
  {
    name: "deletePatientFile de un archivo de B",
    act: (c) => deletePatientFile(c.fileB),
    untouched: async (c, db) => ((await db.patientFile.count({ where: { id: c.fileB } })) === 1 ? 0 : 1),
  },
  {
    name: "getDownloadUrl de un archivo de B",
    act: (c) => getDownloadUrl(c.fileB),
    untouched: (c, db) => db.auditEvent.count({ where: { action: "patientFile.download", entityId: c.fileB } }),
  },
  {
    name: "setPatientDiagnosis de un paciente de B",
    act: (c) => setPatientDiagnosis(c.patB, "Pisado por A", "x"),
    untouched: (c, db) => db.patient.count({ where: { id: c.patB, diagnosisTitle: "Pisado por A" } }),
  },
  {
    name: "createProgram para un paciente de B",
    act: (c) => createProgram({ patientId: c.patB, title: "Colado por A", totalSessions: 2, frequency: 1, startDate: new Date() }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { patientId: c.patB, title: "Colado por A" } }),
  },
  {
    name: "recordEvaScore de un paciente de B",
    act: (c) => recordEvaScore({ patientId: c.patB, value: 7, source: "colado-a" }),
    untouched: (c, db) => db.evaScore.count({ where: { patientId: c.patB, source: "colado-a" } }),
  },
  {
    name: "updateProgram de un plan de B",
    act: (c) => updateProgram({ id: c.programB, title: "Pisado por A" }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { id: c.programB, title: "Pisado por A" } }),
  },
  {
    name: "setProgramStatus de un plan de B",
    act: (c) => setProgramStatus({ id: c.programB, status: "CANCELLED" }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { id: c.programB, status: "CANCELLED" } }),
  },
  {
    name: "deleteSession de una sesión de B",
    act: (c) => deleteSession(c.sessionB),
    untouched: async (c, db) => ((await db.session.count({ where: { id: c.sessionB } })) === 1 ? 0 : 1),
  },
  {
    name: "deleteProgram de un plan de B",
    act: (c) => deleteProgram(c.programB),
    untouched: async (c, db) => ((await db.treatmentProgram.count({ where: { id: c.programB } })) === 1 ? 0 : 1),
  },
  {
    name: "setPatientArchived de un paciente de B",
    act: (c) => setPatientArchived({ id: c.patB, archived: true }),
    untouched: (c, db) => db.patient.count({ where: { id: c.patB, archivedAt: { not: null } } }),
  },
  {
    name: "bulkArchivePatients con un paciente de B",
    act: (c) => bulkArchivePatients({ ids: [c.patA, c.patB], archived: true }),
    untouched: (c, db) => db.patient.count({ where: { id: { in: [c.patA, c.patB] }, archivedAt: { not: null } } }),
  },
];

describe.skipIf(!RUN)("autorización cross-tenant (actor de A con ids de B)", () => {
  let db: PrismaClient;
  const ctx = {} as Ctx;

  beforeAll(async () => {
    db = ownerClient();
    ctx.A = await createEphemeralTenant(db);
    ctx.B = await createEphemeralTenant(db);
    ctx.patA = await addPatient(db, ctx.A);
    ctx.patB = await addPatient(db, ctx.B);
    const bk = await db.booking.create({
      data: {
        tenantId: ctx.B.tenantId,
        patientId: ctx.patB,
        practitionerId: ctx.B.practitionerId,
        serviceId: ctx.B.serviceId,
        scheduledFor: new Date(when("2027-09-10")),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    ctx.bookingB = bk.id;
    const hcB = await seedHc(db, ctx.B, ctx.patB);
    ctx.fileB = hcB.fileId;
    ctx.programB = hcB.programId;
    ctx.sessionB = hcB.sessionId;
    asUser(ctx.A.userId);
  });

  afterAll(async () => {
    await ctx.A?.cleanup();
    await ctx.B?.cleanup();
    await db?.$disconnect();
  });

  for (const row of ROWS) {
    const title = row.failsUntil ? `[${row.failsUntil}] ${row.name} → rechaza sin escribir` : `${row.name} → rechaza sin escribir`;
    (row.failsUntil ? it.fails : it)(title, async () => {
      const r = await row.act(ctx);
      expect(r.ok).toBe(false);
      expect(await row.untouched(ctx, db)).toBe(0);
    });
  }

  // ── A2b-S-vis: lecturas de HC con ids de B → vacío ──
  it("listPatientFiles de un paciente de B → []", async () => {
    expect(await listPatientFiles(ctx.patB)).toEqual([]);
  });

  it("getPatientActivity de un paciente de B → []", async () => {
    expect(await getPatientActivity(ctx.patB)).toEqual([]);
  });

  it("exportPatientsCsv con ids de B → no los incluye", async () => {
    const csv = await exportPatientsCsv({ ids: [ctx.patB] });
    expect(csv).not.toContain(ctx.patB);
    expect(csv.trim().split("\n")).toHaveLength(1); // solo el header
  });
});

/**
 * A2b-S-vis — acceso BÁSICO en el mismo tenant (decisión del dueño 30-sep:
 * "acceso básico = solo ver"). Un PRACTITIONER sin asignación ni share sobre
 * el paciente no puede leer ni tocar su HC. El control positivo (el asignado
 * sí puede) vive en tests/integration/visibility.test.ts.
 */
type BasicCtx = {
  T: EphemeralTenant;
  basicUserId: string;
  pat: string;
  fileId: string;
  programId: string;
  sessionId: string;
};
type BasicRow = {
  name: string;
  act: (c: BasicCtx) => Promise<{ ok: boolean }>;
  untouched: (c: BasicCtx, db: PrismaClient) => Promise<unknown>;
};

const BASIC_ROWS: BasicRow[] = [
  {
    name: "uploadPatientFile",
    act: (c) => uploadPatientFile(c.pat, pdfForm("colado-basico.pdf")),
    untouched: (c, db) => db.patientFile.count({ where: { patientId: c.pat, name: "colado-basico.pdf" } }),
  },
  {
    name: "deletePatientFile",
    act: (c) => deletePatientFile(c.fileId),
    untouched: async (c, db) => ((await db.patientFile.count({ where: { id: c.fileId } })) === 1 ? 0 : 1),
  },
  {
    name: "getDownloadUrl (sin audit de descarga)",
    act: (c) => getDownloadUrl(c.fileId),
    untouched: (c, db) => db.auditEvent.count({ where: { action: "patientFile.download", entityId: c.fileId } }),
  },
  {
    name: "setPatientDiagnosis",
    act: (c) => setPatientDiagnosis(c.pat, "Pisado por básico", "x"),
    untouched: (c, db) => db.patient.count({ where: { id: c.pat, diagnosisTitle: "Pisado por básico" } }),
  },
  {
    name: "createProgram",
    act: (c) => createProgram({ patientId: c.pat, title: "Colado por básico", totalSessions: 2, frequency: 1, startDate: new Date() }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { patientId: c.pat, title: "Colado por básico" } }),
  },
  {
    name: "recordEvaScore",
    act: (c) => recordEvaScore({ patientId: c.pat, value: 3, source: "colado-basico" }),
    untouched: (c, db) => db.evaScore.count({ where: { patientId: c.pat, source: "colado-basico" } }),
  },
  {
    name: "updateProgram",
    act: (c) => updateProgram({ id: c.programId, title: "Pisado por básico" }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { id: c.programId, title: "Pisado por básico" } }),
  },
  {
    name: "setProgramStatus",
    act: (c) => setProgramStatus({ id: c.programId, status: "CANCELLED" }),
    untouched: (c, db) => db.treatmentProgram.count({ where: { id: c.programId, status: "CANCELLED" } }),
  },
  {
    name: "deleteSession",
    act: (c) => deleteSession(c.sessionId),
    untouched: async (c, db) => ((await db.session.count({ where: { id: c.sessionId } })) === 1 ? 0 : 1),
  },
  {
    name: "deleteProgram",
    act: (c) => deleteProgram(c.programId),
    untouched: async (c, db) => ((await db.treatmentProgram.count({ where: { id: c.programId } })) === 1 ? 0 : 1),
  },
  {
    name: "setPatientArchived",
    act: (c) => setPatientArchived({ id: c.pat, archived: true }),
    untouched: (c, db) => db.patient.count({ where: { id: c.pat, archivedAt: { not: null } } }),
  },
  {
    name: "bulkArchivePatients",
    act: (c) => bulkArchivePatients({ ids: [c.pat], archived: true }),
    untouched: (c, db) => db.patient.count({ where: { id: c.pat, archivedAt: { not: null } } }),
  },
];

describe.skipIf(!RUN)("autorización por acceso básico (mismo tenant, sin asignación ni share)", () => {
  let db: PrismaClient;
  const ctx = {} as BasicCtx;

  beforeAll(async () => {
    db = ownerClient();
    ctx.T = await createEphemeralTenant(db);
    const kine = await addPractitioner(db, ctx.T, "PRACTITIONER");
    ctx.basicUserId = kine.userId;
    // Asignado al OWNER: el segundo profesional queda con acceso "basic".
    ctx.pat = await addPatient(db, ctx.T, {
      email: "privado@test.local",
      phone: "1155554444",
      assignedPractitionerId: ctx.T.practitionerId,
    });
    await db.patient.update({ where: { id: ctx.pat }, data: { diagnosisTitle: "Original" } });
    const hc = await seedHc(db, ctx.T, ctx.pat);
    ctx.fileId = hc.fileId;
    ctx.programId = hc.programId;
    ctx.sessionId = hc.sessionId;
    asUser(ctx.basicUserId);
  });

  afterAll(async () => {
    await ctx.T?.cleanup();
    await db?.$disconnect();
  });

  for (const row of BASIC_ROWS) {
    it(`${row.name} de un paciente con acceso básico → rechaza sin escribir`, async () => {
      const r = await row.act(ctx);
      expect(r.ok).toBe(false);
      expect(await row.untouched(ctx, db)).toBe(0);
    });
  }

  it("listPatientFiles con acceso básico → []", async () => {
    expect(await listPatientFiles(ctx.pat)).toEqual([]);
  });

  it("getPatientActivity con acceso básico → []", async () => {
    expect(await getPatientActivity(ctx.pat)).toEqual([]);
  });

  it("exportPatientsCsv con acceso básico → la fila sale sin email ni teléfono", async () => {
    const csv = await exportPatientsCsv({ ids: [ctx.pat] });
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(ctx.pat);
    expect(csv).not.toContain("privado@test.local");
    expect(csv).not.toContain("1155554444");
    expect(csv).not.toContain("Lumbalgia");
  });
});
