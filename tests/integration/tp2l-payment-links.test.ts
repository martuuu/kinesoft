/**
 * T5 · [TP-2l] Links de pago (plan §25.7, contrato C-TP9).
 *
 * Nace en TP-K2 (tanda T5c) con las filas del camino feliz como `it.fails`: `lib/payment-links.ts` y
 * `lib/public-payment-link.ts` son stubs que devuelven «todavía no disponible» (o `null`) sin tocar la base, así que
 * cada fila falla por el motivo correcto. TP-2d las implementa, completa el setup (cuenta ACTIVE del profesional con
 * delegación vía `installFakeMp`, `tests/helpers/mp-connect-fake.ts`) y las da vuelta a `it(...)`. Las filas de rechazo
 * (sin delegación, `collectOwn` ajeno, soporte, montos fuera de rango, …) las agrega TP-2d: con el stub pasarían en
 * verde sin probar nada (anti-false-green).
 *
 * Actions reales contra Postgres, en los dos roles. Se mockea la sesión de Supabase y `next/cache` (integration-setup).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createPaymentLink,
  cancelPaymentLink,
  sendPaymentLinkEmail,
  getPaymentLinkShare,
  getPaymentLinkSuggestions,
} from "@/lib/payment-links";
import { getPublicPaymentLink } from "@/lib/public-payment-link";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[TP-2l] links de pago", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string; membershipId: string };
  let pat: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addStaff(db, T, "ASSISTANT");
    pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId, email: "paciente@test.local", phone: "1155554444" });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Turno confirmado de mañana del profesional, $20.000 de copago, sin cobrar. Sembrado con el owner client. */
  async function seedBooking() {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: kine.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + 86_400_000),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        copagoCents: 20_000_00,
        idempotencyKey: randomUUID(),
      },
    });
  }

  async function createRestLink() {
    const b = await seedBooking();
    asUser(assistant.userId);
    const r = await createPaymentLink({
      patientId: pat,
      bookingId: b.id,
      practitionerId: kine.practitionerId,
      purpose: "REST",
      concept: "Sesión de kinesiología",
      idempotencyKey: randomUUID(),
    });
    return { booking: b, r };
  }

  it.fails("[TP-2l] Secretaria con delegación → REST con el monto restante y URL `/pagar/<22>`", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    const { booking, r } = await createRestLink();
    asUser(assistant.userId);
    const s = await getPaymentLinkSuggestions({ bookingId: booking.id });
    expect(s).toMatchObject({ ok: true, data: { remainingCents: 20_000_00, depositPaidCents: 0, accountKind: "PRACTITIONER" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.amountCents).toBe(20_000_00);
    expect(r.data.accountKind).toBe("PRACTITIONER");
    expect(new URL(r.data.url).pathname).toMatch(/^\/pagar\/[A-Za-z0-9_-]{22}$/);
  });

  it.fails("[TP-2l] Anular: ACTIVE (vence la preferencia); AUTHORIZED → rechazo.", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = await cancelPaymentLink({ chargeId: r.data.chargeId });
    expect(c).toEqual({ ok: true, data: { status: "CANCELLED" } });
  });

  it.fails("[TP-2l] Página pública: `getPublicPaymentLink` sin datos del paciente y con sus estados", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const token = new URL(r.data.url).pathname.split("/").pop()!;
    const page = await getPublicPaymentLink(token);
    expect(page).toMatchObject({ status: "payable", amountCents: 20_000_00 });
    expect(JSON.stringify(page)).not.toContain("Paciente");
  });

  it.fails("[TP-2l] email sin concepto, con `fromName` y `EmailLog`; sin email → error", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await sendPaymentLinkEmail({ chargeId: r.data.chargeId });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.data.sentToMasked).not.toBe("paciente@test.local");
  });

  it.fails("[TP-2l] WhatsApp: texto y `wa.me`.", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await getPaymentLinkShare({ chargeId: r.data.chargeId });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.data.url).toBe(r.data.url);
    expect(s.data.waUrl).toMatch(/^https:\/\/wa\.me\//);
  });
});
