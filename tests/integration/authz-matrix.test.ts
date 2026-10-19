/**
 * Matriz de autorización cross-tenant (A1.1, 2026-09-29) — esqueleto
 * table-driven que A2/A3 y el Bloque B amplían fila por fila.
 *
 * Por qué importa: en prod la conexión tiene BYPASSRLS, así que el
 * `where: { tenantId }` a mano es la ÚNICA barrera, y los chequeos de FK
 * saltean RLS (un id ajeno se persiste aun con el rol app). Cada fila llama a
 * la action REAL como actor del tenant A con ids del tenant B y afirma que
 * rechaza SIN escribir. Lo que hoy falla va con `it.fails("[sesión] …")`.
 *
 * [FC-1e] Fila «FC · portal «Documentos»» (T4, C-FC8): ninguna columna de staff baja el PDF compartido por el portal
 * (→ 404). Nació `it.fails("[FC-2h] …")`; FC-2i la dio vuelta (la ruta existe).
 * [FC-2i] Filas de fichas (T4): compartir/revocar, diagnósticos propios, logo/firma y las descargas del equipo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  updateBooking,
  deleteBooking,
  setBookingStatus,
  setBookingCopagoPaid,
  setBookingInsurerPaid,
} from "@/lib/bookings";
import {
  setPatientCoverage,
  updatePatient,
  setPatientDiagnosis,
  recordEvaScore,
  setPatientArchived,
  bulkArchivePatients,
  getPatientActivity,
  setPatientShares,
  assignPatientToPractitioner,
} from "@/lib/patients";
import { setProgramStatus, deleteProgram, deleteSession } from "@/lib/programs";
import { createPlan } from "@/lib/plans";
import { updatePlanDetails } from "@/lib/plans-lifecycle";
import type { PlanCreateInput } from "@/lib/plans-types";
import { exportPatientsCsv as exportPatientsCsvFor } from "@/lib/patients-export-internal";
import { getActor } from "@/lib/session";
import { listPatientFiles, uploadPatientFile, deletePatientFile, getDownloadUrl } from "@/lib/files";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, currentTestUser } from "@/tests/helpers/actor";
import { cookies } from "next/headers";
import { ForbiddenError } from "@/lib/session";
import { ReadOnlyModeError } from "@/lib/tenant-access";
import { markReceptionAction } from "@/lib/bookings";
import { sendPatientPortalInvite } from "@/lib/patients";
import { previewPlan } from "@/lib/plans";
import type { PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { generatePlanBookings, previewGeneratePlanBookings } from "@/lib/plans-adopt";
import { renewPlanAuthorization } from "@/lib/plans-edit";
import { getPlanDetail, getPatientPlanBalances } from "@/lib/plans-read";
import { decidePatientPortalRequest } from "@/lib/patient-portal-requests";
import { createClinicalNote, voidClinicalNote } from "@/lib/clinical-notes";
import { shareClinicalNoteWithPatient, revokePatientDocument } from "@/lib/patient-documents";
import { searchDiagnoses, createTenantDiagnosis } from "@/lib/diagnoses";
import { removeTenantLogo, updateOwnSignatureInfo } from "@/lib/practice-assets";
import { GET as getFichaDownload } from "@/app/api/pacientes/[id]/fichas/[noteId]/[format]/route";
import { GET as getRecordDownload } from "@/app/api/pacientes/[id]/historia-clinica/[format]/route";
import { getPatientTimeline, getPatientClinicalSummary } from "@/lib/clinical-notes-read";
import { getBillingOverview, previewPlanChange, applyPlanChange, submitPaymentReceipt, getReceiptUrl } from "@/lib/saas-billing";
import { setSharedPatientView, setPublicBookingEnabled, updateTenantBasics } from "@/lib/tenant-settings";
import { addSessionExercise } from "@/lib/sessions";
import { exportBookingsIcs } from "@/lib/bookings-export-internal";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { createPlan as insertPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { endSupportAccessForTenant } from "@/lib/support-session-tenant";
import { createInvitation } from "@/lib/invitations";

// ES4-S26b: abrir la sesión de soporte y cambiar el plan SaaS piden step-up de 2FA (frontera externa: TOTP/cookie).
// Se mockea SOLO eso, como patient-portal-requests.test.ts; la barrera bajo test (capabilities, solo lectura) es real.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

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
  programBUpdatedAt: string;
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

/**
 * P3-S27a: las filas del alta y la edición de planes pasaron de las puertas
 * viejas de `lib/programs.ts` (retiradas) a `createPlan` / `updatePlanDetails`.
 * `createPlan` sin preview lleva un `stateToken` inventado: si el gate NO
 * cortara, el commit devolvería `stale-preview`, que también es `ok: false`.
 * `gateCut` hace fallar ese caso para que el verde sea del gate y no del token.
 */
function planDraft(t: EphemeralTenant, patientId: string, title: string): PlanCreateInput {
  return {
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: t.practitionerId,
    serviceId: t.serviceId,
    locationId: null,
    title,
    schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] },
    startDayKey: "2030-01-07",
    totalSessions: 2,
    pricing: null,
    rows: [],
    stateToken: "sin-preview",
  };
}
async function gateCut(r: Promise<{ ok: boolean; kind?: string }>): Promise<{ ok: boolean }> {
  const out = await r;
  if (!out.ok && out.kind === "stale-preview") throw new Error("stale-preview: el gate no cortó antes del motor");
  return out;
}

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
  return {
    programId: program.id,
    programUpdatedAt: program.updatedAt.toISOString(),
    sessionId: program.sessions[0].id,
    fileId: file.id,
  };
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
    name: "createPlan para un paciente de B",
    act: (c) => gateCut(createPlan(planDraft(c.A, c.patB, "Colado por A"))),
    untouched: (c, db) => db.treatmentProgram.count({ where: { patientId: c.patB, title: "Colado por A" } }),
  },
  {
    name: "recordEvaScore de un paciente de B",
    act: (c) => recordEvaScore({ patientId: c.patB, value: 7, source: "colado-a" }),
    untouched: (c, db) => db.evaScore.count({ where: { patientId: c.patB, source: "colado-a" } }),
  },
  {
    name: "updatePlanDetails de un plan de B",
    act: (c) => updatePlanDetails({ programId: c.programB, expectedUpdatedAt: c.programBUpdatedAt, title: "Pisado por A" }),
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

/**
 * P0-S07sb (Planes E1): columna ASSISTANT. La Secretaria tiene
 * `agenda.operateAll`, que NO mira el nivel de acceso: si un write-path
 * dependiera de él para cortar un id ajeno (`patientAccessFor` da "none"),
 * la Secretaria lo saltearía. Por eso la misma matriz corre también con un
 * ASSISTANT del tenant A.
 */
for (const who of ["OWNER", "ASSISTANT"] as const) describe.skipIf(!RUN)(
  who === "OWNER"
    ? "autorización cross-tenant (actor de A con ids de B)"
    : "autorización cross-tenant (actor de A con ids de B) · ASSISTANT (P0-S07sb)",
  () => {
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
    ctx.programBUpdatedAt = hcB.programUpdatedAt;
    ctx.sessionB = hcB.sessionId;
    asUser(who === "OWNER" ? ctx.A.userId : (await addPractitioner(db, ctx.A, "ASSISTANT")).userId);
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
  }
);

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
  programUpdatedAt: string;
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
    name: "createPlan",
    act: (c) => gateCut(createPlan(planDraft(c.T, c.pat, "Colado por básico"))),
    untouched: (c, db) => db.treatmentProgram.count({ where: { patientId: c.pat, title: "Colado por básico" } }),
  },
  {
    name: "recordEvaScore",
    act: (c) => recordEvaScore({ patientId: c.pat, value: 3, source: "colado-basico" }),
    untouched: (c, db) => db.evaScore.count({ where: { patientId: c.pat, source: "colado-basico" } }),
  },
  {
    name: "updatePlanDetails",
    act: (c) => updatePlanDetails({ programId: c.programId, expectedUpdatedAt: c.programUpdatedAt, title: "Pisado por básico" }),
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

/**
 * P0-S07sb: la misma matriz de HC con la Secretaria (ASSISTANT, nivel `admin`
 * de PD-13). Opera turnos (`agenda.operateAll`) pero no toca nada clínico:
 * archivos, diagnóstico, EVA, planes y sesiones siguen rechazados, igual que
 * para un profesional en básico.
 */
for (const who of ["PRACTITIONER", "ASSISTANT"] as const) describe.skipIf(!RUN)(
  who === "PRACTITIONER"
    ? "autorización por acceso básico (mismo tenant, sin asignación ni share)"
    : "autorización por nivel admin (mismo tenant) · ASSISTANT (P0-S07sb)",
  () => {
  let db: PrismaClient;
  const ctx = {} as BasicCtx;

  beforeAll(async () => {
    db = ownerClient();
    ctx.T = await createEphemeralTenant(db);
    const kine = await addPractitioner(db, ctx.T, who);
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
    ctx.programUpdatedAt = hc.programUpdatedAt;
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

  // `admin` (PD-13) SÍ ve el contacto: la parte de email/teléfono es solo de básico.
  (who === "PRACTITIONER" ? it : it.skip)("exportPatientsCsv con acceso básico → la fila sale sin email ni teléfono", async () => {
    const csv = await exportPatientsCsv({ ids: [ctx.pat] });
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(ctx.pat);
    expect(csv).not.toContain("privado@test.local");
    expect(csv).not.toContain("1155554444");
    expect(csv).not.toContain("Lumbalgia");
  });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ES4-S26b · matriz de autorización del staff (brief ES4 §5)
//
// Columnas: X-tenant (Titular de OTRO consultorio con ids de K) · OWNER Kine · PRACTITIONER en acceso básico ·
// ASSISTANT (Secretaria) · ASSISTANT_CFG (Secretaria con «Configuración») · BILLING · ADMIN (Administrador/a de hoy: no
// atiende, con «Configuración» y «Planes y pagos», T3c-1i) · PRO_CFG (Profesional con «Configuración», decisión 4 del
// 19-oct) · OWNER de un consultorio GENERAL (sobre lo suyo) · SUPPORT (superadmin con una sesión REAL de `startSupport`
// sobre K). Cada celda llama al símbolo real que corre en prod con el `getActor()` real. Las columnas nuevas de T3 solo
// llevan celda en las filas donde el rol cambia algo (cobros, pacientes, lo delicado de Configuración, portal, HC).
//
// Regla de la sesión (brief §5): se afirma lo que hace el código HOY. Si eso contradice PD-13 o C-PL, la celda va
// con `it.fails("[ES4-S26b] …")` y es un hallazgo (no se arregla en una sesión de tests). Si solo difiere del brief
// (el brief simplificó o quedó viejo) se afirma el código y la diferencia queda anotada en `note`.
//
// Anti-falso-verde: cada ✅ afirma el EFECTO (la fila cambió) y cada ⛔/RO afirma `ok:false` + la fila intacta; así
// una celda «rechaza» no puede pasar porque la action no hizo nada por otro motivo. Fixture nueva por celda: ningún
// rechazo depende de lo que dejó la celda anterior.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════

type Col = "XT" | "OWNER" | "BASIC" | "ASSISTANT" | "ASSISTANT_CFG" | "BILLING" | "ADMIN" | "PRO_CFG" | "GENERAL" | "SUPPORT";
const COLS: readonly Col[] = ["XT", "OWNER", "BASIC", "ASSISTANT", "ASSISTANT_CFG", "BILLING", "ADMIN", "PRO_CFG", "GENERAL", "SUPPORT"];
/**
 * ok = ✅ (escribe / ve) · deny = ⛔ sin escribir / sin ver · ro = solo lectura de soporte (`ok:false`, intacto) ·
 * isolated = action sin ids de entrada: el actor de otro consultorio opera el SUYO, y K queda intacto.
 */
type Exp = "ok" | "deny" | "ro" | "isolated";
type Cell = { exp: Exp; fails?: string; note?: string };
type Cells = Partial<Record<Col, Exp | Cell>>;

/** Lo que una celda tiene a mano. `host` = el consultorio dueño de la fixture (K, o G en la columna GENERAL). */
type Fx = {
  host: EphemeralTenant;
  col: Col;
  patientId: string;
  /** Profesional del turno de la fixture (en BASIC, el propio: «✅ propios»). */
  practitionerId: string;
  [k: string]: unknown;
};

type WriteRow = {
  kind: "write";
  name: string;
  cells: Cells;
  setup?: (fx: Fx) => Promise<void>;
  act: (fx: Fx) => Promise<{ ok: boolean }>;
  /** ¿Se produjo el efecto en la fila de `host`? (✅ → true; ⛔/RO/isolated → false). */
  effect: (fx: Fx, db: PrismaClient) => Promise<boolean>;
};
type ReadRow = {
  kind: "read";
  name: string;
  cells: Cells;
  setup?: (fx: Fx) => Promise<void>;
  /** ¿El actor vio el dato de `host`? (✅ → true; ∅/⛔ → false). */
  seen: (fx: Fx) => Promise<boolean>;
};
type MatrixRow = WriteRow | ReadRow;

/** Los rechazos que algunas actions TIRAN en vez de devolver `{ok:false}` (getBillingOverview, requireTenantAdmin). Otro error se propaga. */
async function settle<T extends { ok: boolean }>(p: Promise<T>): Promise<{ ok: boolean }> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof ReadOnlyModeError) return { ok: false };
    throw e;
  }
}
async function resolves(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof ReadOnlyModeError) return false;
    throw e;
  }
}

/** Instante único por celda (el índice paciente-instante y el de profesional no interfieren con lo que se mide). */
let s26bSlot = 0;
const s26bAt = () => new Date(Date.parse("2031-03-03T13:00:00.000Z") + ++s26bSlot * 3 * 3_600_000);
/** Avisos de agenda confirmados (fuera de franja, sobreturno…): la matriz mide autorización, no disponibilidad. */
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true, allowSamePatientDay: true } as const;
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };
const allNone = (p: PlanPreview): PlanRowResolution[] => p.rows.map((r) => ({ index: r.index, kind: "none" }));
function acceptDefaultsS26b(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  ) as PlanRowResolution[];
}

describe.skipIf(!RUN)("ES4-S26b · matriz de autorización del staff (brief §5)", () => {
  let db: PrismaClient;
  /** Kine CONSULTORIO: planes, evoluciones, ejercicios globales, sala de espera. */
  let K: EphemeralTenant;
  /** Otro consultorio Kine (columna X-tenant). */
  let Other: EphemeralTenant;
  /** Consultorio GENERAL (sin planes, diagnóstico, evaluaciones ni ejercicios). */
  let G: EphemeralTenant;
  /** Consultorio «casa» del superadmin de soporte. */
  let H: EphemeralTenant;
  let basic: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  /** T3c-1i: Administrador/a de hoy (sin `Practitioner`, no atiende) con «Configuración» y «Planes y pagos». */
  let admin: { userId: string };
  /** T3c-1i: Secretaria con «Configuración» (sin lo delicado: corte de staff) y Profesional con «Configuración» (con). */
  let assistantCfg: { userId: string };
  let proCfg: { userId: string; practitionerId: string };
  /** Superadmin de las sesiones de soporte que la fila `endSupportAccessForTenant` termina (no el de la columna SUPPORT). */
  let fxSuperadminId = "";
  let supportCookie = "";
  let globalExerciseId = "";
  const portalUsers: string[] = [];

  /** Cambia el actor de la celda; SUPPORT = el superadmin H con la cookie de la sesión de soporte sobre K. */
  function become(col: Col) {
    cookies().delete(SUPPORT_COOKIE);
    const who: Record<Col, string> = {
      XT: Other.userId,
      OWNER: K.userId,
      BASIC: basic.userId,
      ASSISTANT: assistant.userId,
      ASSISTANT_CFG: assistantCfg.userId,
      BILLING: billing.userId,
      ADMIN: admin.userId,
      PRO_CFG: proCfg.userId,
      GENERAL: G.userId,
      SUPPORT: H.userId,
    };
    asUser(who[col]);
    if (col === "SUPPORT") cookies().set(SUPPORT_COOKIE, supportCookie);
  }

  /** Fixture base: un paciente del consultorio dueño, asignado al Titular (BASIC queda en acceso básico). */
  async function baseFx(col: Col): Promise<Fx> {
    const host = col === "GENERAL" ? G : K;
    const patientId = await addPatient(db, host, { email: `s26b-${uniqueSuffix()}@test.local` });
    const practitionerId = col === "BASIC" ? basic.practitionerId : host.practitionerId;
    return { host, col, patientId, practitionerId };
  }

  /** Turno de la fixture (insert directo, sin pasar por la action bajo test). */
  async function fxBooking(fx: Fx, over: { scheduledFor?: Date; title?: string } = {}) {
    const b = await db.booking.create({
      data: {
        tenantId: fx.host.tenantId,
        patientId: fx.patientId,
        practitionerId: fx.practitionerId,
        serviceId: fx.host.serviceId,
        scheduledFor: over.scheduledFor ?? s26bAt(),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
        title: over.title,
      },
    });
    fx.bookingId = b.id;
    fx.bookingUpdatedAt = b.updatedAt.toISOString();
  }

  /** Plan M1 por insert (plan-factory): sirve para gates que cortan antes del motor. */
  async function fxPlan(fx: Fx) {
    const p = await insertPlan(db, fx.host, { patientId: fx.patientId, sessions: 2 });
    fx.programId = p.programId;
    fx.sessionIds = p.sessionIds;
    fx.programUpdatedAt = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).updatedAt.toISOString();
  }

  /** Evolución sembrada con la action real por el Titular del consultorio dueño (después la celda cambia de actor). */
  async function fxNote(fx: Fx, body: string) {
    asUser(fx.host.userId);
    cookies().delete(SUPPORT_COOKIE);
    const r = await createClinicalNote({ patientId: fx.patientId, body, idempotencyKey: randomUUID() });
    if (!r.ok) throw new Error(`fixture createClinicalNote: ${r.error}`);
    fx.noteId = r.data.note.id;
    fx.noteRevision = r.data.note.revision;
  }

  /**
   * [FC-1e] Documento compartido vivo (insert directo de nota raíz + PatientDocument: acá se mide la puerta del portal,
   * no la action de compartir). El snapshot lleva un centinela que no puede salir por la ruta.
   */
  async function fxSharedDocument(fx: Fx) {
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const note = await db.clinicalNote.create({
      data: {
        tenantId: fx.host.tenantId,
        patientId: fx.patientId,
        kind: "EVOLUTION",
        body: "S26b nota de origen",
        occurredAt: new Date(Date.now() - 86_400_000),
        authorUserId: fx.host.userId,
        authorPractitionerId: fx.host.practitionerId,
        authorName: "Titular",
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    const snapshot = { v: 1, content: { fichas: [], centinela: "S26b documento compartido" }, meta: { purpose: "shared" } };
    const doc = await db.patientDocument.create({
      data: {
        tenantId: fx.host.tenantId,
        patientId: fx.patientId,
        noteId: note.id,
        noteRevision: 1,
        sourceDigest: sha(`src-${note.id}`),
        title: "Ficha compartida S26b",
        occurredAt: new Date(Date.now() - 86_400_000),
        snapshot,
        snapshotSha256: sha(JSON.stringify(snapshot)),
        pdfStorageKey: `stub:${note.id}`,
        pdfSha256: sha(`pdf-${note.id}`),
        pdfSizeBytes: 1000,
        sharedByUserId: fx.host.userId,
        sharedByPractitionerId: fx.host.practitionerId,
        sharedAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    fx.documentId = doc.id;
  }

  /**
   * [FC-1e] Llama a la ruta REAL del PDF del portal como el usuario de la celda, con la ficha de la fixture vinculada
   * a su cuenta (Patient es único por (tenantId, userId): se desvincula la anterior). ✅ = 200; ⛔ tiene que ser 404
   * sin audit de descarga. `import()` dinámico: sin la ruta (antes de FC-2h) la celda falla, no el archivo.
   */
  async function portalPdfSeenByCurrentUser(fx: Fx): Promise<boolean> {
    const me = currentTestUser();
    if (!me) throw new Error("la celda no tiene usuario");
    await db.patient.updateMany({ where: { tenantId: fx.host.tenantId, userId: me.id }, data: { userId: null } });
    await db.patient.update({ where: { id: fx.patientId }, data: { userId: me.id } });
    const spec = "@/app/(portal)/portal/c/[slug]/documentos/[id]/pdf/route";
    const { GET } = (await import(/* @vite-ignore */ spec)) as {
      GET: (req: Request, ctx: { params: { slug: string; id: string } }) => Promise<Response>;
    };
    const id = fx.documentId as string;
    __rateLimitInternals.reset();
    const res = await GET(
      new Request(`http://localhost/portal/c/${fx.host.slug}/documentos/${id}/pdf`, { headers: { "user-agent": "S26b" } }),
      { params: { slug: fx.host.slug, id } }
    );
    if (res.status === 200) return true;
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("S26b documento compartido");
    expect(await db.auditEvent.count({ where: { action: "patientDocument.download", entityId: id } })).toBe(0);
    return false;
  }

  const tenantRow = (id: string) => db.tenant.findUniqueOrThrow({ where: { id } });

  const ROWS_S26B: MatrixRow[] = [
    // ─────────────────────────────────────────── Turnos ───────────────────────────────────────────
    {
      kind: "write",
      name: "Turnos · createBooking",
      cells: { XT: "deny", OWNER: "ok", BASIC: { exp: "deny", note: "E1: el profesional opera turnos con acceso full; en básico, ni en su propia agenda" }, ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "ro" },
      act: (fx) => {
        fx.at = s26bAt().toISOString();
        // X-tenant: profesional y servicio propios (de Other) con el paciente de K.
        const own = fx.col === "XT" ? Other : fx.host;
        return createBooking({
          patientId: fx.patientId,
          serviceId: own.serviceId,
          practitionerId: fx.col === "XT" ? Other.practitionerId : fx.practitionerId,
          scheduledFor: fx.at as string,
          idempotencyKey: randomUUID(),
          ...FORCE,
        });
      },
      effect: async (fx, db) => (await db.booking.count({ where: { patientId: fx.patientId, scheduledFor: new Date(fx.at as string) } })) > 0,
    },
    {
      kind: "write",
      name: "Turnos · updateBooking (reprogramar)",
      cells: { XT: "deny", OWNER: "ok", BASIC: { exp: "deny", note: "E1: sin full no modifica, aunque el turno sea de su agenda" }, ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxBooking(fx),
      act: (fx) => {
        fx.to = s26bAt().toISOString();
        return updateBooking({ id: fx.bookingId as string, scheduledFor: fx.to as string, expectedUpdatedAt: fx.bookingUpdatedAt as string, ...FORCE });
      },
      effect: async (fx, db) => +(await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).scheduledFor === Date.parse(fx.to as string),
    },
    {
      kind: "write",
      name: "Turnos · setBookingStatus (cancelar)",
      cells: { XT: "deny", OWNER: "ok", BASIC: { exp: "deny", note: "E1: sin full no cancela, aunque el turno sea de su agenda" }, ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxBooking(fx),
      act: (fx) => setBookingStatus(fx.bookingId as string, "CANCELLED", fx.bookingUpdatedAt as string),
      effect: async (fx, db) => (await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).status === "CANCELLED",
    },
    {
      kind: "write",
      name: "Turnos · Recepción (markReceptionAction «ausente» de un turno de ayer)",
      cells: { XT: "deny", OWNER: "ok", BASIC: { exp: "ok", note: "propios: Recepción es administrativa (B4.1), sus turnos sin full" }, ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxBooking(fx, { scheduledFor: new Date(Date.now() - 26 * 3_600_000) }),
      act: (fx) => markReceptionAction(fx.bookingId as string, "ausente", fx.bookingUpdatedAt as string),
      effect: async (fx, db) => (await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).status === "NO_SHOW",
    },
    // ─────────────────────────────────────────── Cobros (T3, C-AS2) ───────────────────────────────────────────
    {
      kind: "write",
      name: "Cobros · setBookingCopagoPaid (efectivo)",
      // `canCollectCopago`: billing.collect (Titular, Admin, Secretaria, Facturación) cobra cualquier turno;
      // billing.collectOwn (Profesional) solo los suyos. En BASIC el turno es del propio profesional (`baseFx`).
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: { exp: "ok", note: "propio: billing.collectOwn" },
        ASSISTANT: { exp: "ok", note: "billing.collect (decisión 1 del 19-oct)" },
        BILLING: "ok",
        ADMIN: "ok",
        PRO_CFG: { exp: "deny", note: "turno del Titular: «Configuración» no suma billing.collect" },
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "SUPPORT_CAPS sin billing.*" },
      },
      setup: (fx) => fxBooking(fx),
      act: (fx) => setBookingCopagoPaid(fx.bookingId as string, { paid: true, method: "CASH" }, fx.bookingUpdatedAt as string),
      effect: async (fx, db) => {
        const b = await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } });
        return b.paymentStatus === "PAID" && b.copagoPaymentMethod === "CASH";
      },
    },
    {
      kind: "write",
      name: "Cobros · setBookingCopagoPaid de un turno ajeno",
      cells: { BASIC: { exp: "deny", note: "billing.collectOwn: solo sus turnos" } },
      setup: async (fx) => {
        fx.practitionerId = K.practitionerId;
        await fxBooking(fx);
      },
      act: (fx) => setBookingCopagoPaid(fx.bookingId as string, { paid: true, method: "CASH" }, fx.bookingUpdatedAt as string),
      effect: async (fx, db) => (await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).paymentStatus === "PAID",
    },
    {
      kind: "write",
      name: "Cobros · setBookingInsurerPaid (billing.manage)",
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: { exp: "deny", note: "la Secretaria cobra el copago, no confirma la OS" },
        BILLING: "ok",
        ADMIN: "ok",
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "SUPPORT_CAPS sin billing.*" },
      },
      setup: (fx) => fxBooking(fx),
      act: (fx) => setBookingInsurerPaid(fx.bookingId as string, true, fx.bookingUpdatedAt as string),
      effect: async (fx, db) => (await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).insurerPaidAt !== null,
    },
    // ─────────────────────────────────────────── Planes ───────────────────────────────────────────
    {
      kind: "write",
      name: "Planes · agendar sesión (previewGeneratePlanBookings → generatePlanBookings)",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: { exp: "deny", note: "sin `planes`" }, SUPPORT: "ro" },
      setup: async (fx) => {
        if (fx.host === G) return fxPlan(fx); // GENERAL no puede crear planes: el gate de módulo corta antes del motor.
        asUser(K.userId);
        cookies().delete(SUPPORT_COOKIE);
        const input = {
          idempotencyKey: randomUUID(),
          patientId: fx.patientId,
          discipline: "KINESIOLOGY" as const,
          practitionerId: K.practitionerId,
          serviceId: K.serviceId,
          locationId: null,
          title: "Plan S26b",
          schedule: LUN_10,
          startDayKey: "2031-01-06",
          totalSessions: 2,
          pricing: null,
          rows: [],
          stateToken: "x",
        };
        const p = await previewPlan(input);
        if (!p.ok) throw new Error(`fixture previewPlan: ${p.error}`);
        const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: allNone(p.preview) });
        if (!r.ok) throw new Error(`fixture createPlan: ${JSON.stringify(r)}`);
        fx.programId = r.programId;
      },
      act: async (fx) => {
        const p = await previewGeneratePlanBookings({ programId: fx.programId as string });
        if (!p.ok) return p;
        return generatePlanBookings({ programId: fx.programId as string, rows: acceptDefaultsS26b(p.preview), stateToken: p.preview.stateToken });
      },
      effect: async (fx, db) => (await db.booking.count({ where: { programId: fx.programId as string } })) > 0,
    },
    {
      kind: "write",
      name: "Planes · updatePlanDetails (plans.manage)",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: { exp: "deny", note: "no atiende: sin plans.manage (§20.17)" }, GENERAL: "deny", SUPPORT: "ro" },
      setup: fxPlan,
      act: (fx) => updatePlanDetails({ programId: fx.programId as string, expectedUpdatedAt: fx.programUpdatedAt as string, title: "S26b manage" }),
      effect: async (fx, db) => (await db.treatmentProgram.findUniqueOrThrow({ where: { id: fx.programId as string } })).title === "S26b manage",
    },
    {
      kind: "write",
      name: "Planes · renewPlanAuthorization (plans.authorize)",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "ok", BILLING: "deny", ADMIN: "ok", GENERAL: "deny", SUPPORT: "ro" },
      setup: fxPlan,
      act: (fx) => renewPlanAuthorization({ programId: fx.programId as string, expectedCurrentId: null, authorizedSessions: 5, startsOnDayKey: "2031-01-01" }),
      effect: async (fx, db) => (await db.programAuthorization.count({ where: { programId: fx.programId as string } })) > 0,
    },
    {
      kind: "read",
      name: "Planes · getPlanDetail completo",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: { exp: "deny", note: "sin clinical.read" }, GENERAL: "deny", SUPPORT: { exp: "deny", note: "soporte = proyección de la Secretaria (sin clinical.read): nunca el detalle full" } },
      setup: fxPlan,
      seen: async (fx) => {
        const r = await getPlanDetail({ programId: fx.programId as string });
        return r.ok && JSON.stringify(r.data).includes(fx.programId as string);
      },
    },
    {
      kind: "read",
      name: "Planes · getPatientPlanBalances",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "ok", BILLING: "ok", ADMIN: "ok", GENERAL: { exp: "deny", note: "sin `planes` → vacío" }, SUPPORT: "ok" },
      setup: fxPlan,
      seen: async (fx) => {
        const r = await getPatientPlanBalances({ patientId: fx.patientId });
        return r.ok && r.data.plans.some((p) => p.programId === fx.programId);
      },
    },
    // ─────────────────────────────────────────── Paciente ───────────────────────────────────────────
    {
      kind: "write",
      name: "Paciente · updatePatient (teléfono)",
      // T3c-1b (§23.5): la rama `admin` + `patients.editAdmin` edita contacto, DNI y nacimiento (lista cerrada). Antes
      // la fixture mandaba `notes` y la celda de la Secretaria era el it.fails de S26b; ahora lo clínico es otra fila.
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: { exp: "ok", note: "admin + patients.editAdmin (T3c-1b)" },
        BILLING: { exp: "deny", note: "sin patients.editAdmin" },
        ADMIN: "ok",
        GENERAL: "ok",
        SUPPORT: { exp: "ro", note: "SUPPORT_CAPS sin patients.editAdmin" },
      },
      // Teléfono único por celda: el chequeo de duplicados de `updatePatient` mira nombre + contacto y las fixtures se
      // llaman igual; con un número fijo, la segunda celda chocaba con la primera («Ya existe un paciente…»).
      setup: async (fx) => {
        fx.phone = `11${10_000_000 + Math.floor(Math.random() * 89_999_999)}`;
      },
      act: (fx) => updatePatient({ id: fx.patientId, phone: fx.phone as string }),
      effect: async (fx, db) => (await db.patient.findUniqueOrThrow({ where: { id: fx.patientId } })).phone === fx.phone,
    },
    {
      kind: "write",
      name: "Paciente · updatePatient con notas (clínico)",
      // T3c-1b: una clave clínica desde la rama `admin` → rechazo SIN escribir nada (ni el resto de los campos).
      cells: {
        ASSISTANT: { exp: "deny", note: "«Las notas y el diagnóstico los edita el profesional a cargo.»" },
        ADMIN: { exp: "deny", note: "no atiende: rama admin" },
      },
      act: (fx) => updatePatient({ id: fx.patientId, notes: "S26b admin" }),
      effect: async (fx, db) => (await db.patient.findUniqueOrThrow({ where: { id: fx.patientId } })).notes === "S26b admin",
    },
    {
      kind: "write",
      name: "Paciente · setPatientCoverage",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: { exp: "ok", note: "admin + patients.editAdmin (T3c-1b)" }, BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "ro" },
      act: (fx) => setPatientCoverage({ patientId: fx.patientId, insurerName: "OS S26b" }),
      effect: async (fx, db) => (await db.coverage.count({ where: { patientId: fx.patientId, insurer: "OS S26b" } })) > 0,
    },
    {
      kind: "write",
      name: "Paciente · setPatientShares (compartir la HC)",
      // T3-Z M2: compartir decide quién ve la HC: es `tenant.sensitive` (lo delicado de Configuración), no `tenant.admin`.
      // Antes la Secretaria con «Configuración» abría la HC a otro profesional; el corte de staff (T3) se la saca.
      cells: {
        OWNER: "ok",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "«quién ve la HC» es tenant.sensitive (T3-Z M2)" },
        ADMIN: { exp: "ok", note: "«Configuración» delegada con lo delicado" },
        PRO_CFG: { exp: "ok", note: "no es el asignado: pasa por «Configuración»" },
      },
      act: (fx) => setPatientShares({ patientId: fx.patientId, practitionerIds: [basic.practitionerId] }),
      effect: async (fx, db) => (await db.patientShare.count({ where: { patientId: fx.patientId, practitionerId: basic.practitionerId } })) > 0,
    },
    {
      kind: "write",
      name: "Paciente · assignPatientToPractitioner (reasignar)",
      // T3-Z M2: reasignar cambia quién tiene la HC completa → `tenant.sensitive`, igual que compartir.
      cells: {
        OWNER: "ok",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "«quién ve la HC» es tenant.sensitive (T3-Z M2)" },
        ADMIN: "ok",
        PRO_CFG: "ok",
        SUPPORT: { exp: "deny", note: "soporte vale como la Secretaria (memberCapabilitiesForActor)" },
      },
      act: (fx) => assignPatientToPractitioner({ patientId: fx.patientId, practitionerId: basic.practitionerId }),
      effect: async (fx, db) => (await db.patient.findUniqueOrThrow({ where: { id: fx.patientId } })).assignedPractitionerId === basic.practitionerId,
    },
    {
      kind: "write",
      name: "Paciente · setPatientDiagnosis (clínico)",
      // Hallazgo S26b `diagnostico-sin-gate-de-modulo`, cerrado en ES4 P4.Z: un GENERAL escribía el diagnóstico por RPC.
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny",
      GENERAL: { exp: "deny", note: "sin `diagnostico` → ok:false (P4.Z)" }, SUPPORT: "ro" },
      act: (fx) => setPatientDiagnosis(fx.patientId, "S26b dx", "x"),
      effect: async (fx, db) => (await db.patient.findUniqueOrThrow({ where: { id: fx.patientId } })).diagnosisTitle === "S26b dx",
    },
    {
      kind: "write",
      name: "Paciente · recordEvaScore (clínico)",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: { exp: "deny", note: "sin `evaluaciones` → ok:false, no tira (P4.Z)" }, SUPPORT: "ro" },
      // Sin `settle`: desde P4.Z ninguna celda tira; si volviera a tirar ForbiddenError, la celda falla.
      act: (fx) => recordEvaScore({ patientId: fx.patientId, value: 5, source: "s26b" }),
      effect: async (fx, db) => (await db.evaScore.count({ where: { patientId: fx.patientId, source: "s26b" } })) > 0,
    },
    {
      kind: "write",
      name: "Paciente · sendPatientPortalInvite (requiere full)",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "ok", SUPPORT: "ro" },
      setup: async () => __rateLimitInternals.reset(),
      act: (fx) => sendPatientPortalInvite({ patientId: fx.patientId }),
      // El único write de la invitación es el audit (el vínculo lo hace el login): con Supabase admin nulo el mail
      // queda `failed`, pero la action responde ok y audita.
      effect: async (fx, db) => (await db.auditEvent.count({ where: { entityId: fx.patientId, action: { startsWith: "patient.portal_invite" } } })) > 0,
    },
    {
      kind: "write",
      name: "S24r · decidePatientPortalRequest (REJECT)",
      // T3c-1b (§23.5, #26): `canDecide = full || (admin && patients.editAdmin)`: Facturación ya no decide.
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: { exp: "ok", note: "admin + patients.editAdmin" },
        BILLING: { exp: "deny", note: "sin patients.editAdmin (T3c-1b)" },
        ADMIN: "ok",
        GENERAL: "ok",
        SUPPORT: "ro",
      },
      setup: async (fx) => {
        const userId = `portal-${uniqueSuffix()}`;
        await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: "Ana Paciente" } });
        portalUsers.push(userId);
        await db.patient.update({ where: { id: fx.patientId }, data: { userId } });
        const req = await db.patientChangeRequest.create({
          data: { tenantId: fx.host.tenantId, patientId: fx.patientId, changes: { phone: "1155550000" }, requestedByUserId: userId },
        });
        fx.reqId = req.id;
        fx.reqUpdatedAt = req.updatedAt.toISOString();
      },
      act: (fx) => decidePatientPortalRequest({ id: fx.reqId as string, expectedUpdatedAt: fx.reqUpdatedAt as string, decision: "REJECT" }),
      effect: async (fx, db) => (await db.patientChangeRequest.findUniqueOrThrow({ where: { id: fx.reqId as string } })).status !== "PENDING",
    },
    // ─────────────────────────────────────────── EV2 · evoluciones ───────────────────────────────────────────
    {
      kind: "write",
      name: "EV2 · createClinicalNote",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: { exp: "ok", note: "núcleo `evoluciones`" }, SUPPORT: "ro" },
      act: (fx) => createClinicalNote({ patientId: fx.patientId, body: "S26b evolución", idempotencyKey: randomUUID() }),
      effect: async (fx, db) => (await db.clinicalNote.count({ where: { patientId: fx.patientId } })) > 0,
    },
    {
      kind: "write",
      name: "EV2 · voidClinicalNote",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxNote(fx, "S26b a anular"),
      act: (fx) => voidClinicalNote({ noteId: fx.noteId as string, expectedRevision: fx.noteRevision as number, reason: "Cargada por error" }),
      effect: async (fx, db) => (await db.clinicalNote.findUniqueOrThrow({ where: { id: fx.noteId as string } })).voidedAt !== null,
    },
    {
      kind: "read",
      name: "EV2 · getPatientTimeline",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: { exp: "deny", note: "nunca HC (PD-13)" }, BILLING: "deny", ADMIN: { exp: "deny", note: "nunca HC (§20.17)" }, GENERAL: "ok", SUPPORT: { exp: "deny", note: "SUPPORT_CAPS sin clinical.read → null" } },
      setup: (fx) => fxNote(fx, "S26b timeline secreta"),
      seen: async (fx) => JSON.stringify(await getPatientTimeline({ patientId: fx.patientId })).includes("S26b timeline secreta"),
    },
    {
      kind: "read",
      name: "EV2 · getPatientClinicalSummary",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "ok", SUPPORT: "deny" },
      setup: (fx) => fxNote(fx, "S26b resumen"),
      seen: async (fx) => (await getPatientClinicalSummary(fx.patientId)) !== null,
    },
    // ─────────────────────────────────────────── FC · portal «Documentos» ───────────────────────────────────────────
    // [FC-1e] T4 (C-FC8): el staff nunca entra al portal (`requirePortalPatient` corta a quien tiene Membership, AUDIT
    // §5.22), ni con una ficha vinculada a SU cuenta que tiene un documento vivo compartido (peor caso: dato viejo).
    // La descarga del PDF → 404 y sin fila de audit. Nació `it.fails` (la ruta no existía); la dio vuelta FC-2i.
    {
      kind: "read",
      name: "FC · portal «Documentos»: PDF del documento compartido, ficha vinculada a la cuenta del staff",
      cells: Object.fromEntries(COLS.map((c) => [c, { exp: "deny", note: "staff → 404" }])) as Cells,
      setup: (fx) => fxSharedDocument(fx),
      seen: (fx) => portalPdfSeenByCurrentUser(fx),
    },
    // ─────────────────────────────────────────── FC · fichas (T4, FC-2i) ───────────────────────────────────────────
    // Compartir y revocar: escritura clínica (full sobre el paciente). Secretaria, Facturación, ADMIN (no atiende) y
    // soporte → rechazo sin documento. Sin Storage en el Docker local el PDF queda `stub:<id>` (FC-2d).
    {
      kind: "write",
      name: "FC · shareClinicalNoteWithPatient",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: { exp: "deny", note: "no atiende: sin HC" }, GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxNote(fx, "S26b ficha a compartir"),
      act: (fx) => shareClinicalNoteWithPatient({ noteId: fx.noteId as string, idempotencyKey: randomUUID(), notify: false }),
      effect: async (fx, db) => (await db.patientDocument.count({ where: { noteId: fx.noteId as string } })) > 0,
    },
    {
      kind: "write",
      name: "FC · revokePatientDocument",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: { exp: "deny", note: "no atiende: sin HC" }, GENERAL: "ok", SUPPORT: "ro" },
      setup: (fx) => fxSharedDocument(fx),
      act: (fx) => revokePatientDocument({ documentId: fx.documentId as string }),
      effect: async (fx, db) => (await db.patientDocument.findUniqueOrThrow({ where: { id: fx.documentId as string } })).revokedAt !== null,
    },
    // Diagnósticos propios (FC-D22): buscar = `clinical.read` (vocabulario del consultorio, no un paciente: el básico
    // también); crear = escritura clínica con profesional o `tenant.sensitive`.
    {
      kind: "read",
      name: "FC · searchDiagnoses (propio del consultorio)",
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: { exp: "ok", note: "vocabulario del consultorio, no un paciente" },
        ASSISTANT: "deny",
        BILLING: "deny",
        ADMIN: { exp: "deny", note: "no clínico → null" },
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "soporte → null" },
      },
      setup: async (fx) => {
        fx.dxTitle = `Dx S26b ${uniqueSuffix()}`;
        await db.tenantDiagnosis.create({
          data: { tenantId: fx.host.tenantId, title: fx.dxTitle as string, searchText: (fx.dxTitle as string).toLowerCase() },
        });
      },
      seen: async (fx) => {
        const r = await searchDiagnoses({ q: fx.dxTitle as string });
        return !!r?.groups.some((g) => g.options.some((o) => o.title === fx.dxTitle));
      },
    },
    {
      kind: "write",
      name: "FC · createTenantDiagnosis",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: { exp: "ok", note: "FC-D22: cualquier profesional con escritura clínica" },
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "corte de staff: sin tenant.sensitive" },
        BILLING: "deny",
        ADMIN: { exp: "ok", note: "FC-D22: `tenant.sensitive` (Configuración), sin ver HC" },
        PRO_CFG: "ok",
        GENERAL: "ok",
        SUPPORT: "ro",
      },
      act: (fx) => {
        fx.dxTitle = `Propio S26b ${uniqueSuffix()}`;
        return createTenantDiagnosis({ title: fx.dxTitle as string });
      },
      effect: async (fx, db) => (await db.tenantDiagnosis.count({ where: { tenantId: fx.host.tenantId, title: fx.dxTitle as string } })) > 0,
    },
    // Logo (`tenant.sensitive`) y firma (solo la propia, solo quien atiende). Se mide quitar el logo y los datos de la
    // firma: no piden Storage (la subida, sí; sus rechazos están en tests/integration/practice-assets*.test.ts).
    {
      kind: "write",
      name: "FC · removeTenantLogo",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "corte de staff: sin tenant.sensitive" },
        BILLING: "deny",
        ADMIN: { exp: "ok", note: "Configuración delegada (tenant.sensitive)" },
        PRO_CFG: "ok",
        GENERAL: "ok",
        SUPPORT: "ro",
      },
      setup: async (fx) => {
        await db.tenant.update({ where: { id: fx.host.tenantId }, data: { logoStorageKey: `${fx.host.tenantId}/logo/s26b.png`, logoUpdatedAt: new Date() } });
      },
      act: () => removeTenantLogo(),
      effect: async (fx, db) => (await tenantRow(fx.host.tenantId)).logoStorageKey === null,
    },
    {
      kind: "write",
      name: "FC · updateOwnSignatureInfo (la propia)",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: { exp: "ok", note: "la firma es de quien firma, cualquier acceso" },
        ASSISTANT: { exp: "deny", note: "no atiende (practitionerId null)" },
        BILLING: { exp: "deny", note: "no atiende (practitionerId null)" },
        ADMIN: { exp: "deny", note: "sin Practitioner" },
        GENERAL: "ok",
        SUPPORT: "ro",
      },
      act: (fx) => {
        fx.license = `S26B-${uniqueSuffix()}`.slice(0, 40);
        return updateOwnSignatureInfo({ honorific: "LIC", licenseNumber: fx.license as string });
      },
      effect: async (fx, db) => (await db.practitioner.count({ where: { tenantId: fx.host.tenantId, licenseNumber: fx.license as string } })) > 0,
    },
    // Descargas del equipo (FC-2g): 200 solo con `canRead` de la HC; Secretaria/Facturación/ADMIN/ajeno → 404 y
    // soporte → 403, sin evento de audit.
    {
      kind: "read",
      name: "FC · GET /api/pacientes/[id]/fichas/[noteId]/pdf",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "ok", SUPPORT: { exp: "deny", note: "403" } },
      setup: (fx) => fxNote(fx, "S26b ficha a descargar"),
      seen: async (fx) => {
        __rateLimitInternals.reset();
        const id = fx.patientId;
        const noteId = fx.noteId as string;
        const res = await getFichaDownload(new Request(`http://localhost/api/pacientes/${id}/fichas/${noteId}/pdf`), {
          params: { id, noteId, format: "pdf" },
        });
        if (res.status === 200) return true;
        expect(res.status).toBe(fx.col === "SUPPORT" ? 403 : 404);
        expect(await db.auditEvent.count({ where: { action: "clinicalNote.download", entityId: id } })).toBe(0);
        return false;
      },
    },
    {
      kind: "read",
      name: "FC · GET /api/pacientes/[id]/historia-clinica/pdf",
      cells: { XT: "deny", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "ok", SUPPORT: { exp: "deny", note: "403" } },
      setup: (fx) => fxNote(fx, "S26b HC a descargar"),
      seen: async (fx) => {
        __rateLimitInternals.reset();
        const id = fx.patientId;
        const res = await getRecordDownload(new Request(`http://localhost/api/pacientes/${id}/historia-clinica/pdf`), {
          params: { id, format: "pdf" },
        });
        if (res.status === 200) return true;
        expect(res.status).toBe(fx.col === "SUPPORT" ? 403 : 404);
        expect(await db.auditEvent.count({ where: { action: "clinicalRecord.download", entityId: id } })).toBe(0);
        return false;
      },
    },
    // ─────────────────────────────────────────── PL · cuenta del consultorio ───────────────────────────────────────────
    {
      kind: "read",
      name: "PL · getBillingOverview",
      cells: {
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        BILLING: { exp: "deny", note: "C-PL5: `account.billing` solo por titularidad o `grantBilling`, no por el rol" },
        ADMIN: { exp: "ok", note: "«Planes y pagos» por default (decisión 2 del 19-oct)" },
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "C-PL5: soporte nunca `account.*` (el brief decía ✅ RO)" },
      },
      seen: () => resolves(getBillingOverview()),
    },
    {
      kind: "read",
      name: "PL · previewPlanChange",
      cells: { OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: "ok", GENERAL: "ok", SUPPORT: "deny" },
      seen: async () => (await settle(previewPlanChange("CLINICA"))).ok,
    },
    {
      kind: "write",
      name: "PL · applyPlanChange (→ CLINICA)",
      cells: { XT: "isolated", OWNER: "ok", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", ADMIN: { exp: "ok", note: "decisión 2 (con step-up)" }, GENERAL: "ok", SUPPORT: { exp: "ro", note: "soporte nunca `account.*`" } },
      act: async (fx) =>
        settle(
          applyPlanChange({
            to: "CLINICA",
            disableMembershipIds: [],
            reactivateMembershipIds: [],
            expectedUpdatedAt: (await tenantRow(fx.col === "XT" ? Other.tenantId : fx.host.tenantId)).updatedAt.toISOString(),
          })
        ),
      // Lee y DEVUELVE el consultorio a CONSULTORIO (por el escritor del test) para no contaminar las filas siguientes.
      effect: async (fx, db) => {
        const changed = (await tenantRow(fx.host.tenantId)).saasPlan === "CLINICA";
        for (const id of [fx.host.tenantId, Other.tenantId]) {
          await db.tenant.update({ where: { id }, data: { saasPlan: "CONSULTORIO", plan: "STARTER" } });
        }
        return changed;
      },
    },
    {
      kind: "write",
      name: "PL · submitPaymentReceipt",
      // OWNER/GENERAL ✅ necesita Storage: el camino feliz está en saas-billing.test.ts. Acá, los rechazos.
      cells: { BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", SUPPORT: "ro" },
      act: () => {
        const fd = new FormData();
        fd.set("file", new File([new Uint8Array([37, 80, 68, 70])], "comprobante.pdf", { type: "application/pdf" }));
        fd.set("method", "TRANSFER");
        fd.set("amount", "1000");
        fd.set("paidOn", "2026-10-01");
        return settle(submitPaymentReceipt(fd));
      },
      effect: async (fx, db) => (await db.saasPayment.count({ where: { tenantId: fx.host.tenantId } })) > 0,
    },
    {
      kind: "read",
      name: "PL · getReceiptUrl de un comprobante de K",
      // OWNER/GENERAL ✅ firma en Storage (saas-billing.test.ts). Acá: nadie más lo abre, ni otro consultorio.
      cells: { XT: "deny", BASIC: "deny", ASSISTANT: "deny", BILLING: "deny", SUPPORT: "deny" },
      setup: async (fx) => {
        const pay = await db.saasPayment.create({
          data: { tenantId: fx.host.tenantId, source: "MANUAL", method: "TRANSFER", status: "PENDING_REVIEW", amountCents: 100_000, receiptPath: `${fx.host.tenantId}/s26b.pdf`, receiptMimeType: "application/pdf", receiptSizeBytes: 4 },
        });
        fx.paymentId = pay.id;
      },
      seen: async (fx) => (await settle(getReceiptUrl(fx.paymentId))).ok,
    },
    {
      kind: "write",
      name: "PL · setSharedPatientView",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "«quién ve la HC» es tenant.sensitive (T3c-1t)" },
        BILLING: "deny",
        ADMIN: "ok",
        PRO_CFG: { exp: "ok", note: "decisión 4 del 19-oct" },
        GENERAL: "ok",
        SUPPORT: "ro",
      },
      act: () => settle(setSharedPatientView(true)),
      effect: async (fx, db) => {
        const changed = (await tenantRow(fx.host.tenantId)).sharedPatientView;
        for (const id of [fx.host.tenantId, Other.tenantId]) await db.tenant.update({ where: { id }, data: { sharedPatientView: false } });
        return changed;
      },
    },
    {
      kind: "write",
      name: "PL · setPublicBookingEnabled (apagar el turnero)",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "el turnero es tenant.sensitive (T3c-1t)" },
        BILLING: "deny",
        ADMIN: "ok",
        PRO_CFG: { exp: "ok", note: "decisión 4 del 19-oct" },
        GENERAL: "ok",
        SUPPORT: { exp: "ok", note: "BO decisión 3: está en SUPPORT_WRITABLE_ACTIONS (el brief decía RO)" },
      },
      act: () => settle(setPublicBookingEnabled(false)),
      effect: async (fx, db) => {
        const changed = !(await tenantRow(fx.host.tenantId)).publicBookingEnabled;
        for (const id of [fx.host.tenantId, Other.tenantId]) await db.tenant.update({ where: { id }, data: { publicBookingEnabled: true } });
        return changed;
      },
    },
    {
      kind: "write",
      name: "PL · updateTenantBasics",
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "datos del consultorio: tenant.sensitive (T3c-1t)" },
        BILLING: "deny",
        ADMIN: "ok",
        PRO_CFG: "ok",
        GENERAL: "ok",
        SUPPORT: { exp: "ok", note: "BO decisión 3: está en SUPPORT_WRITABLE_ACTIONS (el brief decía RO)" },
      },
      setup: async (fx) => {
        fx.prevName = (await tenantRow(fx.host.tenantId)).name;
        fx.prevOtherName = (await tenantRow(Other.tenantId)).name;
      },
      act: () => settle(updateTenantBasics({ name: "Consultorio S26b" })),
      effect: async (fx, db) => {
        const changed = (await tenantRow(fx.host.tenantId)).name === "Consultorio S26b";
        await db.tenant.update({ where: { id: fx.host.tenantId }, data: { name: fx.prevName as string } });
        await db.tenant.update({ where: { id: Other.tenantId }, data: { name: fx.prevOtherName as string } });
        return changed;
      },
    },
    // ─────────────────────────────────────────── Equipo y soporte (lo delicado, T3c-1t / 1s) ───────────────────────────────────────────
    {
      kind: "write",
      name: "Equipo · createInvitation (Secretaria)",
      // `requireTeamManager` = tenant.sensitive. Se invita un rol NO clínico: sumar a alguien que atiende tiene su propia
      // barrera (`clinicalAssignError`, PL-Z a3#5), que no es lo que mide esta fila.
      cells: {
        XT: "isolated",
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "equipo: tenant.sensitive (decisión 3 del 19-oct)" },
        BILLING: "deny",
        ADMIN: "ok",
        PRO_CFG: { exp: "ok", note: "decisión 4 del 19-oct" },
        GENERAL: "ok",
        SUPPORT: { exp: "ok", note: "BO decisión 3: usuarios desde Configuración (SUPPORT_WRITABLE_ACTIONS)" },
      },
      setup: async (fx) => {
        __rateLimitInternals.reset();
        fx.inviteEmail = `s26b-inv-${uniqueSuffix()}@example.com`;
        // La fila mide el permiso, no el cupo: K tiene 7 miembros (Consultorio admite 5). Clínica mientras dura la
        // celda; `effect` la devuelve a Consultorio y borra la invitación, para no contaminar las filas de PL.
        await db.tenant.update({ where: { id: fx.host.tenantId }, data: { saasPlan: "CLINICA" } });
      },
      act: (fx) => settle(createInvitation({ email: fx.inviteEmail as string, firstName: "In", lastName: "Vitada", role: "ASSISTANT" })),
      effect: async (fx, db) => {
        const where = { tenantId: fx.host.tenantId, email: fx.inviteEmail as string };
        const created = (await db.invitation.count({ where })) > 0;
        await db.invitation.deleteMany({ where });
        await db.tenant.update({ where: { id: fx.host.tenantId }, data: { saasPlan: "CONSULTORIO" } });
        return created;
      },
    },
    {
      kind: "write",
      name: "Soporte · endSupportAccessForTenant (terminar un acceso desde el consultorio)",
      cells: {
        XT: { exp: "deny", note: "id de K desde otro consultorio: `tenantId` a mano en el canal service" },
        OWNER: "ok",
        BASIC: "deny",
        ASSISTANT: "deny",
        ASSISTANT_CFG: { exp: "deny", note: "tenant.sensitive (corte de staff)" },
        BILLING: "deny",
        ADMIN: "ok",
        PRO_CFG: { exp: "ok", note: "decisión 4 del 19-oct" },
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "soporte sale con «Salir de soporte», no termina accesos" },
      },
      setup: async (fx) => {
        // Una abierta por superadmin (índice parcial de M7): se cierra la de la celda anterior antes de abrir otra.
        await db.supportSession.updateMany({ where: { superadminId: fxSuperadminId, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
        const row = await db.supportSession.create({
          data: { tenantId: fx.host.tenantId, superadminId: fxSuperadminId, reason: "Fixture S26b" },
        });
        fx.supportSessionId = row.id;
      },
      act: (fx) => settle(endSupportAccessForTenant({ id: fx.supportSessionId as string })),
      effect: async (fx, db) => {
        const row = await db.supportSession.findUniqueOrThrow({ where: { id: fx.supportSessionId as string } });
        return row.endedAt !== null && row.endedReason === "tenant";
      },
    },
    // ─────────────────────────────────────────── Ejercicios globales ───────────────────────────────────────────
    {
      kind: "write",
      name: "Ejercicios globales · addSessionExercise con un global",
      cells: { XT: "deny", OWNER: { exp: "ok", note: "desde Consultorio" }, ASSISTANT: "deny", BILLING: "deny", ADMIN: "deny", GENERAL: "deny", SUPPORT: "ro" },
      setup: fxPlan,
      act: (fx) => addSessionExercise({ sessionId: (fx.sessionIds as string[])[0], exerciseId: globalExerciseId }),
      effect: async (fx, db) => (await db.sessionExercise.count({ where: { sessionId: (fx.sessionIds as string[])[0] } })) > 0,
    },
    // ─────────────────────────────────────────── ICS ───────────────────────────────────────────
    {
      kind: "read",
      name: "ICS · exportBookingsIcs: título clínico del turno",
      cells: {
        XT: "deny",
        OWNER: "ok",
        BASIC: { exp: "deny", note: "sin título" },
        ASSISTANT: "deny",
        BILLING: "deny",
        ADMIN: { exp: "deny", note: "sin clinical.read" },
        GENERAL: "ok",
        SUPPORT: { exp: "deny", note: "según destino: soporte no tiene clinical.read" },
      },
      setup: async (fx) => {
        // En BASIC el turno es de OTRO profesional (el Titular): el básico ve la agenda pero no lo clínico.
        if (fx.col === "BASIC") fx.practitionerId = K.practitionerId;
        await fxBooking(fx, { title: "Titulo clinico S26b" });
      },
      seen: async (fx) => {
        const at = (await db.booking.findUniqueOrThrow({ where: { id: fx.bookingId as string } })).scheduledFor;
        const out = await exportBookingsIcs(await getActor(), { from: new Date(+at - 3_600_000), to: new Date(+at + 3_600_000) });
        // GENERAL: sin «Sesión» (no hay planes); vale para todas las columnas, ningún turno suelto lleva «Sesión».
        expect(out).not.toMatch(/Sesi[oó]n \d+\/\d+/);
        return out.includes("Titulo clinico S26b");
      },
    },
  ];

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", saasPlan: "CONSULTORIO" });
    H = await createEphemeralTenant(db);
    basic = await addPractitioner(db, K, "PRACTITIONER");
    assistant = await addPractitioner(db, K, "ASSISTANT");
    billing = await addPractitioner(db, K, "BILLING");
    // T3c-1i: las columnas de T3 (las filas se insertan directo: K queda con más miembros de los que admite
    // Consultorio, y la fila de invitar lo sube a Clínica mientras dura la celda).
    admin = await addStaff(db, K, "ADMIN", { grantSettings: true, grantBilling: true });
    assistantCfg = await addStaff(db, K, "ASSISTANT", { grantSettings: true });
    proCfg = await addPractitioner(db, K, "PRACTITIONER");
    await db.membership.update({ where: { userId_tenantId: { userId: proCfg.userId, tenantId: K.tenantId } }, data: { grantSettings: true } });
    fxSuperadminId = `test-user-sa-${uniqueSuffix()}`;
    portalUsers.push(fxSuperadminId);
    await db.userProfile.create({ data: { id: fxSuperadminId, email: `${fxSuperadminId}@test.local`, fullName: "Soporte S26b", isPlatformAdmin: true } });
    globalExerciseId = (
      await db.exercise.create({ data: { slug: `s26b-global-${uniqueSuffix()}`, name: "Global S26b", isBasic: true } })
    ).id;
    // Sesión de soporte REAL (BO): superadmin de H entra a K. La cookie se guarda y la columna SUPPORT la repone.
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    asUser(H.userId);
    const s = await startSupport(K.tenantId, "Matriz de autorización S26b");
    if (!s.ok) throw new Error(`startSupport: ${s.error}`);
    supportCookie = cookies().get(SUPPORT_COOKIE)?.value ?? "";
    if (!supportCookie) throw new Error("startSupport no dejó la cookie de soporte");
    expect((await getActor()).support?.sessionId).toBe(s.data.sessionId);
    cookies().delete(SUPPORT_COOKIE);
  });

  afterAll(async () => {
    cookies().delete(SUPPORT_COOKIE);
    if (db && H) {
      await db.supportSession.updateMany({ where: { superadminId: H.userId, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
    }
    for (const t of [K, Other, G, H]) await t?.cleanup();
    if (portalUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
    if (globalExerciseId) await db?.exercise.delete({ where: { id: globalExerciseId } }).catch(() => {});
    await db?.$disconnect();
  });

  const LABEL: Record<Exp, string> = {
    ok: "✅",
    deny: "⛔ sin escribir / sin ver",
    ro: "RO (ok:false, intacto)",
    isolated: "opera el suyo, K intacto",
  };

  for (const row of ROWS_S26B) {
    for (const col of COLS) {
      const raw = row.cells[col];
      if (!raw) continue;
      const cell: Cell = typeof raw === "string" ? { exp: raw } : raw;
      const title = `${cell.fails ? `[${cell.fails}] ` : ""}${row.name} · ${col} → ${LABEL[cell.exp]}${cell.note ? ` (${cell.note})` : ""}`;
      (cell.fails ? it.fails : it)(title, async () => {
        const fx = await baseFx(col);
        await row.setup?.(fx);
        become(col);
        if (row.kind === "write") {
          const r = await row.act(fx);
          if (cell.exp === "ok") expect(r.ok, JSON.stringify(r)).toBe(true);
          if (cell.exp === "deny" || cell.exp === "ro") expect(r.ok, JSON.stringify(r)).toBe(false);
          expect(await row.effect(fx, db)).toBe(cell.exp === "ok");
        } else {
          expect(await row.seen(fx)).toBe(cell.exp === "ok");
        }
      });
    }
  }

  it("Ejercicios globales · KINE INDIVIDUAL (ex FREE) no asigna un global (enmienda EV0 de S26b)", async () => {
    const KF = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "INDIVIDUAL" });
    try {
      const patientId = await addPatient(db, KF);
      const p = await insertPlan(db, KF, { patientId, sessions: 1 });
      become("OWNER");
      asUser(KF.userId);
      const r = await addSessionExercise({ sessionId: p.sessionIds[0], exerciseId: globalExerciseId });
      expect(r.ok).toBe(false);
      expect(await db.sessionExercise.count({ where: { sessionId: p.sessionIds[0] } })).toBe(0);
    } finally {
      await KF.cleanup();
    }
  });
});
