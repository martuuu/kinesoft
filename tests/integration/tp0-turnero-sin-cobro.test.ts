/**
 * TP-0 (H-TP0 / H-TP2 / H-TP3, plan §22.5): el turnero vuelve a reservar sin cobro. `submitPublicBooking`,
 * `getPublicBookingStatus` y `getPublicClinic` REALES contra Postgres, en el canal de servicio (sin Actor, como en prod).
 *
 * Se mockea solo lo externo: el SDK de Mercado Pago (HTTP; con un interruptor para que la preferencia falle) y el
 * rate-limit. `TURNERO_CHECKOUT` se cambia por test en `process.env`: `turneroCheckout()` (lib/env.ts) lo lee en cada
 * llamada. La regla pura (`decidePublicCheckout`) tiene su tabla en tests/unit/public-booking-payment.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  // MP «configurado»: el SDK está mockeado abajo, nunca sale a la red.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
});
const mp = vi.hoisted(() => ({ fail: false, calls: [] as string[] }));
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
      mp.calls.push(body.external_reference);
      if (mp.fail) throw new Error("MP 401 invalid access token");
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
import { logger } from "@/lib/logger";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
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
    mp.fail = false;
    mp.calls = [];
    delete process.env.TURNERO_CHECKOUT; // default `off`
  });
  afterEach(() => vi.restoreAllMocks());

  it("[TP-0] precio 0 → CONFIRMED/UNPAID sin preferencia ni Payment y retiene cupo pasados 30 min", async () => {
    // Con el checkout PRENDIDO: el monto de $0 alcanza para no mandar a pagar.
    process.env.TURNERO_CHECKOUT = "platform";
    const slot = await freeSlot(freeId);
    const r = await submitPublicBooking(input("40111222", { slot, serviceId: freeId }));
    expect(r).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null } });
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
    expect((await getPublicClinic(T.slug))?.onlineCheckout).toBe(false);
    const key = randomUUID();
    const req = input("40222111", { slot: await freeSlot(pricedId), serviceId: pricedId, key });
    const r1 = await submitPublicBooking(req);
    expect(r1).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null } });
    if (!r1.ok) return;
    const b1 = await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId }, include: { payment: true } });
    expect([b1.status, b1.paymentStatus, b1.payment]).toEqual(["CONFIRMED", "UNPAID", null]);
    expect(mp.calls).toEqual([]);
    const notifs = await reservedNotifs();
    const rt = rtCallsFor(b1.id);
    expect(rt).toBe(1);

    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual({ ok: true, data: { bookingId: b1.id, next: "reserved", initPoint: null } });
    const b2 = await db.booking.findUniqueOrThrow({ where: { id: b1.id } });
    expect(b2.updatedAt.getTime()).toBe(b1.updatedAt.getTime());
    expect(await reservedNotifs()).toBe(notifs);
    expect(rtCallsFor(b1.id)).toBe(rt);
    expect(mp.calls).toEqual([]);

    // Con el switch en `platform` el wizard sabe que podría cobrar (copy).
    process.env.TURNERO_CHECKOUT = "platform";
    expect((await getPublicClinic(T.slug))?.onlineCheckout).toBe(true);
  });

  it("[TP-0] la preferencia falla → mismo turno CONFIRMED (degradado)", async () => {
    process.env.TURNERO_CHECKOUT = "platform";
    mp.fail = true;
    const warn = vi.spyOn(logger, "warn");
    const key = randomUUID();
    const req = input("40333111", { slot: await freeSlot(pricedId), serviceId: pricedId, key });
    const r = await submitPublicBooking(req);
    expect(r).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null } });
    if (!r.ok) return;
    expect(mp.calls).toEqual([r.data.bookingId]);
    expect(warn).toHaveBeenCalledWith(
      "booking.public.checkout_degraded",
      expect.objectContaining({ bookingId: r.data.bookingId })
    );
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId }, include: { payment: true } });
    // El MISMO turno (no uno nuevo), reservado, sin Payment (la preferencia nunca se creó).
    expect(await db.booking.count({ where: { idempotencyKey: `pub:${T.tenantId}:${key}` } })).toBe(1);
    expect([b.status, b.paymentStatus, b.payment]).toEqual(["CONFIRMED", "UNPAID", null]);
    // Dos commits (alta PENDING + promoción): dos eventos realtime; un solo aviso.
    expect(rtCallsFor(b.id)).toBe(2);
    expect(await reservedNotifs(T.userId)).toBeGreaterThanOrEqual(1);
    const notifs = await reservedNotifs();

    // Replay con MP todavía caído: el mismo turno, sin preferencia nueva ni aviso.
    mp.calls = [];
    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual({ ok: true, data: { bookingId: b.id, next: "reserved", initPoint: null } });
    expect(mp.calls).toEqual([]);
    expect(await reservedNotifs()).toBe(notifs);
  });

  it("[TP-0] PENDING vigente previo → CONFIRMED una vez; vencido → «Tu reserva venció»", async () => {
    // Un hold que nació con el checkout prendido (o antes de TP-0, cuando MP fallaba siempre).
    process.env.TURNERO_CHECKOUT = "platform";
    const req = input("40444111", { slot: await freeSlot(pricedId), serviceId: pricedId });
    const r0 = await submitPublicBooking(req);
    expect(r0.ok && r0.data.next).toBe("checkout");
    if (!r0.ok) return;
    expect(r0.data.initPoint).toBe(`https://mp.test/checkout/${r0.data.bookingId}`);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r0.data.bookingId } })).status).toBe("PENDING");
    const before = await reservedNotifs();

    // Se apaga el checkout y el paciente reintenta con la misma key: se promueve.
    delete process.env.TURNERO_CHECKOUT;
    const r1 = await submitPublicBooking(req);
    expect(r1).toEqual({ ok: true, data: { bookingId: r0.data.bookingId, next: "reserved", initPoint: null } });
    const b1 = await db.booking.findUniqueOrThrow({ where: { id: r0.data.bookingId } });
    expect([b1.status, b1.paymentStatus]).toEqual(["CONFIRMED", "UNPAID"]);
    const afterPromotion = await reservedNotifs();
    expect(afterPromotion).toBeGreaterThan(before);

    // Una sola vez: el siguiente replay no escribe ni avisa.
    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual({ ok: true, data: { bookingId: b1.id, next: "reserved", initPoint: null } });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b1.id } })).updatedAt.getTime()).toBe(b1.updatedAt.getTime());
    expect(await reservedNotifs()).toBe(afterPromotion);

    // Vencido: pasaron los 30 min, el cupo se pudo dar a otro → no se promueve ni se escribe.
    process.env.TURNERO_CHECKOUT = "platform";
    const reqOld = input("40444222", { slot: await freeSlot(pricedId), serviceId: pricedId });
    const o0 = await submitPublicBooking(reqOld);
    expect(o0.ok && o0.data.next).toBe("checkout");
    if (!o0.ok) return;
    const aged = await db.booking.update({
      where: { id: o0.data.bookingId },
      data: { createdAt: new Date(Date.now() - 40 * 60_000) },
    });
    delete process.env.TURNERO_CHECKOUT;
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
    process.env.TURNERO_CHECKOUT = "platform";
    const r = await submitPublicBooking(input("40666111", { slot: await freeSlot(pricedId), serviceId: pricedId }));
    expect(r.ok && r.data.next).toBe("checkout");
    if (!r.ok) return;
    const pay = await db.payment.findUniqueOrThrow({ where: { bookingId: r.data.bookingId } });
    expect([pay.status, pay.amountCents, pay.expectedAmountCents]).toEqual(["UNPAID", 0, 8000]);
    // El ancla manda sobre el precio vivo (si el consultorio cambia el precio, se muestra lo que se va a cobrar).
    await db.payment.update({ where: { id: pay.id }, data: { expectedAmountCents: 7000 } });
    const st = await getPublicBookingStatus(r.data.bookingId);
    expect(st).toMatchObject({ status: "PENDING", paymentStatus: "UNPAID", amountCents: 7000, onlinePayment: true });

    // Reservado sin cobro: el precio del servicio (se paga en el consultorio) y sin pago online.
    delete process.env.TURNERO_CHECKOUT;
    const rr = await submitPublicBooking(input("40666222", { slot: await freeSlot(pricedId), serviceId: pricedId }));
    expect(rr.ok && rr.data.next).toBe("reserved");
    if (!rr.ok) return;
    expect(await getPublicBookingStatus(rr.data.bookingId)).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      amountCents: 8000,
      onlinePayment: false,
    });
  });
});
