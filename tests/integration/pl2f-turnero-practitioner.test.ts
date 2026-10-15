/**
 * PL-2f · turnero por consultorio Y por profesional (plan §20.5.12, H-TURN; decisión 20 de Martin).
 *
 * Un profesional aparece en el turnero público solo si el turnero del consultorio está abierto, él tiene
 * `Practitioner.publicBookingEnabled` y ofrece ≥ 1 servicio PUBLIC. Se fija:
 *   - consultorio prendido + profesional apagado → no aparece en `getPublicClinic`, no tiene horarios
 *     (`listPublicSlots`), «cualquier profesional» (`findFirstPublicSlot`) no lo elige, y un submit armado a mano
 *     con su id se rechaza SIN escribir (ni turno ni ficha);
 *   - consultorio apagado → nadie aparece, aunque el profesional esté prendido;
 *   - `setPractitionerPublicBooking`: el Titular (tenant.admin) o el propio profesional; otro profesional → rechazo con copy (PL-Z a3#15);
 *     un id de otro consultorio = inexistente; el cambio se audita en la tx y el mismo valor no escribe.
 *
 * Símbolos reales por el canal de servicio (como en prod). Se mockea solo lo externo: el SDK de Mercado Pago y el
 * rate-limit in-memory. Los flags se mueven con UPDATE directo de setup salvo en el bloque de la action.
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
import { findFirstPublicSlot, getPublicClinic, listPublicSlots, submitPublicBooking } from "@/lib/public-booking";
import { setPractitionerPublicBooking } from "@/lib/practitioner-public";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR. */
function futureWeekday(): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("PL-2f · turnero por profesional", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svc: string; // servicio compartido (sin dueño): lo ofrecen los dos
  let B: { userId: string; practitionerId: string };
  const DAY = futureWeekday();

  const setPrac = (practitionerId: string, on: boolean) =>
    db.practitioner.update({ where: { id: practitionerId }, data: { publicBookingEnabled: on } });
  const setTenant = (on: boolean) => db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: on } });
  const slots = (practitionerId: string) =>
    listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId: svc, date: DAY });
  const counts = async () => ({
    bookings: await db.booking.count({ where: { tenantId: T.tenantId } }),
    patients: await db.patient.count({ where: { tenantId: T.tenantId } }),
  });
  function input(practitionerId: string, slot = at(DAY, "10:00")): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId,
      serviceId: svc,
      scheduledFor: slot,
      patient: {
        firstName: "Ana",
        lastName: "Turnero",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId: `${Math.floor(1e7 + Math.random() * 8e7)}`,
        dateOfBirth: "1990-05-10",
      },
    };
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db); // turnero del consultorio y del titular prendidos (factory)
    B = await addPractitioner(db, T, "PRACTITIONER");
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Kine", durationMin: 45, priceCents: 5000 },
      })
    ).id;
    await setPrac(B.practitionerId, false);
  });
  afterAll(async () => {
    asAnonymous();
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("consultorio prendido + profesional apagado: no aparece en el wizard ni tiene horarios", async () => {
    const c = await getPublicClinic(T.slug);
    expect(c).not.toBeNull();
    expect(c!.practitioners.map((p) => p.id)).toEqual([T.practitionerId]);
    expect(c!.services.find((s) => s.id === svc)?.practitionerIds).toEqual([T.practitionerId]);
    // Línea de base: el titular (prendido) sí tiene horarios ese día; si no, el `[]` de abajo no probaría nada.
    expect((await slots(T.practitionerId)).length).toBeGreaterThan(0);
    expect(await slots(B.practitionerId)).toEqual([]);
  });

  it("«cualquier profesional» no elige a uno apagado", async () => {
    // Solo B prendido → el primer hueco es de B; B apagado también → nadie.
    await setPrac(T.practitionerId, false);
    await setPrac(B.practitionerId, true);
    try {
      expect(await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc })).toMatchObject({
        practitionerId: B.practitionerId,
      });
      await setPrac(B.practitionerId, false);
      expect(await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc })).toBeNull();
      expect(await getPublicClinic(T.slug)).toMatchObject({ practitioners: [], services: [] });
    } finally {
      await setPrac(T.practitionerId, true);
      await setPrac(B.practitionerId, false);
    }
  });

  it("submit con un profesional apagado → rechazo sin escribir turno ni ficha; con uno prendido, reserva", async () => {
    const before = await counts();
    expect(await submitPublicBooking(input(B.practitionerId))).toEqual({ ok: false, error: "Profesional no encontrado." });
    expect(await counts()).toEqual(before);

    // Un horario real de la grilla del titular (la misma función que valida el submit).
    const free = (await slots(T.practitionerId)).find((x) => x.available);
    if (!free) throw new Error("el titular no tiene horarios libres ese día");
    const ok = await submitPublicBooking(input(T.practitionerId, free.iso));
    expect(ok).toMatchObject({ ok: true });
    expect(await counts()).toEqual({ bookings: before.bookings + 1, patients: before.patients + 1 });
  });

  it("consultorio apagado: nadie aparece aunque el profesional esté prendido", async () => {
    await setPrac(B.practitionerId, true);
    await setTenant(false);
    try {
      expect(await getPublicClinic(T.slug)).toBeNull();
      expect(await slots(T.practitionerId)).toEqual([]);
      expect(await slots(B.practitionerId)).toEqual([]);
      expect(await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc })).toBeNull();
      const before = await counts();
      expect(await submitPublicBooking(input(B.practitionerId, at(DAY, "11:00")))).toEqual({
        ok: false,
        error: "Este consultorio no toma turnos online.",
      });
      expect(await counts()).toEqual(before);
    } finally {
      await setTenant(true);
      await setPrac(B.practitionerId, false);
    }
  });

  describe("setPractitionerPublicBooking", () => {
    let U: EphemeralTenant;
    beforeAll(async () => {
      U = await createEphemeralTenant(db);
    });
    afterAll(async () => {
      await U?.cleanup();
    });
    const flag = async (practitionerId: string) =>
      (await db.practitioner.findUniqueOrThrow({ where: { id: practitionerId } })).publicBookingEnabled;
    const audits = (practitionerId: string) =>
      db.auditEvent.findMany({
        where: { tenantId: T.tenantId, action: "practitioner.publicBooking", entityId: practitionerId },
        orderBy: { createdAt: "asc" },
        select: { actorId: true, payload: true },
      });

    it("el titular prende a otro profesional: escribe y audita en la tx; el mismo valor no escribe", async () => {
      asUser(T.userId);
      expect(await setPractitionerPublicBooking(B.practitionerId, true)).toEqual({ ok: true, data: { enabled: true } });
      expect(await flag(B.practitionerId)).toBe(true);
      expect(await audits(B.practitionerId)).toEqual([{ actorId: T.userId, payload: { enabled: true } }]);
      // Ya aparece en el turnero.
      expect((await getPublicClinic(T.slug))!.practitioners.map((p) => p.id).sort()).toEqual(
        [T.practitionerId, B.practitionerId].sort()
      );

      expect(await setPractitionerPublicBooking(B.practitionerId, true)).toEqual({ ok: true, data: { enabled: true } });
      expect(await audits(B.practitionerId)).toHaveLength(1);
    });

    it("el propio profesional se apaga; sobre otro profesional → 403 sin escribir", async () => {
      asUser(B.userId);
      expect(await setPractitionerPublicBooking(B.practitionerId, false)).toEqual({ ok: true, data: { enabled: false } });
      expect(await flag(B.practitionerId)).toBe(false);
      expect(await audits(B.practitionerId)).toHaveLength(2);

      // PL-Z a3#15: copy en el resultado (antes un ForbiddenError que en prod llegaba redactado).
      expect(await setPractitionerPublicBooking(T.practitionerId, false)).toEqual({ ok: false, error: expect.stringMatching(/titular/) });
      expect(await flag(T.practitionerId)).toBe(true);
      expect(await audits(T.practitionerId)).toEqual([]);
    });

    it("id de otro consultorio = inexistente, sin escribir", async () => {
      asUser(T.userId);
      expect(await setPractitionerPublicBooking(U.practitionerId, false)).toEqual({
        ok: false,
        error: "Profesional no encontrado.",
      });
      expect(await flag(U.practitionerId)).toBe(true);
    });
  });
});
