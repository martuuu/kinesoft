/**
 * SR2b · El turnero público estampa la sala por defecto de la franja del slot
 * (`submitPublicBooking` → `defaultRoomFor` con la grilla fresca de la tx),
 * validada DESPUÉS del lock compartido de sedes: archivada → null, sin error.
 * SR-D3: no chequea ocupación ni toma lock de sala.
 *
 * Canal de servicio real (sin Actor, como en prod). Se mockea solo lo externo:
 * el SDK de Mercado Pago y el rate-limit (igual que public-booking.test.ts).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
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
import { submitPublicBooking } from "@/lib/public-booking";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addRoom,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** El próximo `dow` (0=Dom) entre 7 y 13 días adelante, en calendario AR. */
function futureDow(dow: number): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("SR2b · turnero público estampa la sala", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let r1: { roomId: string; locationId: string };
  let r2: { roomId: string; locationId: string };
  const MON = futureDow(1);
  const TUE = futureDow(2);
  const WED = futureDow(3);

  function req(slot: string, documentId: string): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: T.practitionerId,
      serviceId: T.serviceId,
      scheduledFor: slot,
      patient: {
        firstName: "Ana",
        lastName: "Sala",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId,
        dateOfBirth: "1990-05-10",
      },
    };
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    r1 = await addRoom(db, T, { name: "Consultorio 1" });
    r2 = await addRoom(db, T, { name: "Consultorio 2", locationId: r1.locationId });
    // Lunes con sala 1, martes con sala 2 (la que se archiva), miércoles sin sala. 9 a 13.
    await db.practitionerSchedule.createMany({
      data: [
        { dow: 1, roomId: r1.roomId },
        { dow: 2, roomId: r2.roomId },
        { dow: 3, roomId: null },
      ].map((x) => ({
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        locationId: r1.locationId,
        startMin: 540,
        endMin: 780,
        ...x,
      })),
    });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("franja con sala → el turno la lleva, con la sede explícita (SR-D6)", async () => {
    const r = await submitPublicBooking(req(at(MON, "09:00"), "70100101"));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.roomId).toBe(r1.roomId);
    expect(b.locationId).toBe(r1.locationId);
    expect(b.isOverbooked).toBe(false);
  });

  it("SR-D3: no chequea ocupación — otro profesional ya en la sala (capacidad 1) y estampa igual", async () => {
    const p2 = await addPractitioner(db, T);
    const patientId = await addPatient(db, T, { assignedPractitionerId: p2.practitionerId });
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: p2.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: new Date(at(MON, "09:45")),
        durationMin: 45,
        locationId: r1.locationId,
        roomId: r1.roomId,
        status: "CONFIRMED",
        idempotencyKey: `sr2b-${randomUUID()}`,
      },
    });
    const r = await submitPublicBooking(req(at(MON, "09:45"), "70100102"));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.roomId).toBe(r1.roomId);
  });

  it("sala archivada (la franja todavía la nombra) → el turno queda sin sala, sin error", async () => {
    await db.room.update({ where: { id: r2.roomId }, data: { active: false } });
    try {
      const r = await submitPublicBooking(req(at(TUE, "09:00"), "70100103"));
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
      expect(b.roomId).toBeNull();
      expect(b.locationId).toBe(r1.locationId);
    } finally {
      await db.room.update({ where: { id: r2.roomId }, data: { active: true } });
    }
  });

  it("franja sin sala → sin sala (como hoy)", async () => {
    const r = await submitPublicBooking(req(at(WED, "09:00"), "70100104"));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.roomId).toBeNull();
    expect(b.locationId).toBe(r1.locationId);
  });
});
