/**
 * S07k (Planes P0.1, E0) · `listBookingsInRange` sin PHI clínica por RPC.
 *
 * `listBookingsInRange` es una server action exportada de un `"use server"`:
 * se puede llamar por RPC aunque la agenda ya no la use. Gateaba full/basic
 * pero no `clinical.read`, así que la Secretaria (ASSISTANT) con
 * `sharedPatientView` (acceso full a todos los pacientes) leía title,
 * description, notas y el diagnóstico del plan activo. Ahora aplica
 * `bookingFieldAccess` (la misma regla que `listAgendaBookings`) y
 * `patientCondition` sale solo con `clinical.read` + full.
 *
 * Además, el plan ACTIVO del chip se elige de forma determinística: con dos
 * ACTIVE (legacy de prod) gana el más reciente (`createdAt desc`), no el que
 * Postgres devuelva primero.
 *
 * `getActor()` real; los dos modos (kinesoft_app con RLS y owner BYPASSRLS).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listBookingsInRange } from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** "2027-03-10", "10:00" → instante del reloj AR (sin depender del host). */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));
const DAY = "2027-05-10";
const range = { from: ar(DAY, "00:00"), to: ar("2027-05-11", "00:00") };

describe.skipIf(!RUN)("S07k · listBookingsInRange: PHI y plan activo determinístico", () => {
  let db: PrismaClient;
  /** sharedPatientView: true → ASSISTANT y PRACTITIONER con acceso full a todos. */
  let A: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let patientId: string;
  let withPatientId: string;
  let guestId: string;

  /** Caso + diagnóstico (condición propia del tenant) + programa ACTIVE. */
  async function activeProgram(name: string, createdAt: Date): Promise<void> {
    const cond = await db.condition.create({
      data: { tenantId: A.tenantId, slug: `s07k-${uniqueSuffix()}`, name },
    });
    const kase = await db.clinicalCase.create({
      data: {
        tenantId: A.tenantId,
        authorId: A.practitionerId,
        patientId,
        selectedZones: [],
        refinements: {},
        diagnoses: { create: { conditionId: cond.id, matchScore: 1, rank: 0, confirmed: true } },
      },
    });
    await db.treatmentProgram.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        caseId: kase.id,
        title: name,
        startDate: createdAt,
        status: "ACTIVE",
        createdAt,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { sharedPatientView: true });
    assistant = await addPractitioner(db, A, "ASSISTANT");
    patientId = await addPatient(db, A);

    // Dos ACTIVE: el viejo se inserta PRIMERO (sin orderBy, el heap lo
    // devuelve antes y el chip mostraba el diagnóstico viejo).
    await activeProgram("Diagnóstico viejo", new Date("2026-01-01T12:00:00Z"));
    await activeProgram("Diagnóstico nuevo", new Date("2026-06-01T12:00:00Z"));

    const withPatient = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId,
        scheduledFor: ar(DAY, "10:00"),
        durationMin: 45,
        status: "CONFIRMED",
        title: "Lumbalgia",
        description: "detalle clínico",
        notes: "nota clínica",
        idempotencyKey: `s07k-${uniqueSuffix()}`,
      },
    });
    withPatientId = withPatient.id;
    const guest = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        guestName: "Invitado",
        scheduledFor: ar(DAY, "12:00"),
        durationMin: 45,
        status: "PENDING",
        title: "Cervicalgia guest",
        description: "detalle guest",
        notes: "tel 1234",
        idempotencyKey: `s07k-${uniqueSuffix()}`,
      },
    });
    guestId = guest.id;
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[P0-S07k] listBookingsInRange con 2 ACTIVE toma el más reciente", async () => {
    asUser(A.userId);
    const rows = await listBookingsInRange(range);
    const row = rows.find((r) => r.id === withPatientId)!;
    expect(row.patientAccess).toBe("full");
    expect(row.patientCondition).toBe("Diagnóstico nuevo");
  });

  it("OWNER (clinical.read + full): ve title/description/notes del turno con paciente y del guest", async () => {
    asUser(A.userId);
    const rows = await listBookingsInRange(range);
    expect(rows.find((r) => r.id === withPatientId)).toMatchObject({
      title: "Lumbalgia",
      description: "detalle clínico",
      notes: "nota clínica",
    });
    expect(rows.find((r) => r.id === guestId)).toMatchObject({
      title: "Cervicalgia guest",
      description: "detalle guest",
      notes: "tel 1234",
      patientCondition: null,
    });
  });

  it("[P0-S07k] ASSISTANT con sharedPatientView: listBookingsInRange sin title/description/notes/patientCondition", async () => {
    asUser(assistant.userId);
    const rows = await listBookingsInRange(range);
    expect(rows.map((r) => r.id).sort()).toEqual([withPatientId, guestId].sort());
    const row = rows.find((r) => r.id === withPatientId)!;
    // PD-13: la Secretaria queda en `admin`, que en `BookingRow` viaja como basic.
    expect(row.patientAccess).toBe("basic");
    expect({
      title: row.title,
      description: row.description,
      notes: row.notes,
      patientCondition: row.patientCondition,
    }).toEqual({ title: null, description: null, notes: null, patientCondition: null });
    // Nombre del paciente y datos operativos siguen (la Secretaria opera la agenda).
    expect(row.patientName).toMatch(/^Paciente /);
    expect(row.serviceName).toBe("Consulta");
  });

  it("[P0-S07k] ASSISTANT en un guest: title/description ocultos, la nota administrativa queda (= listAgendaBookings)", async () => {
    asUser(assistant.userId);
    const rows = await listBookingsInRange(range);
    expect(rows.find((r) => r.id === guestId)).toMatchObject({
      title: null,
      description: null,
      notes: "tel 1234",
      patientCondition: null,
      patientAccess: "none",
    });
  });
});
