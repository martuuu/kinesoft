/**
 * TP-0 (H-TP0 / H-TP2 / H-TP3, plan §22.5): el turnero vuelve a reservar sin cobro. `submitPublicBooking`,
 * `getPublicBookingStatus` y `getPublicClinic` REALES contra Postgres, en el canal de servicio (sin Actor, como en prod).
 *
 * Se mockea solo lo externo: el SDK de Mercado Pago de la PLATAFORMA (para contar llamadas) y el rate-limit.
 *
 * T5 (TP-2c): el turnero ya no cobra con la cuenta de la plataforma. `TURNERO_CHECKOUT=platform` + `MP_ACCESS_TOKEN`
 * (lo que antes prendía el checkout) no hace nada: 0 llamadas al SDK. Lo que antes nacía PENDING con ese checkout
 * (los holds «legados» que siguen en la base al deployar) se siembra a mano para probar la promoción y la pantalla
 * de estado. El cobro con la cuenta del profesional: tests/integration/tp2t-turnero-cobro.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  // MP «configurado»: el SDK está mockeado abajo, nunca sale a la red.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
});
const mp = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
      mp.calls.push(body.external_reference);
      return { id: `pref-${body.external_reference}`, init_point: `https://mp.test/checkout/${body.external_reference}` };
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
import { submitPublicBooking, listPublicSlots, getPublicClinic, getPublicBookingStatus } from "@/lib/public-booking";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  addPatient,
  addPractitioner,
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

describe.skipIf(!RUN)("TP-0 · turnero sin cobro online", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Cupo 1 a $0 (los servicios de arranque valen $0: H-TP0). */
  let freeId: string;
  /** Cupo 1 con precio ($80). */
  let pricedId: string;
  const DAY = futureWeekday();
  const prevMode = process.env.TURNERO_CHECKOUT;

  function input(
    documentId: string,
    opts: { slot: string; serviceId: string; key?: string; practitionerId?: string }
  ): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: opts.key ?? randomUUID(),
      practitionerId: opts.practitionerId ?? T.practitionerId,
      serviceId: opts.serviceId,
      scheduledFor: opts.slot,
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId,
        dateOfBirth: "1990-05-10",
        title: "Lumbalgia",
      },
    };
  }
  const reservedNotifs = (userId?: string) =>
    db.notification.count({
      where: { tenantId: T.tenantId, kind: "BOOKING_CREATED", title: "Turno online reservado", ...(userId ? { userId } : {}) },
    });
  /** El primer horario libre de la grilla pública de ese día (el paso de la grilla lo decide el motor, no el test). */
  async function freeSlot(serviceId: string, practitionerId = T.practitionerId): Promise<string> {
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId, date: DAY });
    const s = slots.find((x) => x.available);
    if (!s) throw new Error("sin horarios libres en el día de prueba");
    return s.iso;
  }
  /**
   * Un hold PENDING del checkout LEGADO (TP-0 con `TURNERO_CHECKOUT=platform`, o anterior a TP-0): el turno que la
   * reserva dejó en la base antes de T5, con su `Payment` UNPAID anclado al precio. Se siembra con la MISMA key que va a
   * reintentar el wizard (`pub:<tenant>:<uuid>`).
   */
  async function seedLegacyHold(req: SubmitPublicBookingInput, o: { payment?: boolean; createdAt?: Date } = {}) {
    const patientId = await addPatient(db, T, { documentId: req.patient.documentId });
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: req.practitionerId,
        serviceId: req.serviceId,
        patientId,
        scheduledFor: new Date(req.scheduledFor),
        durationMin: 60,
        status: "PENDING",
        paymentStatus: "UNPAID",
        idempotencyKey: `pub:${T.tenantId}:${req.idempotencyKey}`,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    if (o.payment) {
      await db.payment.create({ data: { bookingId: b.id, status: "UNPAID", amountCents: 0, expectedAmountCents: 8000 } });
    }
    return b;
  }
  const rtCallsFor = (bookingId: string) =>
    realtimeFake.calls.filter((c) => c.refs?.some((r) => r.bookingId === bookingId)).length;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    freeId = await addService(db, T, { name: "Evaluación", durationMin: 60, priceCents: 0, maxConcurrent: 1 });
    pricedId = await addService(db, T, { name: "Osteopatía", durationMin: 60, priceCents: 8000, maxConcurrent: 1 });
  });
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.TURNERO_CHECKOUT;
    else process.env.TURNERO_CHECKOUT = prevMode;
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    mp.calls = [];
    delete process.env.TURNERO_CHECKOUT; // default `off`
  });
  afterEach(() => vi.restoreAllMocks());

  it("[TP-0] precio 0 → CONFIRMED/UNPAID sin preferencia ni Payment y retiene cupo pasados 30 min", async () => {
    // Con el checkout PRENDIDO: el monto de $0 alcanza para no mandar a pagar.
    process.env.TURNERO_CHECKOUT = "platform";
    const slot = await freeSlot(freeId);
    const r = await submitPublicBooking(input("40111222", { slot, serviceId: freeId }));
    expect(r).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null, amountCents: null } });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId }, include: { payment: true } });
    expect(b.status).toBe("CONFIRMED");
    expect(b.paymentStatus).toBe("UNPAID");
    expect(b.payment).toBeNull();
    expect(mp.calls).toEqual([]);

    // A los 40 min sigue reteniendo (solo vence un PENDING): ni la grilla lo ofrece ni otro paciente lo toma.
    await db.booking.update({ where: { id: b.id }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId: freeId, date: DAY });
    expect(slots.find((s) => s.iso === slot)!.available).toBe(false);
    const other = await submitPublicBooking(input("40111333", { slot, serviceId: freeId }));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toMatch(/se acaba de ocupar/);
    expect(await db.booking.count({ where: { tenantId: T.tenantId, serviceId: freeId, scheduledFor: new Date(slot) } })).toBe(1);
  });

  it("[TP-0] checkout off → reservado; replay mismo turno sin escribir ni avisar", async () => {
    // Default `off`, servicio con precio y MP configurado: igual no se cobra (H-TP1).
    expect((await getPublicClinic(T.slug))?.onlinePayment ?? null).toBeNull();
    const key = randomUUID();
    const req = input("40222111", { slot: await freeSlot(pricedId), serviceId: pricedId, key });
    const r1 = await submitPublicBooking(req);
    expect(r1).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null, amountCents: null } });
    if (!r1.ok) return;
    const b1 = await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId }, include: { payment: true } });
    expect([b1.status, b1.paymentStatus, b1.payment]).toEqual(["CONFIRMED", "UNPAID", null]);
    expect(mp.calls).toEqual([]);
    const notifs = await reservedNotifs();
    const rt = rtCallsFor(b1.id);
    expect(rt).toBe(1);

    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual({ ok: true, data: { bookingId: b1.id, next: "reserved", initPoint: null, amountCents: null } });
    const b2 = await db.booking.findUniqueOrThrow({ where: { id: b1.id } });
    expect(b2.updatedAt.getTime()).toBe(b1.updatedAt.getTime());
    expect(await reservedNotifs()).toBe(notifs);
    expect(rtCallsFor(b1.id)).toBe(rt);
    expect(mp.calls).toEqual([]);

    // TP-2c: el switch viejo en `platform` ya no promete cobro online (lo decide la cuenta del profesional).
    process.env.TURNERO_CHECKOUT = "platform";
    expect((await getPublicClinic(T.slug))?.onlinePayment ?? null).toBeNull();
  });

  it("[TP-2c] TURNERO_CHECKOUT=platform + MP_ACCESS_TOKEN → reservado sin llamar al SDK de la plataforma (H-TP1)", async () => {
    // Antes de T5 esto mandaba a pagar con la cuenta de la plataforma (y con MP caído degradaba a reservado).
    process.env.TURNERO_CHECKOUT = "platform";
    const r = await submitPublicBooking(input("40333111", { slot: await freeSlot(pricedId), serviceId: pricedId }));
    expect(r).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null, amountCents: null } });
    if (!r.ok) return;
    expect(mp.calls).toEqual([]);
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId }, include: { payment: true } });
    expect([b.status, b.paymentStatus, b.payment]).toEqual(["CONFIRMED", "UNPAID", null]);
    expect(await db.onlineCharge.count({ where: { bookingId: b.id } })).toBe(0);
    // Un solo commit (el alta): un evento realtime.
    expect(rtCallsFor(b.id)).toBe(1);
  });

  it("[TP-0] PENDING vigente previo → CONFIRMED una vez; vencido → «Tu reserva venció»", async () => {
    // Un hold que nació con el checkout legado (o antes de TP-0, cuando MP fallaba siempre) y sigue en la base.
    const req = input("40444111", { slot: await freeSlot(pricedId), serviceId: pricedId });
    const held = await seedLegacyHold(req, { payment: true });
    const before = await reservedNotifs();

    // El paciente reintenta con la misma key: se promueve (sin cobro de T5 que lo retenga).
    const r1 = await submitPublicBooking(req);
    expect(r1).toEqual({ ok: true, data: { bookingId: held.id, next: "reserved", initPoint: null, amountCents: null } });
    const b1 = await db.booking.findUniqueOrThrow({ where: { id: held.id } });
    expect([b1.status, b1.paymentStatus]).toEqual(["CONFIRMED", "UNPAID"]);
    const afterPromotion = await reservedNotifs();
    expect(afterPromotion).toBeGreaterThan(before);
    expect(mp.calls).toEqual([]);

    // Una sola vez: el siguiente replay no escribe ni avisa.
    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual({ ok: true, data: { bookingId: b1.id, next: "reserved", initPoint: null, amountCents: null } });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b1.id } })).updatedAt.getTime()).toBe(b1.updatedAt.getTime());
    expect(await reservedNotifs()).toBe(afterPromotion);

    // Vencido: pasaron los 30 min, el cupo se pudo dar a otro → no se promueve ni se escribe.
    const reqOld = input("40444222", { slot: await freeSlot(pricedId), serviceId: pricedId });
    const aged = await seedLegacyHold(reqOld, { payment: true, createdAt: new Date(Date.now() - 40 * 60_000) });
    const o1 = await submitPublicBooking(reqOld);
    expect(o1).toEqual({ ok: false, error: "Tu reserva venció. Volvé a elegir el horario." });
    const still = await db.booking.findUniqueOrThrow({ where: { id: aged.id } });
    expect([still.status, still.updatedAt.getTime()]).toEqual(["PENDING", aged.updatedAt.getTime()]);
    expect(await reservedNotifs()).toBe(afterPromotion);
  });

  it("[TP-0] BOOKING_CREATED una vez, replay 0", async () => {
    // Titular, el profesional del turno (otro) y la Secretaria (`agenda.operateAll`): un aviso a cada uno.
    const kine = await addPractitioner(db, T, "PRACTITIONER");
    const secretary = await addPractitioner(db, T, "ASSISTANT");
    const shared = await db.service.create({
      data: { tenantId: T.tenantId, practitionerId: null, name: "Control", durationMin: 30, priceCents: 0 },
      select: { id: true },
    });
    const slot = await freeSlot(shared.id, kine.practitionerId);
    const req = input("40555111", { slot, serviceId: shared.id, practitionerId: kine.practitionerId });
    const r1 = await submitPublicBooking(req);
    expect(r1.ok && r1.data.next).toBe("reserved");
    if (!r1.ok) return;
    const rows = await db.notification.findMany({
      // Por el servicio del body: los tests de arriba dejaron avisos del mismo día al titular.
      where: {
        tenantId: T.tenantId,
        kind: "BOOKING_CREATED",
        title: "Turno online reservado",
        link: `/agenda?date=${DAY}`,
        body: { startsWith: "Control · " },
      },
      select: { userId: true, body: true },
    });
    expect(rows.map((n) => n.userId).sort()).toEqual([T.userId, kine.userId, secretary.userId].sort());
    expect(rows[0].body).toContain("Control · Ana Pérez");

    const r2 = await submitPublicBooking(req);
    expect(r2.ok && r2.data.bookingId).toBe(r1.data.bookingId);
    for (const u of [T.userId, kine.userId, secretary.userId]) {
      expect(
        await db.notification.count({
          where: { tenantId: T.tenantId, userId: u, kind: "BOOKING_CREATED", body: { startsWith: "Control · " } },
        })
      ).toBe(1);
    }
  });

  it("[TP-0] status pendiente muestra expectedAmountCents, no $0", async () => {
    // Hold del checkout legado con su Payment anclado a $80 (lo que sigue en la base al deployar T5).
    const held = await seedLegacyHold(input("40666111", { slot: await freeSlot(pricedId), serviceId: pricedId }), { payment: true });
    const pay = await db.payment.findUniqueOrThrow({ where: { bookingId: held.id } });
    expect([pay.status, pay.amountCents, pay.expectedAmountCents]).toEqual(["UNPAID", 0, 8000]);
    // El ancla manda sobre el precio vivo (si el consultorio cambia el precio, se muestra lo que se va a cobrar).
    await db.payment.update({ where: { id: pay.id }, data: { expectedAmountCents: 7000 } });
    const st = await getPublicBookingStatus(held.id);
    expect(st).toMatchObject({ status: "PENDING", paymentStatus: "UNPAID", amountCents: 7000, onlinePayment: true, onlineCharge: null });

    // Reservado sin cobro: el precio del servicio (se paga en el consultorio) y sin pago online.
    const rr = await submitPublicBooking(input("40666222", { slot: await freeSlot(pricedId), serviceId: pricedId }));
    expect(rr.ok && rr.data.next).toBe("reserved");
    if (!rr.ok) return;
    expect(await getPublicBookingStatus(rr.data.bookingId)).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      amountCents: 8000,
      onlinePayment: false,
      onlineCharge: null,
    });
  });
});
