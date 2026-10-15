/**
 * P0-S07sp (Planes E1, PD-09/PD-13) — la Secretaria en pacientes.
 *
 * Contrato (PLANES.md P0.2, S07sp):
 *  - `createPatient(raw, opts?: {assignTo})`: sin `clinical.read` exige
 *    `agenda.operateAll` (BILLING no crea) y `assignTo` = el profesional del
 *    turno, validado en la tx (del tenant, membresía aceptada en un rol
 *    clínico, distinto del actor). Ignora notas y diagnóstico. Antes el
 *    paciente quedaba asignado a quien lo creaba: la Secretaria se quedaba con
 *    la ficha y el kine del turno la veía en básico.
 *  - `getPatientCore` con nivel `admin` devuelve la proyección congelada
 *    `PatientAdminCore` (sin HC); desde PL-A la lectura no se audita.
 *  - Turnos y estado de cobro visibles para `admin`, con title/description/
 *    notes redactados por `bookingFieldAccess`.
 *  - `setPatientDiagnosis` exige `canWriteClinical`.
 *
 * Símbolos reales de `lib/patients.ts` contra la DB; solo se mockea la sesión
 * de Supabase (integration-setup). Los controles (OWNER, PRACTITIONER) evitan
 * el falso verde de "todo se rechaza".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createPatient,
  getPatientCore,
  getPatientBookingsSummary,
  getPatientBookingsAll,
  getPatientBillableCount,
  getPatientEvaScores,
  setPatientDiagnosis,
} from "@/lib/patients";
import { patientAccessFor } from "@/lib/visibility";
import { getActor } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Staff = { userId: string; practitionerId: string };

/** Claves exactas de `PatientAdminCore` (lib/patients-types.ts, congelado). */
const ADMIN_CORE_KEYS = [
  "access",
  "assignedPractitionerName",
  "coverage",
  "dateOfBirth",
  "documentId",
  "email",
  "emergency",
  "firstName",
  "id",
  "lastName",
  "nextBookingAt",
  "phone",
].sort();

describe.skipIf(!RUN)("P0-S07sp · Secretaria en pacientes", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let X: EphemeralTenant;
  let assistant: Staff;
  let assistant2: Staff;
  let billing: Staff;
  let kine: Staff;
  /** PRACTITIONER con invitación sin aceptar (membresía con acceptedAt null). */
  let pendingKine: Staff;
  let foreignKine: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { sharedPatientView: true });
    X = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, A, "ASSISTANT");
    assistant2 = await addPractitioner(db, A, "ASSISTANT");
    billing = await addPractitioner(db, A, "BILLING");
    kine = await addPractitioner(db, A, "PRACTITIONER");
    pendingKine = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: pendingKine.userId, tenantId: A.tenantId } },
      data: { acceptedAt: null },
    });
    foreignKine = X.practitionerId;
  });

  afterAll(async () => {
    await A?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  const newPatient = (extra: Record<string, unknown> = {}) => {
    const s = uniqueSuffix();
    return { firstName: "Sec", lastName: `Alta ${s}`, documentId: `S7-${s}`, ...extra };
  };

  const countByDni = (documentId: string) =>
    db.patient.count({ where: { tenantId: A.tenantId, documentId } });

  // ── createPatient ──────────────────────────────────────────────────────

  it("[P0-S07sp] alta desde el modal por ASSISTANT → paciente a cargo del profesional del turno; ASSISTANT sigue sin HC y el diagnóstico se ignora", async () => {
    asUser(assistant.userId);
    const input = newPatient({
      notes: "Dolor lumbar desde hace 3 meses",
      diagnosisTitle: "Lumbalgia",
      diagnosisNote: "Irradiada a MI derecho",
    });
    const r = await createPatient(input, { assignTo: kine.practitionerId });
    if (!r.ok) throw new Error(r.error);

    const row = await db.patient.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.assignedPractitionerId).toBe(kine.practitionerId);
    expect(row.notes).toBeNull();
    expect(row.diagnosisTitle).toBeNull();
    expect(row.diagnosisNote).toBeNull();

    // La Secretaria sigue en `admin` sobre la ficha que creó (no full).
    const sec = await getActor();
    expect(await patientAccessFor(sec, r.data.id)).toBe("admin");
    const core = await getPatientCore(r.data.id);
    expect(core?.access).toBe("admin");
    expect(core).not.toHaveProperty("notes");

    // El kine del turno queda con la ficha (full).
    asUser(kine.userId);
    expect(await patientAccessFor(await getActor(), r.data.id)).toBe("full");
  });

  it("[P0-S07sp] BILLING no crea pacientes", async () => {
    asUser(billing.userId);
    const input = newPatient();
    const r = await createPatient(input, { assignTo: kine.practitionerId });
    expect(r.ok).toBe(false);
    expect(await countByDni(input.documentId)).toBe(0);
  });

  it("[P0-S07sp] assignTo de otro tenant → rechazo", async () => {
    asUser(A.userId); // OWNER
    const input = newPatient();
    const r = await createPatient(input, { assignTo: foreignKine });
    expect(r.ok).toBe(false);
    expect(await countByDni(input.documentId)).toBe(0);
  });

  it("ASSISTANT sin assignTo → rechazo (no se queda con la ficha)", async () => {
    asUser(assistant.userId);
    const input = newPatient();
    const r = await createPatient(input);
    expect(r.ok).toBe(false);
    expect(await countByDni(input.documentId)).toBe(0);
  });

  it("ASSISTANT: assignTo a sí misma, a otra Secretaria, a BILLING, a un kine sin aceptar o de otro tenant → rechazo", async () => {
    asUser(assistant.userId);
    for (const assignTo of [
      assistant.practitionerId,
      assistant2.practitionerId,
      billing.practitionerId,
      pendingKine.practitionerId,
      foreignKine,
      "no-existe",
    ]) {
      const input = newPatient();
      const r = await createPatient(input, { assignTo });
      expect(r.ok, assignTo).toBe(false);
      expect(await countByDni(input.documentId)).toBe(0);
    }
  });

  it("controles: OWNER con assignTo lo asigna al kine y conserva notas; PRACTITIONER sin assignTo queda a su cargo", async () => {
    asUser(A.userId);
    const o = await createPatient(newPatient({ notes: "nota", diagnosisTitle: "Cervicalgia" }), {
      assignTo: kine.practitionerId,
    });
    if (!o.ok) throw new Error(o.error);
    const orow = await db.patient.findUniqueOrThrow({ where: { id: o.data.id } });
    expect(orow.assignedPractitionerId).toBe(kine.practitionerId);
    expect(orow.notes).toBe("nota");
    expect(orow.diagnosisTitle).toBe("Cervicalgia");

    const own = await createPatient(newPatient());
    if (!own.ok) throw new Error(own.error);
    expect((await db.patient.findUniqueOrThrow({ where: { id: own.data.id } })).assignedPractitionerId).toBe(
      A.practitionerId
    );

    asUser(kine.userId);
    const k = await createPatient(newPatient({ diagnosisTitle: "Esguince" }));
    if (!k.ok) throw new Error(k.error);
    const krow = await db.patient.findUniqueOrThrow({ where: { id: k.data.id } });
    expect(krow.assignedPractitionerId).toBe(kine.practitionerId);
    expect(krow.diagnosisTitle).toBe("Esguince");
  });

  it("PRACTITIONER no regala la ficha: assignTo ajeno se ignora (re-asignar es de OWNER/ADMIN)", async () => {
    asUser(kine.userId);
    const r = await createPatient(newPatient(), { assignTo: A.practitionerId });
    if (!r.ok) throw new Error(r.error);
    expect((await db.patient.findUniqueOrThrow({ where: { id: r.data.id } })).assignedPractitionerId).toBe(
      kine.practitionerId
    );
  });

  // ── setPatientDiagnosis ────────────────────────────────────────────────

  it("[P0-S07sp] setPatientDiagnosis por ASSISTANT → rechazo y diagnóstico intacto", async () => {
    const p = await addPatient(db, A, { assignedPractitionerId: assistant.practitionerId });
    await db.patient.update({ where: { id: p }, data: { diagnosisTitle: "Original", diagnosisNote: "Nota" } });
    asUser(assistant.userId);
    const r = await setPatientDiagnosis(p, "", "");
    expect(r.ok).toBe(false);
    expect(await db.patient.findUniqueOrThrow({ where: { id: p } })).toMatchObject({
      diagnosisTitle: "Original",
      diagnosisNote: "Nota",
    });

    // Control: el kine con full sí lo escribe.
    asUser(A.userId);
    expect((await setPatientDiagnosis(p, "Nuevo", "")).ok).toBe(true);
  });

  // ── Proyección admin ───────────────────────────────────────────────────

  it("getPatientCore admin = PatientAdminCore exacto (sin HC) y sin audit de lectura (PL-A)", async () => {
    const p = await addPatient(db, A, {
      assignedPractitionerId: kine.practitionerId,
      notes: "Nota clínica privada",
      email: `adm-${uniqueSuffix()}@test.local`,
      phone: `11${Date.now().toString().slice(-8)}`,
    });
    await db.patient.update({ where: { id: p }, data: { diagnosisTitle: "Lumbalgia" } });
    await db.coverage.create({ data: { patientId: p, insurer: "Vieja", planName: "A", memberId: "1" } });
    await db.coverage.create({ data: { patientId: p, insurer: "OSDE", planName: "310", memberId: "99", copagoCents: 1234 } });
    await db.emergencyContact.create({ data: { patientId: p, name: "Mamá", relation: "Madre", phone: "1155555555" } });

    for (const who of [assistant, billing]) {
      asUser(who.userId);
      const core = await getPatientCore(p);
      expect(core?.access).toBe("admin");
      expect(Object.keys(core!).sort()).toEqual(ADMIN_CORE_KEYS);
      if (core?.access !== "admin") throw new Error("no admin");
      expect(core.coverage).toEqual({ insurer: "OSDE", planName: "310", memberId: "99" });
      expect(core.emergency).toEqual([{ name: "Mamá", relation: "Madre", phone: "1155555555" }]);
      expect(core.assignedPractitionerName).toMatch(/^Kine /);
      expect(core.email).not.toBeNull();
      expect(core.phone).not.toBeNull();
    }

    // PL-A (plan §20.5.9): abrir el perfil ya no audita (lectura de PHI).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entityId: p } })).toBe(0);

    // Controles: OWNER full (con notas); un PRACTITIONER sin acceso en un
    // tenant sin "Consultorio común" sigue en básico (ver test de abajo).
    asUser(A.userId);
    const full = await getPatientCore(p);
    expect(full?.access).toBe("full");
    expect(full).toHaveProperty("notes", "Nota clínica privada");
  });

  it("turnos y cobro para admin: title/description/notes redactados; EVA sigue cerrada", async () => {
    const p = await addPatient(db, A, { assignedPractitionerId: kine.practitionerId });
    for (const [i, paymentStatus] of (["PAID", "UNPAID"] as const).entries()) {
      await db.booking.create({
        data: {
          tenantId: A.tenantId,
          patientId: p,
          practitionerId: kine.practitionerId,
          serviceId: A.serviceId,
          scheduledFor: new Date(Date.UTC(2026, 9, 10 + i, 13)),
          durationMin: 45,
          status: "CONFIRMED",
          paymentStatus,
          idempotencyKey: randomUUID(),
          title: "Lumbalgia",
          description: "Irradiada",
          notes: "Refiere dolor 8/10",
        },
      });
    }
    await db.evaScore.create({ data: { patientId: p, value: 7 } });

    asUser(assistant.userId);
    const summary = await getPatientBookingsSummary(p, 5);
    expect(summary).toHaveLength(2);
    for (const b of summary) {
      expect(b).toMatchObject({ title: null, description: null, notes: null, serviceName: "Consulta" });
      expect(typeof b.copagoCents).toBe("number");
    }
    expect(summary.map((b) => b.paymentStatus).sort()).toEqual(["PAID", "UNPAID"]);

    const all = await getPatientBookingsAll(p);
    expect(all.rows).toHaveLength(2);
    for (const b of all.rows) {
      expect(b).toMatchObject({ title: null, description: null, notes: null });
    }
    expect(await getPatientBillableCount(p)).toBe(1);
    expect(await getPatientEvaScores(p)).toEqual([]);

    // Control: OWNER (full + clinical.read) ve los campos.
    asUser(A.userId);
    const ownerRows = await getPatientBookingsSummary(p, 5);
    expect(ownerRows[0]).toMatchObject({ title: "Lumbalgia", description: "Irradiada", notes: "Refiere dolor 8/10" });
    expect((await getPatientBookingsAll(p)).rows[0].notes).toBe("Refiere dolor 8/10");
  });

  it("control: PRACTITIONER básico (tenant sin Consultorio común) sigue sin turnos ni core admin", async () => {
    const otherKine = await addPractitioner(db, X, "PRACTITIONER");
    const p = await addPatient(db, X);
    asUser(otherKine.userId);
    const core = await getPatientCore(p);
    expect(core?.access).toBe("basic");
    expect(await getPatientBookingsSummary(p)).toEqual([]);
    expect((await getPatientBookingsAll(p)).rows).toEqual([]);
    expect(await getPatientBillableCount(p)).toBe(0);
  });
});
