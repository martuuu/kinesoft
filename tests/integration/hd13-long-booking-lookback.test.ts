/**
 * [HD-13] PV (§27, ola Q1, sesión W1d) — el cupo y el solape del paciente ven los turnos de hasta 480 min.
 *
 * El bug (AUDIT «Hallazgo B cupo-lookback-240», Ronda T3): `Service.durationMin` admite hasta 480
 * (`lib/validation.ts`), pero `countCapacityOverlaps` / `countAgendaOccupancy` traían candidatos desde
 * `inicio − 240'` y `checkPatientOverlap` desde `min(día AR, inicio − 240')`. Un turno de 6 h que arrancó a las
 * 08:00 no entraba en el conteo de un alta a las 12:30 (08:00 < 08:30) y el cupo 1 se veía libre: dos turnos a la vez
 * en un servicio de cupo 1, sin pedir sobreturno. Con `BOOKING_LOOKBACK_MIN = 480` (= tope de `Service.durationMin`)
 * la ventana hacia atrás cubre cualquier turno que pueda seguir en curso.
 *
 * Símbolos reales: `createBooking` (lock de cupo + conteo en la misma tx), `classifyBookingInstant` (motor + loader),
 * `checkPatientOverlap` dentro de `runWithRls`. Se mockea solo la sesión (integration-setup). Corre en los dos roles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking } from "@/lib/bookings";
import { checkPatientOverlap, countCapacityOverlaps } from "@/lib/bookings-core";
import { classifyBookingInstant } from "@/lib/availability-actions";
import { BOOKING_LOOKBACK_MIN } from "@/lib/availability/types";
import { runWithRls } from "@/lib/rls";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → ISO. */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("[HD-13] lookback del cupo y del solape = 480 min", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** 360', cupo 1, del titular (sin franjas: horario del consultorio lun-sáb 8-19). */
  let longSvc: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    longSvc = await addService(db, T, { name: "Rehabilitación intensiva", durationMin: 360, maxConcurrent: 1 });
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("la constante es el tope de Service.durationMin", () => {
    expect(BOOKING_LOOKBACK_MIN).toBe(480);
  });

  it("[HD-13] turno de 360' a las 08:00 con cupo 1: el alta de las 12:30 se rechaza por cupo y la disponibilidad de 12:30 está ocupada", async () => {
    const day = "2027-11-09"; // martes
    const [p1, p2] = [await addPatient(db, T), await addPatient(db, T)];
    // Sin `durationMin`: toma la del servicio (360'); `BookingCreate` tope 240 no aplica al default del servicio.
    const first = await createBooking({
      patientId: p1,
      serviceId: longSvc,
      practitionerId: T.practitionerId,
      scheduledFor: ar(day, "08:00"),
      idempotencyKey: randomUUID(),
    });
    if (!first.ok) throw new Error(`alta de las 08:00: ${first.error}`);
    expect((await db.booking.findUnique({ where: { id: first.data.id } }))?.durationMin).toBe(360);

    const second = await createBooking({
      patientId: p2,
      serviceId: longSvc,
      practitionerId: T.practitionerId,
      scheduledFor: ar(day, "12:30"),
      idempotencyKey: randomUUID(),
    });
    expect(second.ok).toBe(false);
    expect("conflict" in second && second.conflict).toBeTruthy();
    // No se escribió nada: sigue habiendo un solo turno del servicio ese día.
    expect(await db.booking.count({ where: { tenantId: T.tenantId, serviceId: longSvc, status: { not: "CANCELLED" } } })).toBe(1);

    // El conteo de cupo (contrato §5) ve el turno en curso.
    const used = await runWithRls(T.tenantId, (tx) =>
      countCapacityOverlaps(tx, {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: longSvc,
        start: new Date(ar(day, "12:30")),
        end: new Date(new Date(ar(day, "12:30")).getTime() + 360 * 60_000),
        now: new Date(),
      })
    );
    expect(used).toBe(1);

    // Disponibilidad (aviso del modal): 12:30 ocupada por el turno de las 08:00.
    const check = await classifyBookingInstant({
      practitionerId: T.practitionerId,
      serviceId: longSvc,
      scheduledFor: ar(day, "12:30"),
    });
    expect(check).toMatchObject({ ok: true, data: { class: "sobreturno", used: 1, cap: 1 } });
  });

  it("[HD-13] solape del paciente: un turno de 360' que cruza la medianoche AR se ve desde el día siguiente", async () => {
    // 20:30 + 360' = 02:30 del día siguiente. Alta a la 01:00: la cota vieja `min(00:00, 01:00 − 240')` = 21:00 del
    // día anterior dejaba afuera el turno de las 20:30 (siguen juntos de 01:00 a 01:45); con 480 la cota es 17:00.
    const patient = await addPatient(db, T);
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: longSvc,
        patientId: patient,
        scheduledFor: new Date(ar("2027-11-10", "20:30")),
        durationMin: 360,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    const start = new Date(ar("2027-11-11", "01:00"));
    const r = await runWithRls(T.tenantId, (tx) =>
      checkPatientOverlap(tx, {
        tenantId: T.tenantId,
        patientId: patient,
        start,
        end: new Date(start.getTime() + 45 * 60_000),
      })
    );
    expect(r.overlapISO).toBe(new Date(ar("2027-11-10", "20:30")).toISOString());
    expect(r.sameInstant).toBe(false);
    // El arrastre del día anterior no dispara el aviso suave de «otro turno el mismo día».
    expect(r.sameDayStarts).toEqual([]);
  });
});
