/**
 * EV0 · EV-T — turnero público con switch (plan §15.3/§15.4, EV-D2 opt-in).
 *
 * `Tenant.publicBookingEnabled` (M2) apagado = el consultorio no toma turnos
 * online: el wizard no recibe datos (`getPublicClinic` null), no hay horarios
 * (`listPublicSlots` [] / `findFirstPublicSlot` null) y `submitPublicBooking`
 * rechaza ANTES del replay idempotente y de tocar fichas. Lo que NO se gatea:
 * el estado de un turno ya reservado (`getPublicBookingStatus`: página de
 * retorno de Mercado Pago) — apagar el turnero no puede dejar a alguien que ya
 * pagó sin ver su turno —, el webhook de MP (AUDIT §5.4) y el middleware (§5.3).
 *
 * Símbolos reales contra Postgres por el canal de servicio (como en prod). Se
 * mockea solo lo externo: el SDK de Mercado Pago y el rate-limit in-memory. El
 * switch se mueve con un UPDATE directo de setup (el escritor de la app es
 * `applyTenantEntitlementsInTx`, de EV-C2, y se prueba en su archivo).
 *
 * La factory crea tenants con el turnero PRENDIDO (tests previos a EV0); acá
 * los casos de apagado pasan `publicBookingEnabled: false` o lo apagan.
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
import {
  submitPublicBooking,
  listPublicSlots,
  getPublicClinic,
  findFirstPublicSlot,
  getPublicBookingStatus,
} from "@/lib/public-booking";
import { getPublicBookingGate, loadPublicBookingPage } from "@/lib/public-booking-internal";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const CLOSED_ERROR = "Este consultorio no toma turnos online.";

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR. */
function futureWeekday(offset = 0): string {
  for (let d = 7 + offset; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("EV-T · turnero público con switch", () => {
  let db: PrismaClient;
  /** Kine, turnero prendido (default de la factory); se apaga y prende en los tests. */
  let K: EphemeralTenant;
  /** Consultorio General con el switch prendido. */
  let G: EphemeralTenant;
  /** Kine que nace con el turnero apagado (como un alta real, EV-D2). */
  let OFF: EphemeralTenant;
  const DAY = futureWeekday();

  function input(
    T: EphemeralTenant,
    opts: { slot?: string; key?: string; documentId?: string; email?: string } = {}
  ): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: opts.key ?? randomUUID(),
      practitionerId: T.practitionerId,
      serviceId: T.serviceId,
      scheduledFor: opts.slot ?? at(DAY, "08:00"),
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: opts.email ?? `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId: opts.documentId ?? `${Math.floor(1e7 + Math.random() * 8e7)}`,
        dateOfBirth: "1990-05-10",
      },
    };
  }
  const slotsInput = (T: EphemeralTenant) => ({
    tenantSlug: T.slug,
    practitionerId: T.practitionerId,
    serviceId: T.serviceId,
    date: DAY,
  });
  const setSwitch = (T: EphemeralTenant, on: boolean) =>
    db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: on } });
  const counts = async (T: EphemeralTenant) => ({
    bookings: await db.booking.count({ where: { tenantId: T.tenantId } }),
    patients: await db.patient.count({ where: { tenantId: T.tenantId } }),
  });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    K = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    OFF = await createEphemeralTenant(db, { publicBookingEnabled: false });
    await db.tenant.update({
      where: { id: OFF.tenantId },
      data: { phone: "1140001111", whatsapp: "1150002222", publicEmail: "turnos@consultorio.test", legalName: "Razón SA" },
    });
  });
  afterAll(async () => {
    asAnonymous();
    await K?.cleanup();
    await G?.cleanup();
    await OFF?.cleanup();
    await db?.$disconnect();
  });

  it("apagado: sin datos del wizard, sin horarios, sin primer slot", async () => {
    // Línea de base con el switch prendido: si esto no diera horarios, el `[]`
    // de abajo no probaría nada.
    expect(await getPublicClinic(K.slug)).not.toBeNull();
    expect((await listPublicSlots(slotsInput(K))).length).toBeGreaterThan(0);
    expect(await findFirstPublicSlot({ tenantSlug: K.slug, serviceId: K.serviceId })).not.toBeNull();

    await setSwitch(K, false);
    try {
      expect(await getPublicClinic(K.slug)).toBeNull();
      expect(await listPublicSlots(slotsInput(K))).toEqual([]);
      expect(await findFirstPublicSlot({ tenantSlug: K.slug, serviceId: K.serviceId })).toBeNull();
      // Un tenant que nace apagado, igual.
      expect(await getPublicClinic(OFF.slug)).toBeNull();
      expect(await listPublicSlots(slotsInput(OFF))).toEqual([]);
    } finally {
      await setSwitch(K, true);
    }
  });

  it("apagado: submit rechazado sin crear turnos ni fichas, aun con el DNI de una ficha existente", async () => {
    const existing = await addPatient(db, OFF, { documentId: "30999888", email: "ficha@test.local" });
    const before = await counts(OFF);
    const r1 = await submitPublicBooking(input(OFF));
    const r2 = await submitPublicBooking(input(OFF, { documentId: "30.999.888", email: "otro@test.local" }));
    expect(r1).toEqual({ ok: false, error: CLOSED_ERROR });
    expect(r2).toEqual({ ok: false, error: CLOSED_ERROR });
    expect(await counts(OFF)).toEqual(before);
    const p = await db.patient.findUniqueOrThrow({ where: { id: existing } });
    expect(p.email).toBe("ficha@test.local");
  });

  it("apagado: el replay idempotente de una reserva previa también se rechaza; el estado del turno sigue respondiendo", async () => {
    const key = randomUUID();
    const first = await submitPublicBooking(input(K, { key, slot: at(DAY, "09:30") }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await setSwitch(K, false);
    try {
      const before = await counts(K);
      // Mismo intento (misma key y slot): con el turnero abierto devolvería el
      // mismo turno + una preferencia NUEVA de MP; cerrado no se cobra nada.
      const replay = await submitPublicBooking(input(K, { key, slot: at(DAY, "09:30") }));
      expect(replay).toEqual({ ok: false, error: CLOSED_ERROR });
      expect(await counts(K)).toEqual(before);
      const events = await db.auditEvent.count({
        where: { tenantId: K.tenantId, action: "booking.public.create", entityId: first.data.bookingId },
      });
      expect(events).toBe(1);

      // Retorno de MP / página de estado: NO se gatea.
      const st = await getPublicBookingStatus(first.data.bookingId);
      expect(st?.bookingId).toBe(first.data.bookingId);
      expect(st?.status).toBe("PENDING");
    } finally {
      await setSwitch(K, true);
    }
  });

  it("re-encender: vuelven los horarios y el submit funciona", async () => {
    await setSwitch(K, false);
    expect(await listPublicSlots(slotsInput(K))).toEqual([]);
    await setSwitch(K, true);
    expect((await listPublicSlots(slotsInput(K))).length).toBeGreaterThan(0);
    expect(await getPublicClinic(K.slug)).not.toBeNull();
    const r = await submitPublicBooking(input(K, { slot: at(DAY, "11:00") }));
    expect(r.ok).toBe(true);
  });

  it("consultorio GENERAL con el switch prendido: el turnero funciona (es módulo de las dos verticales)", async () => {
    const t = await db.tenant.findUniqueOrThrow({ where: { id: G.tenantId }, select: { vertical: true } });
    expect(t.vertical).toBe("GENERAL");
    expect(await getPublicBookingGate(G.slug)).toEqual({ state: "open" });
    expect(await getPublicClinic(G.slug)).not.toBeNull();
    expect((await listPublicSlots(slotsInput(G))).length).toBeGreaterThan(0);
    const r = await submitPublicBooking(input(G));
    expect(r.ok).toBe(true);

    await setSwitch(G, false);
    try {
      expect(await getPublicClinic(G.slug)).toBeNull();
      expect(await submitPublicBooking(input(G, { slot: at(DAY, "12:00") }))).toEqual({ ok: false, error: CLOSED_ERROR });
    } finally {
      await setSwitch(G, true);
    }
  });

  it("gate: slug inexistente → null (404); cerrado → solo el contacto público del consultorio", async () => {
    expect(await getPublicBookingGate(`no-existe-${randomUUID()}`)).toBeNull();
    expect(await getPublicBookingGate(K.slug)).toEqual({ state: "open" });
    const g = await getPublicBookingGate(OFF.slug);
    expect(g).toEqual({
      state: "closed",
      contact: {
        name: expect.stringMatching(/^Test /),
        phone: "1140001111",
        whatsapp: "1150002222",
        email: "turnos@consultorio.test",
      },
    });
  });

  it("página cerrada: no hace el prefill de PII aunque haya sesión verificada con ficha", async () => {
    const visitor = `visitor-${randomUUID().slice(0, 8)}`;
    await addPatient(db, OFF, { firstName: "Secreta", documentId: "41222333", email: `${visitor}@test.local` });
    await addPatient(db, K, { firstName: "Secreta", documentId: "41222334", email: `${visitor}@test.local` });
    asUser(visitor);
    try {
      const closed = await loadPublicBookingPage(OFF.slug);
      expect(closed?.state).toBe("closed");
      // Nada más que el contacto: ni ficha, ni sesión, ni datos del wizard.
      expect(Object.keys(closed ?? {}).sort()).toEqual(["contact", "state"]);
      expect(JSON.stringify(closed)).not.toContain("Secreta");
      expect(JSON.stringify(closed)).not.toContain("41222333");

      // Control: abierto sí prefillea (si no, el assert de arriba no probaría nada).
      const open = await loadPublicBookingPage(K.slug);
      expect(open?.state).toBe("open");
      if (open?.state !== "open") return;
      expect(open.prefill?.firstName).toBe("Secreta");
      expect(open.session?.email).toBe(`${visitor}@test.local`);
      expect(open.clinic.slug).toBe(K.slug);

      expect(await loadPublicBookingPage(`no-existe-${randomUUID()}`)).toBeNull();
    } finally {
      asAnonymous();
    }
  });
});
