/**
 * Turnos con evolución (EV2, M9 `20261017120000_clinical_notes`; brief EV2 §0 R1/R2, C-EV2-7, EV2-D21/D23).
 *
 * M9 cuelga ClinicalNote del turno con FKs RESTRICT, incluida la compuesta (bookingId, tenantId, patientId) →
 * Booking. Consecuencias que la base ya garantiza y que la app todavía NO traduce (las da vuelta EV2-2c, único dueño
 * de lib/bookings.ts y lib/bookings-core.ts en EV2):
 *   - `deleteBooking` borra en duro: con una evolución, la FK tira P2003 crudo (un 500) en vez del mensaje
 *     «cancelalo en vez de eliminarlo» (BOOKING_HAS_CLINICAL_NOTE_ERROR, C-EV2-7).
 *   - `updateBooking` con otro `patientId`: la FK compuesta tira 23503 crudo en vez de
 *     BOOKING_CLINICAL_NOTE_PATIENT_ERROR.
 * EV2-0 los escribió como `it.fails("[EV2] …")`; EV2-2c los dio vuelta: `deleteBookingImpl` mira la nota antes de
 * los pagos (+1 sentencia solo ahí) y `applyBookingUpdateInTx` solo en la rama de cambio de paciente (0 sentencias en
 * el camino normal). El copy se importa de lib/bookings-constants.ts (C-EV2-7).
 *
 * La nota la siembra el owner con SQL (ninguna action de evoluciones existe todavía). Corre igual en
 * `test:integration` (kinesoft_app) y en `:owner`; la limpieza va por deleteTenantDeep (notas en modo réplica).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, deleteBooking, updateBooking } from "@/lib/bookings";
import { BOOKING_CLINICAL_NOTE_PATIENT_ERROR, BOOKING_HAS_CLINICAL_NOTE_ERROR } from "@/lib/bookings-constants";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** "2027-03-10", "10:00" → instante ISO del reloj AR (sin depender del host). */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("turnos con evolución (M9)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  /** Turno real (createBooking) + evolución sembrada por el owner sobre ese turno. */
  async function bookingWithNote(day: string): Promise<{ bookingId: string; patientId: string }> {
    const patientId = await addPatient(db, A);
    const r = await createBooking({
      patientId,
      serviceId: A.serviceId,
      practitionerId: A.practitionerId,
      scheduledFor: ar(day, "10:00"),
      durationMin: 45,
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(r.error);
    await db.$executeRaw`
      INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "bookingId", body, "occurredAt", "authorUserId",
                                  "authorPractitionerId", "authorName", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${`ev2-bcn-${uniqueSuffix()}`}, ${A.tenantId}, ${patientId}, ${r.data.id}, 'Evolución de prueba',
              ${new Date(ar(day, "10:00"))}, ${A.userId}, ${A.practitionerId}, 'Kine Test', ${randomUUID()},
              now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    return { bookingId: r.data.id, patientId };
  }

  it("precondición: la evolución quedó colgada del turno", async () => {
    const { bookingId } = await bookingWithNote("2027-04-01");
    expect(await db.clinicalNote.count({ where: { bookingId } })).toBe(1);
  });

  it("[EV2] deleteBooking rechaza un turno con evolución («cancelalo») y el turno sigue", async () => {
    const { bookingId } = await bookingWithNote("2027-04-02");
    const d = await deleteBooking(bookingId);
    expect(d.ok).toBe(false);
    expect(d.ok ? "" : d.error).toBe(BOOKING_HAS_CLINICAL_NOTE_ERROR);
    expect(await db.booking.count({ where: { id: bookingId } })).toBe(1);
    expect(await db.clinicalNote.count({ where: { bookingId } })).toBe(1);
  });

  it("[EV2] updateBooking rechaza cambiar el paciente de un turno con evolución", async () => {
    const { bookingId, patientId } = await bookingWithNote("2027-04-03");
    const other = await addPatient(db, A);
    const u = await updateBooking({ id: bookingId, patientId: other });
    expect(u.ok).toBe(false);
    expect(u.ok ? "" : u.error).toBe(BOOKING_CLINICAL_NOTE_PATIENT_ERROR);
    const row = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { patientId: true } });
    expect(row.patientId).toBe(patientId);
    expect(await db.clinicalNote.count({ where: { bookingId, patientId } })).toBe(1);
  });

  it("[EV2-2c] una evolución ANULADA también frena el borrado (la FK no distingue)", async () => {
    const { bookingId } = await bookingWithNote("2027-04-05");
    await db.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${A.userId},
                                "voidReason" = 'Cargada en el turno equivocado'
      WHERE "bookingId" = ${bookingId}`;
    const d = await deleteBooking(bookingId);
    expect(d.ok ? "" : d.error).toBe(BOOKING_HAS_CLINICAL_NOTE_ERROR);
    expect(await db.booking.count({ where: { id: bookingId } })).toBe(1);
  });

  it("[EV2-2c] el turno con evolución se sigue editando y cancelando sin cambiar el paciente", async () => {
    const { bookingId, patientId } = await bookingWithNote("2027-04-06");
    // Reenviar el mismo paciente no es un cambio: no dispara el rechazo.
    const u = await updateBooking({ id: bookingId, patientId, notes: "Trae estudios" });
    expect(u.ok).toBe(true);
    const c = await updateBooking({ id: bookingId, status: "CANCELLED" });
    expect(c.ok).toBe(true);
    const row = await db.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { patientId: true, status: true, notes: true },
    });
    expect(row).toEqual({ patientId, status: "CANCELLED", notes: "Trae estudios" });
    expect(await db.clinicalNote.count({ where: { bookingId } })).toBe(1);
  });

  it("[EV2-2c] un turno sin evolución se borra y se re-vincula igual que antes", async () => {
    const patientId = await addPatient(db, A);
    const other = await addPatient(db, A);
    const mk = async (hhmm: string) => {
      const r = await createBooking({
        patientId,
        serviceId: A.serviceId,
        practitionerId: A.practitionerId,
        scheduledFor: ar("2027-04-07", hhmm),
        durationMin: 45,
        idempotencyKey: randomUUID(),
      });
      if (!r.ok) throw new Error(r.error);
      return r.data.id;
    };
    const toMove = await mk("10:00");
    const u = await updateBooking({ id: toMove, patientId: other });
    expect(u.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: toMove }, select: { patientId: true } })).patientId).toBe(
      other
    );
    const toDelete = await mk("12:00");
    const d = await deleteBooking(toDelete);
    expect(d.ok).toBe(true);
    expect(await db.booking.count({ where: { id: toDelete } })).toBe(0);
  });
});
