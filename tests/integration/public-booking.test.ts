/**
 * Reserva pública (A2b-S-pub): `submitPublicBooking` + `listPublicSlots` REALES
 * contra Postgres, en el canal de servicio (sin Actor, como en prod).
 *
 * Se mockea solo lo externo: el SDK de Mercado Pago (la preferencia de
 * Checkout Pro es una llamada HTTP) y el rate-limit (el bucket in-memory por
 * IP "unknown" cortaría a los 5 submits; se prueba aparte en A3-S-rl).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  // `client()` exige el token; nunca sale a la red (SDK mockeado abajo).
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
});
/**
 * SV06a: orden observable de los efectos externos del submit. La preferencia
 * de MP anota `pref:<bookingId>` y el publisher fake (vía `realtimeFake.onCall`)
 * anota `rt:<bookingId>`: así se afirma que el evento sale ANTES de la
 * preferencia (que puede fallar y dejar el turno escrito sin aviso).
 */
const effects = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
      effects.order.push(`pref:${body.external_reference}`);
      return {
        id: `pref-${body.external_reference}`,
        init_point: `https://mp.test/checkout/${body.external_reference}`,
      };
    }
  }
  class Payment {
    async get() {
      throw new Error("no usado en este archivo");
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  submitPublicBooking,
  listPublicSlots,
  getPublicClinic,
  findFirstPublicSlot,
  devMarkBookingPaid,
} from "@/lib/public-booking";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import { createBooking } from "@/lib/bookings";
import { asUser } from "@/tests/helpers/actor";
import {
  PUBLIC_CONTACT_MISMATCH_NOTE,
  PUBLIC_SHARED_CONTACT_NOTE,
} from "@/lib/public-booking-internal";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { addDays } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addService,
  addPractitioner,
  addInsurer,
  addRoom,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR. */
function futureWeekday(offset = 0): string {
  for (let d = 7 + offset; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("reserva pública · submitPublicBooking (A2b-S-pub)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Servicio de cupo 1 (osteopatía, 60 min). */
  let osteoId: string;
  const DAY = futureWeekday();

  function input(
    patch: Partial<SubmitPublicBookingInput["patient"]> & { documentId: string },
    opts: { slot?: string; serviceId?: string; key?: string } = {}
  ): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: opts.key ?? randomUUID(),
      practitionerId: T.practitionerId,
      serviceId: opts.serviceId ?? T.serviceId,
      scheduledFor: opts.slot ?? at(DAY, "08:00"),
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        dateOfBirth: "1990-05-10",
        ...patch,
      },
    };
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    osteoId = await addService(db, T, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("H4: un DNI ajeno (con puntos) NO toca el email ni el teléfono de la ficha; el contacto va al snapshot + nota", async () => {
    const victimId = await addPatient(db, T, {
      firstName: "Víctima",
      lastName: "Real",
      email: "victima@test.local",
      phone: "1140001000",
      documentId: "30123456",
    });
    const r = await submitPublicBooking(
      input({ documentId: "30.123.456", email: "atacante@test.local", phone: "1199998888" }, { slot: at(DAY, "08:45") })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const victim = await db.patient.findUniqueOrThrow({ where: { id: victimId } });
    expect(victim.email).toBe("victima@test.local");
    expect(victim.phone).toBe("1140001000");
    expect(victim.firstName).toBe("Víctima");

    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.patientId).toBe(victimId);
    expect(b.guestEmail).toBe("atacante@test.local");
    expect(b.guestPhone).toBe("1199998888");
    expect(b.guestName).toBe("Ana Pérez");
    expect(b.notes).toContain(PUBLIC_CONTACT_MISMATCH_NOTE);
    expect(b.status).toBe("PENDING");
    expect(b.paymentStatus).toBe("UNPAID");
  });

  it("H4: una ficha SIN email tampoco se completa desde la reserva anónima (ni cobertura)", async () => {
    const id = await addPatient(db, T, { documentId: "27999888", phone: "1140002000" });
    const r = await submitPublicBooking(
      input(
        { documentId: "27999888", email: "nuevo@test.local", phone: "1140002000", coverageInsurer: "OSDE" },
        { slot: at(DAY, "09:30") }
      )
    );
    expect(r.ok).toBe(true);
    const p = await db.patient.findUniqueOrThrow({ where: { id }, include: { coverages: true } });
    expect(p.email).toBeNull();
    expect(p.coverages).toHaveLength(0);
    if (r.ok) {
      const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
      expect(b.notes).toContain("Obra social declarada online: OSDE");
    }
  });

  it("mismo contacto que la ficha → sin snapshot ni nota", async () => {
    const id = await addPatient(db, T, {
      firstName: "Ana",
      lastName: "Pérez",
      email: "ana.ok@test.local",
      phone: "1140003000",
      documentId: "25111222",
    });
    const r = await submitPublicBooking(
      input({ documentId: "25111222", email: "ANA.ok@test.local ", phone: "11 4000-3000" }, { slot: at(DAY, "10:15") })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.patientId).toBe(id);
    expect(b.guestEmail).toBeNull();
    expect(b.notes ?? "").not.toContain(PUBLIC_CONTACT_MISMATCH_NOTE);
  });

  it("P2002 familiar: teléfono y email de otra ficha → crea la ficha sin esos campos, el contacto queda en el turno", async () => {
    await addPatient(db, T, {
      firstName: "Mamá",
      email: "familia@test.local",
      phone: "1140004000",
      documentId: "20111333",
    });
    const r = await submitPublicBooking(
      input(
        { firstName: "Hijo", documentId: "45111333", email: "familia@test.local", phone: "1140004000" },
        { slot: at(DAY, "11:00") }
      )
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({
      where: { id: r.data.bookingId },
      include: { patient: true },
    });
    expect(b.patient!.documentId).toBe("45111333");
    expect(b.patient!.firstName).toBe("Hijo");
    expect(b.patient!.email).toBeNull();
    expect(b.patient!.phone).toBeNull();
    // Dueño de la ficha = el profesional del turno (si no, nadie salvo OWNER la operaba).
    expect(b.patient!.assignedPractitionerId).toBe(T.practitionerId);
    expect(b.guestEmail).toBe("familia@test.local");
    expect(b.guestPhone).toBe("1140004000");
    expect(b.notes).toContain(PUBLIC_SHARED_CONTACT_NOTE);
  });

  it("idempotencia: la misma key (doble click, incluso concurrente) → un solo turno", async () => {
    const payload = input({ documentId: "33444555" }, { slot: at(DAY, "11:45") });
    const [a, b] = await Promise.all([submitPublicBooking(payload), submitPublicBooking(payload)]);
    const c = await submitPublicBooking(payload);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.data.bookingId).toBe(a.data.bookingId);
    expect(c.data.bookingId).toBe(a.data.bookingId);
    const rows = await db.booking.count({
      where: { tenantId: T.tenantId, scheduledFor: new Date(at(DAY, "11:45")) },
    });
    expect(rows).toBe(1);
    const patients = await db.patient.count({ where: { tenantId: T.tenantId, documentId: "33444555" } });
    expect(patients).toBe(1);
  });

  it("una key reusada con OTRO horario se rechaza (no devuelve el turno viejo)", async () => {
    const k = randomUUID();
    const r1 = await submitPublicBooking(input({ documentId: "33444666" }, { slot: at(DAY, "12:30"), key: k }));
    expect(r1.ok).toBe(true);
    const r2 = await submitPublicBooking(input({ documentId: "33444666" }, { slot: at(DAY, "13:15"), key: k }));
    expect(r2.ok).toBe(false);
  });

  it("re-reservar después de cancelar crea un turno NUEVO; el CANCELLED no revive", async () => {
    const k1 = randomUUID();
    const slot = at(DAY, "14:00");
    const r1 = await submitPublicBooking(input({ documentId: "36555777" }, { slot, key: k1 }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await db.booking.update({ where: { id: r1.data.bookingId }, data: { status: "CANCELLED" } });

    // Mismo intento (misma key) → no revive: pide recargar.
    const again = await submitPublicBooking(input({ documentId: "36555777" }, { slot, key: k1 }));
    expect(again.ok).toBe(false);

    const r2 = await submitPublicBooking(input({ documentId: "36555777" }, { slot }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.bookingId).not.toBe(r1.data.bookingId);
    const old = await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId } });
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: r2.data.bookingId } });
    expect(old.status).toBe("CANCELLED");
    expect(fresh.status).toBe("PENDING");
    expect(fresh.patientId).toBe(old.patientId);
  });

  it("horario fuera de la grilla (no alineado, madrugada o domingo) → rechazo sin escribir nada", async () => {
    let sunday = DAY;
    for (let d = 1; toARDow(new Date(localToARIso(`${sunday}T12:00:00`))) !== 0; d++) {
      sunday = toARDateKey(new Date(new Date(localToARIso(`${DAY}T12:00:00`)).getTime() + d * 86_400_000));
    }
    const before = await db.patient.count({ where: { tenantId: T.tenantId } });
    for (const slot of [at(DAY, "10:07"), at(DAY, "03:00"), at(sunday, "10:15")]) {
      const r = await submitPublicBooking(input({ documentId: "40999000" }, { slot }));
      expect(r.ok, slot).toBe(false);
    }
    expect(await db.patient.count({ where: { tenantId: T.tenantId } })).toBe(before);
    expect(await db.booking.count({ where: { tenantId: T.tenantId, patient: { documentId: "40999000" } } })).toBe(0);
  });

  it("horario con menos de 1 h de anticipación → rechazo", async () => {
    const r = await submitPublicBooking(
      input({ documentId: "40999001" }, { slot: new Date(Date.now() + 10 * 60_000).toISOString() })
    );
    expect(r.ok).toBe(false);
  });

  it("cupo 1: una reserva pública impaga VENCIDA (>30 min) no bloquea; una fresca sí", async () => {
    const day = futureWeekday(1);
    const holderPatient = await addPatient(db, T, { documentId: "50111000" });
    const expired = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: osteoId,
        patientId: holderPatient,
        scheduledFor: new Date(at(day, "08:00")),
        durationMin: 60,
        status: "PENDING",
        paymentStatus: "UNPAID",
        // Key del turnero público: el discriminante de isHoldingCapacity.
        idempotencyKey: `pub:${T.tenantId}:${randomUUID()}`,
        createdAt: new Date(Date.now() - 31 * 60_000),
      },
    });

    const slots = await listPublicSlots({
      tenantSlug: T.slug,
      practitionerId: T.practitionerId,
      serviceId: osteoId,
      date: day,
    });
    expect(slots.find((s) => s.time === "08:00")!.available).toBe(true);

    const r = await submitPublicBooking(
      input({ documentId: "50111001" }, { slot: at(day, "08:00"), serviceId: osteoId })
    );
    expect(r.ok).toBe(true);
    expect(expired.id).toBeTruthy();

    // La reserva recién creada (fresca) sí retiene el cupo.
    const after = await listPublicSlots({
      tenantSlug: T.slug,
      practitionerId: T.practitionerId,
      serviceId: osteoId,
      date: day,
    });
    expect(after.find((s) => s.time === "08:00")!.available).toBe(false);
    const r2 = await submitPublicBooking(
      input({ documentId: "50111002" }, { slot: at(day, "08:00"), serviceId: osteoId })
    );
    expect(r2.ok).toBe(false);
  });

  // B4.1 (TOCTOU de cupo, handoff de B3.2): el chequeo de la grilla corría
  // FUERA de la tx del INSERT, y entre los dos está `resolvePublicPatient`
  // (alta de ficha): dos pacientes DISTINTOS en un slot de cupo 1 leían "libre"
  // los dos y escribían los dos (el índice único parcial solo frena al mismo
  // paciente). Ahora la tx toma `lockCapacityWindow` y re-chequea la grilla.
  it("[B4.1] cupo 1: tres submits concurrentes de pacientes distintos al mismo slot → exactamente uno ok", async () => {
    const day = futureWeekday(3);
    const slot = at(day, "10:15");
    const results = await Promise.all(
      ["53100001", "53100002", "53100003"].map((dni) =>
        submitPublicBooking(input({ documentId: dni }, { slot, serviceId: osteoId }))
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) {
      expect(r.ok ? "" : r.error).toMatch(/se acaba de ocupar/);
    }
    const live = await db.booking.count({
      where: { tenantId: T.tenantId, serviceId: osteoId, scheduledFor: new Date(slot), status: { not: "CANCELLED" } },
    });
    expect(live).toBe(1);
  });

  it("[B4.1] cupo 1: la agenda y el turnero compiten por el mismo slot a la vez → un solo turno vivo", async () => {
    // Misma clave de lock (`kinesoft:cap:<tenant>:<prof>:<servicio>:<día AR>`)
    // en `createBooking` y en el submit público: se serializan entre canales.
    const day = futureWeekday(3);
    const slot = at(day, "13:15");
    const deskPatient = await addPatient(db, T, { documentId: "53200001" });
    asUser(T.userId);
    const [desk, pub] = await Promise.all([
      createBooking({
        patientId: deskPatient,
        serviceId: osteoId,
        practitionerId: T.practitionerId,
        scheduledFor: slot,
        durationMin: 60,
        idempotencyKey: randomUUID(),
      }),
      submitPublicBooking(input({ documentId: "53200002" }, { slot, serviceId: osteoId })),
    ]);
    expect([desk.ok, pub.ok].filter(Boolean)).toHaveLength(1);
    const live = await db.booking.count({
      where: { tenantId: T.tenantId, serviceId: osteoId, scheduledFor: new Date(slot), status: { not: "CANCELLED" } },
    });
    expect(live).toBe(1);
  });

  it("el paciente ya tiene un turno activo en ese instante (agenda) → mensaje de solape, no error genérico", async () => {
    const pid = await addPatient(db, T, { documentId: "51222333", email: "solape@test.local", phone: "1140005000" });
    const slot = at(DAY, "14:45");
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        patientId: pid,
        scheduledFor: new Date(slot),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
      },
    });
    const r = await submitPublicBooking(
      input({ documentId: "51222333", email: "solape@test.local", phone: "1140005000" }, { slot })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Ya tenés un turno reservado en ese horario.");
  });

  it("[revisión A2] mismo DNI re-reserva su slot vencido → ok: la vieja queda CANCELLED y la nueva retiene", async () => {
    const day = futureWeekday(2);
    const slot = at(day, "08:45");
    const r1 = await submitPublicBooking(input({ documentId: "53444555" }, { slot, serviceId: osteoId }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // Abandonó MP: a los 40 min la reserva ya no retiene el cupo.
    await db.booking.update({ where: { id: r1.data.bookingId }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });

    const r2 = await submitPublicBooking(input({ documentId: "53444555" }, { slot, serviceId: osteoId }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.bookingId).not.toBe(r1.data.bookingId);
    const old = await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId } });
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: r2.data.bookingId } });
    expect(old.status).toBe("CANCELLED");
    expect(fresh.status).toBe("PENDING");
    expect(fresh.patientId).toBe(old.patientId);
    // PL-A (plan §20.5.9): el reemplazo de un hold vencido ya no se audita (ruido); lo observable es el estado.
    // La nueva retiene el cupo 1.
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId: osteoId, date: day });
    expect(slots.find((s) => s.time === "08:45")!.available).toBe(false);
  });

  it("[revisión A2] su reserva pública todavía VIGENTE (o ya pagada) no se reemplaza", async () => {
    const slot = at(DAY, "16:15");
    const r1 = await submitPublicBooking(input({ documentId: "53444666" }, { slot }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = await submitPublicBooking(input({ documentId: "53444666" }, { slot }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("Ya tenés un turno reservado en ese horario.");

    // Vencida pero con el pago AUTHORIZED (efectivo en curso): retiene, no se toca.
    await db.booking.update({
      where: { id: r1.data.bookingId },
      data: { createdAt: new Date(Date.now() - 40 * 60_000), paymentStatus: "AUTHORIZED" },
    });
    const r3 = await submitPublicBooking(input({ documentId: "53444666" }, { slot }));
    expect(r3.ok).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId } })).status).toBe("PENDING");
  });

  it("ancla el monto esperado en el Payment al crear la preferencia", async () => {
    const r = await submitPublicBooking(input({ documentId: "52333444" }, { slot: at(DAY, "15:30") }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.initPoint).toBe(`https://mp.test/checkout/${r.data.bookingId}`);
    const pay = await db.payment.findUniqueOrThrow({ where: { bookingId: r.data.bookingId } });
    expect(pay.expectedAmountCents).toBe(5000);
    expect(pay.status).toBe("UNPAID");
  });
});

/** Próximo día AR con ese dow (0=Dom) a partir de 7 días adelante. */
function futureDow(dow: number, offsetDays = 7): string {
  for (let d = offsetDays; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}
/** `@db.Date` de un día AR (medianoche UTC, como lo guarda Prisma). */
const dbDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe.skipIf(!RUN)("reserva pública · motor de disponibilidad (B3.2 AV-public)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Segundo profesional: franja propia lunes 14:00-17:00 en la sede B. */
  let P2: string;
  let locA: string;
  let locB: string;
  /** Compartido (sin dueño): PRIVATE para P1. */
  let privateSvc: string;
  /** Compartido: deshabilitado para P2, habilitado para P1. */
  let partialSvc: string;
  let osdeId: string;
  const MON = futureDow(1);
  const MON2 = futureDow(1, 14);
  const SUN = futureDow(0);

  function req(
    o: { practitionerId: string; serviceId: string; slot: string; documentId: string; key?: string }
  ): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: o.key ?? randomUUID(),
      practitionerId: o.practitionerId,
      serviceId: o.serviceId,
      scheduledFor: o.slot,
      patient: {
        firstName: "Bea",
        lastName: "Motor",
        email: `bea-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId: o.documentId,
        dateOfBirth: "1985-03-02",
      },
    };
  }
  const slots = (practitionerId: string, serviceId: string, date: string, locationId?: string) =>
    listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId, date, ...(locationId ? { locationId } : {}) });

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P2 = (await addPractitioner(db, T)).practitionerId;
    locA = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", address: "Av. 1 123", isPrimary: true } })).id;
    locB = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte", address: "Calle 2 456" } })).id;
    // P1 sin franjas → red de seguridad (horario del tenant lun-sáb en la principal).
    await db.practitionerSchedule.create({
      data: { tenantId: T.tenantId, practitionerId: P2, locationId: locB, dow: 1, startMin: 14 * 60, endMin: 17 * 60 },
    });
    const mk = async (name: string) =>
      (await db.service.create({ data: { tenantId: T.tenantId, name, durationMin: 45, priceCents: 7000, maxConcurrent: 1 } })).id;
    privateSvc = await mk("Evaluación interna");
    partialSvc = await mk("Drenaje");
    await db.practitionerService.createMany({
      data: [
        { tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: privateSvc, visibility: "PRIVATE" },
        { tenantId: T.tenantId, practitionerId: P2, serviceId: privateSvc, visibility: "PRIVATE" },
        { tenantId: T.tenantId, practitionerId: P2, serviceId: partialSvc, enabled: false },
        // Override de duración de P1 para el servicio compartido.
        { tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: partialSvc, durationMin: 60 },
      ],
    });
    osdeId = await addInsurer(db, T, { name: "OSDE" });
    await db.practitionerPayer.create({ data: { tenantId: T.tenantId, practitionerId: P2, insurerId: osdeId, active: false } });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("getPublicClinic: sin servicios PRIVATE; servicio deshabilitado para un profesional no aparece para él; sedes y coberturas", async () => {
    const c = (await getPublicClinic(T.slug))!;
    const ids = c.services.map((s) => s.id);
    expect(ids).not.toContain(privateSvc);
    const partial = c.services.find((s) => s.id === partialSvc)!;
    expect(partial.practitionerIds).toEqual([T.practitionerId]);
    // Un solo profesional lo ofrece → el filtro del wizard actual lo ata a él, con su duración.
    expect(partial.practitionerId).toBe(T.practitionerId);
    expect(partial.durationMin).toBe(60);
    // El servicio default (de P1) no lo ofrece P2.
    expect(c.services.find((s) => s.id === T.serviceId)!.practitionerIds).toEqual([T.practitionerId]);
    expect(c.locations!.map((l) => l.id)).toEqual([locA, locB]);
    expect(c.locations![0]).toMatchObject({ name: "Centro", address: "Av. 1 123", isPrimary: true });
    // P2 no ofrece ningún servicio online → no aparece.
    expect(c.practitioners.map((p) => p.id)).toEqual([T.practitionerId]);
    expect(c.practitioners[0].locationIds).toEqual([locA]);
    expect(c.practitioners[0].acceptedInsurerIds!.sort()).toEqual([T.particularInsurerId, osdeId].sort());
    expect(c.insurers!.map((i) => i.name)).toEqual(["Particular", "OSDE"]);
    // [VX-Z] openingSummary (VX2-d1): solo cuentan los profesionales que el turnero ofrece. P1 no tiene franjas →
    // red de seguridad (horario del consultorio, lun a sáb); la franja de P2 (lun 14-17 en Norte) no suma porque
    // P2 no ofrece nada online. Antes el nav decía «lun-sáb 8 a 19hs» fijo.
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: T.tenantId },
      select: { businessHoursStart: true, businessHoursEnd: true },
    });
    expect(c.openingSummary).toBe(`Lun a sáb ${t.businessHoursStart} a ${t.businessHoursEnd}`);
  });

  it("servicio PRIVATE: sin horarios y el submit armado a mano se rechaza", async () => {
    expect(await slots(T.practitionerId, privateSvc, MON)).toEqual([]);
    const r = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: privateSvc, slot: at(MON, "08:00"), documentId: "60100100" })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Servicio no encontrado.");
  });

  it("servicio deshabilitado para un profesional: sin horarios ni submit para él; con el otro sí (override de duración)", async () => {
    expect(await slots(P2, partialSvc, MON)).toEqual([]);
    const no = await submitPublicBooking(req({ practitionerId: P2, serviceId: partialSvc, slot: at(MON, "14:00"), documentId: "60100101" }));
    expect(no.ok).toBe(false);
    const ok = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: partialSvc, slot: at(MON, "17:00"), documentId: "60100102" })
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: ok.data.bookingId } });
    expect(b.durationMin).toBe(60);
  });

  it("franja propia del profesional distinta del horario del tenant (y sede asignada al turno)", async () => {
    // P2 ofrece online un servicio propio.
    const own = await db.service.create({
      data: { tenantId: T.tenantId, practitionerId: P2, name: "Osteo P2", durationMin: 45, priceCents: 9000, maxConcurrent: 1 },
    });
    const list = await slots(P2, own.id, MON);
    expect(list.map((s) => s.time)).toEqual(["14:00", "14:45", "15:30", "16:15"]);
    expect(list.every((s) => s.locationId === locB)).toBe(true);
    // Filtro por sede: P2 no atiende en la principal.
    expect(await slots(P2, own.id, MON, locA)).toEqual([]);
    // 08:00 está dentro del horario del tenant pero fuera de la franja de P2.
    const out = await submitPublicBooking(req({ practitionerId: P2, serviceId: own.id, slot: at(MON, "08:00"), documentId: "60100103" }));
    expect(out.ok).toBe(false);
    const r = await submitPublicBooking(req({ practitionerId: P2, serviceId: own.id, slot: at(MON, "14:45"), documentId: "60100104" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.locationId).toBe(locB);
    expect(b.idempotencyKey.startsWith(`pub:${T.tenantId}:`)).toBe(true);
    // getPublicClinic ahora lista a P2 con su sede y sin OSDE (PractitionerPayer inactivo).
    const c = (await getPublicClinic(T.slug))!;
    const p2 = c.practitioners.find((p) => p.id === P2)!;
    expect(p2.locationIds).toEqual([locB]);
    expect(p2.acceptedInsurerIds).toEqual([T.particularInsurerId]);
  });

  it("profesional sin franjas → sede principal en el turno", async () => {
    const r = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: T.serviceId, slot: at(MON, "08:45"), documentId: "60100105" })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).locationId).toBe(locA);
  });

  it("día bloqueado: no ofrece horarios ni acepta el submit; un bloqueo parcial saca solo lo que pisa", async () => {
    const day = futureDow(2); // martes
    await db.timeBlock.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: null,
        locationId: null,
        startsAt: new Date(at(day, "00:00")),
        endsAt: new Date(at(addDays(day, 1), "00:00")),
        allDay: true,
        reason: "Feriado",
        createdById: T.userId,
      },
    });
    expect(await slots(T.practitionerId, T.serviceId, day)).toEqual([]);
    const r = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: T.serviceId, slot: at(day, "10:15"), documentId: "60100106" })
    );
    expect(r.ok).toBe(false);
    expect(await db.booking.count({ where: { tenantId: T.tenantId, scheduledFor: new Date(at(day, "10:15")) } })).toBe(0);

    // Parcial 09:00-10:00 el miércoles: 08:00 sí; 08:45 (pisa) no; la grilla sigue a las 10:00.
    const wed = addDays(day, 1);
    await db.timeBlock.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        startsAt: new Date(at(wed, "09:00")),
        endsAt: new Date(at(wed, "10:00")),
        createdById: T.userId,
      },
    });
    const times = (await slots(T.practitionerId, T.serviceId, wed)).map((s) => s.time);
    expect(times.slice(0, 3)).toEqual(["08:00", "10:00", "10:45"]);
    const hit = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: T.serviceId, slot: at(wed, "08:45"), documentId: "60100107" })
    );
    expect(hit.ok).toBe(false);
  });

  it("excepción CUSTOM_HOURS abre un domingo (slots + submit, con la sede de la excepción)", async () => {
    expect(await slots(T.practitionerId, T.serviceId, SUN)).toEqual([]);
    await db.scheduleException.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        date: dbDate(SUN),
        kind: "CUSTOM_HOURS",
        ranges: [{ startMin: 10 * 60, endMin: 12 * 60, locationId: locB }],
        reason: "Jornada de domingo",
        createdById: T.userId,
      },
    });
    const list = await slots(T.practitionerId, T.serviceId, SUN);
    expect(list.map((s) => s.time)).toEqual(["10:00", "10:45"]);
    const r = await submitPublicBooking(
      req({ practitionerId: T.practitionerId, serviceId: T.serviceId, slot: at(SUN, "10:45"), documentId: "60100108" })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).locationId).toBe(locB);
  });

  it("cualquier profesional: primer hueco de la grilla pública, filtrado por cobertura; reservable", async () => {
    const svc = await db.service.create({
      data: { tenantId: T.tenantId, name: "Masaje", durationMin: 45, priceCents: 6000, maxConcurrent: 1 },
    });
    // P1 cerrado ese lunes → el primero es P2 a las 14:00 (franja propia).
    await db.scheduleException.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, date: dbDate(MON2), kind: "CLOSED", createdById: T.userId },
    });
    const first = await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc.id, fromDate: MON2 });
    expect(first).toMatchObject({ practitionerId: P2, date: MON2, time: "14:00", locationId: locB, durationMin: 45 });
    // Con OSDE (P2 no la acepta) → P1, el martes siguiente a las 08:00.
    const osde = await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc.id, fromDate: MON2, insurerId: osdeId });
    expect(osde!.practitionerId).toBe(T.practitionerId);
    expect(osde!.time).toBe("08:00");
    // Cobertura de otro consultorio → null (no se ofrece a ciegas).
    expect(await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc.id, insurerId: "nope" })).toBeNull();
    // Lo devuelto se reserva con el submit (misma grilla).
    const r = await submitPublicBooking(req({ practitionerId: first!.practitionerId, serviceId: svc.id, slot: first!.iso, documentId: "60100109" }));
    expect(r.ok).toBe(true);
  });
});

/**
 * SV06a · el turnero público emite a la Sala de Espera realtime
 * (`afterBookingsCommitted`). Tenant propio con sala en la franja (lun-vie
 * 9 a 13) para que el ref lleve un `roomId` real, no el null de siempre.
 * Afirma el efecto observable: las llamadas registradas por el publisher fake
 * (`realtimeFake.calls`, una por commit) y, con `onCall`, que la fila ya está
 * commiteada cuando sale el evento (se lee con otra conexión).
 */
describe.skipIf(!RUN)("SV06a · turnero público → afterBookingsCommitted", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let room: { roomId: string; locationId: string };
  const MON = futureDow(1);
  const TUE = futureDow(2);
  const WED = futureDow(3);

  function req(slot: string, documentId: string, key = randomUUID()): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: key,
      practitionerId: T.practitionerId,
      serviceId: T.serviceId,
      scheduledFor: slot,
      patient: {
        firstName: "Sol",
        lastName: "Sala",
        email: `sol-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId,
        dateOfBirth: "1991-07-01",
      },
    };
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    room = await addRoom(db, T, { name: "Consultorio SV" });
    await db.practitionerSchedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        locationId: room.locationId,
        roomId: room.roomId,
        dow,
        startMin: 540,
        endMin: 780,
      })),
    });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[SV06a] submitPublicBooking emite 1 vez tras el commit (ref con roomId), antes de la preferencia de MP; el replay idempotente no emite", async () => {
    effects.order = [];
    let committedAtPublish: boolean | null = null;
    realtimeFake.onCall = async (call) => {
      const id = call.refs?.[0]?.bookingId ?? "?";
      effects.order.push(`rt:${id}`);
      committedAtPublish = !!(await db.booking.findUnique({ where: { id }, select: { id: true } }));
    };
    const key = randomUUID();
    const slot = at(MON, "09:00");
    const r = await submitPublicBooking(req(slot, "71100101", key));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;

    expect(realtimeFake.calls).toHaveLength(1);
    expect(realtimeFake.calls[0]).toEqual({
      tenantId: T.tenantId,
      refs: [
        {
          bookingId: r.data.bookingId,
          practitionerId: T.practitionerId,
          scheduledFor: new Date(slot),
          roomId: room.roomId,
          kind: "booking",
        },
      ],
    });
    expect(committedAtPublish).toBe(true);
    // El evento sale ANTES de pedir la preferencia de MP.
    expect(effects.order).toEqual([`rt:${r.data.bookingId}`, `pref:${r.data.bookingId}`]);

    // Replay del mismo intento (misma key): mismo turno, sin evento nuevo.
    const again = await submitPublicBooking(req(slot, "71100101", key));
    expect(again).toMatchObject({ ok: true, data: { bookingId: r.data.bookingId } });
    expect(realtimeFake.calls).toHaveLength(1);
  });

  it("[SV06a] doble submit concurrente del mismo intento (twin P2002 o replay) → 1 sola llamada", async () => {
    const payload = req(at(TUE, "09:00"), "71100102");
    const [a, b] = await Promise.all([submitPublicBooking(payload), submitPublicBooking(payload)]);
    expect(a.ok && b.ok).toBe(true);
    expect(realtimeFake.calls).toHaveLength(1);
    expect(realtimeFake.calls[0].refs).toHaveLength(1);
  });

  it("[SV06a] hold vencido reemplazado → 1 llamada con 2 refs (la nueva y la vieja cancelada)", async () => {
    const slot = at(WED, "09:00");
    const r1 = await submitPublicBooking(req(slot, "71100103"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await db.booking.update({ where: { id: r1.data.bookingId }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });
    realtimeFake.reset();

    const r2 = await submitPublicBooking(req(slot, "71100103"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.bookingId).not.toBe(r1.data.bookingId);
    expect(realtimeFake.calls).toHaveLength(1);
    expect(realtimeFake.calls[0].refs).toEqual([
      { bookingId: r2.data.bookingId, practitionerId: T.practitionerId, scheduledFor: new Date(slot), roomId: room.roomId, kind: "booking" },
      { bookingId: r1.data.bookingId, practitionerId: T.practitionerId, scheduledFor: new Date(slot), roomId: room.roomId, kind: "booking" },
    ]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId } })).status).toBe("CANCELLED");
  });

  it("[SV06a] devMarkBookingPaid emite 1 vez (kind booking), con la fila ya pagada", async () => {
    const slot = at(MON, "09:45");
    const r = await submitPublicBooking(req(slot, "71100104"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    realtimeFake.reset();
    let paidAtPublish: string | null = null;
    realtimeFake.onCall = async () => {
      paidAtPublish = (await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).paymentStatus;
    };
    expect(await devMarkBookingPaid(r.data.bookingId)).toEqual({ ok: true, data: undefined });
    expect(realtimeFake.calls).toEqual([
      {
        tenantId: T.tenantId,
        refs: [
          { bookingId: r.data.bookingId, practitionerId: T.practitionerId, scheduledFor: new Date(slot), roomId: room.roomId, kind: "booking" },
        ],
      },
    ]);
    expect(paidAtPublish).toBe("PAID");
  });
});
