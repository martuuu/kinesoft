/**
 * EV2-3d · «Imprimir historia clínica» (`lib/clinical-notes-print-internal.ts`, C-EV2-6, EV2-D11).
 *
 * Contra la base real con el `getActor()` real (solo se mockea la sesión de Supabase, la cookie jar y `next/cache`,
 * tests/helpers/integration-setup.ts). Corre con los dos roles: `kinesoft_app` (RLS) y el owner BYPASSRLS
 * (`test:integration:owner`, = prod): con BYPASSRLS lo ajeno tiene que seguir sin salir por el `tenantId` a mano.
 *
 * Qué se prueba (efecto observable: la fila de AuditEvent y lo devuelto):
 *   - con acceso (profesional dueño, Titular clínico): escribe UN `clinicalRecord.print` con `{ count }` y devuelve
 *     paciente + evoluciones en orden cronológico, enmiendas y anuladas incluidas (marcadas), nada de otro paciente;
 *   - sin acceso (Secretaria, Facturación, ADMIN, profesional sin acceso, Titular sin agenda, paciente de otro
 *     consultorio): null y CERO eventos;
 *   - si el audit falla: la promesa rechaza (sin datos) — falla cerrado.
 *
 * Lo único reemplazado es `auditSecurityEvent`, y solo para poder hacerlo fallar: por defecto delega en el real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadClinicalRecordForPrint } from "@/lib/clinical-notes-print-internal";
import { getActor } from "@/lib/session";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const auditCtl = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    auditSecurityEvent: async (p: Parameters<typeof real.auditSecurityEvent>[0]) => {
      if (auditCtl.fail) throw new Error("audit caído (test)");
      return real.auditSecurityEvent(p);
    },
  };
});

const RUN = process.env.INTEGRATION === "1";

type Author = { userId: string; practitionerId: string; name: string };

async function seedNote(
  db: PrismaClient,
  t: EphemeralTenant,
  n: { patientId: string; body: string; occurredAt: Date; author: Author; amendsNoteId?: string; createdAt?: Date }
): Promise<string> {
  const row = await db.clinicalNote.create({
    data: {
      tenantId: t.tenantId,
      patientId: n.patientId,
      amendsNoteId: n.amendsNoteId ?? null,
      body: n.body,
      occurredAt: n.occurredAt,
      authorUserId: n.author.userId,
      authorPractitionerId: n.author.practitionerId,
      authorName: n.author.name,
      idempotencyKey: randomUUID(),
      createdAt: n.createdAt ?? new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

describe.skipIf(!RUN)("EV2-3d · imprimir historia clínica", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let Other: EphemeralTenant;
  const users = {} as Record<"PRO" | "PRO_BASIC" | "ASSISTANT" | "BILLING" | "ADMIN", string>;
  let patientId: string;
  let siblingPatientId: string;
  let otherPatientId: string;
  let oldRoot: string;
  let voidedRoot: string;
  let amendment: string;
  let recentRoot: string;

  const printEvents = (entityId: string) =>
    db.auditEvent.findMany({ where: { action: "clinicalRecord.print", entityId }, select: { actorId: true, tenantId: true, payload: true } });

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    const p = await addPractitioner(db, K, "PRACTITIONER");
    users.PRO = p.userId;
    users.PRO_BASIC = (await addPractitioner(db, K, "PRACTITIONER")).userId;
    users.ASSISTANT = (await addPractitioner(db, K, "ASSISTANT")).userId;
    users.BILLING = (await addPractitioner(db, K, "BILLING")).userId;
    users.ADMIN = (await addPractitioner(db, K, "ADMIN")).userId;
    await db.membership.update({ where: { userId_tenantId: { userId: users.ADMIN, tenantId: K.tenantId } }, data: { clinical: true } });
    const pro: Author = { userId: p.userId, practitionerId: p.practitionerId, name: "Kine EV2-3d" };
    const owner: Author = { userId: K.userId, practitionerId: K.practitionerId, name: "Titular EV2-3d" };

    patientId = await addPatient(db, K, { assignedPractitionerId: p.practitionerId, firstName: "Ana", lastName: "Print" });
    await db.patient.update({ where: { id: patientId }, data: { dateOfBirth: new Date("1990-05-04T00:00:00Z") } });
    // Insertadas fuera de orden: la impresión ordena por `occurredAt`.
    recentRoot = await seedNote(db, K, { patientId, body: "Reciente", occurredAt: new Date("2026-04-01T12:00:00Z"), author: pro });
    oldRoot = await seedNote(db, K, { patientId, body: "Primera consulta", occurredAt: new Date("2026-01-10T12:00:00Z"), author: pro });
    voidedRoot = await seedNote(db, K, { patientId, body: "Anulada", occurredAt: new Date("2026-02-10T12:00:00Z"), author: pro });
    await db.clinicalNote.update({
      where: { id: voidedRoot },
      data: { voidedAt: new Date(), voidedByUserId: pro.userId, voidReason: "Paciente equivocado" },
    });
    amendment = await seedNote(db, K, {
      patientId,
      amendsNoteId: oldRoot,
      body: "Enmienda de la primera",
      occurredAt: new Date("2026-03-01T12:00:00Z"),
      author: owner,
    });

    // Mismo consultorio, otro paciente: no tiene que colarse.
    siblingPatientId = await addPatient(db, K, { assignedPractitionerId: p.practitionerId });
    await seedNote(db, K, { patientId: siblingPatientId, body: "De otro paciente", occurredAt: new Date("2026-03-15T12:00:00Z"), author: pro });

    otherPatientId = await addPatient(db, Other);
    await seedNote(db, Other, {
      patientId: otherPatientId,
      body: "Nota de otro consultorio",
      occurredAt: new Date("2026-03-10T12:00:00Z"),
      author: { userId: Other.userId, practitionerId: Other.practitionerId, name: "Otro" },
    });
  });

  afterAll(async () => {
    if (db && K) await db.auditEvent.deleteMany({ where: { action: "clinicalRecord.print", tenantId: { in: [K.tenantId, Other.tenantId] } } });
    await K?.cleanup();
    await Other?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    auditCtl.fail = false;
    await db.auditEvent.deleteMany({ where: { action: "clinicalRecord.print", tenantId: { in: [K.tenantId, Other.tenantId] } } });
  });

  it("profesional dueño: audita una vez con { count } y devuelve la HC en orden, con enmienda y anulada marcadas", async () => {
    asUser(users.PRO);
    const actor = await getActor();
    const r = await loadClinicalRecordForPrint(actor, patientId);
    expect(r).not.toBeNull();
    expect(r!.patient).toEqual({ firstName: "Ana", lastName: "Print", documentId: expect.any(String), dateOfBirth: "1990-05-04" });
    expect(r!.tenantName).toBe(actor.tenantName);
    expect(r!.printedBy).toBe(actor.practitionerName);
    expect(r!.printedBy).not.toContain("@");
    expect(r!.truncated).toBe(false);
    expect(r!.notes.map((n) => n.id)).toEqual([oldRoot, voidedRoot, amendment, recentRoot]);
    expect(r!.notes.every((n) => n.patientId === patientId)).toBe(true);
    expect(r!.notes.find((n) => n.id === voidedRoot)!.voided).toMatchObject({ reason: "Paciente equivocado" });
    expect(r!.notes.find((n) => n.id === amendment)!.amendsNoteId).toBe(oldRoot);
    expect(r!.notes.find((n) => n.id === recentRoot)!.voided).toBeNull();

    const ev = await printEvents(patientId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorId: users.PRO, tenantId: K.tenantId, payload: { count: 4 } });
    // Nada clínico en el evento (EV2-D16): solo el conteo.
    expect(JSON.stringify(ev[0].payload)).not.toContain("Primera consulta");
  });

  it("Titular clínico: también imprime y audita", async () => {
    asUser(K.userId);
    const r = await loadClinicalRecordForPrint(await getActor(), patientId);
    expect(r?.notes).toHaveLength(4);
    expect(await printEvents(patientId)).toHaveLength(1);
  });

  it.each(["ASSISTANT", "BILLING", "ADMIN", "PRO_BASIC"] as const)("%s: null y sin audit", async (role) => {
    asUser(users[role]);
    expect(await loadClinicalRecordForPrint(await getActor(), patientId)).toBeNull();
    expect(await printEvents(patientId)).toHaveLength(0);
  });

  it("Titular sin agenda (clinical = false): null y sin audit", async () => {
    await db.membership.update({ where: { userId_tenantId: { userId: K.userId, tenantId: K.tenantId } }, data: { clinical: false } });
    try {
      asUser(K.userId);
      expect(await loadClinicalRecordForPrint(await getActor(), patientId)).toBeNull();
      expect(await printEvents(patientId)).toHaveLength(0);
    } finally {
      await db.membership.update({ where: { userId_tenantId: { userId: K.userId, tenantId: K.tenantId } }, data: { clinical: true } });
    }
  });

  it("paciente de otro consultorio: null y sin audit (ni en un consultorio ni en el otro)", async () => {
    asUser(K.userId);
    expect(await loadClinicalRecordForPrint(await getActor(), otherPatientId)).toBeNull();
    expect(await printEvents(otherPatientId)).toHaveLength(0);
  });

  it("id inexistente: null y sin audit", async () => {
    asUser(users.PRO);
    expect(await loadClinicalRecordForPrint(await getActor(), "no-existe-ev2-3d")).toBeNull();
    expect(await printEvents("no-existe-ev2-3d")).toHaveLength(0);
  });

  it("falla del audit → rechaza, sin datos (falla cerrado)", async () => {
    asUser(users.PRO);
    const actor = await getActor();
    auditCtl.fail = true;
    let result: unknown = "sin asignar";
    await expect(
      loadClinicalRecordForPrint(actor, patientId).then((r) => {
        result = r;
        return r;
      })
    ).rejects.toThrow("audit caído");
    expect(result).toBe("sin asignar");
    expect(await printEvents(patientId)).toHaveLength(0);
  });
});
