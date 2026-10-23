/**
 * T6 · [WA-S2] Hook de WhatsApp de los turnos (C-WA8, brief §26.5): paso 3 de `afterBookingsCommitted`
 * (`lib/booking-events-internal.ts`, firma C-SV3 intacta) → `lib/whatsapp/booking-hook-internal.ts` → la cola.
 *
 * Por las actions REALES (createBooking / createBookingsBatch / updateBooking con getActor real), el webhook REAL de
 * Mercado Pago (rama `?acct=`, que ya llama al hook) y el simulador de Meta. Lo único reemplazado es la red (Meta falso,
 * MP falso), el SDK de MP de la rama legada, el rate limit in-memory y el conteo de sentencias (`installQueryCounter`
 * envuelve los clientes de Prisma sin tocar el código).
 *
 * Con `WHATSAPP_MODE=off` (default de prod hoy) el hook no hace NINGUNA sentencia: el write path de la agenda cuesta lo
 * mismo que antes de T6. Corre en los dos roles.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.MP_WEBHOOK_SECRET = "test-webhook-secret-wa-s2";
});
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create() {
      throw new Error("no usado en este archivo");
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
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, updateBooking } from "@/lib/bookings";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { __resetWaHookBreakerForTests } from "@/lib/whatsapp/booking-hook-internal";
import { POST as mpWebhookPOST } from "@/app/api/webhooks/mercadopago/route";
import { buildChargePreference, connectNotificationUrl } from "@/lib/mp-connect/preference";
import { mpFetch } from "@/lib/mp-connect/http";
import { localToARIso } from "@/lib/datetime-ar";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { measure } from "@/tests/helpers/query-counter";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  fakeGraphMessages,
  type FakeWhatsAppAccount,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";
import { connectFakeAccount, installFakeMp, payFake, FAKE_APP_URL } from "@/tests/helpers/mp-connect-fake";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true, allowRoomConflict: true };

/** Lo que grabó el contador (global del helper). */
const recorded = () =>
  ((globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events ?? []).map((e) => e.query);

function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

/** Un instante futuro redondo (AR), distinto por llamada: los turnos no chocan entre casos. */
let slot = 0;
function future(days = 5): Date {
  slot += 1;
  const d = new Date(Date.now() + (days + slot) * DAY);
  const key = d.toISOString().slice(0, 10);
  return new Date(localToARIso(`${key}T10:00:00`));
}

describe.skipIf(!RUN)("[WA-S2] hook de WhatsApp de los turnos", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledFakeGraph;
  let acc: FakeWhatsAppAccount;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    __resetWaHookBreakerForTests();
    fake = installFakeGraph();
    asUser(T.userId);
    await db.whatsAppMessage.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: T.tenantId } });
    acc = await connectFakeWhatsApp(db, T);
  });
  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
  });

  async function consentedPatient(o: { phone?: string; consent?: boolean } = {}) {
    const phone = o.phone ?? uniquePhone();
    const patientId = await addPatient(db, T, { firstName: "Martina", lastName: "Gómez", phone });
    if (o.consent !== false) {
      await db.patient.update({
        where: { id: patientId },
        data: { waConsent: "GRANTED", waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
      });
    }
    return { patientId, phone };
  }

  const messages = () => db.whatsAppMessage.findMany({ where: { tenantId: T.tenantId }, orderBy: { createdAt: "asc" } });

  async function book(patientId: string, at: Date) {
    const r = await createBooking({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: at.toISOString(),
      durationMin: 45,
      idempotencyKey: randomUUID(),
      ...FORCE,
    });
    expect(r).toMatchObject({ ok: true });
    return db.booking.findFirstOrThrow({ where: { tenantId: T.tenantId, patientId, scheduledFor: at } });
  }

  it("[WA-S2] modo off → el hook hace 0 sentencias y el alta del turno no toca WhatsApp", async () => {
    const { patientId } = await consentedPatient();
    // Control (anti-false-green): con el modo prendido el contador SÍ ve las sentencias de WhatsApp.
    const on = await measure(() => book(patientId, future()));
    expect(recorded().some((q) => /WhatsApp/.test(q))).toBe(true);
    expect(on.m.statements).toBeGreaterThan(0);

    vi.stubEnv("WHATSAPP_MODE", "off");
    const b = await db.booking.findFirstOrThrow({ where: { tenantId: T.tenantId, patientId } });
    const hook = await measure(() =>
      afterBookingsCommitted(T.tenantId, [{ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, kind: "booking" }])
    );
    expect(hook.m.statements).toBe(0);
    await measure(() => book(patientId, future()));
    expect(recorded().filter((q) => /WhatsApp/.test(q))).toEqual([]);
    expect(await db.whatsAppMessage.count({ where: { tenantId: T.tenantId } })).toBe(1);
  });

  it("[WA-S2] turno creado → BOOKING_CREATED (bc:<id>) enviado inline por el simulador", async () => {
    const { patientId, phone } = await consentedPatient();
    const b = await book(patientId, future());
    const [m] = await messages();
    expect(m).toMatchObject({ kind: "BOOKING_CREATED", trigger: "AUTO", idempotencyKey: `bc:${b.id}`, status: "SENT", bookingId: b.id, patientId });
    expect(m.bookingScheduledFor?.toISOString()).toBe(b.scheduledFor.toISOString());
    expect(fakeGraphMessages().map((x) => [x.templateName, x.to, x.callbackData])).toEqual([["cs_turno_agendado_v1", phone.slice(1), m.id]]);
  });

  it("[WA-S2] turno viejo movido → BOOKING_MOVED (bm:<id>:<epoch>); una edición sin cambio de horario no avisa", async () => {
    const { patientId } = await consentedPatient();
    const at = future();
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: T.serviceId, patientId, scheduledFor: at,
        durationMin: 45, status: "CONFIRMED", idempotencyKey: `test-${randomUUID()}`, createdAt: new Date(Date.now() - 3 * DAY),
      },
    });
    const to = new Date(at.getTime() + 3_600_000);
    expect(await updateBooking({ id: b.id, scheduledFor: to.toISOString(), expectedUpdatedAt: b.updatedAt.toISOString(), ...FORCE })).toMatchObject({ ok: true });
    const ms = await messages();
    expect(ms.map((m) => [m.kind, m.idempotencyKey, m.status])).toEqual([["BOOKING_MOVED", `bm:${b.id}:${Math.floor(to.getTime() / 1000)}`, "SENT"]]);
    expect(fakeGraphMessages()[0].templateName).toBe("cs_turno_reprogramado_v1");

    // Edición sin cambio de horario (notas): nada nuevo.
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(await updateBooking({ id: b.id, notes: "otra nota", expectedUpdatedAt: fresh.updatedAt.toISOString(), ...FORCE })).toMatchObject({ ok: true });
    expect(await db.whatsAppMessage.count({ where: { tenantId: T.tenantId } })).toBe(1);
  });

  it("[WA-S2] serie de 10 → UN BOOKINGS_UPDATED (bs:<serie>:<epoch>) con seriesCount 10", async () => {
    const { patientId } = await consentedPatient();
    const r = await createBookingsBatch({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: future(10).toISOString(),
      durationMin: 45,
      count: 10,
      daysOfWeek: [1, 3, 5],
      idempotencyKey: randomUUID(),
      allowOverbooking: true,
      allowRoomConflict: true,
    });
    expect(r).toMatchObject({ ok: true, data: { created: 10 } });
    const ms = await messages();
    expect(ms).toHaveLength(1);
    const first = await db.booking.findFirstOrThrow({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
    expect(ms[0]).toMatchObject({ kind: "BOOKINGS_UPDATED", seriesCount: 10, status: "SENT", bookingId: first.id });
    expect(ms[0].idempotencyKey).toBe(`bs:${first.seriesId}:${Math.floor(first.scheduledFor.getTime() / 1000)}`);
    expect(fakeGraphMessages().map((m) => m.templateName)).toEqual(["cs_turnos_actualizados_v1"]);
    expect(fakeGraphMessages()[0].bodyParams[2]).toBe("10");
  });

  it("[WA-S2] creado y movido en < 2 h con el «agendado» ya enviado → BOOKING_MOVED con la hora nueva", async () => {
    const { patientId } = await consentedPatient();
    const at = future();
    const b = await book(patientId, at);
    expect((await messages())[0]).toMatchObject({ kind: "BOOKING_CREATED", status: "SENT" });
    const to = new Date(at.getTime() + 2 * 3_600_000);
    expect(await updateBooking({ id: b.id, scheduledFor: to.toISOString(), expectedUpdatedAt: b.updatedAt.toISOString(), ...FORCE })).toMatchObject({ ok: true });
    const ms = await messages();
    expect(ms.map((m) => m.kind)).toEqual(["BOOKING_CREATED", "BOOKING_MOVED"]);
    expect(ms[1].bookingScheduledFor?.toISOString()).toBe(to.toISOString());
  });

  it("[WA-S2] < 60′, sin consentimiento, guest y PENDING del turnero → no se encola nada; autoBookingNotice apagado tampoco", async () => {
    const { patientId } = await consentedPatient();
    await book(patientId, new Date(Date.now() + 30 * 60_000));
    const nc = await consentedPatient({ consent: false });
    await book(nc.patientId, future());
    const guest = await db.booking.create({
      data: {
        tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: T.serviceId, patientId: null, guestName: "Invitada",
        guestPhone: uniquePhone(), scheduledFor: future(), durationMin: 45, status: "PENDING", idempotencyKey: `pub:${T.practitionerId}:${randomUUID()}`,
      },
    });
    const pending = await db.booking.create({
      data: {
        tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: T.serviceId, patientId, scheduledFor: future(),
        durationMin: 45, status: "PENDING", idempotencyKey: `pub:${T.practitionerId}:${randomUUID()}`,
      },
    });
    await afterBookingsCommitted(
      T.tenantId,
      [guest, pending].map((b) => ({ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, kind: "booking" as const }))
    );
    // Recepción («llegó») y el llamado de la sala no son cambios de turno.
    await afterBookingsCommitted(T.tenantId, [{ bookingId: pending.id, practitionerId: T.practitionerId, scheduledFor: pending.scheduledFor, kind: "reception" }]);
    expect(await messages()).toEqual([]);

    await db.whatsAppAccount.update({ where: { id: acc.accountId }, data: { autoBookingNotice: false } });
    await book(patientId, future());
    expect(await messages()).toEqual([]);
    expect(fakeGraphMessages()).toEqual([]);
  });

  it("[WA-S2] Graph caído → la action del turno sigue ok y el aviso queda en la cola para reintentar", async () => {
    const { patientId } = await consentedPatient();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/whatsapp/fake")) throw new TypeError("fetch failed");
      return inner(input, init);
    }) as typeof fetch;
    try {
      await book(patientId, future());
    } finally {
      globalThis.fetch = inner;
    }
    const [m] = await messages();
    expect(m).toMatchObject({ kind: "BOOKING_CREATED", status: "QUEUED", attempts: 1, errorCode: "network" });
    expect(m.nextAttemptAt).not.toBeNull();
  });

  it("[WA-S2] breaker: 3 timeouts seguidos → 60 s sin envío inline (los avisos quedan en la cola)", async () => {
    const ps = await Promise.all([1, 2, 3, 4].map(() => consentedPatient({ phone: undefined })));
    // Los 3 primeros al número que el simulador cuelga (…0003); el cuarto, a uno normal.
    const timeoutPhone = (i: number) => `+5491155${String(i).padStart(2, "0")}0003`;
    for (const [i, p] of ps.slice(0, 3).entries()) {
      await db.patient.update({ where: { id: p.patientId }, data: { phone: timeoutPhone(i + 10), waPhoneE164: timeoutPhone(i + 10) } });
    }
    for (const p of ps) await book(p.patientId, future());
    const ms = await messages();
    expect(ms).toHaveLength(4);
    expect(ms.slice(0, 3).map((m) => m.status)).toEqual(["SENDING", "SENDING", "SENDING"]);
    // Con el breaker abierto el cuarto ni se intenta: queda QUEUED (sin intento) para el drain.
    expect(ms[3]).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(fakeGraphMessages().some((m) => m.callbackData === ms[3].id)).toBe(false);
  }, 30_000);

  it("[WA-S2] reserva pública REQUIRED pagada por el MP falso → BOOKING_CREATED (el webhook connect llama al hook)", async () => {
    const { patientId, phone } = await consentedPatient();
    const mpAcc = await connectFakeAccount(db, T, {});
    const waStub = globalThis.fetch;
    const mp = installFakeMp({ webhook: mpWebhookPOST, reset: false });
    const mpStub = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes("/api/whatsapp/") ? waStub(input, init) : mpStub(input, init);
    }) as typeof fetch;
    try {
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: T.serviceId, patientId, scheduledFor: future(),
          durationMin: 45, status: "PENDING", idempotencyKey: `pub:${T.practitionerId}:${randomUUID()}`,
        },
      });
      const charge = await db.onlineCharge.create({
        data: {
          tenantId: T.tenantId, origin: "TURNERO", kind: "FULL", mpAccountId: mpAcc.accountId, practitionerId: T.practitionerId,
          patientId, bookingId: b.id, amountCents: 5000, copagoBasisCents: 5000, expiresAt: new Date(Date.now() + DAY), idempotencyKey: `turnero:${b.id}`,
        },
      });
      const body = buildChargePreference({
        charge: { id: charge.id, amountCents: 5000, scheduledFor: new Date() },
        tenantName: "Consultorio de prueba",
        mode: "REQUIRED",
        notificationUrl: connectNotificationUrl(FAKE_APP_URL, mpAcc.webhookRef),
        backUrls: { success: `${FAKE_APP_URL}/ok`, failure: `${FAKE_APP_URL}/ko`, pending: `${FAKE_APP_URL}/pend` },
        expiresAt: new Date(Date.now() + DAY),
      });
      const pr = await mpFetch("/checkout/preferences", { token: mpAcc.accessToken, method: "POST", body });
      if (!pr.ok) throw new Error("no se creó la preferencia en el fake");
      const pref = pr.json as { id: string; init_point: string };
      await db.onlineCharge.update({ where: { id: charge.id }, data: { preferenceId: pref.id, checkoutUrl: pref.init_point } });
      // Mientras está PENDING, nada.
      expect(await messages()).toEqual([]);

      expect(await payFake(pref.id, "approved")).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CONFIRMED");
      const ms = await messages();
      expect(ms.map((m) => [m.kind, m.idempotencyKey, m.status])).toEqual([["BOOKING_CREATED", `bc:${b.id}`, "SENT"]]);
      expect(fakeGraphMessages().map((m) => m.to)).toEqual([phone.slice(1)]);
    } finally {
      mp.uninstall();
    }
  });
});
