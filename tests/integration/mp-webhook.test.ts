/**
 * Webhook de Mercado Pago (A2b-S-pub), de punta a punta: el `POST` REAL de
 * `app/api/webhooks/mercadopago/route.ts` → `verifyWebhookSignature` (firma
 * HMAC real con el secreto de test) → `consumeWebhook` real → Postgres.
 *
 * Lo único mockeado es lo externo: el SDK de MP (`Payment.get`, la llamada HTTP
 * que trae el detalle del pago) y el rate-limit in-memory.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const WEBHOOK_SECRET = "test-webhook-secret";
vi.hoisted(() => {
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.MP_WEBHOOK_SECRET = "test-webhook-secret";
});

/** Detalle que "devuelve MP" por payment id. */
const mpPayments = vi.hoisted(() => new Map<string, Record<string, unknown>>());
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
    async get({ id }: { id: string }) {
      const d = mpPayments.get(String(id));
      if (!d) throw new Error(`payment ${id} desconocido`);
      // Un poco de latencia para que las llamadas concurrentes se crucen de verdad.
      await new Promise((r) => setTimeout(r, 5));
      return d;
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import crypto, { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { nextPaymentStatus } from "@/lib/mercadopago";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Request firmado como lo firma MP: HMAC-SHA256 de `id:<dataId>;request-id:<req>;ts:<ts>;`. */
function signedRequest(dataId: string, opts: { badSignature?: boolean; staleTs?: boolean } = {}) {
  const requestId = randomUUID();
  const ts = String(Math.floor(Date.now() / 1000) - (opts.staleTs ? 600 : 0));
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = opts.badSignature
    ? "0".repeat(64)
    : crypto.createHmac("sha256", WEBHOOK_SECRET).update(manifest).digest("hex");
  return new Request(`http://localhost/api/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": `ts=${ts},v1=${v1}`,
      "x-request-id": requestId,
    },
    body: JSON.stringify({ type: "payment", data: { id: dataId } }),
  });
}

function mpDetail(id: string, bookingId: string, status: string, amount = 50) {
  mpPayments.set(id, {
    id,
    status,
    status_detail: status === "approved" ? "accredited" : "cc_rejected_other_reason",
    transaction_amount: amount,
    currency_id: "ARS",
    external_reference: bookingId,
    // PII que NO debe persistirse (redactPayload, AUDIT §5.4).
    payer: { email: "tarjetahabiente@test.local", identification: { number: "30123456" } },
    card: { cardholder: { name: "TITULAR" } },
  });
}

async function hook(id: string, opts?: Parameters<typeof signedRequest>[1]) {
  const res = await POST(signedRequest(id, opts));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("nextPaymentStatus (pura)", () => {
  it("PAID solo sale hacia REFUNDED", () => {
    expect(nextPaymentStatus("PAID", "FAILED")).toBe("PAID");
    expect(nextPaymentStatus("PAID", "AUTHORIZED")).toBe("PAID");
    expect(nextPaymentStatus("PAID", "UNPAID")).toBe("PAID");
    expect(nextPaymentStatus("PAID", "REFUNDED")).toBe("REFUNDED");
  });
  it("REFUNDED no vuelve a FAILED/AUTHORIZED; el resto toma el entrante", () => {
    expect(nextPaymentStatus("REFUNDED", "FAILED")).toBe("REFUNDED");
    expect(nextPaymentStatus("REFUNDED", "AUTHORIZED")).toBe("REFUNDED");
    expect(nextPaymentStatus("FAILED", "PAID")).toBe("PAID");
    expect(nextPaymentStatus("AUTHORIZED", "FAILED")).toBe("FAILED");
    expect(nextPaymentStatus(null, "AUTHORIZED")).toBe("AUTHORIZED");
  });
});

describe.skipIf(!RUN)("webhook MP · consumeWebhook vía la ruta firmada (A2b-S-pub)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let slotSeq = 0;

  /** Turno público PENDING/UNPAID con su Payment anclado (lo que deja el checkout). */
  async function pendingBooking(status: "PENDING" | "CANCELLED" | "COMPLETED" = "PENDING") {
    const pid = await addPatient(db, T);
    slotSeq += 1;
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        patientId: pid,
        scheduledFor: new Date(Date.now() + (3 + slotSeq) * 86_400_000),
        durationMin: 45,
        status,
        idempotencyKey: `test-${randomUUID()}`,
      },
    });
    await db.payment.create({
      data: { bookingId: b.id, provider: "mercadopago", status: "UNPAID", expectedAmountCents: 5000, amountCents: 0 },
    });
    return b.id;
  }
  const notifCount = () =>
    db.notification.count({ where: { tenantId: T.tenantId, kind: "PAYMENT_RECEIVED" } });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("preserva HMAC y anti-replay: firma inválida o vieja → 401 sin tocar nada", async () => {
    const id = await pendingBooking();
    mpDetail("PAY-SIG", id, "approved");
    expect((await hook("PAY-SIG", { badSignature: true })).status).toBe(401);
    expect((await hook("PAY-SIG", { staleTs: true })).status).toBe(401);
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(b.paymentStatus).toBe("UNPAID");
  });

  it("approved → PAID + CONFIRMED + notificación; el reenvío es idempotente; no guarda PII", async () => {
    const id = await pendingBooking();
    const n0 = await notifCount();
    mpDetail("PAY-OK", id, "approved");
    const r = await hook("PAY-OK");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("PAID");

    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(b.status).toBe("CONFIRMED");
    expect(b.paymentStatus).toBe("PAID");
    expect(b.payment!.externalId).toBe("PAY-OK");
    expect(b.payment!.amountCents).toBe(5000);
    expect(JSON.stringify(b.payment!.rawPayload)).not.toContain("tarjetahabiente");
    expect(JSON.stringify(b.payment!.rawPayload)).not.toContain("TITULAR");
    expect(await notifCount()).toBeGreaterThan(n0);

    const n1 = await notifCount();
    const again = await hook("PAY-OK");
    expect(again.body.replay).toBe(true);
    expect(await notifCount()).toBe(n1);
  });

  it("no-downgrade: un rejected / pending tardío NO baja un PAID; queda en el historial", async () => {
    const id = await pendingBooking();
    mpDetail("PAY-A", id, "approved");
    await hook("PAY-A");
    mpDetail("PAY-B", id, "rejected");
    mpDetail("PAY-C", id, "in_process");
    await hook("PAY-B");
    await hook("PAY-C");

    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(b.paymentStatus).toBe("PAID");
    expect(b.status).toBe("CONFIRMED");
    expect(b.payment!.status).toBe("PAID");
    expect(b.payment!.externalId).toBe("PAY-A");
    const attempts = (b.payment!.rawPayload as { attempts: Array<{ id: string; applied: boolean }> }).attempts;
    expect(attempts.map((a) => [a.id, a.applied])).toEqual([
      ["PAY-A", true],
      ["PAY-B", false],
      ["PAY-C", false],
    ]);
    expect(JSON.stringify(attempts)).not.toContain("tarjetahabiente");

    // PAID → REFUNDED sí se aplica.
    mpDetail("PAY-A", id, "refunded");
    await hook("PAY-A");
    const after = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(after.paymentStatus).toBe("REFUNDED");
  });

  it("un cobro a mano (paymentStatus PAID en la agenda) tampoco lo baja un rejected", async () => {
    const id = await pendingBooking();
    await db.booking.update({ where: { id }, data: { paymentStatus: "PAID", status: "CONFIRMED" } });
    mpDetail("PAY-MANUAL", id, "rejected");
    await hook("PAY-MANUAL");
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(b.paymentStatus).toBe("PAID");
  });

  it("monto distinto sobre un turno ya pagado → no lo baja", async () => {
    const id = await pendingBooking();
    mpDetail("PAY-GOOD", id, "approved");
    await hook("PAY-GOOD");
    mpDetail("PAY-CHEAP", id, "approved", 1);
    const r = await hook("PAY-CHEAP");
    expect(r.body.reason).toBe("amount_mismatch");
    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(b.paymentStatus).toBe("PAID");
    expect(b.payment!.externalId).toBe("PAY-GOOD");
    expect(b.payment!.amountCents).toBe(5000);
  });

  it("un turno CANCELLED no revive: se registra el pago y se avisa para reembolsar", async () => {
    const id = await pendingBooking("CANCELLED");
    mpDetail("PAY-CXL", id, "approved");
    const r = await hook("PAY-CXL");
    expect(r.status).toBe(200);
    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(b.status).toBe("CANCELLED");
    expect(b.paymentStatus).toBe("PAID");
    expect(b.payment!.externalId).toBe("PAY-CXL");
    const n = await db.notification.findFirst({
      where: { tenantId: T.tenantId, title: { contains: "cancelado" } },
    });
    expect(n?.body).toContain("reembolsar");
  });

  it("un turno COMPLETED tampoco cambia de estado", async () => {
    const id = await pendingBooking("COMPLETED");
    mpDetail("PAY-DONE", id, "approved");
    await hook("PAY-DONE");
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("COMPLETED");
    expect(b.paymentStatus).toBe("PAID");
  });

  it("concurrencia: el mismo evento dos veces a la vez → un solo efecto, sin 500", async () => {
    const id = await pendingBooking();
    // Sin Payment previo: los dos webhooks compiten por crearlo (P2002 → reintento).
    await db.payment.delete({ where: { bookingId: id } });
    mpDetail("PAY-RACE", id, "approved");
    const n0 = await notifCount();
    const [a, b] = await Promise.all([hook("PAY-RACE"), hook("PAY-RACE")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const booking = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(booking.paymentStatus).toBe("PAID");
    expect(booking.payment!.externalId).toBe("PAY-RACE");
    const owners = await db.membership.count({ where: { tenantId: T.tenantId, role: { in: ["OWNER", "ADMIN"] } } });
    // Una sola tanda de notificaciones (dueños + el profesional, deduplicados).
    expect((await notifCount()) - n0).toBe(owners);
  });

  it("concurrencia: approved y rejected cruzados → termina PAID sin importar el orden", async () => {
    const id = await pendingBooking();
    mpDetail("PAY-X1", id, "rejected");
    mpDetail("PAY-X2", id, "approved");
    await Promise.all([hook("PAY-X1"), hook("PAY-X2")]);
    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
    expect(b.paymentStatus).toBe("PAID");
    expect(b.status).toBe("CONFIRMED");
    expect(b.payment!.externalId).toBe("PAY-X2");
  });
});
