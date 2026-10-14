/**
 * IAM-4b · los write-paths de turnos rechazan un profesional que NO atiende en
 * el consultorio (rol no clínico, membresía no aceptada o suspendida).
 *
 * Por qué: IAM-2e sacó a la Secretaria (ASSISTANT) y a Facturación (BILLING)
 * de las LISTAS (agenda, turnero, disponibilidad «todos»), pero los write-paths
 * validaban el `practitionerId` solo contra el tenant: por RPC (o con un id
 * viejo en el cliente) se le cargaba un turno a la Secretaria, y el loader con
 * `practitionerIds` explícitos le ofrecía slots (con el horario de fallback del
 * consultorio, porque no tiene franjas). Ahora:
 *   - `createBooking` / `createBookingsBatch`: la lectura del profesional que
 *     ya existía (`validateBookingRefsInTx`) lleva `bookablePractitionerWhere`
 *     → «Ese profesional no atiende en este consultorio.» SIN sentencias nuevas;
 *   - `updateBooking` que MUEVE (o reactiva) un turno viejo de un profesional no
 *     reservable → mismo mensaje (lo detecta el loader que ya corría: sin
 *     plantilla para ese id). Cancelar / editar notas sigue andando: el turno
 *     viejo se tiene que poder limpiar;
 *   - `loadAvailabilityInputs` con un id no reservable → sin plantillas ni slots;
 *   - Planes: un responsable con la membresía suspendida se rechaza (el rol ya
 *     se chequeaba desde P0).
 *
 * Anti-false-green: cada profesional no reservable tiene `PractitionerService`
 * habilitado para el servicio, así sin el guard el alta pasaría (se ve en los
 * controles positivos con el kine).
 *
 * Símbolos reales contra el Docker local en los dos roles; se mockea la sesión
 * (integration-setup). Fechas en 2032 (futuro).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, updateBooking, setBookingStatus } from "@/lib/bookings";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput } from "@/lib/plans-types";
import { PRACTITIONER_NOT_BOOKABLE_ERROR } from "@/lib/bookings-core";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();

type Staff = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("IAM-4b · turnos solo con profesionales reservables", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: Staff;
  let assistant: Staff;
  let billing: Staff;
  let suspended: Staff;
  let pat: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
    suspended = await addPractitioner(db, T, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
    await db.practitionerService.createMany({
      data: [kine, assistant, billing, suspended].map((s) => ({
        tenantId: T.tenantId,
        practitionerId: s.practitionerId,
        serviceId: T.serviceId,
        enabled: true,
        visibility: "PUBLIC" as const,
      })),
    });
    pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
  });

  beforeEach(() => asUser(T.userId)); // OWNER: full sobre todo, el gate E1 no interfiere

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const countFor = (practitionerId: string) =>
    db.booking.count({ where: { tenantId: T.tenantId, practitionerId } });

  it("[IAM-4b] createBooking con el id de una Secretaria se rechaza", async () => {
    for (const [i, p] of [assistant, billing, suspended].entries()) {
      const r = await createBooking({
        patientId: pat,
        serviceId: T.serviceId,
        practitionerId: p.practitionerId,
        scheduledFor: ar("2032-03-01", `1${i}:00`),
        idempotencyKey: key(),
        allowOutOfHours: true,
      });
      expect(r).toEqual({ ok: false, error: PRACTITIONER_NOT_BOOKABLE_ERROR });
      expect(await countFor(p.practitionerId)).toBe(0);
    }
    // Control: el kine sí (mismo servicio, mismo paciente).
    const ok = await createBooking({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: kine.practitionerId,
      scheduledFor: ar("2032-03-01", "15:00"),
      idempotencyKey: key(),
      allowOutOfHours: true,
    });
    expect(ok).toMatchObject({ ok: true });
  });

  it("[IAM-4b] createBookingsBatch con el id de una Secretaria se rechaza (también el dryRun)", async () => {
    for (const dryRun of [true, false]) {
      const r = await createBookingsBatch({
        patientId: pat,
        serviceId: T.serviceId,
        practitionerId: assistant.practitionerId,
        scheduledFor: ar("2032-03-08", "10:00"),
        count: 2,
        idempotencyKey: key(),
        dryRun,
      });
      expect(r).toEqual({ ok: false, error: PRACTITIONER_NOT_BOOKABLE_ERROR });
    }
    expect(await countFor(assistant.practitionerId)).toBe(0);
    const ok = await createBookingsBatch({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: kine.practitionerId,
      scheduledFor: ar("2032-03-08", "10:00"),
      count: 2,
      idempotencyKey: key(),
    });
    expect(ok).toMatchObject({ ok: true });
  });

  it("[IAM-4b] reprogramar un turno viejo de la Secretaria se rechaza; cancelarlo sigue andando", async () => {
    // Turno de antes de IAM-2e (cargado directo, como en prod).
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: assistant.practitionerId,
        patientId: pat,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar("2032-03-17", "10:00")),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: key(),
      },
    });
    const moved = await updateBooking({
      id: b.id,
      scheduledFor: ar("2032-03-18", "11:00"),
      expectedUpdatedAt: b.updatedAt.toISOString(),
      allowOutOfHours: true,
    });
    expect(moved).toEqual({ ok: false, error: PRACTITIONER_NOT_BOOKABLE_ERROR });
    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(+row.scheduledFor).toBe(+b.scheduledFor);
    expect(+row.updatedAt).toBe(+b.updatedAt);

    // Notas: sin cambio de horario no se re-clasifica → se puede limpiar el turno viejo.
    const noted = await updateBooking({ id: b.id, notes: "reasignar", expectedUpdatedAt: b.updatedAt.toISOString() });
    expect(noted).toMatchObject({ ok: true });
    const v1 = noted.ok ? noted.data.updatedAt : "";
    const cancelled = await setBookingStatus(b.id, "CANCELLED", typeof v1 === "string" ? v1 : new Date(v1).toISOString());
    expect(cancelled).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CANCELLED");
  });

  it("[IAM-4b] loader con un id no reservable → sin plantillas ni slots", async () => {
    const day = "2032-03-22";
    const input = await loadAvailabilityInputs(db, {
      tenantId: T.tenantId,
      practitionerIds: [assistant.practitionerId, billing.practitionerId, suspended.practitionerId, kine.practitionerId],
      serviceId: T.serviceId,
      from: day,
      to: day,
    });
    expect(input.templates.map((t) => t.practitionerId)).toEqual([kine.practitionerId]);
    expect(input.practitionerServices.map((ps) => ps.practitionerId)).toEqual([kine.practitionerId]);
  });

  it("[IAM-4b] Planes: un responsable con la membresía suspendida se rechaza", async () => {
    asUser(T.userId);
    const input: PlanCreateInput = {
      idempotencyKey: key(),
      patientId: pat,
      discipline: "KINESIOLOGY",
      practitionerId: suspended.practitionerId,
      serviceId: T.serviceId,
      locationId: null,
      schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] },
      startDayKey: "2032-04-05",
      totalSessions: 2,
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 10_000_00 },
      rows: [],
      stateToken: "x",
    };
    const p = await previewPlan(input);
    expect(p.ok).toBe(false);
    const r = await createPlan(input);
    expect(r.ok).toBe(false);
    expect(await db.treatmentProgram.count({ where: { tenantId: T.tenantId, practitionerId: suspended.practitionerId } })).toBe(0);
  });
});
