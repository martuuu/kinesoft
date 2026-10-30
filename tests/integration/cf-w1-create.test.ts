/**
 * [CF-W1] CF (§28, decisiones 1 y 2 del 30-oct, ADR-032) — la regla «el profesional no atiende servicios distintos a
 * la vez» en el ALTA de un turno (`createBooking`) y en el LOTE (`createBookingsBatch`), contra Postgres real en los
 * dos roles.
 *
 * El bug (feedback del cliente): el cupo es por servicio (`countCapacityOverlaps`, §5), así que una Evaluación a las
 * 10:30 encima de la Kinesiología de las 10:00 del mismo profesional entraba sin aviso, aunque el profesional no puede
 * atender las dos.
 *
 * Contratos que fija (brief CF A.5 y handoff [CF-W2→CF-W1], literal):
 *   - El alta toma `pday: practitionerDayKeysForWindow(...)` en el MISMO `lockAgendaKeysMany` (cupo → día → hora →
 *     sala) y cuenta el otro servicio en la MISMA sentencia que el cupo (`countAgendaOccupancy` con
 *     `exclusiveService` del `pre`, como `icap`, y el `patientId` del turno).
 *   - Orden en la tx: cupo (`conflict`) → OTRO SERVICIO → tope → sala. Sin `allowOtherService` → `otherService:
 *     BookingOtherServicePrompt` + `OTHER_SERVICE_ERROR`, sin escribir. `allowOverbooking` NO lo fuerza (flag propio).
 *   - Forzado (`allowOtherService`) = sobreturno: `isOverbooked` + prefijo `[SOBRETURNO]` (§5.29).
 *   - Mismo servicio: hasta el cupo, sin aviso de otro servicio. Mismo paciente (no nulo, CF-D3): sin aviso; un guest
 *     no se exime. Un hold público vencido no cuenta (CF-D5).
 *   - `allowParallelServices = true` = la conducta de antes, exacta (sin claves nuevas en la respuesta del lote).
 *   - Lote (CF-D4): se pliega en «sobreturno» — la fecha que choca sube a `sobreturno` con `otherServiceBusy: true`,
 *     se omite sin `allowOverbooking` y con él entra `isOverbooked` + prefijo. El re-chequeo en la tx (con el día
 *     tomado) ve lo commiteado después del preflight.
 *
 * Arrancaron como `it.fails` (CF-W1) y se dieron vuelta al implementar. Símbolos reales; se mockean la sesión
 * (`asUser`) y `next/cache` (setup). Fixtures por owner. Servicios del consultorio (sin fila PractitionerService),
 * sin tope por intervalo, sin franjas (fallback lun-sáb 08-19). Un profesional por caso (no se pisan). Fechas de ene
 * 2028 (lun = 2028-01-10).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch } from "@/lib/bookings";
import { practitionerDayLockKey } from "@/lib/booking-cap-lock";
import { OTHER_SERVICE_ERROR, isOtherServiceError } from "@/lib/bookings-constants";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

describe.skipIf(!RUN)("[CF-W1] alta y lote con «no atiende servicios distintos a la vez»", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svcA: string; // «Kine», 60', ilimitado
  let svcB: string; // «Evaluación», 60', ilimitado
  let svcC: string; // «Grupo», 60', cupo 2

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    const mkSvc = async (name: string, maxConcurrent: number | null) =>
      (
        await db.service.create({
          data: { tenantId: T.tenantId, practitionerId: null, name, durationMin: 60, priceCents: 0, maxConcurrent },
        })
      ).id;
    svcA = await mkSvc("Kine", null);
    svcB = await mkSvc("Evaluación", null);
    svcC = await mkSvc("Grupo", 2);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { bookingCapCount: true } });
    expect(tenant.bookingCapCount).toBeNull(); // sin tope por intervalo: no se mete en los casos
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Profesional nuevo con la regla por defecto (M20) salvo que se pida lo contrario. No vacuo: se relee. */
  async function prac(allowParallelServices = false) {
    const p = await addPractitioner(db, T, "PRACTITIONER", allowParallelServices ? { allowParallelServices } : {});
    const r = await db.practitioner.findUniqueOrThrow({
      where: { id: p.practitionerId },
      select: { allowParallelServices: true, bookingCapMode: true },
    });
    expect(r).toEqual({ allowParallelServices, bookingCapMode: "INHERIT" });
    return p.practitionerId;
  }

  /** Turno cargado directo (owner). `patientId: null` = guest. */
  async function mk(o: {
    prac: string;
    when: Date;
    svc: string;
    dur?: number;
    patientId?: string | null;
    status?: BookingStatus;
    idempotencyKey?: string;
    paymentStatus?: "UNPAID" | "PAID";
    createdAt?: Date;
  }) {
    const patientId = o.patientId === undefined ? await addPatient(db, T) : o.patientId;
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac,
        serviceId: o.svc,
        patientId,
        guestName: patientId ? null : "Invitado",
        scheduledFor: o.when,
        durationMin: o.dur ?? 60,
        status: o.status ?? "CONFIRMED",
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
        ...(o.paymentStatus ? { paymentStatus: o.paymentStatus } : {}),
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
  }

  /** Alta por la action real de la agenda; devuelve el resultado y la fila (null = no escribió). */
  async function alta(
    o: { prac: string; when: Date; svc: string; patientId?: string | null } & Partial<
      Pick<
        Parameters<typeof createBooking>[0],
        "allowOverbooking" | "allowOtherService" | "allowPatientOverlap" | "allowSamePatientDay"
      >
    >
  ) {
    const { prac: practitionerId, when, svc, patientId: pid, ...flags } = o;
    const patientId = pid === undefined ? await addPatient(db, T) : pid;
    const idempotencyKey = randomUUID();
    const r = await createBooking({
      ...(patientId ? { patientId } : { guestName: "Invitado Web", guestPhone: "1155554444" }),
      serviceId: svc,
      practitionerId,
      scheduledFor: when.toISOString(),
      durationMin: 60,
      idempotencyKey,
      ...flags,
    });
    const row = await db.booking.findUnique({ where: { idempotencyKey } });
    return { r, row };
  }

  it("[CF-W1] alta de otro servicio pisado → aviso otherService sin escribir; allowOverbooking no lo fuerza", async () => {
    const day = "2028-01-10";
    const P = await prac();
    const A = await mk({ prac: P, when: at(day, "10:00"), svc: svcA });

    const { r, row } = await alta({ prac: P, when: at(day, "10:30"), svc: svcB });
    expect(r.ok).toBe(false);
    expect(row).toBeNull();
    expect(r.otherService).toEqual({
      practitionerName: expect.stringMatching(/^Kine /),
      serviceName: "Kine",
      existingISO: A.scheduledFor.toISOString(),
      nextFreeISO: expect.any(String),
    });
    const error = r.ok ? null : r.error;
    expect(error).toBe(OTHER_SERVICE_ERROR({ practitionerName: r.otherService!.practitionerName, serviceName: "Kine" }));
    expect(isOtherServiceError(error)).toBe(true);
    // Un aviso por respuesta: el cupo del servicio no está lleno.
    expect(r.conflict).toBeUndefined();
    // El «próximo libre» saltea el turno de otro servicio (el motor con la regla): no vuelve a avisar.
    const next = new Date(r.otherService!.nextFreeISO!);
    expect(next.getTime() >= A.scheduledFor.getTime() + 60 * 60_000 || next.getTime() + 60 * 60_000 <= A.scheduledFor.getTime()).toBe(true);

    // Aceptar el cupo del servicio no tapa en silencio el otro servicio (flag propio).
    const again = await alta({ prac: P, when: at(day, "10:30"), svc: svcB, allowOverbooking: true });
    expect(again.r.ok).toBe(false);
    expect(again.row).toBeNull();
    expect(again.r.otherService?.serviceName).toBe("Kine");
    expect(await db.booking.count({ where: { practitionerId: P } })).toBe(1);
  });

  it("[CF-W1] forzar con allowOtherService → isOverbooked + prefijo [SOBRETURNO]", async () => {
    const day = "2028-01-10";
    const P = await prac();
    await mk({ prac: P, when: at(day, "10:00"), svc: svcA });

    const { r, row } = await alta({ prac: P, when: at(day, "10:30"), svc: svcB, allowOtherService: true });
    expect(r.ok).toBe(true);
    expect(r.otherService).toBeUndefined();
    expect(row).toMatchObject({ isOverbooked: true, serviceId: svcB });
    expect(row!.notes).toBe("[SOBRETURNO]");
  });

  it("[CF-W1] mismo servicio hasta el cupo, sin aviso de otro servicio; pasado el cupo, el conflict de siempre", async () => {
    const day = "2028-01-10";
    const P = await prac();
    const one = await alta({ prac: P, when: at(day, "11:00"), svc: svcC });
    const two = await alta({ prac: P, when: at(day, "11:30"), svc: svcC });
    expect([one.r.ok, two.r.ok]).toEqual([true, true]);
    expect([one.row?.isOverbooked, two.row?.isOverbooked]).toEqual([false, false]);

    const three = await alta({ prac: P, when: at(day, "11:15"), svc: svcC });
    expect(three.r.ok).toBe(false);
    expect(three.row).toBeNull();
    expect(three.r.conflict).toBeDefined();
    expect(three.r.otherService).toBeUndefined();
  });

  it("[CF-W1] el mismo paciente no cuenta (CF-D3); un guest sí; un hold público vencido no cuenta (CF-D5)", async () => {
    const day = "2028-01-10";
    const P = await prac();
    const patientId = await addPatient(db, T);
    await mk({ prac: P, when: at(day, "09:00"), svc: svcA, patientId });

    // Mismo paciente pasando de Kine a Evaluación: sin aviso de otro servicio (sí el suyo de solape, ya confirmado).
    const same = await alta({
      prac: P,
      when: at(day, "09:30"),
      svc: svcB,
      patientId,
      allowPatientOverlap: true,
      allowSamePatientDay: true,
    });
    expect(same.r.ok).toBe(true);
    expect(same.r.otherService).toBeUndefined();
    expect(same.row).toMatchObject({ isOverbooked: false });

    // Un guest encima del de Kine (14:00): no se exime, no sabemos quién es.
    await mk({ prac: P, when: at(day, "14:00"), svc: svcA });
    const guest = await alta({ prac: P, when: at(day, "14:30"), svc: svcB, patientId: null });
    expect(guest.r.ok).toBe(false);
    expect(guest.row).toBeNull();
    expect(guest.r.otherService?.serviceName).toBe("Kine");

    // Hold público impago vencido (creado hace 2 h, key `pub:<tenant>:<uuid>`, con paciente como toda reserva
    // pública): ya no retiene, igual que el cupo.
    await mk({
      prac: P,
      when: at(day, "16:00"),
      svc: svcA,
      status: "PENDING",
      paymentStatus: "UNPAID",
      idempotencyKey: `pub:${T.tenantId}:${randomUUID()}`,
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    const afterHold = await alta({ prac: P, when: at(day, "16:30"), svc: svcB });
    expect(afterHold.r.ok).toBe(true);
    expect(afterHold.row).toMatchObject({ isOverbooked: false });
  });

  it("[CF-W1] allowParallelServices = true → la conducta de antes, exacta (sin aviso ni sobreturno)", async () => {
    const day = "2028-01-10";
    const P = await prac(true);
    await mk({ prac: P, when: at(day, "10:00"), svc: svcA });
    const { r, row } = await alta({ prac: P, when: at(day, "10:30"), svc: svcB });
    expect(r).toEqual({ ok: true, data: { id: row!.id } });
    expect(row).toMatchObject({ isOverbooked: false, notes: null });

    // Lote: la respuesta no gana claves (forma de antes de CF).
    const pid = await addPatient(db, T);
    const b = await createBookingsBatch({
      patientId: pid,
      serviceId: svcB,
      practitionerId: P,
      scheduledFor: at(day, "10:15").toISOString(),
      durationMin: 60,
      count: 2,
      dryRun: true,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.data.dates.map((d) => d.status)).toEqual(["libre", "libre"]);
    for (const d of b.data.dates) expect(d).not.toHaveProperty("otherServiceBusy");
  });

  it("[CF-W1] lote: la fecha que pisa otro servicio sube a sobreturno con otherServiceBusy; se omite sin forzar y entra como sobreturno forzada", async () => {
    // lun 10, 17 y 24 de enero; Kine ocupa el 10 y el 24 a las 10:00.
    const days = ["2028-01-10", "2028-01-17", "2028-01-24"];
    const P = await prac();
    await mk({ prac: P, when: at(days[0], "10:00"), svc: svcA });
    await mk({ prac: P, when: at(days[2], "10:00"), svc: svcA });
    const input = (patientId: string) => ({
      patientId,
      serviceId: svcB,
      practitionerId: P,
      scheduledFor: at(days[0], "10:30").toISOString(),
      durationMin: 60,
      count: 3,
    });

    const pid = await addPatient(db, T);
    const dry = await createBookingsBatch({ ...input(pid), dryRun: true });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.dates.map((d) => d.status)).toEqual(["sobreturno", "libre", "sobreturno"]);
    expect(dry.data.dates.map((d) => d.otherServiceBusy ?? false)).toEqual([true, false, true]);
    expect(dry.data.dates[1]).not.toHaveProperty("otherServiceBusy");
    expect({ free: dry.data.free, conflicted: dry.data.conflicted }).toEqual({ free: 1, conflicted: 2 });

    // Sin forzar: solo la fecha libre.
    const plain = await createBookingsBatch({ ...input(pid), idempotencyKey: randomUUID() });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect({ created: plain.data.created, omitted: plain.data.omitted, sobreturnos: plain.data.sobreturnos }).toEqual({
      created: 1,
      omitted: 2,
      sobreturnos: 0,
    });
    const mine = await db.booking.findMany({ where: { practitionerId: P, patientId: pid }, orderBy: { scheduledFor: "asc" } });
    expect(mine.map((b) => [b.scheduledFor.toISOString(), b.isOverbooked])).toEqual([[at(days[1], "10:30").toISOString(), false]]);

    // Forzado (`allowOverbooking`, CF-D4): las dos que pisan entran como sobreturno con prefijo.
    const pid2 = await addPatient(db, T);
    const forced = await createBookingsBatch({ ...input(pid2), idempotencyKey: randomUUID(), allowOverbooking: true });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect({ created: forced.data.created, omitted: forced.data.omitted, sobreturnos: forced.data.sobreturnos }).toEqual({
      created: 3,
      omitted: 0,
      sobreturnos: 2,
    });
    expect(forced.data.dates.map((d) => d.otherServiceBusy ?? false)).toEqual([true, false, true]);
    const rows = await db.booking.findMany({ where: { practitionerId: P, patientId: pid2 }, orderBy: { scheduledFor: "asc" } });
    expect(rows.map((b) => [b.isOverbooked, b.notes])).toEqual([
      [true, "[SOBRETURNO]"],
      [false, null],
      [true, "[SOBRETURNO]"],
    ]);
  });

  it("[CF-W1] lote: el re-chequeo con el día tomado ve el otro servicio commiteado después del preflight", async () => {
    const day = "2028-01-31";
    for (const forced of [false, true]) {
      const P = await prac();
      const pid = await addPatient(db, T);
      const other = await addPatient(db, T);
      const key = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: P, dayKey: day });
      const holder = ownerClient();
      const probe = ownerClient();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const got = new Promise<void>((r) => (acquired = r));
      // El holder toma el día del profesional y, dentro de esa tx, carga una Kine a las 10:00: el preflight del lote
      // (otra tx, antes del lock) no la ve; el re-conteo, después de esperar el día, sí.
      const held = holder.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          await tx.booking.create({
            data: {
              tenantId: T.tenantId,
              practitionerId: P,
              serviceId: svcA,
              patientId: other,
              scheduledFor: at(day, "10:00"),
              durationMin: 60,
              status: "CONFIRMED",
              idempotencyKey: randomUUID(),
            },
          });
          acquired();
          await released;
        },
        { timeout: 30_000 }
      );
      try {
        await got;
        const p = createBookingsBatch({
          patientId: pid,
          serviceId: svcB,
          practitionerId: P,
          scheduledFor: at(day, "10:30").toISOString(),
          durationMin: 60,
          count: 1,
          idempotencyKey: randomUUID(),
          ...(forced ? { allowOverbooking: true } : {}),
        });
        // La carrera ocurre de verdad: el lote espera el día del profesional.
        await waitForAdvisoryWaiter(probe, key, { timeoutMs: 8_000 });
        release();
        await held;
        const r = await p;
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // El preflight la vio libre; el re-chequeo la marca.
        expect(r.data.dates).toHaveLength(1);
        expect(r.data.dates[0]).toMatchObject({ status: "libre", otherServiceBusy: true });
        const rows = await db.booking.findMany({ where: { practitionerId: P, patientId: pid } });
        if (forced) {
          expect({ created: r.data.created, sobreturnos: r.data.sobreturnos, omitted: r.data.omitted }).toEqual({
            created: 1,
            sobreturnos: 1,
            omitted: 0,
          });
          expect(rows.map((b) => [b.isOverbooked, b.notes])).toEqual([[true, "[SOBRETURNO]"]]);
        } else {
          expect({ created: r.data.created, omitted: r.data.omitted }).toEqual({ created: 0, omitted: 1 });
          expect(rows).toHaveLength(0);
        }
      } finally {
        release();
        await held.catch(() => {});
        await Promise.all([holder.$disconnect(), probe.$disconnect()]);
      }
    }
  });
});
