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
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
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
import { submitPublicBooking, listPublicSlots } from "@/lib/public-booking";
import {
  PUBLIC_CONTACT_MISMATCH_NOTE,
  PUBLIC_SHARED_CONTACT_NOTE,
} from "@/lib/public-booking-internal";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addService,
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
    T = await createEphemeralTenant(db);
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
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: T.tenantId, action: "booking.public.expired_replaced", entityId: old.id },
    });
    expect(ev).toBeTruthy();
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
