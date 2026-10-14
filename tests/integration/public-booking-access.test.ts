/**
 * BO2-D · superficies públicas y acceso del consultorio (C-BO1 `publicSurfacesOpen`, plan §19.5).
 *
 * El turnero (`/c/<slug>`: página, datos del wizard, horarios y submit) se cierra cuando el modo EFECTIVO no es
 * `publicSurfacesOpen` (full | grace): con el default `banner`, solo suspendido / dado de baja; con `enforce`,
 * también el solo lectura (trial vencido > 7 días). Mismo molde que el switch de EV0: página «Turnos online no
 * disponibles» con el contacto público, submit rechazado ANTES de tocar fichas o turnos, y el estado de un turno
 * ya reservado sigue respondiendo.
 *
 * **El webhook de Mercado Pago NUNCA se bloquea** (AUDIT §5.4): un pago siempre se concilia, también con el
 * consultorio suspendido o dado de baja (y con `enforce`). Se prueba por la ruta firmada real.
 *
 * Símbolos reales contra Postgres por el canal de servicio. Mocks: SDK de MP y rate limit in-memory. El estado y
 * la suscripción se mueven con UPDATE directo de setup (el escritor se prueba en platform-lifecycle.test.ts).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

const WEBHOOK_SECRET = "test-webhook-secret";
vi.hoisted(() => {
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.MP_WEBHOOK_SECRET = "test-webhook-secret";
});
const mpPayments = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
      return { id: `pref-${body.external_reference}`, init_point: `https://mp.test/checkout/${body.external_reference}` };
    }
  }
  class Payment {
    async get({ id }: { id: string }) {
      const d = mpPayments.get(String(id));
      if (!d) throw new Error(`payment ${id} desconocido`);
      return d;
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import crypto, { randomUUID } from "node:crypto";
import type { PrismaClient, TenantStatus } from "@prisma/client";
import {
  submitPublicBooking,
  listPublicSlots,
  getPublicClinic,
  findFirstPublicSlot,
  getPublicBookingStatus,
} from "@/lib/public-booking";
import { getPublicBookingGate, loadPublicBookingPage } from "@/lib/public-booking-internal";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { asAnonymous } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const CLOSED_ERROR = "Este consultorio no toma turnos online.";
const DAY_MS = 86_400_000;

function futureWeekday(offset = 0): string {
  for (let d = 7 + offset; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * DAY_MS));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

function signedRequest(dataId: string) {
  const requestId = randomUUID();
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest("hex");
  return new Request(`http://localhost/api/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
    body: JSON.stringify({ type: "payment", data: { id: dataId } }),
  });
}

describe.skipIf(!RUN)("BO2-D · turnero, webhook y acceso del consultorio", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  const DAY = futureWeekday();
  let slotSeq = 0;
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  const input = (opts: { slot?: string; key?: string } = {}): SubmitPublicBookingInput => ({
    tenantSlug: T.slug,
    idempotencyKey: opts.key ?? randomUUID(),
    practitionerId: T.practitionerId,
    serviceId: T.serviceId,
    scheduledFor: opts.slot ?? at(DAY, "08:00"),
    patient: {
      firstName: "Ana",
      lastName: "Pérez",
      email: `ana-${randomUUID().slice(0, 8)}@test.local`,
      phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
      documentId: `${Math.floor(1e7 + Math.random() * 8e7)}`,
      dateOfBirth: "1990-05-10",
    },
  });
  const slotsInput = () => ({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId: T.serviceId, date: DAY });
  const counts = async () => ({
    bookings: await db.booking.count({ where: { tenantId: T.tenantId } }),
    patients: await db.patient.count({ where: { tenantId: T.tenantId } }),
  });
  const setTenant = (data: {
    status?: TenantStatus;
    subscriptionStatus?: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELLED";
    trialEndsAt?: Date | null;
  }) => db.tenant.update({ where: { id: T.tenantId }, data });
  const reset = () => setTenant({ status: "ACTIVE", subscriptionStatus: "ACTIVE", trialEndsAt: null });

  /** Lo que hoy expone el turnero: abierto (true) o cerrado en todas sus superficies (false). */
  async function turneroOpen(): Promise<boolean> {
    const gate = await getPublicBookingGate(T.slug);
    const page = await loadPublicBookingPage(T.slug);
    const clinic = await getPublicClinic(T.slug);
    const slots = await listPublicSlots(slotsInput());
    const first = await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: T.serviceId });
    const open = gate?.state === "open";
    // Coherencia: o todo abierto o todo cerrado (nada a medias).
    expect(page?.state, "page").toBe(open ? "open" : "closed");
    expect(clinic !== null, "clinic").toBe(open);
    expect(slots.length > 0, "slots").toBe(open);
    expect(first !== null, "first").toBe(open);
    return open;
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { phone: "1140001111", whatsapp: null, publicEmail: "turnos@consultorio.test" },
    });
  });
  afterEach(async () => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    asAnonymous();
    await reset();
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("suspendido (default banner): turnero cerrado con la página de no disponible + contacto; submit sin escribir", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default = banner
    expect(await turneroOpen()).toBe(true); // línea de base

    // Un turno reservado ANTES de la suspensión: su estado tiene que seguir respondiendo.
    const slot = (await listPublicSlots(slotsInput())).find((s) => s.available)!;
    const prior = await submitPublicBooking(input({ slot: slot.iso }));
    expect(prior).toMatchObject({ ok: true });

    await setTenant({ status: "SUSPENDED" });
    expect(await turneroOpen()).toBe(false);
    expect(await getPublicBookingGate(T.slug)).toEqual({
      state: "closed",
      contact: { name: expect.stringMatching(/^Test /), phone: "1140001111", whatsapp: null, email: "turnos@consultorio.test" },
    });

    const before = await counts();
    expect(await submitPublicBooking(input({ slot: at(DAY, "10:00") }))).toEqual({ ok: false, error: CLOSED_ERROR });
    // El replay idempotente del turno previo tampoco (armaría una preferencia nueva de MP).
    expect(await counts()).toEqual(before);
    if (prior.ok) {
      const st = await getPublicBookingStatus(prior.data.bookingId);
      expect(st?.bookingId).toBe(prior.data.bookingId);
    }
  });

  it("dado de baja: igual que suspendido", async () => {
    await setTenant({ status: "CLOSED" });
    expect(await turneroOpen()).toBe(false);
    const before = await counts();
    expect(await submitPublicBooking(input({ slot: at(DAY, "11:00") }))).toEqual({ ok: false, error: CLOSED_ERROR });
    expect(await counts()).toEqual(before);
  });

  it("trial vencido hace 30 días: abierto con banner (solo se avisa), cerrado con enforce; en gracia abierto", async () => {
    await setTenant({ subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 30 * DAY_MS) });
    process.env.TENANT_ACCESS_ENFORCEMENT = "banner";
    expect(await turneroOpen()).toBe(true);
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    expect(await turneroOpen()).toBe(false);
    const before = await counts();
    expect(await submitPublicBooking(input({ slot: at(DAY, "12:00") }))).toEqual({ ok: false, error: CLOSED_ERROR });
    expect(await counts()).toEqual(before);

    // Gracia (vencido hace 2 días): `publicSurfacesOpen` incluye grace.
    await setTenant({ subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 2 * DAY_MS) });
    expect(await turneroOpen()).toBe(true);

    // `off` = interruptor de emergencia: ni la suspensión corta.
    process.env.TENANT_ACCESS_ENFORCEMENT = "off";
    await setTenant({ status: "SUSPENDED" });
    expect(await turneroOpen()).toBe(true);
  });

  it("el webhook de MP concilia el pago aunque el consultorio esté suspendido o dado de baja (también con enforce)", async () => {
    async function pendingBooking() {
      const pid = await addPatient(db, T);
      slotSeq += 1;
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          patientId: pid,
          scheduledFor: new Date(Date.now() + (20 + slotSeq) * DAY_MS),
          durationMin: 45,
          status: "PENDING",
          idempotencyKey: `test-${randomUUID()}`,
        },
      });
      await db.payment.create({
        data: { bookingId: b.id, provider: "mercadopago", status: "UNPAID", expectedAmountCents: 5000, amountCents: 0 },
      });
      return b.id;
    }
    const cases: [string, TenantStatus, string | undefined][] = [
      ["suspendido · banner", "SUSPENDED", undefined],
      ["baja · enforce", "CLOSED", "enforce"],
    ];
    for (const [label, status, enforcement] of cases) {
      const id = await pendingBooking();
      await setTenant({ status });
      if (enforcement) process.env.TENANT_ACCESS_ENFORCEMENT = enforcement;
      else delete process.env.TENANT_ACCESS_ENFORCEMENT;
      const payId = `PAY-BO2D-${randomUUID().slice(0, 8)}`;
      mpPayments.set(payId, {
        id: payId,
        status: "approved",
        status_detail: "accredited",
        transaction_amount: 50,
        currency_id: "ARS",
        external_reference: id,
      });
      const res = await POST(signedRequest(payId));
      expect(res.status, label).toBe(200);
      const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
      expect(b.paymentStatus, label).toBe("PAID");
      expect(b.payment?.status, label).toBe("PAID");
      expect(b.payment?.externalId, label).toBe(payId);
      expect(b.payment?.amountCents, label).toBe(5000);
      await reset();
    }
  });
});
