/**
 * Core de turnos server-only (S07c, ES2b P2.0; PLANES.md §10 y C8).
 *
 * Qué afirma:
 *   - `applyBookingUpdateInTx` (el cuerpo de la tx de `updateBooking`, ahora
 *     llamable dentro de la tx de Planes) da el MISMO outcome que la action:
 *     stale, patient-slot, fuera de horario y cupo; y el ok trae `refs`
 *     (enmienda Realtime) con `prev` cuando se movió;
 *   - contrato Secretaria (E1, C8): el gate `canOperateBooking` y el filtrado
 *     de `bookingFieldAccess` viven DENTRO del core: llamarlo directo (como
 *     hará "este y los siguientes") no los saltea;
 *   - `afterBookingsCommitted` reemplaza a `invalidateBookingDerivedCaches`:
 *     `revalidateTag(bookingDays)` sale DESPUÉS del commit (otra conexión ya ve
 *     la fila nueva) y no sale si la tx falla o no escribe; la recepción emite
 *     siempre pero solo invalida con cambio de estado.
 *
 * Se mockea solo `next/cache` (spy de tests/helpers/integration-setup.ts) y la
 * sesión; el core y las actions corren reales contra Postgres, en los dos roles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  updateBooking,
  deleteBooking,
  setBookingCopagoPaid,
  markReceptionAction,
} from "@/lib/bookings";
import { applyBookingUpdateInTx, type BookingUpdateTxOutcome } from "@/lib/bookings-core";
import {
  OUT_OF_HOURS_ERROR,
  STALE_ERROR,
  UPDATE_SAME_INSTANT_ERROR,
  BASIC_ACCESS_ERROR,
} from "@/lib/bookings-constants";
import { BookingUpdate, type BookingUpdateInput } from "@/lib/validation";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import { tags } from "@/lib/cache-tags";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";

const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();

/** El core dentro de una tx propia, con el actor de la sesión mockeada (como lo llamará Planes). */
async function core(
  patch: BookingUpdateInput,
  o: { expectedUpdatedAt?: string; force?: ForceFlags; capLocksHeld?: boolean } = {}
): Promise<BookingUpdateTxOutcome> {
  const actor = await getActor();
  return runWithRls(actor.tenantId, (tx) =>
    applyBookingUpdateInTx(
      tx,
      actor,
      { patch: BookingUpdate.parse(patch), expectedUpdatedAt: o.expectedUpdatedAt, force: o.force ?? {} },
      { now: new Date(), capLocksHeld: o.capLocksHeld }
    )
  );
}

describe.skipIf(!RUN)("core de turnos (S07c)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let centro: string;
  /** Cupo 1, 60 min. */
  let osteoId: string;
  let other: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    osteoId = await addService(db, T, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
    centro = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    // Lun-vie 9-13: un horario a las 18 queda fuera de la franja.
    await db.practitionerSchedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        locationId: centro,
        dow,
        startMin: 9 * 60,
        endMin: 13 * 60,
      })),
    });
    other = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
  });

  beforeEach(() => {
    asUser(T.userId);
    revalidateTagSpy.mockReset();
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const base = (patientId: string, when: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    serviceId: T.serviceId,
    practitionerId: T.practitionerId,
    scheduledFor: when,
    durationMin: 45,
    idempotencyKey: key(),
    ...extra,
  });

  async function book(patientId: string, when: string, extra: Record<string, unknown> = {}) {
    const r = await createBooking(base(patientId, when, extra));
    if (!r.ok) throw new Error(r.error);
    return db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
  }

  const bookingDaysCalls = () =>
    revalidateTagSpy.mock.calls.filter(([t]) => t === tags.bookingDays(T.tenantId)).length;

  // ── Paridad core ↔ updateBooking ───────────────────────────────────────
  describe("applyBookingUpdateInTx da el mismo outcome que updateBooking", () => {
    it("stale: versión vieja → core 'stale' y la action STALE_ERROR, sin escribir", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-01", "10:00"));
      const old = new Date(b.updatedAt.getTime() - 1000).toISOString();
      const patch = { id: b.id, notes: "pisada" };
      expect((await core(patch, { expectedUpdatedAt: old })).kind).toBe("stale");
      const r = await updateBooking({ ...patch, expectedUpdatedAt: old });
      expect(r).toMatchObject({ ok: false, error: STALE_ERROR });
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).notes).toBe(b.notes);
    });

    it("patient-slot: mover al instante exacto de otro turno del paciente", async () => {
      const p = await addPatient(db, T);
      await book(p, ar("2027-11-02", "10:00"));
      const b = await book(p, ar("2027-11-02", "11:00"), { allowSamePatientDay: true });
      const patch = { id: b.id, scheduledFor: ar("2027-11-02", "10:00") };
      expect((await core(patch)).kind).toBe("patient-slot");
      expect(await updateBooking(patch)).toMatchObject({ ok: false, error: UPDATE_SAME_INSTANT_ERROR });
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.scheduledFor.toISOString()).toBe(ar("2027-11-02", "11:00"));
    });

    it("fuera de horario: core 'out-of-hours' con los datos del aviso; la action el prompt; forzado pasa", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-03", "10:00"));
      const patch = { id: b.id, scheduledFor: ar("2027-11-03", "18:00") };
      const o = await core(patch);
      expect(o.kind).toBe("out-of-hours");
      if (o.kind === "out-of-hours") {
        expect(o.newWhen.toISOString()).toBe(ar("2027-11-03", "18:00"));
        expect(o.before.id).toBe(b.id);
        expect(o.finalPatientId).toBe(p);
      }
      const r = await updateBooking(patch);
      expect(r).toMatchObject({ ok: false, error: OUT_OF_HOURS_ERROR });
      expect("outOfHours" in r && r.outOfHours).toBeTruthy();
      expect((await core(patch, { force: { allowOutOfHours: true } })).kind).toBe("ok");
    });

    it("cupo: mover sobre un cupo 1 lleno → 'conflict' en los dos; con allowOverbooking queda sobreturno", async () => {
      const p1 = await addPatient(db, T);
      const p2 = await addPatient(db, T);
      await book(p1, ar("2027-11-04", "10:00"), { serviceId: osteoId, durationMin: 60 });
      const b = await book(p2, ar("2027-11-04", "12:00"), { serviceId: osteoId, durationMin: 60 });
      const patch = { id: b.id, scheduledFor: ar("2027-11-04", "10:00") };
      const o = await core(patch);
      expect(o.kind).toBe("conflict");
      if (o.kind === "conflict") expect(o.cap).toBe(1);
      const r = await updateBooking(patch);
      expect(r.ok).toBe(false);
      expect("conflict" in r && r.conflict).toBeTruthy();
      expect((await core(patch, { force: { allowOverbooking: true } })).kind).toBe("ok");
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).isOverbooked).toBe(true);
    });

    it("ok: escribe y devuelve refs con prev (movido) y written; sin mover, prev null", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-05", "10:00"));
      const o = await core({ id: b.id, scheduledFor: ar("2027-11-05", "11:00"), notes: "control" });
      expect(o.kind).toBe("ok");
      if (o.kind !== "ok") return;
      expect(o.refs).toEqual([
        {
          bookingId: b.id,
          practitionerId: T.practitionerId,
          scheduledFor: new Date(ar("2027-11-05", "11:00")),
          // SR (SR2a): la sala de después y la de antes; null = sin sala.
          roomId: null,
          prev: { practitionerId: T.practitionerId, scheduledFor: new Date(ar("2027-11-05", "10:00")), roomId: null },
          kind: "booking",
        },
      ]);
      expect(o.written).toMatchObject({ notes: "control" });
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.scheduledFor.toISOString()).toBe(ar("2027-11-05", "11:00"));
      expect(+row.updatedAt).toBe(+o.updatedAt);

      const o2 = await core({ id: b.id, notes: "otra" });
      expect(o2.kind === "ok" && o2.refs[0].prev).toBeNull();
    });

    it("capLocksHeld: el caller ya tomó el cupo; el core igual valida y escribe", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-08", "10:00"));
      const o = await core({ id: b.id, scheduledFor: ar("2027-11-08", "12:00") }, { capLocksHeld: true });
      expect(o.kind).toBe("ok");
      // No saltea la clasificación: fuera de franja sigue avisando.
      expect((await core({ id: b.id, scheduledFor: ar("2027-11-08", "19:00") }, { capLocksHeld: true })).kind).toBe(
        "out-of-hours"
      );
    });
  });

  // ── Contrato Secretaria DENTRO del core (E1, C8) ──────────────────────
  describe("contrato Secretaria dentro de applyBookingUpdateInTx", () => {
    it("PRACTITIONER ajeno (acceso básico) llamando al core directo → 'basic', sin escribir", async () => {
      const p = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
      const b = await book(p, ar("2027-11-09", "10:00"));
      asUser(other.userId);
      expect((await core({ id: b.id, scheduledFor: ar("2027-11-09", "11:00") })).kind).toBe("basic");
      expect(await updateBooking({ id: b.id, scheduledFor: ar("2027-11-09", "11:00") })).toMatchObject({
        ok: false,
        error: BASIC_ACCESS_ERROR,
      });
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.scheduledFor.toISOString()).toBe(ar("2027-11-09", "10:00"));
    });

    it("Secretaria por el core: mueve el turno pero las notas clínicas salen del patch (ni write ni written)", async () => {
      const p = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
      const b = await book(p, ar("2027-11-10", "10:00"), { notes: "nota clínica" });
      asUser(assistant.userId);
      const o = await core({ id: b.id, scheduledFor: ar("2027-11-10", "11:00"), notes: "pisada" });
      expect(o.kind).toBe("ok");
      if (o.kind === "ok") expect(o.written).not.toHaveProperty("notes");
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.notes).toBe("nota clínica");
      expect(row.scheduledFor.toISOString()).toBe(ar("2027-11-10", "11:00"));
    });
  });

  // ── afterBookingsCommitted (enmienda Realtime) ─────────────────────────
  describe("afterBookingsCommitted después del commit", () => {
    it("updateBooking ok: revalida bookingDays y, en ese momento, otra conexión ya ve la fila nueva", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-11", "10:00"));
      revalidateTagSpy.mockReset();
      let seen: Promise<Date | undefined> | undefined;
      revalidateTagSpy.mockImplementation((t: string) => {
        if (t === tags.bookingDays(T.tenantId) && !seen) {
          // Lectura por OTRA conexión (owner): solo ve lo commiteado.
          seen = db.booking.findUnique({ where: { id: b.id } }).then((r) => r?.scheduledFor);
        }
      });
      const r = await updateBooking({ id: b.id, scheduledFor: ar("2027-11-11", "12:00") });
      expect(r.ok).toBe(true);
      expect(bookingDaysCalls()).toBe(1);
      expect((await seen)?.toISOString()).toBe(ar("2027-11-11", "12:00"));
    });

    it("tx que no escribe (stale) → no revalida", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-12", "10:00"));
      revalidateTagSpy.mockReset();
      const r = await updateBooking({
        id: b.id,
        notes: "x",
        expectedUpdatedAt: new Date(b.updatedAt.getTime() - 1000).toISOString(),
      });
      expect(r.ok).toBe(false);
      expect(bookingDaysCalls()).toBe(0);
    });

    it("tx abortada por el índice único parcial (P2002) → rollback y no revalida", async () => {
      const p = await addPatient(db, T);
      await book(p, ar("2027-11-15", "10:00"));
      revalidateTagSpy.mockReset();
      // Con los dos allow* el alta saltea el guard del paciente: el upsert
      // choca con el índice y la tx entera se aborta.
      const r = await createBooking(
        base(p, ar("2027-11-15", "10:00"), { allowSamePatientDay: true, allowPatientOverlap: true })
      );
      expect(r.ok).toBe(false);
      expect(await db.booking.count({ where: { patientId: p } })).toBe(1);
      expect(bookingDaysCalls()).toBe(0);
    });

    it("createBooking, cobro y borrado revalidan bookingDays una vez cada uno", async () => {
      const p = await addPatient(db, T);
      const b = await book(p, ar("2027-11-16", "10:00"));
      expect(bookingDaysCalls()).toBe(1);
      revalidateTagSpy.mockReset();
      const paid = await setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString());
      expect(paid.ok).toBe(true);
      expect(bookingDaysCalls()).toBe(1);
      if (!paid.ok) return;
      const unpaid = await setBookingCopagoPaid(b.id, false, paid.data.updatedAt.toISOString());
      if (!unpaid.ok) throw new Error(unpaid.error);
      revalidateTagSpy.mockReset();
      expect((await deleteBooking(b.id, unpaid.data.updatedAt.toISOString())).ok).toBe(true);
      expect(bookingDaysCalls()).toBe(1);
    });

    it("recepción: 'llegó' no invalida los caches (sin cambio de estado); 'atendido' sí", async () => {
      const p = await addPatient(db, T);
      // Turno de HOY (la llegada solo se marca en el día), directo en la base.
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          patientId: p,
          scheduledFor: new Date(),
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: key(),
        },
      });
      const r1 = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
      if (!r1.ok) throw new Error(r1.error);
      expect(bookingDaysCalls()).toBe(0);
      const r2 = await markReceptionAction(b.id, "atendido", r1.data.updatedAt);
      expect(r2.ok).toBe(true);
      expect(bookingDaysCalls()).toBe(1);
    });
  });
});
